-- MCP access tokens are now self-issued JWTs signed with JWT_SECRET.
-- The supabase_refresh_token column is no longer needed for new tokens.
-- Make it nullable so existing tokens continue to work during transition.
ALTER TABLE mcp_tokens ALTER COLUMN supabase_refresh_token DROP NOT NULL;
