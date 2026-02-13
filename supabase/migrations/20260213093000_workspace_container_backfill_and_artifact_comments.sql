-- ============================================================================
-- Workspace containers + artifact comments + workspace-scoped backfill
-- ============================================================================
-- This migration restores schema changes that were lost during squash/merge:
-- 1) workspace_containers + workspace_members tables
-- 2) workspace_id columns on workspace-scoped tables
-- 3) artifact_comments table
-- 4) studio_id on sessions (legacy workspace_id compatibility retained)
-- 5) identity UUID foreign keys on artifacts/artifact_history

-- ----------------------------------------------------------------------------
-- 1) New tables: workspace_containers, workspace_members, artifact_comments
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.workspace_containers (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  name text NOT NULL,
  slug text NOT NULL,
  type text NOT NULL DEFAULT 'personal',
  description text,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  archived_at timestamptz,
  PRIMARY KEY (id),
  CONSTRAINT workspace_containers_type_check CHECK (type = ANY (ARRAY['personal'::text, 'team'::text]))
);

CREATE TABLE IF NOT EXISTS public.workspace_members (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL,
  role text NOT NULL DEFAULT 'member',
  created_at timestamptz DEFAULT now(),
  PRIMARY KEY (id),
  CONSTRAINT workspace_members_role_check CHECK (
    role = ANY (ARRAY['owner'::text, 'admin'::text, 'member'::text, 'viewer'::text])
  )
);

CREATE TABLE IF NOT EXISTS public.artifact_comments (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  artifact_id uuid NOT NULL,
  user_id uuid NOT NULL,
  workspace_id uuid,
  parent_comment_id uuid,
  content text NOT NULL,
  created_by_agent_id text,
  created_by_identity_id uuid,
  metadata jsonb DEFAULT '{}'::jsonb,
  deleted_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  PRIMARY KEY (id)
);

-- ----------------------------------------------------------------------------
-- 2) Add missing columns on existing tables
-- ----------------------------------------------------------------------------

ALTER TABLE public.agent_identities ADD COLUMN IF NOT EXISTS workspace_id uuid;
ALTER TABLE public.agent_identity_history ADD COLUMN IF NOT EXISTS workspace_id uuid;
ALTER TABLE public.artifacts ADD COLUMN IF NOT EXISTS workspace_id uuid;
ALTER TABLE public.artifacts ADD COLUMN IF NOT EXISTS created_by_identity_id uuid;
ALTER TABLE public.artifact_history ADD COLUMN IF NOT EXISTS workspace_id uuid;
ALTER TABLE public.artifact_history ADD COLUMN IF NOT EXISTS changed_by_identity_id uuid;
ALTER TABLE public.authorized_groups ADD COLUMN IF NOT EXISTS workspace_id uuid;
ALTER TABLE public.connected_accounts ADD COLUMN IF NOT EXISTS workspace_id uuid;
ALTER TABLE public.group_challenge_codes ADD COLUMN IF NOT EXISTS workspace_id uuid;
ALTER TABLE public.trusted_users ADD COLUMN IF NOT EXISTS workspace_id uuid;
ALTER TABLE public.user_identity ADD COLUMN IF NOT EXISTS workspace_id uuid;
ALTER TABLE public.user_identity_history ADD COLUMN IF NOT EXISTS workspace_id uuid;
ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS studio_id uuid;

-- ----------------------------------------------------------------------------
-- 3) Seed personal workspace containers + memberships
-- ----------------------------------------------------------------------------

INSERT INTO public.workspace_containers (user_id, name, slug, type, metadata)
SELECT u.id, 'Personal', 'personal', 'personal', '{}'::jsonb
FROM public.users u
WHERE NOT EXISTS (
  SELECT 1
  FROM public.workspace_containers wc
  WHERE wc.user_id = u.id
    AND wc.slug = 'personal'
    AND wc.archived_at IS NULL
);

