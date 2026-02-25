-- ============================================================================
-- Rename workspace_containers → workspaces
-- ============================================================================
-- The "workspace_containers" name was a transitional artifact from when
-- "workspaces" referred to git worktrees (now called "studios"). Now that
-- the worktree table is studios, we can reclaim the cleaner name "workspaces"
-- for the product/team concept.
--
-- workspace_members is kept as-is — its workspace_id FK column name is fine.
-- FK constraints on OTHER tables (e.g. agent_identities_workspace_id_fkey)
-- automatically follow the table rename; their names don't contain
-- "workspace_containers" so they don't need updating.

-- ----------------------------------------------------------------------------
-- 1) Rename the table
-- ----------------------------------------------------------------------------

DO $$
BEGIN
  IF to_regclass('public.workspace_containers') IS NOT NULL
     AND to_regclass('public.workspaces') IS NULL THEN
    EXECUTE 'ALTER TABLE public.workspace_containers RENAME TO workspaces';
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 2) Rename constraints on the table
-- ----------------------------------------------------------------------------

DO $$
BEGIN
  -- CHECK constraint: type in ('personal', 'team')
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'workspace_containers_type_check'
      AND conrelid = 'public.workspaces'::regclass
  ) THEN
    ALTER TABLE public.workspaces
      RENAME CONSTRAINT workspace_containers_type_check TO workspaces_type_check;
  END IF;

  -- FK: user_id → users(id)
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'workspace_containers_user_id_fkey'
      AND conrelid = 'public.workspaces'::regclass
  ) THEN
    ALTER TABLE public.workspaces
      RENAME CONSTRAINT workspace_containers_user_id_fkey TO workspaces_user_id_fkey;
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 3) Rename indexes
-- ----------------------------------------------------------------------------

-- Unique partial index: (user_id, slug) WHERE archived_at IS NULL
ALTER INDEX IF EXISTS workspace_containers_user_slug_active_key
  RENAME TO workspaces_user_slug_active_key;

-- Regular indexes
ALTER INDEX IF EXISTS idx_workspace_containers_user_id
  RENAME TO idx_workspaces_user_id;

ALTER INDEX IF EXISTS idx_workspace_containers_type
  RENAME TO idx_workspaces_type;

-- ----------------------------------------------------------------------------
-- 4) Rename trigger
-- ----------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'update_workspace_containers_updated_at'
      AND tgrelid = 'public.workspaces'::regclass
  ) THEN
    ALTER TRIGGER update_workspace_containers_updated_at
      ON public.workspaces
      RENAME TO update_workspaces_updated_at;
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 5) Update RLS policy
-- ----------------------------------------------------------------------------

-- Drop the old-named policy and recreate with the new name.
-- (PostgreSQL doesn't support RENAME POLICY, so drop + create.)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'workspaces'
      AND policyname = 'Service role full access to workspace_containers'
  ) THEN
    DROP POLICY "Service role full access to workspace_containers" ON public.workspaces;
    CREATE POLICY "Service role full access to workspaces"
      ON public.workspaces
      FOR ALL
      USING ((auth.jwt() ->> 'role') = 'service_role');
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 6) Update table comment
-- ----------------------------------------------------------------------------

COMMENT ON TABLE public.workspaces IS 'Product/team workspace containers. Each user has at least one personal workspace; team workspaces enable shared access.';
