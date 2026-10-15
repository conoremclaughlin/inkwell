-- sessions.turn_scope is set at insert only: the database refuses any later
-- change (ink://specs/inkling-multi-person-groups, Phase 2 gate 1).
--
-- The column marks a session that runs turns in a shared conversation, and
-- the MCP server refuses to authenticate a request by such a session's
-- context alone. Server code never writes the column after insert
-- (session-turn-scope-writes.test.ts pins every api update path). This
-- trigger is the floor under that test: it also covers what the test can't
-- see, such as scripts, later migrations, raw SQL and service-role writes
-- outside the scanned source. An update that marks, unmarks or changes the
-- value fails and its whole statement rolls back. INSERT and DELETE are
-- unaffected, and the existing CHECK still limits the value.
--
-- AFTER, with WHEN: it judges the final row, after every BEFORE trigger on
-- sessions, and the function runs only when the value actually changes.
-- Not a definer, not callable as an RPC, reads no table.
--
-- Approved by Conor on Oct 15, 2026 as defense in depth, which clears his
-- Oct 4 rule for this one trigger and function.
--
-- Rollback:
--   DROP TRIGGER session_turn_scope_immutable ON public.sessions;
--   DROP FUNCTION public.refuse_session_turn_scope_change();

CREATE OR REPLACE FUNCTION public.refuse_session_turn_scope_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'sessions.turn_scope is set at insert only'
    USING ERRCODE = '23514';
END;
$$;

REVOKE ALL ON FUNCTION public.refuse_session_turn_scope_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.refuse_session_turn_scope_change() FROM anon, authenticated;

DROP TRIGGER IF EXISTS session_turn_scope_immutable ON public.sessions;
CREATE TRIGGER session_turn_scope_immutable
  AFTER UPDATE ON public.sessions
  FOR EACH ROW
  WHEN (OLD.turn_scope IS DISTINCT FROM NEW.turn_scope)
  EXECUTE FUNCTION public.refuse_session_turn_scope_change();
