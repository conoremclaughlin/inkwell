-- Add backend_session_id as the generic replacement for claude_session_id.
-- The existing backend column already tracks which backend (claude-code, codex, etc).
-- backend_session_id stores the backend-specific session ID for resumption.

ALTER TABLE sessions ADD COLUMN backend_session_id TEXT;

-- Copy existing claude_session_id values to the new column
UPDATE sessions SET backend_session_id = claude_session_id WHERE claude_session_id IS NOT NULL;

-- Index for resume lookups
CREATE INDEX idx_sessions_backend_session_id ON sessions(backend_session_id) WHERE backend_session_id IS NOT NULL;
