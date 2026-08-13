-- Exact unread-thread candidacy for delivery polls (spec inkmail-read-state §4,
-- PR #473 round 3 — Lumen).
--
-- Why not thread.updated_at vs pointer: send_to_inbox bumps updated_at AFTER
-- the message insert with a later app timestamp, while the ack stores the
-- message's created_at — so a fully-acked thread keeps updated_at >
-- last_read_at and would remain a "candidate" forever, hogging page slots and
-- starving genuinely-unread threads. Candidacy must compare the pointer
-- against the exact LATEST MESSAGE timestamp, in SQL, with no client-side
-- pre-cap (threads beyond any fetch window must stay reachable).
--
-- Baseline matches the unread computation: last_read_at, else joined_at
-- (participants never replay pre-join history).

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
  'Delivery-poll thread candidacy: threads whose latest message is newer than the agent''s read pointer (or join time). Exact, unpaged-scan, ordered newest-first with total count for truncation reporting. Spec: inkmail-read-state §4.';
