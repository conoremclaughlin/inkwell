-- Add active_thread_key to sessions for tracking what artifact/thread
-- a session is currently working on (mutable, unlike thread_key which
-- is the immutable routing anchor set at session creation).

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS active_thread_key text;

CREATE INDEX IF NOT EXISTS idx_sessions_active_thread_key
  ON sessions (user_id, active_thread_key)
  WHERE active_thread_key IS NOT NULL AND ended_at IS NULL;
