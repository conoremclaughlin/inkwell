-- Relax UNIQUE(worktree_path) to UNIQUE(worktree_path, agent_id).
--
-- The old single-column constraint prevents multiple agents from having
-- their own studio row for the same root repo (e.g., wren + lumen both
-- working in ~/ws/pcp).  The new composite index keeps one-studio-per-
-- agent-per-path while allowing per-agent rows.

ALTER TABLE studios DROP CONSTRAINT IF EXISTS studios_worktree_path_key;
DROP INDEX IF EXISTS studios_worktree_path_key;

CREATE UNIQUE INDEX studios_worktree_path_agent_key
  ON studios (worktree_path, agent_id)
  WHERE agent_id IS NOT NULL;
