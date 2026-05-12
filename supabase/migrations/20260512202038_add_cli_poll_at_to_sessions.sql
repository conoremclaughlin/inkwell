-- Add cli_poll_at timestamp to sessions for connection-based attachment detection.
-- The channel plugin stamps this on every poll cycle (~10s). The trigger handler
-- considers a session "attached" if cli_poll_at is within the last 30s, replacing
-- the sticky cli_attached boolean for plugin-equipped backends.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS cli_poll_at timestamptz;
