-- Literal substring search uses the existing pg_trgm extension and artifact
-- title GIN index. English FTS indexes do not serve these ~* predicates.
-- No function or schema/API dependency: these indexes accelerate queries that
-- also work before migration. Short terms may still need a scan.
CREATE INDEX IF NOT EXISTS idx_artifacts_content_trgm
  ON public.artifacts USING gin (content gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_tasks_title_trgm
  ON public.tasks USING gin (title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_tasks_description_trgm
  ON public.tasks USING gin (description gin_trgm_ops);
