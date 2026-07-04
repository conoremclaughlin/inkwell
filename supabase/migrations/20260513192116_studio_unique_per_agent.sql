-- Relax single-column unique constraints on studios to composites.
--
-- The old UNIQUE(worktree_path) and UNIQUE(branch) prevent multiple agents
-- from having their own studio row for the same root repo or branch
-- (e.g., wren + lumen both working in ~/ws/pcp on main).
--
-- New composites keep one-studio-per-agent-per-path while allowing
-- per-agent rows, and allow multiple root-repo studios with branch='main'.

-- worktree_path: one studio per agent per filesystem path
ALTER TABLE studios DROP CONSTRAINT IF EXISTS studios_worktree_path_key;
DROP INDEX IF EXISTS studios_worktree_path_key;

CREATE UNIQUE INDEX studios_worktree_path_agent_key
  ON studios (worktree_path, agent_id)
  WHERE agent_id IS NOT NULL;

-- branch: drop the single-column unique. Multiple root-repo studios (one per
-- agent, or one per project) all use branch='main'. The worktree_path+agent_id
-- composite above is the dedup key; branch uniqueness is no longer meaningful.
ALTER TABLE studios DROP CONSTRAINT IF EXISTS studios_branch_key;
DROP INDEX IF EXISTS studios_branch_key;
DROP INDEX IF EXISTS studios_branch_agent_key;
