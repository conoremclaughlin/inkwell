-- Session Lifecycle / Phase Split
--
-- Adds a `lifecycle` column to track runtime state (running, idle, completed, failed)
-- separately from `current_phase` (agent-set work semantics like implementing, reviewing, etc.).
--
-- The old `status` column is deprecated but kept for backward compat.
-- The `runtime:*` prefix hack in `current_phase` is cleaned up.

-- 1. Add lifecycle column (new code writes it, old code ignores it)
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS lifecycle text DEFAULT 'idle';

-- 2. Backfill lifecycle from existing data
UPDATE sessions SET lifecycle = CASE
  WHEN ended_at IS NOT NULL THEN 'completed'
  WHEN current_phase = 'runtime:generating' THEN 'running'
  WHEN current_phase = 'runtime:idle' THEN 'idle'
  WHEN status = 'failed' THEN 'failed'
  ELSE 'idle'
END;

-- 3. Strip runtime: prefix from current_phase (now tracked via lifecycle)
UPDATE sessions SET current_phase = NULL
WHERE current_phase IN ('runtime:generating', 'runtime:idle');

-- 4. Indexes for lifecycle queries
CREATE INDEX IF NOT EXISTS idx_sessions_lifecycle ON sessions (lifecycle);
CREATE INDEX IF NOT EXISTS idx_sessions_agent_lifecycle ON sessions (agent_id, lifecycle);

-- 5. Document columns
COMMENT ON COLUMN sessions.lifecycle IS 'Runtime state: running, idle, completed, failed';
COMMENT ON COLUMN sessions.status IS '[Deprecated] Replaced by lifecycle column';
