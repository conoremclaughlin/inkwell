-- Stop tombstone for marker reclaims (Lumen, PR #563 round 9).
--
-- The pending-takeover reclaim raced the stop event: plugin reads marker →
-- claim RPC parked → stop deletes the marker and writes idle → the claim
-- lands afterward and re-marks a FINISHED turn as running under a fresh
-- epoch. Client-side ordering cannot close this; the revocation has to be
-- CASed with the claim in one statement.
--
-- sessions.cli_turn_stopped_at records the last CLI stop (written by the
-- stop path's column-only update). A RECLAIM passes the marker's birth time
-- as p_not_stopped_after: if a stop landed after the marker was written, the
-- claim matches zero rows — atomically, however the plugin/stop interleave.
-- Ordinary prompt claims pass NULL and are unconditional as before.

ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS cli_turn_stopped_at timestamptz;

CREATE OR REPLACE FUNCTION public.claim_turn_epoch(
  p_session_id uuid,
  p_set_running boolean DEFAULT false,
  p_not_stopped_after timestamptz DEFAULT NULL
)
RETURNS text
LANGUAGE sql
AS $$
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
  RETURNING turn_epoch;
$$;

REVOKE ALL ON FUNCTION public.claim_turn_epoch(uuid, boolean, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_turn_epoch(uuid, boolean, timestamptz) FROM anon, authenticated;
DROP FUNCTION IF EXISTS public.claim_turn_epoch(uuid, boolean);
