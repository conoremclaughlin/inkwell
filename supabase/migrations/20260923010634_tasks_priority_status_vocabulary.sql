-- Close the gap that crashed the tasks dashboard.
--
-- `tasks.priority` and `tasks.status` are varchars with a default and no CHECK,
-- so the column accepts any string. Two rows written on 2026-05-13 carry
-- priority 'normal' — a value from the OTHER vocabulary in this codebase
-- (`low|normal|high|urgent`, used by inbox messages, triggers and task GROUPS,
-- whose column default is literally 'normal'). The tasks vocabulary is
-- `low|medium|high|critical`. The dashboard indexed its style map directly, so
-- the lookup returned undefined and the page died on `config.bgColor`.
--
-- The UI is fixed separately and no longer depends on the data being clean
-- (see packages/web/src/app/(dashboard)/tasks/task-display.ts) — an unknown
-- value now renders in a neutral badge. This migration is the other half: stop
-- the column from holding values the application has no meaning for.
--
-- Measured before writing, over 689 rows:
--   priority: medium 319, high 309, low 49, critical 10, normal 2
--   status:   pending 398, completed 252, in_progress 24, blocked 15
-- So status is already clean and only the two priority rows need moving.

BEGIN;

-- 'normal' is the neighbouring vocabulary's midpoint, and 'medium' is this
-- one's — and is also the column default, so these two rows end up saying what
-- every task that never chose a priority says. Scoped to the exact value
-- rather than "anything invalid": a future unexpected value is a thing to look
-- at, not something to silently fold into the default.
UPDATE tasks SET priority = 'medium' WHERE priority = 'normal';

-- NULL stays permitted: the column is nullable today and the API treats a
-- missing priority as the default. Constraining that at the same time would be
-- a second, unrelated change to every writer.
ALTER TABLE tasks
  ADD CONSTRAINT tasks_priority_check
  CHECK (priority IS NULL OR priority IN ('low', 'medium', 'high', 'critical'));

ALTER TABLE tasks
  ADD CONSTRAINT tasks_status_check
  CHECK (status IN ('pending', 'in_progress', 'completed', 'blocked'));

COMMIT;

-- Why a constraint and not just the data fix: `add_graph_nodes` writes
-- `coalesce(n ->> 'priority', 'medium')` straight from caller-supplied JSON
-- into tasks.priority with no vocabulary check. Its only caller today passes
-- in-repo templates typed `NodePriority = 'low'|'medium'|'high'|'critical'`,
-- so nothing reaches it with a bad value right now — but the validation lives
-- in TypeScript while the write happens in plpgsql, and that is exactly the
-- seam the two 2026-05-13 rows came through. A CHECK covers every writer,
-- including ones added later in a language nobody greps.
