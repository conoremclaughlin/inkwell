-- Add repo_root to projects for local filesystem path resolution.
-- Nullable because not all projects are coding projects.
-- Used by start_strategy to resolve where to spawn autonomous sessions.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS repo_root text;
