-- Migration: add search indexes + embedding column to artifacts table
-- Enables text search (trigram + FTS) and semantic search (pgvector) on artifacts.
-- Extensions vector and pg_trgm are already enabled in the initial schema.

-- 1. Embedding column for semantic search (nullable — existing rows backfilled later)
ALTER TABLE public.artifacts
  ADD COLUMN IF NOT EXISTS embedding vector(1024);

-- 2. HNSW index for cosine similarity on embeddings
CREATE INDEX IF NOT EXISTS idx_artifacts_embedding
  ON public.artifacts
  USING hnsw (embedding vector_cosine_ops);

-- 3. GIN trigram index on title for ILIKE substring matching
CREATE INDEX IF NOT EXISTS idx_artifacts_title_trgm
  ON public.artifacts
  USING gin (title gin_trgm_ops);

-- 4. FTS index on content for full-text search
CREATE INDEX IF NOT EXISTS idx_artifacts_content_fts
  ON public.artifacts
  USING gin (to_tsvector('english'::regconfig, content));

-- 5. FTS index on title for full-text search
CREATE INDEX IF NOT EXISTS idx_artifacts_title_fts
  ON public.artifacts
  USING gin (to_tsvector('english'::regconfig, title));
