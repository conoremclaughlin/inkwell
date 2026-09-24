-- update_inbox_thread_metadata, after the inkmail thread-scope cutover.
--
-- 20260916020035 defined this function against the pre-cutover message row:
-- its timeline event was inserted with `sender_agent_id = 'system'` and nothing
-- else about the author. 20260913090000 (which sorts BEFORE it, so runs first)
-- made the author a principal: `sender_kind` is NOT NULL, a system message must
-- carry `sender_kind = 'system'` with both principal ids null, and
-- `inbox_thread_messages_slug_only_for_sb` forbids a slug on anything but an
-- SB. On a database that ran both in order the function was created fine —
-- plpgsql resolves columns at execution — and every title or summary edit
-- then failed at the audit INSERT, rolling the edit back with it. This is the
-- same function with the event written the way reopen_inbox_thread writes
-- its own (same migration, §2): the system borrows nobody's identity and the
-- actor lives in the event's metadata.
--
-- Everything else — the field flags, the attribution columns, the returned
-- timestamp, the one-transaction property — is unchanged from 20260916020035.

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

  -- The system's own event (spec inkmail-thread-scope §3): kind says system,
  -- both principal ids null, no slug — the editor is named in the metadata.
  INSERT INTO public.inbox_thread_messages (thread_id, sender_kind, content, message_type, metadata)
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
  'Edit an inbox thread title/summary and record the timeline event in one transaction. Returns the timestamp written. Raises if the thread does not exist, so a failed audit can never leave an unattributed edit behind. The event is a system-kind message (post-cutover principal columns).';
