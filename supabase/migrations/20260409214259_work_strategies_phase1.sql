-- Work Strategies Phase 1: Persistence strategy support
-- Adds strategy columns to task_groups and task ordering to tasks.
-- See ink://specs/work-strategies v4 for full design.

-- ============================================================================
-- task_groups: strategy columns
-- ============================================================================

-- Strategy preset name (persistence, review, architect, parallel, swarm)
ALTER TABLE task_groups ADD COLUMN IF NOT EXISTS strategy text;

-- Strategy-specific configuration (planUri, checkInInterval, notifications, etc.)
ALTER TABLE task_groups ADD COLUMN IF NOT EXISTS strategy_config jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Verification mode: how task completion is validated
ALTER TABLE task_groups ADD COLUMN IF NOT EXISTS verification_mode text NOT NULL DEFAULT 'self';

-- Link to the spec/plan artifact that defines the full plan
ALTER TABLE task_groups ADD COLUMN IF NOT EXISTS plan_uri text;

-- Index of the current task being worked (0-based)
ALTER TABLE task_groups ADD COLUMN IF NOT EXISTS current_task_index integer NOT NULL DEFAULT 0;

-- Counter for approval gates: how many tasks completed since last human approval
ALTER TABLE task_groups ADD COLUMN IF NOT EXISTS iterations_since_approval integer NOT NULL DEFAULT 0;

-- Timestamps for strategy lifecycle
ALTER TABLE task_groups ADD COLUMN IF NOT EXISTS strategy_started_at timestamptz;
ALTER TABLE task_groups ADD COLUMN IF NOT EXISTS strategy_paused_at timestamptz;

-- Owner agent: which SB is executing this strategy
ALTER TABLE task_groups ADD COLUMN IF NOT EXISTS owner_agent_id text;

-- ============================================================================
-- tasks: ordering within groups
-- ============================================================================

-- Task order within a group (nullable for standalone tasks)
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS task_order integer;

-- Index for efficient ordered queries within a group
CREATE INDEX IF NOT EXISTS idx_tasks_group_order ON tasks (task_group_id, task_order)
  WHERE task_group_id IS NOT NULL;

-- Index for finding active strategies
CREATE INDEX IF NOT EXISTS idx_task_groups_active_strategy ON task_groups (strategy, status)
  WHERE strategy IS NOT NULL AND status = 'active';

-- Index for owner agent lookup
CREATE INDEX IF NOT EXISTS idx_task_groups_owner_agent ON task_groups (owner_agent_id, status)
  WHERE owner_agent_id IS NOT NULL;

-- ============================================================================
-- Comments
-- ============================================================================
-- strategy_config JSONB shape (persistence preset):
-- {
--   "planUri": "ink://specs/oauth-pkce",           -- artifact URI for the plan
--   "checkInInterval": 3,                           -- post progress every N tasks
--   "checkInNotify": "myra",                        -- agent to notify on check-ins
--   "approvalNotify": "myra",                       -- agent to notify on approval gates
--   "maxIterationsWithoutApproval": 10,              -- pause after N tasks without human OK
--   "contextSummaryInterval": 5,                     -- compact context every N tasks
--   "verificationGates": ["tests", "build"]          -- what must pass before advancing
-- }
