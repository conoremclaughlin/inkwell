-- Atomic publication and cleanup of a memory's embedding artifacts.
--
-- A memory's embedding lives in two places: the primary vector and counters on
-- public.memories, and one row per chunk in public.memory_embedding_chunks.
-- The repository used to write them with separate statements, which leaves a
-- window where they disagree — and, worse, no way for a slow writer to notice
-- that the row it embedded has since been revised. Two concurrent edits could
-- end with the memory's content describing one revision and every artifact
-- describing the other.
--
-- Both functions take the `version` the caller embedded from and refuse if the
-- row has moved on. `version` is bumped by archive_memory_on_update whenever
-- the text changes, so it is exactly "is this still the revision I read". The
-- SELECT ... FOR UPDATE makes the check-then-write a single decision rather
-- than two, which a check in application code cannot do.
--
-- Return values are 'ok' | 'superseded' | 'missing'. Superseded is not an
-- error: the newer revision's artifacts are the correct ones and must stand.

CREATE OR REPLACE FUNCTION public.swap_memory_embedding(
  p_memory_id uuid,
  p_user_id uuid,
  p_expected_version integer,
  p_chunks jsonb,
  p_embedding text,
  p_chunks_version integer,
  p_chunk_count integer,
  p_metadata_patch jsonb,
  p_metadata_remove text[] DEFAULT NULL
)
RETURNS text
LANGUAGE plpgsql
-- `extensions` is not decoration: pgvector lives there on Supabase, so pinning
-- the path to public alone makes `::vector` fail to resolve at RUNTIME, inside
-- a function that creates and replaces cleanly. Caught by executing it.
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_current_version integer;
  v_metadata jsonb;
  v_key text;
BEGIN
  SELECT version, COALESCE(metadata, '{}'::jsonb)
  INTO v_current_version, v_metadata
  FROM public.memories
  WHERE id = p_memory_id AND user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN 'missing';
  END IF;

  IF v_current_version IS DISTINCT FROM p_expected_version THEN
    RETURN 'superseded';
  END IF;

  -- Delete then insert rather than upsert then trim. A re-embed can produce
  -- fewer chunks than the previous revision, and the surplus rows are matched
  -- directly by the chunk search RPC — which never consults the memory row's
  -- embedding metadata, chunk count or version. Leaving one behind keeps text
  -- the memory no longer contains searchable.
  DELETE FROM public.memory_embedding_chunks WHERE memory_id = p_memory_id;

  INSERT INTO public.memory_embedding_chunks (
    memory_id, user_id, chunk_index, chunk_type, chunk_text, embedding, metadata
  )
  SELECT
    p_memory_id,
    p_user_id,
    (chunk->>'chunk_index')::integer,
    chunk->>'chunk_type',
    chunk->>'chunk_text',
    (chunk->>'embedding')::vector,
    COALESCE(chunk->'metadata', '{}'::jsonb)
  FROM jsonb_array_elements(COALESCE(p_chunks, '[]'::jsonb)) AS chunk;

  -- Merge, never replace. The caller's metadata snapshot was read before the
  -- embedding ran, and `version` does not move for a metadata-only write — so
  -- an unrelated update landing during the embed passes the fence and would
  -- still be erased by writing the whole object back. Only the keys this
  -- function owns are applied, on top of whatever the row holds right now.
  v_metadata := v_metadata || COALESCE(p_metadata_patch, '{}'::jsonb);

  IF p_metadata_remove IS NOT NULL THEN
    FOREACH v_key IN ARRAY p_metadata_remove LOOP
      v_metadata := v_metadata - v_key;
    END LOOP;
  END IF;

  UPDATE public.memories
  SET
    embedding = p_embedding::vector,
    embedding_chunks_version = p_chunks_version,
    embedding_chunk_count = p_chunk_count,
    metadata = v_metadata
  WHERE id = p_memory_id AND user_id = p_user_id;

  RETURN 'ok';
END;
$$;

-- The cleanup half, and it needs the same fence for the same reason. A slow
-- edit whose embedding provider fails must not delete the chunk rows and null
-- the vector that a newer, successful edit just wrote: the memory would be
-- left current in its text and unsearchable by every semantic path.
CREATE OR REPLACE FUNCTION public.clear_memory_embedding(
  p_memory_id uuid,
  p_user_id uuid,
  p_expected_version integer,
  p_metadata_remove text[] DEFAULT NULL
)
RETURNS text
LANGUAGE plpgsql
-- `extensions` is not decoration: pgvector lives there on Supabase, so pinning
-- the path to public alone makes `::vector` fail to resolve at RUNTIME, inside
-- a function that creates and replaces cleanly. Caught by executing it.
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_current_version integer;
  v_metadata jsonb;
  v_key text;
BEGIN
  SELECT version, COALESCE(metadata, '{}'::jsonb)
  INTO v_current_version, v_metadata
  FROM public.memories
  WHERE id = p_memory_id AND user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN 'missing';
  END IF;

  IF v_current_version IS DISTINCT FROM p_expected_version THEN
    RETURN 'superseded';
  END IF;

  -- Unconditional: chunk rows can exist for a memory whose metadata mentions
  -- no embedding at all, because remember() writes chunks before it updates
  -- the memory row. The row's opinion of its own embeddings is not evidence
  -- about the contents of the chunk table.
  DELETE FROM public.memory_embedding_chunks WHERE memory_id = p_memory_id;

  IF p_metadata_remove IS NOT NULL THEN
    FOREACH v_key IN ARRAY p_metadata_remove LOOP
      v_metadata := v_metadata - v_key;
    END LOOP;
  END IF;

  UPDATE public.memories
  SET
    embedding = NULL,
    embedding_chunks_version = NULL,
    embedding_chunk_count = NULL,
    metadata = v_metadata
  WHERE id = p_memory_id AND user_id = p_user_id;

  RETURN 'ok';
END;
$$;

COMMENT ON FUNCTION public.swap_memory_embedding IS
  'Atomically replace a memory''s chunk rows, primary vector and embedding metadata, refusing if the memory was revised since p_expected_version.';

COMMENT ON FUNCTION public.clear_memory_embedding IS
  'Atomically remove a memory''s chunk rows, primary vector and embedding metadata, refusing if the memory was revised since p_expected_version.';

-- Stale LLM extractions are a property of the TEXT, so they are invalidated
-- with the text edit rather than with the re-embed that follows it. If they
-- were only dropped as part of a successful swap, a failed or superseded embed
-- would leave them on the row and the next refresh — including a summary-only
-- one — would embed them again. Nothing in the server recomputes them; the
-- offline extract-memory-llm-views script does, from the corrected text.
--
-- A single UPDATE using the jsonb `-` operator, so there is no read-modify-
-- write window for a concurrent metadata change to fall into.
CREATE OR REPLACE FUNCTION public.invalidate_memory_extractions(
  p_memory_id uuid,
  p_user_id uuid
)
RETURNS void
LANGUAGE sql
SET search_path = public, pg_temp
AS $$
  UPDATE public.memories
  SET metadata = COALESCE(metadata, '{}'::jsonb) - 'llm_extractions'
  WHERE id = p_memory_id AND user_id = p_user_id;
$$;

COMMENT ON FUNCTION public.invalidate_memory_extractions IS
  'Drop cached llm_extractions from a memory whose text changed; they describe the superseded revision.';
