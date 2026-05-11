-- GIN trigram index on content for ILIKE substring matching.
-- textSearch uses ILIKE on content, which benefits from trigram indexing.
CREATE INDEX IF NOT EXISTS idx_artifacts_content_trgm
  ON public.artifacts
  USING gin (content gin_trgm_ops);
