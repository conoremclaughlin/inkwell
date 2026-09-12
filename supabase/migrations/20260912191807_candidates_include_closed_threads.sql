-- Closed is a work-state signal, not a delivery filter (spec
-- inkmail-thread-scope §2). A closed thread accepts replies, and a reply on a
-- closed thread is unread until its recipient reads it — so candidacy must
-- see it. The previous definition (20260812030550) scoped candidates to
-- t.status = 'open', which made such a reply stored but undeliverable: the
-- channel poll never offered it, and the unread count never showed it.
--
-- Only the status predicate is removed. Everything else — deliverable
-- (non-system) messages only, the per-agent read pointer with join time as
-- the floor, newest-first ordering, and the total for truncation reporting —
-- is unchanged. list_threads(status='open') remains the explicit work-list
-- filter; it is not a delivery path.

CREATE OR REPLACE FUNCTION public.get_unread_thread_candidates(
  p_user_id uuid,
  p_agent_id text,
  p_session_id uuid DEFAULT NULL,
  p_limit int DEFAULT 20
)
RETURNS TABLE (
  thread_id uuid,
  latest_message_at timestamptz,
  total_candidates bigint
)
LANGUAGE sql
STABLE
AS $$
  WITH scoped AS (
    SELECT p.thread_id, p.joined_at
    FROM public.inbox_thread_participants p
    JOIN public.inbox_threads t ON t.id = p.thread_id
    WHERE t.user_id = p_user_id
      AND p.agent_id = p_agent_id
      AND (p_session_id IS NULL OR p.session_id = p_session_id)
  ),
  latest AS (
    SELECT m.thread_id, max(m.created_at) AS latest_message_at
    FROM public.inbox_thread_messages m
    JOIN scoped s ON s.thread_id = m.thread_id
    WHERE m.message_type <> 'system'
    GROUP BY m.thread_id
  ),
  candidates AS (
    SELECT l.thread_id, l.latest_message_at
    FROM latest l
    JOIN scoped s ON s.thread_id = l.thread_id
    LEFT JOIN public.inbox_thread_read_status rs
      ON rs.thread_id = l.thread_id AND rs.agent_id = p_agent_id
    WHERE l.latest_message_at > COALESCE(rs.last_read_at, s.joined_at)
  )
  SELECT c.thread_id, c.latest_message_at,
         (SELECT count(*) FROM candidates) AS total_candidates
  FROM candidates c
  ORDER BY c.latest_message_at DESC
  LIMIT p_limit;
$$;

COMMENT ON FUNCTION public.get_unread_thread_candidates(uuid, text, uuid, int) IS
  'Delivery-poll thread candidacy: threads, open or closed, whose latest DELIVERABLE (non-system) message is newer than the agent''s read pointer (or join time). Closed is a work-state signal, not a delivery filter. Exact, unpaged-scan, ordered newest-first with total count for truncation reporting. Spec: inkmail-read-state §4; inkmail-thread-scope §2.';
