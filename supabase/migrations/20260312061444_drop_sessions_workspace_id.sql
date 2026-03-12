-- Drop the legacy sessions.workspace_id column.
--
-- This column was the original FK before the `workspaces → studios` rename.
-- After the rename, `studio_id` became the canonical column (same FK target),
-- and `workspace_id` was kept temporarily for backward compatibility via
-- dual-writes. All code now reads `studio_id` exclusively.
--
-- The column name was also dangerously misleading: it FK'd to `studios`,
-- not the current `workspaces` table (renamed from `workspace_containers`).

-- 1. Drop the standalone index on workspace_id
DROP INDEX IF EXISTS idx_sessions_workspace_id;

-- 2. Drop the composite active-lookup index that includes workspace_id
DROP INDEX IF EXISTS idx_sessions_active_lookup;

-- 3. Drop the FK constraint
ALTER TABLE public.sessions DROP CONSTRAINT IF EXISTS sessions_workspace_id_fkey;

-- 4. Drop the column
ALTER TABLE public.sessions DROP COLUMN IF EXISTS workspace_id;

-- 5. Recreate the active-lookup index with studio_id instead of workspace_id
CREATE INDEX idx_sessions_active_lookup
  ON public.sessions (user_id, agent_id, studio_id)
  WHERE ended_at IS NULL;
