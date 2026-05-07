-- Thread participant session tracking
--
-- Adds session_id to inbox_thread_participants so the channel plugin
-- can filter threads to those assigned to the current session.
-- Prevents cross-session replay: each agent's threads are scoped to
-- the session that owns them.

ALTER TABLE inbox_thread_participants
  ADD COLUMN IF NOT EXISTS session_id UUID REFERENCES sessions(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_inbox_thread_participants_session
  ON inbox_thread_participants (agent_id, session_id)
  WHERE session_id IS NOT NULL;
