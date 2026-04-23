-- Channel Routes: active session tracking
--
-- Adds active_session_id to channel_routes so we can see exactly which
-- PCP session is currently handling messages for a given route.
-- Updated when a session is created or reused for a channel message;
-- cleared when the session ends.

ALTER TABLE channel_routes
  ADD COLUMN IF NOT EXISTS active_session_id uuid REFERENCES sessions(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_channel_routes_active_session
  ON channel_routes (active_session_id)
  WHERE active_session_id IS NOT NULL;
