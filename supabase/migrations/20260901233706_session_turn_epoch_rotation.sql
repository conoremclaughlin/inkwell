-- Turn ownership becomes a DB-assigned generation (Lumen, PR #563 round 3).
--
-- The background finalize retry outlives the session processing lock, and an
-- in-process cancellation token is neither a fence nor a durable handoff: a
-- finalize write already in flight can land after a newer turn's `running`
-- write and clobber it, and a client-side staleness read is self-defeating —
-- after a failed finalize the turn's OWN row necessarily still says
-- `running`, so the check classifies the owner as superseded and the retry
-- never fires.
--
-- The fix is a generation stamped by the database itself: every write that
-- moves a session INTO `running` — the server's pre-turn write, a CLI
-- lifecycle hook, any future path — rotates `metadata.turnEpoch`. The
-- finalize write compare-and-sets on the epoch it captured from its own
-- `running` write, so it can only ever land on the row state it owns:
-- a raced newer turn means zero rows matched, never a clobber.
--
-- running → running writes (a CLI session's successive prompts) keep their
-- epoch: same owner, same turn series. Only ENTERING running rotates.
--
-- This subsumes strip_interruption_on_running (20260901224247): the same
-- transition that takes ownership also sheds the interruption breadcrumbs.

CREATE OR REPLACE FUNCTION public.handle_session_running_write()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- A running session is not interrupted.
  NEW.metadata := (COALESCE(NEW.metadata, '{}'::jsonb) - 'interruptedAt') - 'interruptedReason';

  -- Entering running takes ownership: rotate the turn epoch. This overrides
  -- any caller-supplied candidate — the DB value returned by the write is
  -- authoritative, and callers capture it from there.
  IF TG_OP = 'INSERT' OR OLD.lifecycle IS DISTINCT FROM 'running' THEN
    NEW.metadata := jsonb_set(NEW.metadata, '{turnEpoch}', to_jsonb(gen_random_uuid()::text), true);
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS strip_interruption_on_running ON public.sessions;
DROP FUNCTION IF EXISTS public.strip_interruption_on_running();

DROP TRIGGER IF EXISTS session_running_write ON public.sessions;

CREATE TRIGGER session_running_write
  BEFORE INSERT OR UPDATE ON public.sessions
  FOR EACH ROW
  WHEN (NEW.lifecycle = 'running')
  EXECUTE FUNCTION public.handle_session_running_write();

REVOKE ALL ON FUNCTION public.handle_session_running_write() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.handle_session_running_write() FROM anon, authenticated;
