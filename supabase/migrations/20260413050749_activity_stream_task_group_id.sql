-- Add task_group_id to activity_stream for strategy event correlation.
-- Enables joining strategy events, watchdog fires, and task completions
-- back to their task group for the strategy execution dashboard.

ALTER TABLE activity_stream ADD COLUMN IF NOT EXISTS task_group_id uuid
  REFERENCES task_groups(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_activity_stream_task_group
  ON activity_stream (task_group_id)
  WHERE task_group_id IS NOT NULL;
