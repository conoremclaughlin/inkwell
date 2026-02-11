-- Add updated_at to sessions table for consistency with all other tables.
-- The sessions table was the only table missing this column, causing
-- the updateSession() repository method to fail against PostgREST.

ALTER TABLE sessions ADD COLUMN updated_at TIMESTAMPTZ DEFAULT NOW();

-- Backfill: set updated_at to started_at for existing rows
UPDATE sessions SET updated_at = COALESCE(ended_at, started_at, NOW());

-- Apply the same auto-update trigger used by all other tables
CREATE TRIGGER update_sessions_updated_at
  BEFORE UPDATE ON sessions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
