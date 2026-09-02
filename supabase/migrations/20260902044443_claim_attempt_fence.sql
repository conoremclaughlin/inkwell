-- Attempt-level fencing (Lumen, PR #563 round 21).
--
-- The round-20 generation fence had three gaps:
--   * a SCALAR: fence A → fence B overwrote A, so a late parked A claim saw
--     B and landed after both scopes ended;
--   * the wrapper generation spans every prompt of an interactive session,
--     so one missing-record turn's fence permanently refused ALL later
--     failed prompts of the same wrapper;
--   * generation-less missing-epoch stops stamped nothing, leaving the
--     legacy (channel-plugin) parked-claim tail unfenced.
--
-- The fence is now per ATTEMPT: every marker carries a fresh attemptId, the
-- reclaim presents it (`p_attempt`), and scope-ends APPEND the attempts they
-- abandon to `cli_turn_fenced_attempts` (jsonb array — every still-possible
-- attempt is preserved). Legacy attempt-less reclaims are fenced by
-- `cli_turn_missing_stop_at`, which every missing-epoch stop stamps; modern
-- claims skip that column entirely, so it can never refuse a coexisting
-- generation's newer marker. `cli_turn_stopped_at` (real fenced stops,
-- strict <) is unchanged. The round-20 generation column is retired.

ALTER TABLE public.sessions
  ADD COLUMN IF NOT EXISTS cli_turn_fenced_attempts jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS cli_turn_missing_stop_at timestamptz;

DROP FUNCTION IF EXISTS public.claim_turn_epoch(uuid, boolean, timestamptz, uuid, jsonb, text);

