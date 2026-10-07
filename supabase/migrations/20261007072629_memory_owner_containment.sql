-- Remove shared memories, slice 1: containment (ink://specs/remove-shared-memories).
--
-- Every memory has exactly one owner, a canonical identity (sb_id), and every
-- agent-facing path acts only for it. Two database pieces carry that.
--
-- 1. Recall's RPCs take the owner's canonical id. They used to match on the
--    slug alone, which is unique only per workspace, and cut the candidate
--    list at match_count before the server could filter it: a same-slug peer
--    with more high-scoring rows would crowd the caller's own matches out of
--    the page entirely (Lumen, spec v2 re-review). With p_sb_id set, the owner
--    predicate runs before the ranking and the limit, and the slug and
--    p_include_shared are not consulted. It is a trailing parameter with a
--    NULL default, so a server still running the previous code keeps calling
--    these functions exactly as before until it is replaced.
--
--    The signature changes, so each function is dropped and recreated: an
--    added default parameter under CREATE OR REPLACE would create an overload,
--    and PostgREST's named-argument calls could then match both.
--
-- 2. memory_history records the owner. It never had agent_id or sb_id, so a
--    deleted memory lost its owner, and restoring it recreated a row with no
--    owner: a shared memory. The archive triggers now copy both, and existing
--    history rows whose memory still exists take that memory's owner.

DROP FUNCTION IF EXISTS public.match_memories(vector, double precision, integer, uuid, text, text, text[], text, boolean, boolean);
DROP FUNCTION IF EXISTS public.match_memory_embedding_chunks(vector, double precision, integer, uuid, text, text, text[], text, boolean, boolean, text[]);

CREATE FUNCTION public.match_memories(
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
  p_sb_id uuid DEFAULT NULL
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
  sb_id uuid,
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
    m.sb_id,
    1 - (m.embedding <=> query_embedding) AS similarity
  FROM public.memories m
  WHERE
    m.embedding IS NOT NULL
    AND (p_user_id IS NULL OR m.user_id = p_user_id)
    AND (p_source IS NULL OR m.source = p_source)
    AND (p_salience IS NULL OR m.salience = p_salience)
    AND (p_topics IS NULL OR m.topics && p_topics)
    AND (
      CASE
        WHEN p_sb_id IS NOT NULL THEN m.sb_id = p_sb_id
        ELSE (
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
      END
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

CREATE FUNCTION public.match_memory_embedding_chunks(
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
  p_chunk_types text[] DEFAULT NULL,
  p_sb_id uuid DEFAULT NULL
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
  sb_id uuid,
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
      m.sb_id,
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
      AND (
        CASE
          WHEN p_sb_id IS NOT NULL THEN m.sb_id = p_sb_id
          ELSE (
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
        END
      )
      AND (
        p_include_expired
        OR m.expires_at IS NULL
        OR m.expires_at > now()
      )
      AND 1 - (c.embedding <=> query_embedding) > match_threshold
      AND (p_chunk_types IS NULL OR c.chunk_type = ANY(p_chunk_types))
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
    sb_id,
    matched_chunk_text,
    matched_chunk_index,
    matched_chunk_type,
    similarity
  FROM ranked_matches
  WHERE rank_within_memory = 1
  ORDER BY similarity DESC, created_at DESC
  LIMIT match_count;
$$;

-- memory_history records the owner.
ALTER TABLE public.memory_history
  ADD COLUMN IF NOT EXISTS agent_id text,
  ADD COLUMN IF NOT EXISTS sb_id uuid;

CREATE INDEX IF NOT EXISTS memory_history_sb_id_idx ON public.memory_history (sb_id);

UPDATE public.memory_history h
SET agent_id = m.agent_id,
    sb_id = m.sb_id
FROM public.memories m
WHERE m.id = h.memory_id
  AND h.agent_id IS NULL
  AND h.sb_id IS NULL;

CREATE OR REPLACE FUNCTION public.archive_memory_on_delete()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  INSERT INTO memory_history (
    memory_id, user_id, content, source, salience, topics, metadata,
    version, created_at, change_type, summary, topic_key, contact_id,
    agent_id, sb_id
  ) VALUES (
    OLD.id, OLD.user_id, OLD.content, OLD.source, OLD.salience, OLD.topics,
    OLD.metadata, OLD.version, OLD.created_at, 'delete', OLD.summary, OLD.topic_key, OLD.contact_id,
    OLD.agent_id, OLD.sb_id
  );
  RETURN OLD;
END;
$function$;

CREATE OR REPLACE FUNCTION public.archive_memory_on_update()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD.content IS DISTINCT FROM NEW.content
     OR OLD.salience IS DISTINCT FROM NEW.salience
     OR OLD.topics IS DISTINCT FROM NEW.topics
     OR OLD.summary IS DISTINCT FROM NEW.summary
     OR OLD.topic_key IS DISTINCT FROM NEW.topic_key THEN
    INSERT INTO memory_history (
      memory_id, user_id, content, source, salience, topics, metadata,
      version, created_at, change_type, summary, topic_key, contact_id,
      agent_id, sb_id
    ) VALUES (
      OLD.id, OLD.user_id, OLD.content, OLD.source, OLD.salience, OLD.topics,
      OLD.metadata, OLD.version, OLD.created_at, 'update', OLD.summary, OLD.topic_key, OLD.contact_id,
      OLD.agent_id, OLD.sb_id
    );
    NEW.version := OLD.version + 1;
  END IF;
  RETURN NEW;
END;
$function$;
