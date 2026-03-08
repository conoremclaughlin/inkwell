-- Memory semantic recall: index + RPC matcher for pgvector cosine similarity

-- 1) Ensure memories has a vector index for semantic search
CREATE INDEX IF NOT EXISTS idx_memories_embedding
  ON public.memories
  USING hnsw (embedding vector_cosine_ops);

-- 2) Semantic matcher for memories with filtering support
CREATE OR REPLACE FUNCTION public.match_memories(
  query_embedding vector,
  match_threshold double precision DEFAULT 0.2,
  match_count integer DEFAULT 20,
  p_user_id uuid DEFAULT NULL,
  p_source text DEFAULT NULL,
  p_salience text DEFAULT NULL,
  p_topics text[] DEFAULT NULL,
  p_agent_id text DEFAULT NULL,
  p_include_shared boolean DEFAULT true,
  p_include_expired boolean DEFAULT false
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
  similarity double precision
)
LANGUAGE sql
STABLE
AS $$
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
    1 - (m.embedding <=> query_embedding) AS similarity
  FROM public.memories m
  WHERE
    m.embedding IS NOT NULL
    AND (p_user_id IS NULL OR m.user_id = p_user_id)
    AND (p_source IS NULL OR m.source = p_source)
    AND (p_salience IS NULL OR m.salience = p_salience)
    AND (p_topics IS NULL OR m.topics && p_topics)
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
    AND 1 - (m.embedding <=> query_embedding) > match_threshold
  ORDER BY m.embedding <=> query_embedding
  LIMIT match_count;
$$;

