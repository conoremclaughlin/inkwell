-- Attempts are CONSUMED, not merely denylisted (Lumen, PR #563 round 22).
--
-- Two failure shapes in the round-21 fence:
--   * a duplicate/retried same-attempt claim ROTATED the epoch again — the
--     claim was not idempotent per attempt;
--   * commit-then-response-loss: an attempt's claim committed (row running
--     under its epoch), the response was lost, the caller treated it as
--     failed, and the scope-end fenced the attempt as "abandoned" — while
--     its committed epoch stayed `running` forever.
--
-- `cli_turn_attempt_claims` records {attemptId: epoch} inside the claim's
-- own transaction. A REPLAY of a recorded attempt returns the SAME epoch
-- (re-asserting the running state fenced on it) instead of rotating; a
-- replay whose epoch was superseded reports 'stopped'. And
-- `fence_turn_attempts` RECONCILES: if any attempt being fenced had a
-- committed claim that still owns the row, the fence CLOSES that turn
-- (idle + marker clear + tombstone) in the same statement — an abandoned-
-- but-committed attempt can no longer leave a durable running zombie.

ALTER TABLE public.sessions
  ADD COLUMN IF NOT EXISTS cli_turn_attempt_claims jsonb NOT NULL DEFAULT '{}'::jsonb;

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
  v_session record;
  v_session_user uuid;
  v_studio record;
  v_path text;
  v_pathless boolean;
  v_locked_path text;
  v_epoch text;
  v_prior text;
  v_regrant boolean := false;
  v_now text := to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
BEGIN
  SELECT user_id, turn_epoch, cli_turn_fenced_attempts, cli_turn_attempt_claims
    INTO v_session
    FROM public.sessions WHERE id = p_session_id;
  IF v_session.user_id IS NULL THEN
    RETURN jsonb_build_object('outcome', 'stopped');
  END IF;
  v_session_user := v_session.user_id;

  IF p_attempt IS NOT NULL THEN
    IF v_session.cli_turn_fenced_attempts ? p_attempt THEN
      RETURN jsonb_build_object('outcome', 'stopped');
    END IF;
    v_prior := v_session.cli_turn_attempt_claims ->> p_attempt;
    IF v_prior IS NOT NULL THEN
      -- IDEMPOTENT replay: this attempt already claimed. Re-assert the
      -- running state FENCED on its own epoch — never rotate again. A
      -- superseded epoch means the turn moved on: report 'stopped'.
      UPDATE public.sessions
      SET lifecycle = CASE WHEN p_set_running THEN 'running' ELSE lifecycle END,
          cli_turn_at = CASE WHEN p_set_running THEN now() ELSE cli_turn_at END
      WHERE id = p_session_id AND turn_epoch = v_prior;
      IF FOUND THEN
        RETURN jsonb_build_object('outcome', 'claimed', 'epoch', v_prior, 'regranted', false);
      END IF;
      RETURN jsonb_build_object('outcome', 'stopped');
    END IF;
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
      p_attempt IS NOT NULL
      OR p_not_stopped_after IS NULL
      OR cli_turn_missing_stop_at IS NULL
      OR cli_turn_missing_stop_at < p_not_stopped_after
    )
  RETURNING turn_epoch INTO v_epoch;

  IF v_epoch IS NULL THEN
    RETURN jsonb_build_object('outcome', 'stopped');
  END IF;

  IF p_attempt IS NOT NULL THEN
    -- Record the attempt → epoch binding so replays are idempotent and the
    -- fence can reconcile a committed-but-response-lost claim.
    UPDATE public.sessions
    SET cli_turn_attempt_claims =
          cli_turn_attempt_claims || jsonb_build_object(p_attempt, v_epoch)
    WHERE id = p_session_id;
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

-- Fence + RECONCILE: an attempt being fenced whose committed claim still
-- owns the row is CLOSED here, in the same atomic statement — abandoning a
-- committed-but-response-lost attempt must never strand a running row.
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
      cli_turn_missing_stop_at = now(),
      lifecycle = CASE
        WHEN EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(COALESCE(p_attempts, '[]'::jsonb)) a(att)
          WHERE cli_turn_attempt_claims ->> a.att = turn_epoch
        ) THEN 'idle' ELSE lifecycle END,
      cli_turn_at = CASE
        WHEN EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(COALESCE(p_attempts, '[]'::jsonb)) a(att)
          WHERE cli_turn_attempt_claims ->> a.att = turn_epoch
        ) THEN NULL ELSE cli_turn_at END,
      cli_turn_stopped_at = CASE
        WHEN EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(COALESCE(p_attempts, '[]'::jsonb)) a(att)
          WHERE cli_turn_attempt_claims ->> a.att = turn_epoch
        ) THEN now() ELSE cli_turn_stopped_at END
  WHERE id = p_session_id;
$$;

REVOKE ALL ON FUNCTION public.fence_turn_attempts(uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fence_turn_attempts(uuid, jsonb) FROM anon, authenticated;
