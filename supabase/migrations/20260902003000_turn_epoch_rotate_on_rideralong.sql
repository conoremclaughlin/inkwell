-- Turn epoch v4 (Lumen, PR #563 round 6 P2).
--
-- A REUSED idle row retains its previous turn's epoch in the column. A
-- lifecycle-only entering-running write (no epoch named) therefore arrives
-- with NEW.turn_epoch = OLD.turn_epoch — non-null — and the fill-if-absent
-- rule from v3 left the STALE epoch in place: the previous turn's fenced
-- writes would still match a row a brand-new turn owns.
--
-- The distinction that matters is not null-ness but PROVENANCE: did the
-- entering write NAME a new epoch, or did the old value merely ride along?
-- On UPDATE, a caller-provided candidate differs from OLD (candidates are
-- fresh uuids); a ride-along equals OLD. So: rotate when entering running
-- unless the write carries an epoch DISTINCT from the previous value.

CREATE OR REPLACE FUNCTION public.handle_session_running_write()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- A running session is not interrupted.
  NEW.metadata := (COALESCE(NEW.metadata, '{}'::jsonb) - 'interruptedAt') - 'interruptedReason';

  IF TG_OP = 'INSERT' THEN
    -- Born running: a provided epoch is a candidate and stands; otherwise mint.
    IF NEW.turn_epoch IS NULL THEN
      NEW.turn_epoch := gen_random_uuid()::text;
    END IF;
  ELSIF OLD.lifecycle IS DISTINCT FROM 'running' THEN
    -- Entering running: rotate unless the write names a NEW epoch. A value
    -- equal to OLD is a ride-along from the reused row, not a claim.
    IF NEW.turn_epoch IS NULL OR NEW.turn_epoch IS NOT DISTINCT FROM OLD.turn_epoch THEN
      NEW.turn_epoch := gen_random_uuid()::text;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