INSERT INTO public.workspace_members (workspace_id, user_id, role)
SELECT wc.id, wc.user_id, 'owner'
FROM public.workspace_containers wc
LEFT JOIN public.workspace_members wm
  ON wm.workspace_id = wc.id
 AND wm.user_id = wc.user_id
WHERE wc.slug = 'personal'
  AND wc.archived_at IS NULL
  AND wm.id IS NULL;

-- ----------------------------------------------------------------------------
-- 4) Backfill workspace_id/studio_id data
-- ----------------------------------------------------------------------------

UPDATE public.agent_identities ai
SET workspace_id = wc.id
FROM public.workspace_containers wc
WHERE ai.workspace_id IS NULL
  AND wc.user_id = ai.user_id
  AND wc.slug = 'personal'
  AND wc.archived_at IS NULL;

UPDATE public.agent_identity_history aih
SET workspace_id = wc.id
FROM public.workspace_containers wc
WHERE aih.workspace_id IS NULL
  AND wc.user_id = aih.user_id
  AND wc.slug = 'personal'
  AND wc.archived_at IS NULL;

UPDATE public.artifacts a
SET workspace_id = wc.id
FROM public.workspace_containers wc
WHERE a.workspace_id IS NULL
  AND wc.user_id = a.user_id
  AND wc.slug = 'personal'
  AND wc.archived_at IS NULL;

UPDATE public.artifact_history ah
SET workspace_id = a.workspace_id
FROM public.artifacts a
WHERE ah.workspace_id IS NULL
  AND ah.artifact_id = a.id;

UPDATE public.connected_accounts ca
SET workspace_id = wc.id
FROM public.workspace_containers wc
WHERE ca.workspace_id IS NULL
  AND wc.user_id = ca.user_id
  AND wc.slug = 'personal'
  AND wc.archived_at IS NULL;

UPDATE public.trusted_users tu
SET workspace_id = wc.id
FROM public.workspace_containers wc
WHERE tu.workspace_id IS NULL
  AND tu.user_id IS NOT NULL
  AND wc.user_id = tu.user_id
  AND wc.slug = 'personal'
  AND wc.archived_at IS NULL;

UPDATE public.user_identity ui
SET workspace_id = wc.id
FROM public.workspace_containers wc
WHERE ui.workspace_id IS NULL
  AND wc.user_id = ui.user_id
  AND wc.slug = 'personal'
  AND wc.archived_at IS NULL;

UPDATE public.user_identity_history uih
SET workspace_id = wc.id
FROM public.workspace_containers wc
WHERE uih.workspace_id IS NULL
  AND wc.user_id = uih.user_id
  AND wc.slug = 'personal'
  AND wc.archived_at IS NULL;

UPDATE public.group_challenge_codes gcc
SET workspace_id = wc.id
FROM public.workspace_containers wc
WHERE gcc.workspace_id IS NULL
  AND gcc.created_by IS NOT NULL
  AND wc.user_id = gcc.created_by
  AND wc.slug = 'personal'
  AND wc.archived_at IS NULL;

UPDATE public.authorized_groups ag
SET workspace_id = wc.id
FROM public.workspace_containers wc
WHERE ag.workspace_id IS NULL
  AND ag.authorized_by IS NOT NULL
  AND wc.user_id = ag.authorized_by
  AND wc.slug = 'personal'
  AND wc.archived_at IS NULL;

UPDATE public.authorized_groups ag
SET workspace_id = wc.id
FROM public.workspace_containers wc
WHERE ag.workspace_id IS NULL
  AND ag.authorized_by IS NULL
  AND ag.revoked_by IS NOT NULL
  AND wc.user_id = ag.revoked_by
  AND wc.slug = 'personal'
  AND wc.archived_at IS NULL;

-- Keep legacy sessions.workspace_id (worktree/workspace) and mirror into studio_id.
UPDATE public.sessions s
SET studio_id = s.workspace_id
WHERE s.studio_id IS NULL
  AND s.workspace_id IS NOT NULL;

