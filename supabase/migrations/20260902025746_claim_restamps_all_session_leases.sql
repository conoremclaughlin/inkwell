-- The claim restamps EVERY lease the session holds (Lumen, PR #563 round 13).
--
-- Round 12 stamped only the NAMED studio inside the atomic claim and left an
-- application-level renewBySession(..., epoch) to restamp any other studios
-- the session held. That follow-up was a rewind hazard: a DELAYED turn A's
-- renewal, landing after successor B's claim, read B's same-session lease
-- and restamped it back to A — session epoch B, lease epoch A, and neither
-- turn's fenced stop could release it.
--
-- Ownership is session-level (one turn per session), so the claim now stamps
-- ALL of the session's non-quarantined leases in the same transaction. The
-- application-level restamp is deleted outright — renewals and touches are
-- pure heartbeats again, and a stale turn's renewal can no longer change any
-- lease's generation.

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

  -- Every lease this session holds now carries the fresh generation — the
  -- named studio (verified above, still under its row lock) and any other
  -- studios the session multiplexes. Quarantined records heal through
  -- rescue, never through a claim.
  UPDATE public.studios
  SET lease = lease || jsonb_build_object(
        'heartbeatAt', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'turnEpoch', v_epoch
      )
  WHERE lease IS NOT NULL
    AND lease->>'sessionId' = p_session_id::text
    AND COALESCE((lease->>'quarantined')::boolean, false) = false;

  RETURN jsonb_build_object('outcome', 'claimed', 'epoch', v_epoch);
END;
$$;

REVOKE ALL ON FUNCTION public.claim_turn_epoch(uuid, boolean, timestamptz, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_turn_epoch(uuid, boolean, timestamptz, uuid) FROM anon, authenticated;
