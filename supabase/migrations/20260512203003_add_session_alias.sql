-- Add alias column to sessions for human-readable routing.
-- Aliases are per-user+agent slugs (e.g., "main", "review") that
-- provide explicit session targeting without needing UUIDs.
-- Unique per (user_id, agent_id) among active (non-ended) sessions.

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS alias text;

-- Partial unique index: only one active session per alias per user+agent
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_alias_unique
  ON sessions (user_id, agent_id, alias)
  WHERE ended_at IS NULL AND alias IS NOT NULL;

-- Lookup index for routing queries
CREATE INDEX IF NOT EXISTS idx_sessions_alias_lookup
  ON sessions (user_id, agent_id, alias)
  WHERE ended_at IS NULL;
