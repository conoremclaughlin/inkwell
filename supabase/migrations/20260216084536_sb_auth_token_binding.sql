-- SB Auth: Token-bound identity
-- Binds an OAuth token to a specific agent identity (text label + canonical UUID)

ALTER TABLE mcp_tokens ADD COLUMN IF NOT EXISTS agent_id text;
ALTER TABLE mcp_tokens ADD COLUMN IF NOT EXISTS identity_id uuid REFERENCES agent_identities(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_mcp_tokens_agent_id ON mcp_tokens(agent_id);
CREATE INDEX IF NOT EXISTS idx_mcp_tokens_identity_id ON mcp_tokens(identity_id);
