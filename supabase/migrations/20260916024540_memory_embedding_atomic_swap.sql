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

-- Stale LLM extractions are a property of the TEXT, so they have to go with
-- the text, in the same statement — not in a second call afterwards.
--
-- A separate invalidation is a window (Lumen, r3). A edits OldDB -> NewDB; B
-- edits NewDB -> LaterDB before A's invalidation lands; the archive trigger
-- has meanwhile snapshotted NewDB carrying OldDB's extractions into
-- memory_history, and clearing the CURRENT row afterwards cannot reach that
-- historical pair. A later restore brings the mismatch back. Faulting the
-- separate call was worse still: the edit reported success and the next embed
-- indexed OldDB into a memory that reads NewDB.
--
-- As a BEFORE UPDATE trigger there is no window at all: the row is never
-- written carrying extractions of text it no longer has, and the archive
-- trigger — also BEFORE UPDATE, reading only OLD — still records the previous
-- revision with the extractions that genuinely described it.
--
-- The second condition is what keeps a restore whole: a writer supplying a
-- DIFFERENT extraction object is stating extractions for the text it is
-- writing, and those are not stale. Only extractions carried over unchanged
-- from the previous revision are dropped.
CREATE OR REPLACE FUNCTION public.strip_stale_memory_extractions()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF (OLD.content IS DISTINCT FROM NEW.content OR OLD.summary IS DISTINCT FROM NEW.summary)
     AND NEW.metadata -> 'llm_extractions' IS NOT DISTINCT FROM OLD.metadata -> 'llm_extractions'
  THEN
    NEW.metadata := COALESCE(NEW.metadata, '{}'::jsonb) - 'llm_extractions';
  END IF;
  RETURN NEW;
END;
$$;

-- Named to sort after memory_update_archive so the ordering is deliberate
-- rather than incidental. Correctness does not depend on it — the archive
-- trigger reads OLD and this one writes NEW — but a reader should not have to
-- work that out.
DROP TRIGGER IF EXISTS memory_update_strip_stale_extractions ON public.memories;
CREATE TRIGGER memory_update_strip_stale_extractions
  BEFORE UPDATE ON public.memories
  FOR EACH ROW
  EXECUTE FUNCTION public.strip_stale_memory_extractions();

COMMENT ON FUNCTION public.strip_stale_memory_extractions IS
  'Drop llm_extractions carried unchanged across a text edit; they describe the superseded revision.';
