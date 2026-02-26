-- Add slug column to studios, derived from the worktree folder name.
-- Convention: worktree folders are named <repo>--<slug>, e.g.
--   personal-context-protocol--wren → "wren"
--   personal-context-protocol--lumen--lumen-alpha → "lumen--lumen-alpha"

ALTER TABLE studios ADD COLUMN slug text;

-- Backfill: extract slug from worktree_path for existing rows
UPDATE studios
SET slug = CASE
  WHEN worktree_path IS NOT NULL
       AND position('--' IN split_part(worktree_path, '/', array_length(string_to_array(worktree_path, '/'), 1))) > 0
  THEN substring(
    split_part(worktree_path, '/', array_length(string_to_array(worktree_path, '/'), 1))
    FROM position('--' IN split_part(worktree_path, '/', array_length(string_to_array(worktree_path, '/'), 1))) + 2
  )
  ELSE NULL
END
WHERE worktree_path IS NOT NULL;
