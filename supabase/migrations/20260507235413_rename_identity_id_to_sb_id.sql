-- =====================================================================
-- Rename identity_id columns to sb_id across all tables
-- =====================================================================
-- Part of the "agent" → "sb" naming migration. All columns that reference
-- agent_identities(id) are renamed from *identity_id to *sb_id.
--
-- user_identity_history.identity_id is NOT renamed — it references
-- user_identity(id) (organic human identity), not agent/SB identity.
-- =====================================================================

BEGIN;

-- =====================================================================
-- Part A: Rename columns
-- =====================================================================

-- Tables with identity_id → sb_id
ALTER TABLE sessions RENAME COLUMN identity_id TO sb_id;
ALTER TABLE activity_stream RENAME COLUMN identity_id TO sb_id;
ALTER TABLE memories RENAME COLUMN identity_id TO sb_id;
ALTER TABLE studios RENAME COLUMN identity_id TO sb_id;
ALTER TABLE mcp_tokens RENAME COLUMN identity_id TO sb_id;
ALTER TABLE scheduled_reminders RENAME COLUMN identity_id TO sb_id;
ALTER TABLE channel_routes RENAME COLUMN identity_id TO sb_id;
ALTER TABLE task_groups RENAME COLUMN identity_id TO sb_id;
ALTER TABLE agent_identity_history RENAME COLUMN identity_id TO sb_id;

-- agent_inbox: recipient/sender variants
ALTER TABLE agent_inbox RENAME COLUMN recipient_identity_id TO recipient_sb_id;
ALTER TABLE agent_inbox RENAME COLUMN sender_identity_id TO sender_sb_id;

-- created_by_identity_id → created_by_sb_id
ALTER TABLE artifacts RENAME COLUMN created_by_identity_id TO created_by_sb_id;
ALTER TABLE artifact_comments RENAME COLUMN created_by_identity_id TO created_by_sb_id;
ALTER TABLE task_comments RENAME COLUMN created_by_identity_id TO created_by_sb_id;

-- changed_by_identity_id → changed_by_sb_id
ALTER TABLE artifact_history RENAME COLUMN changed_by_identity_id TO changed_by_sb_id;

-- task_group_comments (may exist from a prior applied migration)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'task_group_comments'
      AND column_name = 'created_by_identity_id'
  ) THEN
    ALTER TABLE task_group_comments RENAME COLUMN created_by_identity_id TO created_by_sb_id;
  END IF;
END $$;

-- =====================================================================
-- Part B: Rename indexes
-- =====================================================================

ALTER INDEX IF EXISTS idx_reminders_identity_id RENAME TO idx_reminders_sb_id;
ALTER INDEX IF EXISTS idx_mcp_tokens_identity_id RENAME TO idx_mcp_tokens_sb_id;
ALTER INDEX IF EXISTS idx_task_groups_identity_id RENAME TO idx_task_groups_sb_id;
ALTER INDEX IF EXISTS idx_artifact_comments_created_by_identity_id RENAME TO idx_artifact_comments_created_by_sb_id;
ALTER INDEX IF EXISTS idx_agent_identity_history_identity_id RENAME TO idx_agent_identity_history_sb_id;
ALTER INDEX IF EXISTS idx_task_group_comments_created_by_identity_id RENAME TO idx_task_group_comments_created_by_sb_id;

-- =====================================================================
-- Part C: Rename FK constraints
-- =====================================================================

DO $$
DECLARE
  r RECORD;
  renames text[][] := ARRAY[
    ['sessions_identity_id_fkey', 'sessions', 'sessions_sb_id_fkey'],
    ['activity_stream_identity_id_fkey', 'activity_stream', 'activity_stream_sb_id_fkey'],
    ['memories_identity_id_fkey', 'memories', 'memories_sb_id_fkey'],
    ['studios_identity_id_fkey', 'studios', 'studios_sb_id_fkey'],
    ['agent_inbox_recipient_identity_id_fkey', 'agent_inbox', 'agent_inbox_recipient_sb_id_fkey'],
    ['agent_inbox_sender_identity_id_fkey', 'agent_inbox', 'agent_inbox_sender_sb_id_fkey'],
    ['mcp_tokens_identity_id_fkey', 'mcp_tokens', 'mcp_tokens_sb_id_fkey'],
    ['scheduled_reminders_identity_id_fkey', 'scheduled_reminders', 'scheduled_reminders_sb_id_fkey'],
    ['channel_routes_identity_id_fkey', 'channel_routes', 'channel_routes_sb_id_fkey'],
    ['task_groups_identity_id_fkey', 'task_groups', 'task_groups_sb_id_fkey'],
    ['artifacts_created_by_identity_id_fkey', 'artifacts', 'artifacts_created_by_sb_id_fkey'],
    ['artifact_comments_created_by_identity_id_fkey', 'artifact_comments', 'artifact_comments_created_by_sb_id_fkey'],
    ['artifact_history_changed_by_identity_id_fkey', 'artifact_history', 'artifact_history_changed_by_sb_id_fkey'],
    ['task_comments_created_by_identity_id_fkey', 'task_comments', 'task_comments_created_by_sb_id_fkey']
  ];
