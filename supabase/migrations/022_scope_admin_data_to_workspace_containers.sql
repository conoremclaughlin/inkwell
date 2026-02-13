-- Scope admin/dashboard data to product workspace containers.
--
-- This migration adds workspace_id to key admin-surface tables and backfills
-- existing rows to the user's default personal workspace.
--
-- Backward-compatibility strategy:
-- - Columns are nullable during rollout.
-- - Backfill targets existing rows where we can infer ownership.
-- - Older code paths can continue writing rows without workspace_id temporarily.

-- =====================================================
-- Add workspace_id columns
-- =====================================================

ALTER TABLE IF EXISTS trusted_users
  ADD COLUMN IF NOT EXISTS workspace_id UUID;

ALTER TABLE IF EXISTS authorized_groups
  ADD COLUMN IF NOT EXISTS workspace_id UUID;

ALTER TABLE IF EXISTS group_challenge_codes
  ADD COLUMN IF NOT EXISTS workspace_id UUID;

ALTER TABLE IF EXISTS connected_accounts
  ADD COLUMN IF NOT EXISTS workspace_id UUID;

ALTER TABLE IF EXISTS artifacts
  ADD COLUMN IF NOT EXISTS workspace_id UUID;

ALTER TABLE IF EXISTS artifact_comments
  ADD COLUMN IF NOT EXISTS workspace_id UUID;

ALTER TABLE IF EXISTS artifact_history
  ADD COLUMN IF NOT EXISTS workspace_id UUID;

ALTER TABLE IF EXISTS agent_identities
  ADD COLUMN IF NOT EXISTS workspace_id UUID;

ALTER TABLE IF EXISTS agent_identity_history
  ADD COLUMN IF NOT EXISTS workspace_id UUID;

ALTER TABLE IF EXISTS user_identity
  ADD COLUMN IF NOT EXISTS workspace_id UUID;

ALTER TABLE IF EXISTS user_identity_history
  ADD COLUMN IF NOT EXISTS workspace_id UUID;

-- =====================================================
-- Add FK constraints (idempotent)
-- =====================================================

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'trusted_users_workspace_id_fkey'
  ) THEN
    ALTER TABLE trusted_users
      ADD CONSTRAINT trusted_users_workspace_id_fkey
      FOREIGN KEY (workspace_id) REFERENCES workspace_containers(id) ON DELETE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'authorized_groups_workspace_id_fkey'
  ) THEN
    ALTER TABLE authorized_groups
      ADD CONSTRAINT authorized_groups_workspace_id_fkey
      FOREIGN KEY (workspace_id) REFERENCES workspace_containers(id) ON DELETE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'group_challenge_codes_workspace_id_fkey'
  ) THEN
    ALTER TABLE group_challenge_codes
      ADD CONSTRAINT group_challenge_codes_workspace_id_fkey
      FOREIGN KEY (workspace_id) REFERENCES workspace_containers(id) ON DELETE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'connected_accounts_workspace_id_fkey'
  ) THEN
    ALTER TABLE connected_accounts
      ADD CONSTRAINT connected_accounts_workspace_id_fkey
      FOREIGN KEY (workspace_id) REFERENCES workspace_containers(id) ON DELETE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'artifacts_workspace_id_fkey'
  ) THEN
    ALTER TABLE artifacts
      ADD CONSTRAINT artifacts_workspace_id_fkey
      FOREIGN KEY (workspace_id) REFERENCES workspace_containers(id) ON DELETE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'artifact_comments_workspace_id_fkey'
  ) THEN
    ALTER TABLE artifact_comments
      ADD CONSTRAINT artifact_comments_workspace_id_fkey
      FOREIGN KEY (workspace_id) REFERENCES workspace_containers(id) ON DELETE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'artifact_history_workspace_id_fkey'
  ) THEN
    ALTER TABLE artifact_history
      ADD CONSTRAINT artifact_history_workspace_id_fkey
      FOREIGN KEY (workspace_id) REFERENCES workspace_containers(id) ON DELETE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'agent_identities_workspace_id_fkey'
  ) THEN
    ALTER TABLE agent_identities
      ADD CONSTRAINT agent_identities_workspace_id_fkey
      FOREIGN KEY (workspace_id) REFERENCES workspace_containers(id) ON DELETE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'agent_identity_history_workspace_id_fkey'
  ) THEN
    ALTER TABLE agent_identity_history
      ADD CONSTRAINT agent_identity_history_workspace_id_fkey
      FOREIGN KEY (workspace_id) REFERENCES workspace_containers(id) ON DELETE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'user_identity_workspace_id_fkey'
  ) THEN
    ALTER TABLE user_identity
      ADD CONSTRAINT user_identity_workspace_id_fkey
      FOREIGN KEY (workspace_id) REFERENCES workspace_containers(id) ON DELETE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'user_identity_history_workspace_id_fkey'
  ) THEN
    ALTER TABLE user_identity_history
      ADD CONSTRAINT user_identity_history_workspace_id_fkey
      FOREIGN KEY (workspace_id) REFERENCES workspace_containers(id) ON DELETE CASCADE;
  END IF;
