-- The wall-clock tombstone is legacy-only (Lumen, PR #563 round 24).
--
-- Modern attempt-token reclaims compared the CLI marker's wall time with
-- the DB's now() tombstone — an ordering that clock skew makes unreliable
-- (this PR's own test hardening proved it): a FRESH later attempt could be
-- falsely 'stopped', run stale, and retire its marker. Modern attempts
-- need no clocks at all: every path lands in the claims-map replay guard
-- (valid only while the epoch owns a RUNNING row) or the append-only
-- attempt fence. The timestamp fences (cli_turn_stopped_at and
-- cli_turn_missing_stop_at) now apply exclusively to attempt-less legacy
-- reclaims, whose senders share the server's era of timestamps anyway.

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
  v_new text := gen_random_uuid()::text;
  v_epoch text;
  v_regrant boolean := false;
  v_now text := to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
BEGIN
  SELECT user_id, cli_turn_fenced_attempts
    INTO v_session
    FROM public.sessions WHERE id = p_session_id;
  IF v_session.user_id IS NULL THEN
    RETURN jsonb_build_object('outcome', 'stopped');
  END IF;
  v_session_user := v_session.user_id;

  IF p_attempt IS NOT NULL AND v_session.cli_turn_fenced_attempts ? p_attempt THEN
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
  SET turn_epoch = CASE
        WHEN p_attempt IS NOT NULL AND (cli_turn_attempt_claims ? p_attempt)
        THEN turn_epoch
        ELSE v_new
      END,
      lifecycle = CASE WHEN p_set_running THEN 'running' ELSE lifecycle END,
      cli_turn_at = CASE WHEN p_set_running THEN now() ELSE cli_turn_at END,
      studio_id = CASE WHEN v_regrant THEN p_studio_id ELSE studio_id END,
      cli_turn_attempt_claims = CASE
        WHEN p_attempt IS NULL OR (cli_turn_attempt_claims ? p_attempt)
        THEN cli_turn_attempt_claims
        ELSE cli_turn_attempt_claims || jsonb_build_object(p_attempt, v_new)
      END
  WHERE id = p_session_id
    AND (
      -- The wall-clock tombstone applies ONLY to legacy attempt-less
      -- reclaims (round 24): CLI marker time vs DB now() is unordered
      -- under clock skew, and a fresh modern attempt falsely 'stopped'
      -- would run stale and retire its marker. Modern attempts are fully
      -- protected by the consume/replay/fence lifecycle — no clocks.
      p_attempt IS NOT NULL
      OR p_not_stopped_after IS NULL
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
    AND (
      -- A REPLAY (attempt already recorded) is valid only while its epoch
      -- still owns a RUNNING row — never a resurrection, and the running-
      -- entry trigger never fires for it.
      p_attempt IS NULL
      OR NOT (cli_turn_attempt_claims ? p_attempt)
      OR (cli_turn_attempt_claims ->> p_attempt = turn_epoch AND lifecycle = 'running')
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
