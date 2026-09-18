-- update_inbox_thread_metadata: the title/summary edit and its audit event in
-- one transaction. PR #641, Lumen's review.
--
-- This is the second time the same shape has been caught in the same table. In
-- #615 it was reopen: UPDATE then INSERT as two PostgREST round trips are two
-- transactions, so a rejected audit INSERT left the row flipped with no event.
-- The first cut of update_thread did exactly that again — worse, it discarded
-- the INSERT's error entirely, so a failed audit returned success: true while
-- the edit sat in the table with nothing recording who made it. In the
-- slug-only attribution case the timeline message is the ONLY durable record of
-- the editor, so losing it loses the attribution the response was promising.
--
-- A repeat finding in the same path means the design is wrong, not that the
-- patch was missed: any edit to inbox_threads that owes the timeline an event
-- belongs in a function, not in two calls from TypeScript.
--
-- Returns the timestamp actually written, so the caller reports the stored
-- instant rather than an app-side guess at it.

CREATE OR REPLACE FUNCTION public.update_inbox_thread_metadata(
  p_thread_id uuid,
  p_set_title boolean,
  p_title text,
  p_set_summary boolean,
  p_summary text,
  p_editor_sb_id uuid,
  p_editor_slug text,
  p_attributed_by text
) RETURNS timestamptz
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_now timestamptz := now();
  v_updated integer;
  v_fields text[] := ARRAY[]::text[];
  v_metadata jsonb;
BEGIN
  -- "Neither field provided" is a caller error, not a silent no-op that still
  -- writes a "nothing updated" event to the timeline.
  IF NOT p_set_title AND NOT p_set_summary THEN
    RAISE EXCEPTION 'update_inbox_thread_metadata: provide at least one of title or summary';
  END IF;
  IF p_editor_slug IS NULL OR p_editor_slug = '' THEN
    RAISE EXCEPTION 'update_inbox_thread_metadata: an editor slug is required';
  END IF;
  IF p_attributed_by NOT IN ('identity', 'slug-only') THEN
    RAISE EXCEPTION 'update_inbox_thread_metadata: attributed_by must be identity or slug-only, got %', p_attributed_by;
  END IF;

  -- array_append, not `|| 'title'`: with an untyped literal the || operator
  -- resolves to array || array and fails with "malformed array literal".
  IF p_set_title THEN v_fields := array_append(v_fields, 'title'); END IF;
  IF p_set_summary THEN v_fields := array_append(v_fields, 'summary'); END IF;

  -- Each field is written only when its p_set_* flag says so. A NULL p_title
  -- with p_set_title true is an explicit clear; a NULL p_title with the flag
  -- false must leave the column alone. Collapsing those two is how a caller
  -- editing only the summary silently wipes the title.
  UPDATE public.inbox_threads
     SET title = CASE WHEN p_set_title THEN p_title ELSE title END,
         title_updated_by_sb_id = CASE WHEN p_set_title THEN p_editor_sb_id ELSE title_updated_by_sb_id END,
         title_updated_at = CASE WHEN p_set_title THEN v_now ELSE title_updated_at END,
         summary = CASE WHEN p_set_summary THEN p_summary ELSE summary END,
         summary_updated_by_sb_id = CASE WHEN p_set_summary THEN p_editor_sb_id ELSE summary_updated_by_sb_id END,
         summary_updated_at = CASE WHEN p_set_summary THEN v_now ELSE summary_updated_at END,
         updated_at = v_now
   WHERE id = p_thread_id;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated = 0 THEN
    RAISE EXCEPTION 'update_inbox_thread_metadata: thread % not found', p_thread_id;
  END IF;

  v_metadata := jsonb_build_object(
    'type', 'thread_metadata_updated',
    'updatedBy', p_editor_slug,
    'updatedBySbId', p_editor_sb_id,
    'attributedBy', p_attributed_by,
    'updatedFields', to_jsonb(v_fields)
  );
  IF p_set_title THEN
    v_metadata := v_metadata || jsonb_build_object('title', p_title);
  END IF;
  IF p_set_summary THEN
    v_metadata := v_metadata || jsonb_build_object('summary', p_summary);
  END IF;

  INSERT INTO public.inbox_thread_messages (thread_id, sender_agent_id, content, message_type, metadata)
  VALUES (
    p_thread_id,
    'system',
    'Thread ' || array_to_string(v_fields, ' and ') || ' updated by ' || p_editor_slug,
    'system',
    v_metadata
  );

  RETURN v_now;
END;
$$;

REVOKE ALL ON FUNCTION public.update_inbox_thread_metadata(uuid, boolean, text, boolean, text, uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.update_inbox_thread_metadata(uuid, boolean, text, boolean, text, uuid, text, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_inbox_thread_metadata(uuid, boolean, text, boolean, text, uuid, text, text) TO service_role;

COMMENT ON FUNCTION public.update_inbox_thread_metadata(uuid, boolean, text, boolean, text, uuid, text, text) IS
  'Edit an inbox thread title/summary and record the timeline event in one transaction. Returns the timestamp written. Raises if the thread does not exist, so a failed audit can never leave an unattributed edit behind.';