BEGIN
  FOR i IN 1..array_length(renames, 1) LOOP
    IF EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = renames[i][1]
        AND conrelid = ('public.' || renames[i][2])::regclass
    ) THEN
      EXECUTE format(
        'ALTER TABLE public.%I RENAME CONSTRAINT %I TO %I',
        renames[i][2], renames[i][1], renames[i][3]
      );
    END IF;
  END LOOP;
END $$;

-- task_group_comments FK (conditional)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'task_group_comments_created_by_identity_id_fkey'
      AND conrelid = 'public.task_group_comments'::regclass
  ) THEN
    ALTER TABLE public.task_group_comments
      RENAME CONSTRAINT task_group_comments_created_by_identity_id_fkey
      TO task_group_comments_created_by_sb_id_fkey;
  END IF;
EXCEPTION WHEN undefined_table THEN
  NULL;
END $$;

-- =====================================================================
-- Part D: Update trigger functions that reference identity_id column
-- =====================================================================

CREATE OR REPLACE FUNCTION public.archive_agent_identity_on_update()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD.name IS DISTINCT FROM NEW.name
     OR OLD.role IS DISTINCT FROM NEW.role
     OR OLD.description IS DISTINCT FROM NEW.description
     OR OLD.values IS DISTINCT FROM NEW.values
     OR OLD.relationships IS DISTINCT FROM NEW.relationships
     OR OLD.capabilities IS DISTINCT FROM NEW.capabilities
     OR OLD.metadata IS DISTINCT FROM NEW.metadata
     OR OLD.soul IS DISTINCT FROM NEW.soul
     OR OLD.heartbeat IS DISTINCT FROM NEW.heartbeat
     OR OLD.backend IS DISTINCT FROM NEW.backend
     OR OLD.permissions IS DISTINCT FROM NEW.permissions THEN

    INSERT INTO agent_identity_history (
      sb_id, user_id, agent_id,
      name, role, description, values, relationships, capabilities, metadata,
      soul, heartbeat, backend, permissions,
      version, created_at, archived_at, change_type
    ) VALUES (
      OLD.id, OLD.user_id, OLD.agent_id,
      OLD.name, OLD.role, OLD.description, OLD.values, OLD.relationships, OLD.capabilities, OLD.metadata,
      OLD.soul, OLD.heartbeat, OLD.backend, OLD.permissions,
      OLD.version, OLD.created_at, NOW(), 'update'
    );

    NEW.version := COALESCE(OLD.version, 0) + 1;
    NEW.updated_at := NOW();
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.archive_agent_identity_on_delete()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  INSERT INTO agent_identity_history (
    sb_id, user_id, agent_id,
    name, role, description, values, relationships, capabilities, metadata,
    soul, heartbeat, backend, permissions,
    version, created_at, change_type
  ) VALUES (
    OLD.id, OLD.user_id, OLD.agent_id,
    OLD.name, OLD.role, OLD.description, OLD.values, OLD.relationships, OLD.capabilities, OLD.metadata,
    OLD.soul, OLD.heartbeat, OLD.backend, OLD.permissions,
    OLD.version, OLD.created_at, 'delete'
  );

  RETURN OLD;
END;
$function$;

-- =====================================================================
-- Part E: Update semantic search functions (return sb_id, not identity_id)
-- =====================================================================
-- Must DROP first because CREATE OR REPLACE cannot change return type.

DROP FUNCTION IF EXISTS public.match_memories(vector, double precision, integer, uuid, text, text, text[], text, boolean, boolean);
DROP FUNCTION IF EXISTS public.match_memory_embedding_chunks(vector, double precision, integer, uuid, text, text, text[], text, boolean, boolean);
DROP FUNCTION IF EXISTS public.match_memory_embedding_chunks(vector, double precision, integer, uuid, text, text, text[], text, boolean, boolean, text[]);

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

COMMIT;
