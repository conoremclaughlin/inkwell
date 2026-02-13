-- Workspace containers (Notion/Slack/Linear style top-level scopes)
-- This is additive and intentionally does NOT replace legacy worktree
-- "workspaces" yet. That migration will follow after all agents are on studio-first flows.

-- =====================================================
-- workspace_containers
-- =====================================================

CREATE TABLE IF NOT EXISTS workspace_containers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'personal' CHECK (type IN ('personal', 'team')),
  description TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  archived_at TIMESTAMPTZ,
  UNIQUE (user_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_workspace_containers_user_id ON workspace_containers(user_id);
CREATE INDEX IF NOT EXISTS idx_workspace_containers_type ON workspace_containers(type);

DROP TRIGGER IF EXISTS update_workspace_containers_updated_at ON workspace_containers;
CREATE TRIGGER update_workspace_containers_updated_at
  BEFORE UPDATE ON workspace_containers
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- =====================================================
-- workspace_members
-- =====================================================

CREATE TABLE IF NOT EXISTS workspace_members (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID NOT NULL REFERENCES workspace_containers(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (workspace_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_workspace_members_workspace_id ON workspace_members(workspace_id);
CREATE INDEX IF NOT EXISTS idx_workspace_members_user_id ON workspace_members(user_id);

-- =====================================================
-- Security posture
-- =====================================================

ALTER TABLE workspace_containers ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_members ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role full access to workspace_containers" ON workspace_containers;
CREATE POLICY "Service role full access to workspace_containers"
  ON workspace_containers FOR ALL
  USING ((auth.jwt() ->> 'role'::text) = 'service_role'::text);

DROP POLICY IF EXISTS "Service role full access to workspace_members" ON workspace_members;
CREATE POLICY "Service role full access to workspace_members"
  ON workspace_members FOR ALL
  USING ((auth.jwt() ->> 'role'::text) = 'service_role'::text);

-- =====================================================
-- Backfill default personal workspace for existing users
-- =====================================================

INSERT INTO workspace_containers (user_id, name, slug, type)
SELECT u.id, 'Personal', 'personal', 'personal'
FROM users u
WHERE NOT EXISTS (
  SELECT 1
  FROM workspace_containers wc
  WHERE wc.user_id = u.id
    AND wc.slug = 'personal'
);

INSERT INTO workspace_members (workspace_id, user_id, role)
SELECT wc.id, wc.user_id, 'owner'
FROM workspace_containers wc
WHERE wc.slug = 'personal'
ON CONFLICT (workspace_id, user_id) DO NOTHING;
