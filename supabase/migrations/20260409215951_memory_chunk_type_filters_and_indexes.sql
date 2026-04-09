-- Phase 2 multi-view retrieval support:
-- - add chunk-type filter indexes
-- - expose matched_chunk_type from match_memory_embedding_chunks RPC
-- - allow filtered retrieval by chunk view (summary/fact/topic/entity/content)

CREATE INDEX IF NOT EXISTS idx_memory_embedding_chunks_user_chunk_type
  ON public.memory_embedding_chunks(user_id, chunk_type);

CREATE INDEX IF NOT EXISTS idx_memory_embedding_chunks_memory_chunk_type
  ON public.memory_embedding_chunks(memory_id, chunk_type);

DROP FUNCTION IF EXISTS public.match_memory_embedding_chunks(
  vector,
  double precision,
  integer,
  uuid,
  text,
  text,
  text[],
  text,
  boolean,
  boolean
);

CREATE OR REPLACE FUNCTION public.match_memory_embedding_chunks(
  query_embedding vector,
  match_threshold double precision DEFAULT 0.2,
  match_count integer DEFAULT 20,
  p_user_id uuid DEFAULT NULL,
  p_source text DEFAULT NULL,
  p_salience text DEFAULT NULL,
  p_topics text[] DEFAULT NULL,
  p_agent_id text DEFAULT NULL,
  p_include_shared boolean DEFAULT true,
  p_include_expired boolean DEFAULT false,
  p_chunk_types text[] DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  user_id uuid,
  content text,
  summary text,
  topic_key text,
  source text,
  salience text,
  topics text[],
  embedding vector,
  metadata jsonb,
  version integer,
  created_at timestamptz,
  expires_at timestamptz,
  agent_id text,
  identity_id uuid,
  matched_chunk_text text,
  matched_chunk_index integer,
  matched_chunk_type text,
  similarity double precision
)
LANGUAGE sql
STABLE
AS $$
  WITH ranked_matches AS (
    SELECT
      m.id,
      m.user_id,
      m.content,
      m.summary,
      m.topic_key,
      m.source,
      m.salience,
      m.topics,
      m.embedding,
      m.metadata,
      m.version,
      m.created_at,
      m.expires_at,
      m.agent_id,
      m.identity_id,
      c.chunk_text AS matched_chunk_text,
      c.chunk_index AS matched_chunk_index,
      c.chunk_type AS matched_chunk_type,
      1 - (c.embedding <=> query_embedding) AS similarity,
      row_number() OVER (
        PARTITION BY m.id
        ORDER BY c.embedding <=> query_embedding ASC, c.chunk_index ASC
      ) AS rank_within_memory
    FROM public.memory_embedding_chunks c
    JOIN public.memories m ON m.id = c.memory_id
    WHERE
      (p_user_id IS NULL OR m.user_id = p_user_id)
      AND (p_source IS NULL OR m.source = p_source)
      AND (p_salience IS NULL OR m.salience = p_salience)
      AND (p_topics IS NULL OR m.topics && p_topics)
      AND (p_chunk_types IS NULL OR c.chunk_type = ANY(p_chunk_types))
      AND (
        p_agent_id IS NULL
        OR (
          p_include_shared
          AND (m.agent_id = p_agent_id OR m.agent_id IS NULL)
        )
        OR (
          NOT p_include_shared
          AND m.agent_id = p_agent_id
        )
      )
      AND (
        p_include_expired
        OR m.expires_at IS NULL
        OR m.expires_at > now()
      )
      AND 1 - (c.embedding <=> query_embedding) > match_threshold
  )
  SELECT
    id,
    user_id,
    content,
    summary,
    topic_key,
    source,
    salience,
    topics,
    embedding,
    metadata,
    version,
    created_at,
    expires_at,
    agent_id,
    identity_id,
    matched_chunk_text,
    matched_chunk_index,
    matched_chunk_type,
    similarity
  FROM ranked_matches
  WHERE rank_within_memory = 1
  ORDER BY similarity DESC, created_at DESC
  LIMIT match_count;
$$;