-- Backfill canonical identity UUID links for artifacts + history where possible.
UPDATE public.artifacts a
SET created_by_identity_id = ai.id
FROM public.agent_identities ai
WHERE a.created_by_identity_id IS NULL
  AND a.created_by_agent_id IS NOT NULL
  AND ai.user_id = a.user_id
  AND ai.agent_id = a.created_by_agent_id
  AND ai.workspace_id IS NOT DISTINCT FROM a.workspace_id;

UPDATE public.artifact_history ah
SET changed_by_identity_id = ai.id
FROM public.artifacts a
JOIN public.agent_identities ai
  ON ai.user_id = COALESCE(ah.changed_by_user_id, a.user_id)
 AND ai.agent_id = ah.changed_by_agent_id
 AND ai.workspace_id IS NOT DISTINCT FROM ah.workspace_id
WHERE ah.changed_by_identity_id IS NULL
  AND ah.artifact_id = a.id
  AND ah.changed_by_agent_id IS NOT NULL;

-- ----------------------------------------------------------------------------
-- 5) Constraints + indexes
-- ----------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'workspace_containers_user_id_fkey'
  ) THEN
    ALTER TABLE public.workspace_containers
      ADD CONSTRAINT workspace_containers_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'workspace_members_workspace_id_fkey'
  ) THEN
    ALTER TABLE public.workspace_members
      ADD CONSTRAINT workspace_members_workspace_id_fkey
      FOREIGN KEY (workspace_id) REFERENCES public.workspace_containers(id) ON DELETE CASCADE;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'workspace_members_user_id_fkey'
  ) THEN
    ALTER TABLE public.workspace_members
      ADD CONSTRAINT workspace_members_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'artifact_comments_artifact_id_fkey'
  ) THEN
    ALTER TABLE public.artifact_comments
      ADD CONSTRAINT artifact_comments_artifact_id_fkey
      FOREIGN KEY (artifact_id) REFERENCES public.artifacts(id) ON DELETE CASCADE;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'artifact_comments_user_id_fkey'
  ) THEN
    ALTER TABLE public.artifact_comments
      ADD CONSTRAINT artifact_comments_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'artifact_comments_workspace_id_fkey'
  ) THEN
    ALTER TABLE public.artifact_comments
      ADD CONSTRAINT artifact_comments_workspace_id_fkey
      FOREIGN KEY (workspace_id) REFERENCES public.workspace_containers(id) ON DELETE CASCADE;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'artifact_comments_parent_comment_id_fkey'
  ) THEN
    ALTER TABLE public.artifact_comments
      ADD CONSTRAINT artifact_comments_parent_comment_id_fkey
      FOREIGN KEY (parent_comment_id) REFERENCES public.artifact_comments(id) ON DELETE SET NULL;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'artifact_comments_created_by_identity_id_fkey'
  ) THEN
    ALTER TABLE public.artifact_comments
      ADD CONSTRAINT artifact_comments_created_by_identity_id_fkey
      FOREIGN KEY (created_by_identity_id) REFERENCES public.agent_identities(id) ON DELETE SET NULL;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'agent_identities_workspace_id_fkey'
  ) THEN
    ALTER TABLE public.agent_identities
      ADD CONSTRAINT agent_identities_workspace_id_fkey
      FOREIGN KEY (workspace_id) REFERENCES public.workspace_containers(id) ON DELETE CASCADE;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'agent_identity_history_workspace_id_fkey'
  ) THEN
    ALTER TABLE public.agent_identity_history
      ADD CONSTRAINT agent_identity_history_workspace_id_fkey
      FOREIGN KEY (workspace_id) REFERENCES public.workspace_containers(id) ON DELETE CASCADE;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'artifacts_workspace_id_fkey'
  ) THEN
    ALTER TABLE public.artifacts
      ADD CONSTRAINT artifacts_workspace_id_fkey
      FOREIGN KEY (workspace_id) REFERENCES public.workspace_containers(id) ON DELETE CASCADE;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'artifacts_created_by_identity_id_fkey'
  ) THEN
    ALTER TABLE public.artifacts
      ADD CONSTRAINT artifacts_created_by_identity_id_fkey
      FOREIGN KEY (created_by_identity_id) REFERENCES public.agent_identities(id) ON DELETE SET NULL;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'artifact_history_workspace_id_fkey'
  ) THEN
    ALTER TABLE public.artifact_history
      ADD CONSTRAINT artifact_history_workspace_id_fkey
      FOREIGN KEY (workspace_id) REFERENCES public.workspace_containers(id) ON DELETE CASCADE;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'artifact_history_changed_by_identity_id_fkey'
  ) THEN
    ALTER TABLE public.artifact_history
      ADD CONSTRAINT artifact_history_changed_by_identity_id_fkey
      FOREIGN KEY (changed_by_identity_id) REFERENCES public.agent_identities(id) ON DELETE SET NULL;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'authorized_groups_workspace_id_fkey'
  ) THEN
    ALTER TABLE public.authorized_groups
      ADD CONSTRAINT authorized_groups_workspace_id_fkey
      FOREIGN KEY (workspace_id) REFERENCES public.workspace_containers(id) ON DELETE SET NULL;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'connected_accounts_workspace_id_fkey'
  ) THEN
    ALTER TABLE public.connected_accounts
      ADD CONSTRAINT connected_accounts_workspace_id_fkey
      FOREIGN KEY (workspace_id) REFERENCES public.workspace_containers(id) ON DELETE SET NULL;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'group_challenge_codes_workspace_id_fkey'
  ) THEN
    ALTER TABLE public.group_challenge_codes
      ADD CONSTRAINT group_challenge_codes_workspace_id_fkey
      FOREIGN KEY (workspace_id) REFERENCES public.workspace_containers(id) ON DELETE SET NULL;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'trusted_users_workspace_id_fkey'
  ) THEN
    ALTER TABLE public.trusted_users
      ADD CONSTRAINT trusted_users_workspace_id_fkey
      FOREIGN KEY (workspace_id) REFERENCES public.workspace_containers(id) ON DELETE CASCADE;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'user_identity_workspace_id_fkey'
  ) THEN
    ALTER TABLE public.user_identity
      ADD CONSTRAINT user_identity_workspace_id_fkey
      FOREIGN KEY (workspace_id) REFERENCES public.workspace_containers(id) ON DELETE CASCADE;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'user_identity_history_workspace_id_fkey'
  ) THEN
    ALTER TABLE public.user_identity_history
      ADD CONSTRAINT user_identity_history_workspace_id_fkey
      FOREIGN KEY (workspace_id) REFERENCES public.workspace_containers(id) ON DELETE CASCADE;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'sessions_studio_id_fkey'
  ) THEN
    ALTER TABLE public.sessions
      ADD CONSTRAINT sessions_studio_id_fkey
      FOREIGN KEY (studio_id) REFERENCES public.workspaces(id) ON DELETE SET NULL;
  END IF;
