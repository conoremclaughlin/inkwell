-- Accelerate memory lexical recall.
-- Current text recall uses ILIKE over content, summary, and topic_key.
-- pg_trgm GIN indexes make substring matching viable across languages/scripts.

CREATE INDEX IF NOT EXISTS idx_memories_content_trgm
  ON public.memories
  USING gin (content gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_memories_summary_trgm
  ON public.memories
  USING gin (summary gin_trgm_ops)
  WHERE summary IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_memories_topic_key_trgm
  ON public.memories
  USING gin (topic_key gin_trgm_ops)
  WHERE topic_key IS NOT NULL;
