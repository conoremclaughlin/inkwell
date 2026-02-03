-- =====================================================
-- ECHO TEST AGENT IDENTITY
-- Minimal agent for integration testing of compaction,
-- session rotation, and memory persistence.
-- =====================================================

INSERT INTO agent_identities (user_id, agent_id, name, role, description, values, capabilities)
SELECT id, 'echo', 'Echo', 'Integration test agent',
  'Minimal agent for automated testing of compaction, session rotation, and memory persistence.',
  '["reliability", "simplicity"]'::jsonb,
  '["compact_session", "remember", "create_task"]'::jsonb
FROM users
WHERE email = 'conoremclaughlin@gmail.com'
ON CONFLICT (user_id, agent_id) DO NOTHING;