END
$$;

-- Uniqueness updates for workspace scoping.
ALTER TABLE public.agent_identities DROP CONSTRAINT IF EXISTS agent_identities_user_id_agent_id_key;
ALTER TABLE public.trusted_users DROP CONSTRAINT IF EXISTS trusted_users_platform_platform_user_id_key;
ALTER TABLE public.authorized_groups DROP CONSTRAINT IF EXISTS authorized_groups_platform_platform_group_id_key;
ALTER TABLE public.user_identity DROP CONSTRAINT IF EXISTS user_identity_user_id_key;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'agent_identities_user_workspace_agent_id_key'
  ) THEN
    ALTER TABLE public.agent_identities
      ADD CONSTRAINT agent_identities_user_workspace_agent_id_key
      UNIQUE (user_id, workspace_id, agent_id);
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'trusted_users_workspace_platform_user_key'
  ) THEN
    ALTER TABLE public.trusted_users
      ADD CONSTRAINT trusted_users_workspace_platform_user_key
      UNIQUE (workspace_id, platform, platform_user_id);
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'authorized_groups_workspace_platform_group_key'
  ) THEN
    ALTER TABLE public.authorized_groups
      ADD CONSTRAINT authorized_groups_workspace_platform_group_key
      UNIQUE (workspace_id, platform, platform_group_id);
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'user_identity_user_workspace_key'
  ) THEN
    ALTER TABLE public.user_identity
      ADD CONSTRAINT user_identity_user_workspace_key
      UNIQUE (user_id, workspace_id);
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS workspace_members_workspace_user_key
  ON public.workspace_members(workspace_id, user_id);
