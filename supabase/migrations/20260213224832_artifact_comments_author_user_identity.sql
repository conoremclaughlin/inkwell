-- Add canonical human author reference and remove denormalized agent slug field.
ALTER TABLE public.artifact_comments
  ADD COLUMN IF NOT EXISTS created_by_user_id uuid;

-- Backfill from existing ownership column for historical rows.
UPDATE public.artifact_comments
SET created_by_user_id = user_id
WHERE created_by_user_id IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'artifact_comments_created_by_user_id_fkey'
  ) THEN
    ALTER TABLE public.artifact_comments
      ADD CONSTRAINT artifact_comments_created_by_user_id_fkey
      FOREIGN KEY (created_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_artifact_comments_created_by_user_id
  ON public.artifact_comments(created_by_user_id);

ALTER TABLE public.artifact_comments
  DROP COLUMN IF EXISTS created_by_agent_id;
