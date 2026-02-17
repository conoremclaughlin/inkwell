-- Fix archive_artifact_version trigger function.
-- The function still referenced the dropped `changed_by_agent_id` column,
-- causing all artifact updates to fail. The application code handles
-- artifact_history inserts directly, so this trigger is redundant.
-- Drop the trigger and replace the function with a no-op to avoid
-- double-inserting history rows.

DROP TRIGGER IF EXISTS artifact_version_trigger ON artifacts;

CREATE OR REPLACE FUNCTION public.archive_artifact_version()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- History rows are now inserted by the application layer
  -- (artifact-handlers.ts) with proper identity attribution.
  -- This function is retained as a no-op for safety.
  RETURN NEW;
END;
$$;