CREATE FUNCTION public.claim_turn_epoch(
  p_session_id uuid,
  p_set_running boolean DEFAULT false,
  p_not_stopped_after timestamptz DEFAULT NULL,
  p_studio_id uuid DEFAULT NULL,
  p_regrant jsonb DEFAULT NULL,
  p_attempt text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_session_user uuid;
  v_studio record;
  v_path text;
  v_pathless boolean;
  v_locked_path text;
  v_epoch text;
  v_regrant boolean := false;
  v_now text := to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
BEGIN
  SELECT user_id INTO v_session_user FROM public.sessions WHERE id = p_session_id;
  IF v_session_user IS NULL THEN
    RETURN jsonb_build_object('outcome', 'stopped');
  END IF;

  IF p_studio_id IS NOT NULL THEN
    SELECT user_id, public.normalize_worktree_path(worktree_path)
      INTO v_studio
      FROM public.studios
      WHERE id = p_studio_id;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('outcome', 'lease-lost');
    END IF;
    IF v_studio.user_id IS DISTINCT FROM v_session_user THEN
      RETURN jsonb_build_object('outcome', 'forbidden');
    END IF;
    v_path := v_studio.normalize_worktree_path;
    v_pathless := (v_path IS NULL OR v_path = '');

    PERFORM pg_advisory_xact_lock(hashtext(
      CASE WHEN v_pathless
        THEN 'studio-pathless:' || v_session_user::text
        ELSE 'studio-path:' || v_session_user::text || ':' || v_path
      END
    ));

    SELECT id, user_id, lease, status, expires_at, worktree_path
      INTO v_studio
      FROM public.studios
      WHERE id = p_studio_id
      FOR UPDATE;

    IF v_studio.id IS NULL OR v_studio.user_id IS DISTINCT FROM v_session_user THEN
      RETURN jsonb_build_object('outcome', 'forbidden');
    END IF;
    v_locked_path := public.normalize_worktree_path(v_studio.worktree_path);
    IF v_pathless THEN
      IF NOT (v_locked_path IS NULL OR v_locked_path = '') THEN
        RETURN jsonb_build_object('outcome', 'lease-lost');
      END IF;
    ELSIF v_locked_path IS DISTINCT FROM v_path THEN
      RETURN jsonb_build_object('outcome', 'lease-lost');
    END IF;

    IF v_studio.lease IS NULL THEN
      IF p_regrant IS NULL
         OR v_studio.status NOT IN ('active', 'idle')
         OR (v_studio.expires_at IS NOT NULL AND v_studio.expires_at <= now())
         OR EXISTS (
           SELECT 1 FROM public.inbox_threads t
           WHERE t.user_id = v_studio.user_id
             AND t.thread_key = p_regrant->>'threadKey'
             AND t.status = 'closed'
         )
         OR EXISTS (
           SELECT 1 FROM public.studios s
           WHERE s.id <> v_studio.id
             AND s.user_id = v_studio.user_id
             AND s.lease IS NOT NULL
             AND (
               CASE WHEN v_pathless
                 THEN COALESCE(public.normalize_worktree_path(s.worktree_path), '') = ''
                 ELSE public.normalize_worktree_path(s.worktree_path) = v_path
               END
             )
         ) THEN
        RETURN jsonb_build_object('outcome', 'lease-lost');
      END IF;
      v_regrant := true;
    ELSIF v_studio.lease->>'sessionId' IS DISTINCT FROM p_session_id::text
       OR COALESCE((v_studio.lease->>'quarantined')::boolean, false) THEN
      RETURN jsonb_build_object('outcome', 'lease-lost');
    END IF;
  END IF;

  UPDATE public.sessions
  SET turn_epoch = gen_random_uuid()::text,
      lifecycle = CASE WHEN p_set_running THEN 'running' ELSE lifecycle END,
      cli_turn_at = CASE WHEN p_set_running THEN now() ELSE cli_turn_at END,
      studio_id = CASE WHEN v_regrant THEN p_studio_id ELSE studio_id END
  WHERE id = p_session_id
    AND (
      p_not_stopped_after IS NULL
      OR cli_turn_stopped_at IS NULL
      OR cli_turn_stopped_at < p_not_stopped_after
    )
    AND (
      p_attempt IS NULL
      OR NOT (cli_turn_fenced_attempts ? p_attempt)
    )
    AND (
      -- Legacy attempt-less RECLAIMS are fenced by the missing-stop stamp;
      -- modern claims (with an attempt token) skip it entirely, so it can
      -- never refuse a coexisting generation's newer marker.
      p_attempt IS NOT NULL
      OR p_not_stopped_after IS NULL
      OR cli_turn_missing_stop_at IS NULL
      OR cli_turn_missing_stop_at < p_not_stopped_after
    )
  RETURNING turn_epoch INTO v_epoch;

  IF v_epoch IS NULL THEN
    RETURN jsonb_build_object('outcome', 'stopped');
  END IF;

  IF v_regrant THEN
    UPDATE public.studios
    SET lease = p_regrant || jsonb_build_object(
          'acquiredAt', v_now,
          'heartbeatAt', v_now,
          'turnEpoch', v_epoch
        )
    WHERE id = p_studio_id;
  END IF;

  UPDATE public.studios
  SET lease = lease || jsonb_build_object(
        'heartbeatAt', v_now,
        'turnEpoch', v_epoch
      )
  WHERE user_id = v_session_user
    AND lease IS NOT NULL
    AND lease->>'sessionId' = p_session_id::text
    AND COALESCE((lease->>'quarantined')::boolean, false) = false;

  RETURN jsonb_build_object('outcome', 'claimed', 'epoch', v_epoch, 'regranted', v_regrant);
END;
$$;

REVOKE ALL ON FUNCTION public.claim_turn_epoch(uuid, boolean, timestamptz, uuid, jsonb, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_turn_epoch(uuid, boolean, timestamptz, uuid, jsonb, text) FROM anon, authenticated;

-- Append attempts a scope end abandons — every still-possible attempt is
-- preserved (the scalar generation fence lost earlier scopes on overwrite).
CREATE OR REPLACE FUNCTION public.fence_turn_attempts(
  p_session_id uuid,
  p_attempts jsonb
)
RETURNS void
LANGUAGE sql
AS $$
  UPDATE public.sessions
  SET cli_turn_fenced_attempts =
        cli_turn_fenced_attempts || COALESCE(p_attempts, '[]'::jsonb),
      cli_turn_missing_stop_at = now()
  WHERE id = p_session_id;
$$;

REVOKE ALL ON FUNCTION public.fence_turn_attempts(uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fence_turn_attempts(uuid, jsonb) FROM anon, authenticated;
