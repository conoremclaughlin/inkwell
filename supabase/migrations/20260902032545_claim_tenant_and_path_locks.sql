-- Tenant boundary + checkout-class serialization for the claim (Lumen,
-- PR #563 round 15).
--
-- P0: the round-14 claim locked the studio by UUID alone and never required
-- sessions.user_id = studios.user_id — an authenticated caller could name
-- their own session and ANOTHER user's vacant studio UUID and install a
-- cross-tenant lease under the service role. The claim now resolves the
-- session's user first and returns {"outcome":"forbidden"} on any mismatch,
-- before touching anything.
--
-- P1: the regrant bypassed grant_studio_lease's advisory checkout lock, so
-- two vacant sibling rows (or a regrant racing a normal grant) could each
-- scan the other as vacant and lease the same worktree. The regrant now
-- takes the SAME advisory lock ('studio-path:<user>:<normalized path>', row
-- fallback for pathless studios) BEFORE the row lock — the same order the
-- grant uses, so the two paths serialize without deadlock — and the sibling
-- scan compares normalize_worktree_path() like the grant does. A backing
-- moved across the lock acquisition refuses rather than proceeding on a
-- stale class.

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
  v_lock_key text;
  v_epoch text;
  v_regrant boolean := false;
  v_now text := to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
BEGIN
  SELECT user_id INTO v_session_user FROM public.sessions WHERE id = p_session_id;
  IF v_session_user IS NULL THEN
    RETURN jsonb_build_object('outcome', 'stopped');
  END IF;

  IF p_studio_id IS NOT NULL THEN
    -- Pre-lock read: tenant check + checkout class for the advisory lock.
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

    -- Same lock, same order as grant_studio_lease: advisory (checkout
    -- class) first, row lock second — regrants and grants serialize.
    v_lock_key := CASE
      WHEN v_path IS NULL OR v_path = ''
        THEN 'studio-row:' || p_studio_id::text
      ELSE 'studio-path:' || v_session_user::text || ':' || v_path
    END;
    PERFORM pg_advisory_xact_lock(hashtext(v_lock_key));

    SELECT id, user_id, lease, status, expires_at, worktree_path
      INTO v_studio
      FROM public.studios
      WHERE id = p_studio_id
      FOR UPDATE;

    IF v_studio.id IS NULL OR v_studio.user_id IS DISTINCT FROM v_session_user THEN
      RETURN jsonb_build_object('outcome', 'forbidden');
    END IF;
    IF public.normalize_worktree_path(v_studio.worktree_path) IS DISTINCT FROM
       NULLIF(v_path, '') THEN
      -- The backing moved between the pre-lock read and the lock: the
      -- advisory lock protects a class this row no longer belongs to.
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
         OR (
           v_path IS NOT NULL AND v_path <> ''
           AND EXISTS (
             SELECT 1 FROM public.studios s
             WHERE s.id <> v_studio.id
               AND s.user_id = v_studio.user_id
               AND public.normalize_worktree_path(s.worktree_path) = v_path
               AND s.lease IS NOT NULL
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
