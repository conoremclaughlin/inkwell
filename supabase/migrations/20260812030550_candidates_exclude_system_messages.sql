-- Candidacy must be computed over DELIVERABLE messages (PR #473 round 4,
-- Lumen): system events (e.g. add_thread_participant's post-join marker) are
-- not channel-deliverable and never advance the pointer, so including them in
-- max(created_at) makes a thread with a trailing system event a PERMANENT
-- candidate the plugin can never ack away — twenty such threads starve real
-- unread work out of the page. The delivery fetch excludes system events
-- (includeSystemEvents:false); candidacy now matches it.

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
      AND t.status = 'open'
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
  'Delivery-poll thread candidacy: threads whose latest DELIVERABLE (non-system) message is newer than the agent''s read pointer (or join time). Exact, unpaged-scan, ordered newest-first with total count for truncation reporting. Spec: inkmail-read-state §4.';
