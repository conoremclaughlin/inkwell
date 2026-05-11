-- RPC function for semantic artifact search via pgvector cosine distance.
-- Mirrors match_memories but for the artifacts table.

CREATE OR REPLACE FUNCTION public.match_artifacts(
  query_embedding vector,
  match_threshold double precision DEFAULT 0.2,
  match_count integer DEFAULT 20,
  p_user_id uuid DEFAULT NULL,
  p_workspace_id uuid DEFAULT NULL,
  p_artifact_type text DEFAULT NULL,
  p_tags text[] DEFAULT NULL,
  p_visibility text DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  uri text,
  user_id uuid,
  workspace_id uuid,
  title text,
  content text,
  content_type text,
  artifact_type text,
  collaborators text[],
  visibility text,
  version integer,
  tags text[],
  metadata jsonb,
  created_at timestamptz,
  updated_at timestamptz,
  created_by_sb_id uuid,
  edit_mode text,
  similarity double precision
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    a.id,
    a.uri,
    a.user_id,
    a.workspace_id,
    a.title,
    a.content,
    a.content_type,
    a.artifact_type,
    a.collaborators,
    a.visibility,
    a.version,
    a.tags,
    a.metadata,
    a.created_at,
    a.updated_at,
    a.created_by_sb_id,
    a.edit_mode,
    1 - (a.embedding <=> query_embedding) AS similarity
  FROM public.artifacts a
  WHERE
    a.embedding IS NOT NULL
    AND (p_user_id IS NULL OR a.user_id = p_user_id)
    AND (p_workspace_id IS NULL OR a.workspace_id = p_workspace_id)
    AND (p_artifact_type IS NULL OR a.artifact_type = p_artifact_type)
    AND (p_tags IS NULL OR a.tags && p_tags)
    AND (p_visibility IS NULL OR a.visibility = p_visibility)
    AND 1 - (a.embedding <=> query_embedding) > match_threshold
  ORDER BY a.embedding <=> query_embedding
  LIMIT match_count;
$$;
