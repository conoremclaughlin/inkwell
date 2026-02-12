-- Add artifact comments and move artifact authorship toward canonical identity UUIDs.
-- This is phase 1 of migrating from text agent_id to agent_identities.id references.

-- ============================================================================
-- 1) Add identity UUID references to existing artifact tables (backward compatible)
-- ============================================================================

ALTER TABLE artifacts
  ADD COLUMN IF NOT EXISTS created_by_identity_id UUID REFERENCES agent_identities(id) ON DELETE SET NULL;

ALTER TABLE artifact_history
  ADD COLUMN IF NOT EXISTS changed_by_identity_id UUID REFERENCES agent_identities(id) ON DELETE SET NULL;

-- Backfill artifacts.created_by_identity_id from existing text agent IDs.
UPDATE artifacts a
SET created_by_identity_id = ai.id
FROM agent_identities ai
WHERE a.created_by_identity_id IS NULL
  AND a.created_by_agent_id IS NOT NULL
  AND ai.user_id = a.user_id
  AND ai.agent_id = a.created_by_agent_id;

-- Backfill artifact_history.changed_by_identity_id from existing text agent IDs.
-- Prefer changed_by_user_id when available; otherwise fall back to artifact owner.
UPDATE artifact_history h
SET changed_by_identity_id = ai.id
FROM artifacts a
JOIN agent_identities ai
  ON ai.agent_id = h.changed_by_agent_id
  AND ai.user_id = COALESCE(h.changed_by_user_id, a.user_id)
WHERE h.changed_by_identity_id IS NULL
  AND h.changed_by_agent_id IS NOT NULL
  AND a.id = h.artifact_id;

CREATE INDEX IF NOT EXISTS idx_artifacts_created_by_identity_id
  ON artifacts(created_by_identity_id);

CREATE INDEX IF NOT EXISTS idx_artifact_history_changed_by_identity_id
  ON artifact_history(changed_by_identity_id);

-- ============================================================================
-- 2) Add artifact_comments table
-- ============================================================================

CREATE TABLE IF NOT EXISTS artifact_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  artifact_id UUID NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- Backward-compatible display slug (human-readable)
  created_by_agent_id TEXT,

  -- Canonical author reference (new source of truth)
  created_by_identity_id UUID REFERENCES agent_identities(id) ON DELETE SET NULL,

  -- Optional thread support (future-proofing)
  parent_comment_id UUID REFERENCES artifact_comments(id) ON DELETE CASCADE,

  content TEXT NOT NULL CHECK (char_length(trim(content)) > 0),
  metadata JSONB DEFAULT '{}'::jsonb,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_artifact_comments_artifact_id_created_at
  ON artifact_comments(artifact_id, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_artifact_comments_user_id
  ON artifact_comments(user_id);

CREATE INDEX IF NOT EXISTS idx_artifact_comments_created_by_identity_id
  ON artifact_comments(created_by_identity_id);

CREATE INDEX IF NOT EXISTS idx_artifact_comments_parent_comment_id
  ON artifact_comments(parent_comment_id)
  WHERE parent_comment_id IS NOT NULL;

DROP TRIGGER IF EXISTS update_artifact_comments_updated_at ON artifact_comments;
CREATE TRIGGER update_artifact_comments_updated_at
  BEFORE UPDATE ON artifact_comments
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE artifact_comments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own artifact comments"
  ON artifact_comments FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own artifact comments"
  ON artifact_comments FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own artifact comments"
  ON artifact_comments FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own artifact comments"
  ON artifact_comments FOR DELETE
  USING (auth.uid() = user_id);

CREATE POLICY "Service role full access to artifact_comments"
  ON artifact_comments FOR ALL
  USING (auth.jwt() ->> 'role' = 'service_role');

COMMENT ON TABLE artifact_comments IS 'Threaded comments attached to shared artifacts. Uses created_by_identity_id (UUID FK) as canonical author reference.';
COMMENT ON COLUMN artifact_comments.created_by_agent_id IS 'Backward-compatible display slug (e.g., wren, lumen). Not canonical for referential integrity.';
COMMENT ON COLUMN artifact_comments.created_by_identity_id IS 'Canonical FK to agent_identities.id for comment authorship.';
COMMENT ON COLUMN artifacts.created_by_identity_id IS 'Canonical FK to agent_identities.id for artifact creator. created_by_agent_id remains display/backward-compat.';
COMMENT ON COLUMN artifact_history.changed_by_identity_id IS 'Canonical FK to agent_identities.id for artifact history actor. changed_by_agent_id remains display/backward-compat.';