CREATE UNIQUE INDEX IF NOT EXISTS workspace_containers_user_slug_active_key
  ON public.workspace_containers(user_id, slug)
  WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_workspace_containers_user_id ON public.workspace_containers(user_id);
CREATE INDEX IF NOT EXISTS idx_workspace_containers_type ON public.workspace_containers(type);
CREATE INDEX IF NOT EXISTS idx_workspace_members_workspace_id ON public.workspace_members(workspace_id);
CREATE INDEX IF NOT EXISTS idx_workspace_members_user_id ON public.workspace_members(user_id);
CREATE INDEX IF NOT EXISTS idx_agent_identities_workspace_id ON public.agent_identities(workspace_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_workspace_id ON public.artifacts(workspace_id);
CREATE INDEX IF NOT EXISTS idx_artifact_history_workspace_id ON public.artifact_history(workspace_id);
CREATE INDEX IF NOT EXISTS idx_connected_accounts_workspace_id ON public.connected_accounts(workspace_id);
CREATE INDEX IF NOT EXISTS idx_authorized_groups_workspace_id ON public.authorized_groups(workspace_id);
CREATE INDEX IF NOT EXISTS idx_group_challenge_codes_workspace_id ON public.group_challenge_codes(workspace_id);
CREATE INDEX IF NOT EXISTS idx_trusted_users_workspace_id ON public.trusted_users(workspace_id);
CREATE INDEX IF NOT EXISTS idx_user_identity_workspace_id ON public.user_identity(workspace_id);
CREATE INDEX IF NOT EXISTS idx_sessions_studio_id ON public.sessions(studio_id);
CREATE INDEX IF NOT EXISTS idx_artifact_comments_artifact_id ON public.artifact_comments(artifact_id);
CREATE INDEX IF NOT EXISTS idx_artifact_comments_workspace_id ON public.artifact_comments(workspace_id);
CREATE INDEX IF NOT EXISTS idx_artifact_comments_parent_id ON public.artifact_comments(parent_comment_id);
CREATE INDEX IF NOT EXISTS idx_artifact_comments_created_by_identity_id
  ON public.artifact_comments(created_by_identity_id);

-- ----------------------------------------------------------------------------
-- 6) Triggers + RLS policies for new tables
-- ----------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'update_workspace_containers_updated_at'
  ) THEN
    CREATE TRIGGER update_workspace_containers_updated_at
      BEFORE UPDATE ON public.workspace_containers
      FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'update_artifact_comments_updated_at'
  ) THEN
    CREATE TRIGGER update_artifact_comments_updated_at
      BEFORE UPDATE ON public.artifact_comments
      FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
  END IF;
END
$$;

ALTER TABLE public.workspace_containers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspace_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.artifact_comments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role full access to workspace_containers" ON public.workspace_containers;
DROP POLICY IF EXISTS "Service role full access to workspace_members" ON public.workspace_members;
DROP POLICY IF EXISTS "Service role full access to artifact_comments" ON public.artifact_comments;

CREATE POLICY "Service role full access to workspace_containers"
  ON public.workspace_containers
  FOR ALL
  USING ((auth.jwt() ->> 'role') = 'service_role');

CREATE POLICY "Service role full access to workspace_members"
  ON public.workspace_members
  FOR ALL
  USING ((auth.jwt() ->> 'role') = 'service_role');

CREATE POLICY "Service role full access to artifact_comments"
  ON public.artifact_comments
  FOR ALL
  USING ((auth.jwt() ->> 'role') = 'service_role');
