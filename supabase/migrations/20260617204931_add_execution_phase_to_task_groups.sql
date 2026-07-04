-- Add execution_phase to task_groups for strategy execution visibility.
-- Tracks whether a strategy has actually started executing vs just being activated.
--
-- Values:
--   idle            — no strategy active (default)
--   pending_trigger — strategy activated, trigger sent, waiting for session spawn
--   worker_active   — a session is actively working tasks
--   paused          — strategy paused (by user or approval gate)
--   completed       — all tasks done, strategy finalized

ALTER TABLE task_groups
  ADD COLUMN execution_phase text NOT NULL DEFAULT 'idle';

-- Partial index for finding groups awaiting execution
CREATE INDEX idx_task_groups_execution_phase
  ON task_groups (execution_phase)
  WHERE execution_phase IN ('pending_trigger', 'worker_active');
