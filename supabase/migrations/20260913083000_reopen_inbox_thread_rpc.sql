-- reopen_inbox_thread: the reopen flip and its audit event in one transaction
-- Spec: ink://specs/inkmail-thread-scope §2, §6 (reopen is explicit, atomic,
-- audited, wakes nobody). PR #615.
--
-- Two PostgREST round trips — UPDATE, then INSERT — are two transactions. A
-- rejected audit INSERT left the thread reopened with no event, and a retry
-- saw "already open" and never wrote the event (Lumen, #615 review). One
-- function is one transaction: either the row flips AND the event lands, or
-- neither does.
--
-- Returns true when this call reopened the thread. Returns false when the row
-- was not closed at the moment of the write (already open, or reopened by a
-- concurrent caller) — nothing is written in that case.

CREATE OR REPLACE FUNCTION public.reopen_inbox_thread(
  p_thread_id uuid,
  p_actor_kind text,
  p_actor_agent_id text DEFAULT NULL
) RETURNS boolean
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_updated integer;
BEGIN
  IF p_actor_kind NOT IN ('sb', 'user') THEN
    RAISE EXCEPTION 'reopen_inbox_thread: actor kind must be sb or user, got %', p_actor_kind;
  END IF;
  IF p_actor_kind = 'sb' AND (p_actor_agent_id IS NULL OR p_actor_agent_id = '') THEN
    RAISE EXCEPTION 'reopen_inbox_thread: an sb actor needs an agent id';
  END IF;

  -- Guarded on the row still being closed: two reopens racing each other, or
  -- a reopen racing a close, cannot both claim to have done it.
  UPDATE public.inbox_threads
     SET status = 'open',
         closed_at = NULL,
         closed_by_agent_id = NULL,
         updated_at = now()
   WHERE id = p_thread_id
     AND status = 'closed';
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated = 0 THEN
    RETURN false;
  END IF;

  -- The audit event. The actor lands in metadata for now; the principal
  -- columns of spec §3 give it a real home at the cutover.
  INSERT INTO public.inbox_thread_messages (thread_id, sender_agent_id, content, message_type, metadata)
  VALUES (
    p_thread_id,
    'system',
    CASE WHEN p_actor_kind = 'sb'
         THEN 'Thread reopened by ' || p_actor_agent_id
         ELSE 'Thread reopened by the workspace owner' END,
    'system',
    CASE WHEN p_actor_kind = 'sb'
         THEN jsonb_build_object('type', 'thread_reopened', 'reopenedBy', p_actor_agent_id)
         ELSE jsonb_build_object('type', 'thread_reopened', 'reopenedBy', 'user', 'channel', 'admin-api') END
  );
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.reopen_inbox_thread(uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reopen_inbox_thread(uuid, text, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reopen_inbox_thread(uuid, text, text) TO service_role;

COMMENT ON FUNCTION public.reopen_inbox_thread(uuid, text, text) IS
  'Reopen a closed inbox thread and record the audit event in one transaction. true = reopened by this call; false = the row was not closed (nothing written). Spec inkmail-thread-scope §2.';