END $$;

-- =====================================================
-- Backfill existing rows to each user's personal workspace
-- =====================================================

UPDATE trusted_users tu
SET workspace_id = wc.id
FROM workspace_containers wc
WHERE tu.workspace_id IS NULL
  AND COALESCE(tu.user_id, tu.added_by) IS NOT NULL
  AND wc.user_id = COALESCE(tu.user_id, tu.added_by)
  AND wc.slug = 'personal';

UPDATE authorized_groups ag
SET workspace_id = wc.id
FROM workspace_containers wc
WHERE ag.workspace_id IS NULL
  AND ag.authorized_by IS NOT NULL
  AND wc.user_id = ag.authorized_by
  AND wc.slug = 'personal';

UPDATE group_challenge_codes gcc
SET workspace_id = wc.id
FROM workspace_containers wc
WHERE gcc.workspace_id IS NULL
  AND gcc.created_by IS NOT NULL
  AND wc.user_id = gcc.created_by
  AND wc.slug = 'personal';

UPDATE connected_accounts ca
SET workspace_id = wc.id
FROM workspace_containers wc
WHERE ca.workspace_id IS NULL
  AND wc.user_id = ca.user_id
  AND wc.slug = 'personal';

UPDATE artifacts a
SET workspace_id = wc.id
FROM workspace_containers wc
WHERE a.workspace_id IS NULL
  AND wc.user_id = a.user_id
  AND wc.slug = 'personal';

UPDATE artifact_comments ac
SET workspace_id = wc.id
FROM workspace_containers wc
WHERE ac.workspace_id IS NULL
  AND wc.user_id = ac.user_id
  AND wc.slug = 'personal';

UPDATE artifact_history ah
SET workspace_id = a.workspace_id
FROM artifacts a
WHERE ah.workspace_id IS NULL
  AND ah.artifact_id = a.id
  AND a.workspace_id IS NOT NULL;

UPDATE agent_identities ai
SET workspace_id = wc.id
FROM workspace_containers wc
WHERE ai.workspace_id IS NULL
  AND wc.user_id = ai.user_id
  AND wc.slug = 'personal';

UPDATE agent_identity_history aih
SET workspace_id = ai.workspace_id
FROM agent_identities ai
WHERE aih.workspace_id IS NULL
  AND aih.identity_id = ai.id
  AND ai.workspace_id IS NOT NULL;

UPDATE user_identity ui
SET workspace_id = wc.id
FROM workspace_containers wc
WHERE ui.workspace_id IS NULL
  AND wc.user_id = ui.user_id
  AND wc.slug = 'personal';

UPDATE user_identity_history uih
SET workspace_id = ui.workspace_id
FROM user_identity ui
WHERE uih.workspace_id IS NULL
  AND uih.identity_id = ui.id
  AND ui.workspace_id IS NOT NULL;

-- =====================================================
-- Indexes
-- =====================================================

CREATE INDEX IF NOT EXISTS idx_trusted_users_workspace_id ON trusted_users(workspace_id);
CREATE INDEX IF NOT EXISTS idx_authorized_groups_workspace_id ON authorized_groups(workspace_id);
CREATE INDEX IF NOT EXISTS idx_group_challenge_codes_workspace_id ON group_challenge_codes(workspace_id);
CREATE INDEX IF NOT EXISTS idx_connected_accounts_workspace_id ON connected_accounts(workspace_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_workspace_id ON artifacts(workspace_id);
CREATE INDEX IF NOT EXISTS idx_artifact_comments_workspace_id ON artifact_comments(workspace_id);
CREATE INDEX IF NOT EXISTS idx_artifact_history_workspace_id ON artifact_history(workspace_id);
CREATE INDEX IF NOT EXISTS idx_agent_identities_workspace_id ON agent_identities(workspace_id);
CREATE INDEX IF NOT EXISTS idx_agent_identity_history_workspace_id ON agent_identity_history(workspace_id);
CREATE INDEX IF NOT EXISTS idx_user_identity_workspace_id ON user_identity(workspace_id);
CREATE INDEX IF NOT EXISTS idx_user_identity_history_workspace_id ON user_identity_history(workspace_id);
