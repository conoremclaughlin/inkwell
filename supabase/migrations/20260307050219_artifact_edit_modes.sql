-- Artifact edit permissions
-- Adds explicit edit mode support so artifacts can be editable by:
-- 1) everyone in the workspace, or
-- 2) a specific list of editor agent IDs.
--
-- Requirement: default all existing artifacts to workspace-level edit access.

ALTER TABLE public.artifacts
  ADD COLUMN IF NOT EXISTS edit_mode text;

UPDATE public.artifacts
SET edit_mode = 'workspace'
WHERE edit_mode IS NULL;

ALTER TABLE public.artifacts
  ALTER COLUMN edit_mode SET DEFAULT 'workspace',
  ALTER COLUMN edit_mode SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'artifacts_edit_mode_check'
  ) THEN
    ALTER TABLE public.artifacts
      ADD CONSTRAINT artifacts_edit_mode_check
      CHECK (edit_mode IN ('workspace', 'editors'));
  END IF;
END $$;

COMMENT ON COLUMN public.artifacts.edit_mode IS
  'Artifact edit permission mode: workspace (all workspace agents can edit) or editors (only listed collaborators).';
