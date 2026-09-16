-- A session entering `running` sheds its interruption breadcrumbs.
--
-- Why a trigger and not application code: sessions are written through at
-- least two independent paths (SessionRepository.update for server-spawned
-- turns, memory.updateSession for the CLI lifecycle hooks), and both rebuild
-- the metadata JSONB from a read snapshot — so an application-level clear can
-- be silently resurrected by a concurrent read-modify-write replaying a stale
-- blob. The database is the one writer-independent place where the invariant
-- "a running session is not interrupted" cannot be bypassed or raced.
--
-- The breadcrumbs (metadata.interruptedAt / metadata.interruptedReason) are
-- written by the shutdown interrupter (interrupt-active-runs.ts) alongside
-- lifecycle 'interrupted' (turn killed mid-flight) or 'idle' with reason
-- 'server-shutdown-after-turn' (turn finished, terminal write lost). Any
-- writer moving the row back to 'running' — the next server-spawned turn's
-- pre-turn write, or a CLI on-prompt hook — is the resume; the breadcrumbs
-- describe a state that no longer holds.

CREATE OR REPLACE FUNCTION public.strip_interruption_on_running()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.metadata := (COALESCE(NEW.metadata, '{}'::jsonb) - 'interruptedAt') - 'interruptedReason';
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS strip_interruption_on_running ON public.sessions;

-- The WHEN clause keeps the function call off the hot path: it fires only
-- when a row is being written as running while still carrying a breadcrumb.
CREATE TRIGGER strip_interruption_on_running
  BEFORE INSERT OR UPDATE ON public.sessions
  FOR EACH ROW
  WHEN (
    NEW.lifecycle = 'running'
    AND (NEW.metadata ? 'interruptedAt' OR NEW.metadata ? 'interruptedReason')
  )
  EXECUTE FUNCTION public.strip_interruption_on_running();

-- Consistent with the repo-wide ACL posture for internal functions: trigger
-- functions are invoked by the trigger as the table owner, never directly.
REVOKE ALL ON FUNCTION public.strip_interruption_on_running() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.strip_interruption_on_running() FROM anon, authenticated;
