-- Add studio_id to sessions while keeping workspace_id for backward compatibility.
--
-- Why:
-- - "workspace" now refers to product-level containers (personal/team).
-- - Existing session scoping field workspace_id actually represents a git worktree studio.
--
-- Compatibility goals:
-- - New server versions read/write studio_id.
-- - Older server versions still writing workspace_id continue to work.
-- - Both columns are kept synchronized via trigger.

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS studio_id UUID REFERENCES workspaces(id) ON DELETE SET NULL;

-- Backfill existing data in both directions for safety.
UPDATE sessions
SET studio_id = workspace_id
WHERE studio_id IS NULL
  AND workspace_id IS NOT NULL;

UPDATE sessions
SET workspace_id = studio_id
WHERE workspace_id IS NULL
  AND studio_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sessions_studio_id ON sessions(studio_id);
CREATE INDEX IF NOT EXISTS idx_sessions_active_studio_lookup
  ON sessions(user_id, agent_id, studio_id)
  WHERE ended_at IS NULL;

CREATE OR REPLACE FUNCTION sync_sessions_studio_workspace_ids()
RETURNS TRIGGER AS $$
BEGIN
  -- Old writers set workspace_id only.
  IF NEW.studio_id IS NULL AND NEW.workspace_id IS NOT NULL THEN
    NEW.studio_id := NEW.workspace_id;

  -- New writers set studio_id only.
  ELSIF NEW.workspace_id IS NULL AND NEW.studio_id IS NOT NULL THEN
    NEW.workspace_id := NEW.studio_id;

  -- Divergence safety: studio_id is the source of truth.
  ELSIF NEW.studio_id IS NOT NULL
    AND NEW.workspace_id IS NOT NULL
    AND NEW.studio_id <> NEW.workspace_id THEN
    NEW.workspace_id := NEW.studio_id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS sync_sessions_studio_workspace_ids_trigger ON sessions;
CREATE TRIGGER sync_sessions_studio_workspace_ids_trigger
  BEFORE INSERT OR UPDATE ON sessions
  FOR EACH ROW
  EXECUTE FUNCTION sync_sessions_studio_workspace_ids();
