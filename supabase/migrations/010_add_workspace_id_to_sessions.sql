-- Add workspace_id to sessions for workspace-scoped session tracking.
-- Allows multiple active sessions per agent (one per workspace).

ALTER TABLE sessions ADD COLUMN workspace_id UUID REFERENCES workspaces(id) ON DELETE SET NULL;

-- Index for workspace-filtered queries
CREATE INDEX idx_sessions_workspace_id ON sessions(workspace_id);

-- Composite index for the most common lookup: "find active session for this agent in this workspace"
CREATE INDEX idx_sessions_active_lookup ON sessions(user_id, agent_id, workspace_id) WHERE ended_at IS NULL;
