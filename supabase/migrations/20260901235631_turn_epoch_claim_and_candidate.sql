-- Turn epoch v2: candidate-authoritative, with an explicit claim primitive
-- (Lumen, PR #563 round 4).
--
-- v1 rotated the epoch on every ENTRY into running and overrode caller
-- candidates. Two failures fell out of that:
--
--   1. A committed-but-rejected `running` write was unrecoverable: the caller
--      could not recognise the rotated epoch as its own, so "did my write
--      land?" had no answer and the catch path rolled back a takeover that
--      had actually happened.
--   2. A CLI prompt taking over a session whose row is STUCK at `running`
--      (the previous owner never finalized) is a running → running write —
--      no entry, no rotation, and the stale owner's fenced finalize still
--      matched, clobbering the CLI's session.
--
-- v2 rules:
--   * Callers that take ownership WRITE their own candidate epoch. The
--     trigger never overrides a provided value, so a retry of the same write
--     is idempotent and "did it land?" is answered by reading the row and
--     comparing to the candidate.
--   * The trigger fills an epoch only when a session enters running with none
--     present (legacy writers), and still strips interruption breadcrumbs on
--     every running write.
--   * claim_turn_epoch(session_id) is the takeover primitive for paths that
--     cannot carry metadata through their write (the CLI lifecycle hooks'
--     column-only update): one atomic jsonb_set, no read-modify-write replay
--     window, returning the new epoch.

CREATE OR REPLACE FUNCTION public.handle_session_running_write()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- A running session is not interrupted.
  NEW.metadata := (COALESCE(NEW.metadata, '{}'::jsonb) - 'interruptedAt') - 'interruptedReason';

  -- Fill an epoch only when entering running WITHOUT one. A provided value is
  -- the caller's ownership candidate and is never overridden.
  IF (TG_OP = 'INSERT' OR OLD.lifecycle IS DISTINCT FROM 'running')
     AND NEW.metadata ->> 'turnEpoch' IS NULL THEN
    NEW.metadata := jsonb_set(NEW.metadata, '{turnEpoch}', to_jsonb(gen_random_uuid()::text), true);
  END IF;

  RETURN NEW;
END;
$$;

-- Atomic ownership takeover for column-only writers (CLI lifecycle hooks).
-- Single statement — no read-modify-write, no replay window.
CREATE OR REPLACE FUNCTION public.claim_turn_epoch(p_session_id uuid)
RETURNS text
LANGUAGE sql
AS $$
  UPDATE public.sessions
  SET metadata = jsonb_set(
    COALESCE(metadata, '{}'::jsonb),
    '{turnEpoch}',
    to_jsonb(gen_random_uuid()::text),
    true
  )
  WHERE id = p_session_id
  RETURNING metadata ->> 'turnEpoch';
$$;

REVOKE ALL ON FUNCTION public.handle_session_running_write() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.handle_session_running_write() FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_turn_epoch(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_turn_epoch(uuid) FROM anon, authenticated;
