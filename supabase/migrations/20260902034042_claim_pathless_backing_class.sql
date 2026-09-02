-- Pathless studios use the canonical backing class (Lumen, PR #563 round 16).
--
-- The round-15 claim locked pathless studios on 'studio-row:<id>' while the
-- canonical grant locks them on 'studio-pathless:<user>' — one shared
-- defaultWorkingDirectory class per user (P0-3) — so a pathless regrant and
-- a pathless grant did not serialize. Worse, the moved-backing recheck
-- compared normalize('') against NULLIF('',''), refusing EVERY unchanged
-- empty-path regrant with lease-lost.
--
-- The claim now mirrors grant_studio_lease exactly: v_pathless classifies
-- once; the advisory key is 'studio-pathless:<user>' for pathless rows; the
-- moved-backing recheck is pathless-aware (pathless stays pathless, a row
-- that gained a path across the lock refuses); and the sibling scan runs for
-- pathless rows too, against the other pathless rows of the same user.

CREATE OR REPLACE FUNCTION public.claim_turn_epoch(
  p_session_id uuid,
  p_set_running boolean DEFAULT false,
  p_not_stopped_after timestamptz DEFAULT NULL,
  p_studio_id uuid DEFAULT NULL,
  p_regrant jsonb DEFAULT NULL
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
      OR cli_turn_stopped_at <= p_not_stopped_after
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

REVOKE ALL ON FUNCTION public.claim_turn_epoch(uuid, boolean, timestamptz, uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_turn_epoch(uuid, boolean, timestamptz, uuid, jsonb) FROM anon, authenticated;
