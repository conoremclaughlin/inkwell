-- A session's turn scope: 'space-turn' for a session that runs turns in a
-- shared conversation (ink://specs/inkling-multi-person-groups, Phase 2
-- gate 1). The MCP server refuses to authenticate a request by such a
-- session's context alone.
--
-- Set only at insert. Nothing sets it yet; the turn wiring will. No server
-- update path can carry it (session-turn-scope-writes.test.ts pins that).
-- Immutability is enforced in server code only: DB-level immutability needs
-- a trigger, and triggers are discussed with Conor before they are written
-- (Oct 4 rule), so a service-role or raw SQL write could still change it.

ALTER TABLE public.sessions
  ADD COLUMN IF NOT EXISTS turn_scope text
  CONSTRAINT sessions_turn_scope_check CHECK (turn_scope IS NULL OR turn_scope = 'space-turn');
