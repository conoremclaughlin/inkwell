-- Migration: Replace per-message status-based unread tracking with pointer-based
-- tracking for agent_inbox. Mirrors the inbox_thread_read_status pattern.
--
-- Instead of flipping N rows from 'unread' → 'read', a single (user_id, agent_id)
-- row stores last_read_at. Messages with created_at > last_read_at are unread.

CREATE TABLE IF NOT EXISTS agent_inbox_read_status (
  user_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_id   TEXT        NOT NULL,
  last_read_at TIMESTAMPTZ NOT NULL DEFAULT '1970-01-01T00:00:00Z',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, agent_id)
);

-- Trigger for updated_at
CREATE TRIGGER update_agent_inbox_read_status_updated_at
  BEFORE UPDATE ON agent_inbox_read_status
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- Enable RLS (service role bypasses)
ALTER TABLE agent_inbox_read_status ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_full_access" ON agent_inbox_read_status
  FOR ALL USING (true) WITH CHECK (true);

-- Seed from current state: for each (user, agent), set the pointer to the
-- created_at of their most recently read/acknowledged/completed message.
-- Messages created after this timestamp remain unread.
INSERT INTO agent_inbox_read_status (user_id, agent_id, last_read_at)
SELECT
  recipient_user_id,
  recipient_agent_id,
  MAX(created_at)
FROM agent_inbox
WHERE status IN ('read', 'acknowledged', 'completed')
GROUP BY recipient_user_id, recipient_agent_id
ON CONFLICT (user_id, agent_id) DO NOTHING;

-- Index for fast lookups
CREATE INDEX IF NOT EXISTS idx_agent_inbox_read_status_user
  ON agent_inbox_read_status (user_id);

-- Index on agent_inbox for the pointer-based count query:
-- COUNT(*) WHERE recipient_user_id = ? AND recipient_agent_id = ? AND created_at > ?
CREATE INDEX IF NOT EXISTS idx_agent_inbox_recipient_created
  ON agent_inbox (recipient_user_id, recipient_agent_id, created_at DESC);
