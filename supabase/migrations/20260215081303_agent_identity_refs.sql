-- =====================================================================
-- Agent Identity Refs: canonical UUID references across all tables
-- =====================================================================
-- Drops redundant text columns on artifacts (UUID FKs already exist),
-- adds identity_id FK to sessions, activity_stream, memories,
-- workspaces, and agent_inbox, with backfill from agent_identities.
-- =====================================================================

-- =====================================================================
-- Part A: Drop redundant text columns (already have UUID FKs)
-- =====================================================================

ALTER TABLE artifacts DROP COLUMN IF EXISTS created_by_agent_id;
ALTER TABLE artifact_history DROP COLUMN IF EXISTS changed_by_agent_id;

-- =====================================================================
-- Part B: Add identity_id FK to sessions
-- =====================================================================

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS identity_id uuid;
ALTER TABLE sessions ADD CONSTRAINT sessions_identity_id_fkey
  FOREIGN KEY (identity_id) REFERENCES agent_identities(id) ON DELETE SET NULL;

UPDATE sessions s SET identity_id = ai.id
FROM agent_identities ai
WHERE s.agent_id IS NOT NULL AND s.identity_id IS NULL
  AND ai.user_id = s.user_id AND ai.agent_id = s.agent_id;

-- =====================================================================
-- Part C: Add identity_id FK to activity_stream
-- =====================================================================

ALTER TABLE activity_stream ADD COLUMN IF NOT EXISTS identity_id uuid;
ALTER TABLE activity_stream ADD CONSTRAINT activity_stream_identity_id_fkey
  FOREIGN KEY (identity_id) REFERENCES agent_identities(id) ON DELETE SET NULL;

UPDATE activity_stream a SET identity_id = ai.id
FROM agent_identities ai
WHERE a.agent_id IS NOT NULL AND a.identity_id IS NULL
  AND ai.user_id = a.user_id AND ai.agent_id = a.agent_id;

-- =====================================================================
-- Part D: Add identity_id FK to memories
-- =====================================================================

ALTER TABLE memories ADD COLUMN IF NOT EXISTS identity_id uuid;
ALTER TABLE memories ADD CONSTRAINT memories_identity_id_fkey
  FOREIGN KEY (identity_id) REFERENCES agent_identities(id) ON DELETE SET NULL;

UPDATE memories m SET identity_id = ai.id
FROM agent_identities ai
WHERE m.agent_id IS NOT NULL AND m.identity_id IS NULL
  AND ai.user_id = m.user_id AND ai.agent_id = m.agent_id;

-- =====================================================================
-- Part E: Add identity_id FK to workspaces
-- =====================================================================

ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS identity_id uuid;
ALTER TABLE workspaces ADD CONSTRAINT workspaces_identity_id_fkey
  FOREIGN KEY (identity_id) REFERENCES agent_identities(id) ON DELETE SET NULL;

UPDATE workspaces w SET identity_id = ai.id
FROM agent_identities ai
WHERE w.agent_id IS NOT NULL AND w.identity_id IS NULL
  AND ai.user_id = w.user_id AND ai.agent_id = w.agent_id;

-- =====================================================================
-- Part F: Add identity_id FKs to agent_inbox (sender + recipient)
-- =====================================================================

ALTER TABLE agent_inbox ADD COLUMN IF NOT EXISTS recipient_identity_id uuid;
ALTER TABLE agent_inbox ADD CONSTRAINT agent_inbox_recipient_identity_id_fkey
  FOREIGN KEY (recipient_identity_id) REFERENCES agent_identities(id) ON DELETE SET NULL;

ALTER TABLE agent_inbox ADD COLUMN IF NOT EXISTS sender_identity_id uuid;
ALTER TABLE agent_inbox ADD CONSTRAINT agent_inbox_sender_identity_id_fkey
  FOREIGN KEY (sender_identity_id) REFERENCES agent_identities(id) ON DELETE SET NULL;

UPDATE agent_inbox ai_msg SET recipient_identity_id = ai.id
FROM agent_identities ai
WHERE ai_msg.recipient_agent_id IS NOT NULL AND ai_msg.recipient_identity_id IS NULL
  AND ai.user_id = ai_msg.recipient_user_id AND ai.agent_id = ai_msg.recipient_agent_id;

UPDATE agent_inbox ai_msg SET sender_identity_id = ai.id
FROM agent_identities ai
WHERE ai_msg.sender_agent_id IS NOT NULL AND ai_msg.sender_identity_id IS NULL
  AND ai.user_id = COALESCE(ai_msg.sender_user_id, ai_msg.recipient_user_id)
  AND ai.agent_id = ai_msg.sender_agent_id;
