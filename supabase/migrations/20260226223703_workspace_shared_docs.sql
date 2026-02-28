-- Workspace-level shared documents
-- Stage 1 migration: move shared values/process to workspaces while keeping
-- legacy user_identity *_md columns for backwards compatibility.

ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS shared_values text,
  ADD COLUMN IF NOT EXISTS process text;

COMMENT ON COLUMN public.workspaces.shared_values IS
  'Shared values document content at workspace scope.';

COMMENT ON COLUMN public.workspaces.process IS
  'Shared collaboration process document content at workspace scope.';

-- Backfill workspace-level docs from existing user_identity records.
-- Note: this only backfills rows that already have user_identity.workspace_id set.
UPDATE public.workspaces w
SET
  shared_values = COALESCE(w.shared_values, ui.shared_values_md),
  process = COALESCE(w.process, ui.process_md)
FROM public.user_identity ui
WHERE ui.workspace_id = w.id
  AND (
    (w.shared_values IS NULL AND ui.shared_values_md IS NOT NULL)
    OR (w.process IS NULL AND ui.process_md IS NOT NULL)
  );
