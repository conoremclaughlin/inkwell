-- One atomic success boundary for the CLI takeover (Lumen, PR #563 round 12).
--
-- The round-11 sequence committed the session claim FIRST and only then
-- discovered the lease was gone (studioLeaseHeld:false): blocking producers
-- refused the prompt but the row was already running with an open turn
-- marker and no process behind it, and nonblocking producers ran in a
-- worktree whose lease a predecessor's release had cleared — the marker
-- recovery could renew/touch but never REACQUIRE.
--
-- The claim now takes the studio's row lock FIRST (when the caller names
-- one), verifies the lease still belongs to the session, and only then
-- claims the epoch and stamps the lease — all in one transaction:
--   * lease gone/foreign/quarantined → {"outcome":"lease-lost"}, NOTHING
--     modified: no claim, no marker, no stranded row.
--   * stop tombstone refuses a reclaim → {"outcome":"stopped"}, nothing
--     modified (the studio lock is released untouched).
--   * success → {"outcome":"claimed","epoch":...} — the lease carries the
--     fresh epoch and a heartbeat bump before any concurrent release can
--     re-read it (the FOR UPDATE lock serializes the exact-prior CAS the
--     release path uses: it re-evaluates after we commit and loses on
--     heartbeatAt/turnEpoch).
--
-- Returns jsonb; the previous text-returning signature is dropped.

CREATE OR REPLACE FUNCTION public.claim_turn_epoch(
  p_session_id uuid,
  p_set_running boolean DEFAULT false,
  p_not_stopped_after timestamptz DEFAULT NULL,
  p_studio_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_lease jsonb;
  v_epoch text;
BEGIN
  IF p_studio_id IS NOT NULL THEN
    SELECT lease INTO v_lease
    FROM public.studios
    WHERE id = p_studio_id
    FOR UPDATE;

    IF v_lease IS NULL
       OR v_lease->>'sessionId' IS DISTINCT FROM p_session_id::text
       OR COALESCE((v_lease->>'quarantined')::boolean, false) THEN
      RETURN jsonb_build_object('outcome', 'lease-lost');
    END IF;
  END IF;

  UPDATE public.sessions
  SET turn_epoch = gen_random_uuid()::text,
      lifecycle = CASE WHEN p_set_running THEN 'running' ELSE lifecycle END,
      cli_turn_at = CASE WHEN p_set_running THEN now() ELSE cli_turn_at END
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

  IF p_studio_id IS NOT NULL THEN
    UPDATE public.studios
    SET lease = lease || jsonb_build_object(
          'heartbeatAt', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          'turnEpoch', v_epoch
        )
    WHERE id = p_studio_id;
  END IF;

  RETURN jsonb_build_object('outcome', 'claimed', 'epoch', v_epoch);
END;
$$;

REVOKE ALL ON FUNCTION public.claim_turn_epoch(uuid, boolean, timestamptz, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_turn_epoch(uuid, boolean, timestamptz, uuid) FROM anon, authenticated;
DROP FUNCTION IF EXISTS public.claim_turn_epoch(uuid, boolean, timestamptz);
