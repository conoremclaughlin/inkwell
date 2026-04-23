-- Add instructions column to task_groups
-- Free-form text injected into every strategy prompt for the group.
-- Keeps environment context (branch, tools, constraints) separate from
-- individual task descriptions.

ALTER TABLE task_groups ADD COLUMN instructions text;

COMMENT ON COLUMN task_groups.instructions IS
  'Free-form instructions injected into every strategy prompt for this group. '
  'Use for environment context, branch info, tool hints, constraints — anything '
  'that applies to ALL tasks in the group rather than a single task.';
