-- =====================================================
-- USER IDENTITY TABLE
-- Stores user-level identity files (USER.md, VALUES.md)
-- These are shared across all agents for a user
-- =====================================================

CREATE TABLE user_identity (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- The markdown content
  user_profile_md TEXT,           -- USER.md content - who the human is
  shared_values_md TEXT,          -- VALUES.md content - shared values across all SBs

  -- Versioning
  version INTEGER DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  -- Each user has exactly one identity record
  UNIQUE(user_id)
);

-- =====================================================
-- USER IDENTITY HISTORY TABLE
-- Version history for user identity changes
-- =====================================================

CREATE TABLE user_identity_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  identity_id UUID NOT NULL,              -- Original identity ID (may be deleted)
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- Snapshot at this version
  user_profile_md TEXT,
  shared_values_md TEXT,

  -- Version info
  version INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,        -- When the original was created
  archived_at TIMESTAMPTZ DEFAULT NOW(),  -- When this history record was created
  change_type TEXT NOT NULL DEFAULT 'update' CHECK (change_type IN ('update', 'delete'))
);

-- =====================================================
-- INDEXES
-- =====================================================

CREATE INDEX idx_user_identity_user_id ON user_identity(user_id);

CREATE INDEX idx_user_identity_history_identity ON user_identity_history(identity_id);
CREATE INDEX idx_user_identity_history_user ON user_identity_history(user_id);
CREATE INDEX idx_user_identity_history_archived ON user_identity_history(archived_at DESC);

-- =====================================================
-- TRIGGERS
-- =====================================================

-- Auto-update updated_at timestamp
CREATE TRIGGER update_user_identity_updated_at
  BEFORE UPDATE ON user_identity
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- Auto-increment version and create history on update
CREATE OR REPLACE FUNCTION create_user_identity_version_on_update()
RETURNS TRIGGER AS $$
BEGIN
  -- Only create history if content actually changed
  IF OLD.user_profile_md IS DISTINCT FROM NEW.user_profile_md
     OR OLD.shared_values_md IS DISTINCT FROM NEW.shared_values_md THEN

    -- Archive the old version
    INSERT INTO user_identity_history (
      identity_id, user_id, user_profile_md, shared_values_md,
      version, created_at, change_type
    ) VALUES (
      OLD.id, OLD.user_id, OLD.user_profile_md, OLD.shared_values_md,
      OLD.version, OLD.created_at, 'update'
    );

    -- Increment version
    NEW.version = OLD.version + 1;
  END IF;

  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER user_identity_version_trigger
  BEFORE UPDATE ON user_identity
  FOR EACH ROW
  EXECUTE FUNCTION create_user_identity_version_on_update();

-- Archive on delete
CREATE OR REPLACE FUNCTION archive_user_identity_on_delete()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO user_identity_history (
    identity_id, user_id, user_profile_md, shared_values_md,
    version, created_at, change_type
  ) VALUES (
    OLD.id, OLD.user_id, OLD.user_profile_md, OLD.shared_values_md,
    OLD.version, OLD.created_at, 'delete'
  );
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER user_identity_archive_trigger
  BEFORE DELETE ON user_identity
  FOR EACH ROW
  EXECUTE FUNCTION archive_user_identity_on_delete();

-- =====================================================
-- ROW LEVEL SECURITY
-- =====================================================

ALTER TABLE user_identity ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_identity_history ENABLE ROW LEVEL SECURITY;

-- user_identity policies
CREATE POLICY "Users can view own identity"
  ON user_identity FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own identity"
  ON user_identity FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own identity"
  ON user_identity FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own identity"
  ON user_identity FOR DELETE
  USING (auth.uid() = user_id);

-- user_identity_history policies
CREATE POLICY "Users can view own identity history"
  ON user_identity_history FOR SELECT
  USING (auth.uid() = user_id);

-- Service role full access
CREATE POLICY "Service role full access to user_identity"
  ON user_identity FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

CREATE POLICY "Service role full access to user_identity_history"
  ON user_identity_history FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- =====================================================
-- COMMENTS
-- =====================================================

COMMENT ON TABLE user_identity IS 'User-level identity files (USER.md, VALUES.md) that are shared across all agents for a user.';
COMMENT ON COLUMN user_identity.user_profile_md IS 'USER.md content - describes who the human is, their background, preferences, etc.';
COMMENT ON COLUMN user_identity.shared_values_md IS 'VALUES.md content - core values shared by all SBs working with this user.';

COMMENT ON TABLE user_identity_history IS 'Version history for user identity changes, enabling rollback and audit.';
