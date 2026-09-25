-- Seed data for development and testing

-- Insert test user
INSERT INTO users (id, email, username, first_name, last_name, telegram_id, preferences)
VALUES
  ('550e8400-e29b-41d4-a716-446655440000', 'test@example.com', 'testuser', 'Test', 'User', 123456789, '{"theme": "dark", "notifications": true}')
ON CONFLICT (id) DO NOTHING;

-- Insert canonical integration-test agent identity fixture, in the fixture
-- user's personal workspace (provisioned by the users AFTER INSERT trigger
-- above; spec inkmail-thread-scope §1, §3 — a thread principal is an
-- identity in exactly one workspace).
INSERT INTO agent_identities (
  user_id,
  workspace_id,
  agent_id,
  name,
  role,
  description,
  "values",
  relationships,
  capabilities,
  metadata,
  backend
)
VALUES (
  '550e8400-e29b-41d4-a716-446655440000',
  (SELECT id FROM workspaces
    WHERE user_id = '550e8400-e29b-41d4-a716-446655440000'
      AND type = 'personal' AND slug = 'personal' AND archived_at IS NULL
    LIMIT 1),
  'echo',
  'Echo',
  'Integration test fixture agent',
  'Fixture identity used by integration tests',
  '[]'::jsonb,
  '{}'::jsonb,
  '[]'::jsonb,
  '{"fixture": true}'::jsonb,
  'claude'
)
ON CONFLICT DO NOTHING;

-- Insert sample links
INSERT INTO links (user_id, url, title, description, tags, source)
VALUES
  ('550e8400-e29b-41d4-a716-446655440000', 'https://modelcontextprotocol.io', 'Model Context Protocol', 'Official MCP documentation', ARRAY['mcp', 'documentation'], 'api'),
  ('550e8400-e29b-41d4-a716-446655440000', 'https://supabase.com', 'Supabase', 'Open source Firebase alternative', ARRAY['database', 'backend'], 'telegram')
ON CONFLICT DO NOTHING;

-- Insert sample notes
INSERT INTO notes (user_id, title, content, tags)
VALUES
  ('550e8400-e29b-41d4-a716-446655440000', 'Project Ideas', 'Build a personal context protocol that integrates with multiple messaging platforms', ARRAY['ideas', 'projects']),
  ('550e8400-e29b-41d4-a716-446655440000', 'Meeting Notes', 'Discussed the architecture for the MCP server implementation', ARRAY['meetings', 'work'])
ON CONFLICT DO NOTHING;

-- Insert sample tasks (unified table — project_id nullable, no due_date required)
INSERT INTO tasks (user_id, title, description, status, priority, tags)
VALUES
  ('550e8400-e29b-41d4-a716-446655440000', 'Implement MCP server', 'Create the core MCP server with all tools', 'in_progress', 'high', ARRAY['development']),
  ('550e8400-e29b-41d4-a716-446655440000', 'Set up Telegram bot', 'Configure Telegram bot with basic commands', 'pending', 'medium', ARRAY['development', 'telegram'])
ON CONFLICT DO NOTHING;
