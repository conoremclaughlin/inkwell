-- One revocation-aware atomic boundary (Lumen, PR #563 round 14).
--
-- The round-13 application-level reacquire had three boundary failures:
--   1. Vacancy is not authorization — close_thread commits `closed` before
--      releasing, so an in-flight prompt could reacquire a DELIBERATELY
--      revoked studio under a closed thread key.
--   2. releaseStudio() clears the lease first and repoints ephemeral
--      sessions later; a reacquire+claim landing between the steps was then
--      unfenced-repointed off its own studio.
--   3. The watcher sequence lease-lost → acquire → stopped (tombstone wins
--      on the retry) left the freshly granted lease held by a dead turn.
--
-- All three close by moving eligibility + vacant regrant + epoch claim +
-- session binding into claim_turn_epoch itself, and by serializing the
-- release's repoint on the same studio row lock:
--   * `p_regrant` is the lease to install IF the studio is vacant AND
--     eligible: acquirable status, unexpired, the lease's thread NOT closed
--     (revocation), and no sibling row holding the same checkout. Anything
--     else refuses with {'outcome':'lease-lost'} and nothing committed.
--   * The tombstone CAS runs BEFORE the regrant is installed — a reclaim
--     that lost to a stop returns {'outcome':'stopped'} with the studio
--     still vacant (no lease held by a dead turn).
--   * A successful regrant also re-binds sessions.studio_id inside the same
--     transaction.
--   * repoint_sessions_off_ephemeral takes the studio row FOR UPDATE and
--     repoints ONLY while the lease is still NULL — the claim holds the
--     same lock, so whichever commits second sees the other's state:
--     regrant-then-repoint skips (lease present), repoint-then-regrant
--     rebinds the session right back.

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
  v_studio record;
  v_epoch text;
  v_regrant boolean := false;
  v_now text := to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
BEGIN
  IF p_studio_id IS NOT NULL THEN
    SELECT id, user_id, lease, status, expires_at, worktree_path
      INTO v_studio
      FROM public.studios
      WHERE id = p_studio_id
      FOR UPDATE;

    IF v_studio.id IS NULL THEN
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
             AND s.worktree_path = v_studio.worktree_path
             AND s.lease IS NOT NULL
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
    -- The regrant was NOT installed: a stopped reclaim grants nothing.
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
  WHERE lease IS NOT NULL
    AND lease->>'sessionId' = p_session_id::text
    AND COALESCE((lease->>'quarantined')::boolean, false) = false;

  RETURN jsonb_build_object('outcome', 'claimed', 'epoch', v_epoch, 'regranted', v_regrant);
END;
$$;

REVOKE ALL ON FUNCTION public.claim_turn_epoch(uuid, boolean, timestamptz, uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_turn_epoch(uuid, boolean, timestamptz, uuid, jsonb) FROM anon, authenticated;
DROP FUNCTION IF EXISTS public.claim_turn_epoch(uuid, boolean, timestamptz, uuid);

-- The release's ephemeral repoint, serialized on the SAME studio row lock as
-- the claim's regrant. Repoints only while the lease is still NULL: a
-- regrant that won the lock leaves the sessions bound; a repoint that won is
-- immediately corrected by the regrant's own session re-bind.
CREATE OR REPLACE FUNCTION public.repoint_sessions_off_ephemeral(
  p_studio_id uuid,
  p_user_id uuid
)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_studio record;
  v_ancestor uuid := NULL;
  v_parent uuid;
  v_row record;
  v_seen uuid[] := ARRAY[]::uuid[];
  v_count integer := 0;
BEGIN
  SELECT id, ephemeral, parent_studio_id, lease
    INTO v_studio
    FROM public.studios
    WHERE id = p_studio_id AND user_id = p_user_id
    FOR UPDATE;

  IF v_studio.id IS NULL OR v_studio.ephemeral IS DISTINCT FROM true THEN
    RETURN 0;
  END IF;
  IF v_studio.lease IS NOT NULL THEN
    -- Re-leased between the release's clear and this repoint (a regrant
    -- under the row lock) — the sessions belong exactly where they are.
    RETURN 0;
  END IF;

  v_seen := array_append(v_seen, p_studio_id);
  v_parent := v_studio.parent_studio_id;
  WHILE v_parent IS NOT NULL AND NOT (v_parent = ANY(v_seen)) LOOP
    v_seen := array_append(v_seen, v_parent);
    SELECT id, ephemeral, parent_studio_id, status
      INTO v_row
      FROM public.studios
      WHERE id = v_parent AND user_id = p_user_id;
    EXIT WHEN v_row.id IS NULL;
    IF v_row.ephemeral IS DISTINCT FROM true AND v_row.status IS DISTINCT FROM 'cleaned' THEN
      v_ancestor := v_row.id;
      EXIT;
    END IF;
    v_parent := v_row.parent_studio_id;
  END LOOP;

  UPDATE public.sessions
  SET studio_id = v_ancestor
  WHERE user_id = p_user_id AND studio_id = p_studio_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.repoint_sessions_off_ephemeral(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.repoint_sessions_off_ephemeral(uuid, uuid) FROM anon, authenticated;
