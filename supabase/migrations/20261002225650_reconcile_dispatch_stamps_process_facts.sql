-- Dispatch-stamp recovery judges the recipient by process facts, not by
-- ended_at (session lifecycle §6, task T6 c1516218).
--
-- reconcile_graph_dispatch_stamps (20260901084438) clears a stale dispatch
-- stamp when the recipient's turn is over and nothing of the recipient's on
-- the thread is alive. Two of its predicates read the session's terminal
-- columns, and both are agent-written: end_session and
-- update_session_state(status | lifecycle: completed) stamp them from inside
-- the very turn that is still working, and an ended session can be resumed.
--
--   1. The liveness veto skipped ended rows (`s.ended_at IS NULL`). A session
--      that ended its row mid-turn and was visibly alive (an open CLI turn, a
--      fresh poll, a recent running write) did not veto, so its dispatch was
--      cleared and the node re-dispatched onto live work. The veto now covers
--      every session of the recipient on the thread, ended or not.
--
--   2. The evidence counted `ended_at IS NOT NULL` and lifecycle 'completed'
--      as "the recipient's turn is over". Neither proves it. The evidence is
--      now only what the server writes when a turn dies: the shutdown
--      breadcrumb (`metadata.interruptedAt`, interrupt-active-runs.ts) or
--      lifecycle 'failed'. That is the case this function exists for, a turn
--      killed before it ran. A recipient that merely ended its session keeps
--      its stamp, which costs at most the existing 30-minute wait.
--
-- With neither predicate reading ended_at, the cutover that stops stamping it
-- (T11) does not change what this function clears. Everything else is
-- unchanged from 20260901084438, including the compare-and-set UPDATE.

CREATE OR REPLACE FUNCTION public.reconcile_graph_dispatch_stamps(
  p_stale_before timestamptz,
  p_live_window_ms integer DEFAULT 600000
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_since timestamptz := now() - make_interval(secs => p_live_window_ms / 1000.0);
  v_cleared jsonb;
BEGIN
  WITH g AS (
    SELECT tg.id,
           tg.user_id,
           coalesce(tg.thread_key, 'strategy:' || tg.id::text) AS tkey
    FROM task_groups tg
    WHERE tg.execution_model = 'graph'
      AND tg.status = 'active'
  ),
  targets AS (
    SELECT t.id,
           -- Captured so the UPDATE can prove the row did not change under it.
           t.metadata ->> 'graphDispatchedAt' AS stamp_text,
           t.metadata ->> 'graphDispatchedTo' AS recipient_text
    FROM tasks t
    JOIN g ON g.id = t.task_group_id
    CROSS JOIN LATERAL (
      SELECT public._graph_safe_ts(t.metadata ->> 'graphDispatchedAt') AS stamp_at,
             public._graph_safe_uuid(t.metadata ->> 'graphDispatchedTo') AS recipient
    ) st
    WHERE t.claimed_by_session_id IS NULL
      AND t.status <> 'completed'
      AND t.metadata ? 'graphDispatchedAt'
      AND st.stamp_at IS NOT NULL
      -- Too new to regard as stale, whoever wrote it (see 20260901084438).
      AND st.stamp_at < p_stale_before
      -- No recorded recipient, no recovery.
      AND st.recipient IS NOT NULL
      -- Nothing of the RECIPIENT'S on this thread still looks alive, ended or
      -- not: an ended row is not a stopped process.
      AND NOT EXISTS (
        SELECT 1
        FROM sessions s
        WHERE s.user_id = g.user_id
          AND s.sb_id = st.recipient
          AND (s.thread_key = g.tkey OR s.active_thread_key = g.tkey)
          AND (
            (s.cli_attached AND s.updated_at > v_since)
            OR (s.cli_poll_at IS NOT NULL AND s.cli_poll_at > v_since)
            OR (s.cli_turn_at IS NOT NULL AND s.cli_turn_at > v_since)
            OR (s.lifecycle = 'running' AND s.updated_at > v_since)
          )
      )
      -- The RECIPIENT'S own turn died, at or after this dispatch, by the
      -- server's own record of it: the shutdown breadcrumb or a crash.
      AND EXISTS (
        SELECT 1
        FROM sessions s
        WHERE s.user_id = g.user_id
          AND s.sb_id = st.recipient
          AND (s.thread_key = g.tkey OR s.active_thread_key = g.tkey)
          AND (
            s.metadata ? 'interruptedAt'
            OR s.lifecycle = 'failed'
          )
          AND coalesce(
                public._graph_safe_ts(s.metadata ->> 'interruptedAt'),
                s.updated_at
              ) >= st.stamp_at
      )
  ),
  updated AS (
    UPDATE tasks t
    SET metadata = t.metadata - 'graphDispatchedAt' - 'graphDispatchedTo'
    FROM targets tg
    WHERE t.id = tg.id
      -- Compare-and-set on the row as it exists AT UPDATE TIME (Lumen, PR
      -- #559 round 4): a dispatch committing while we wait on the row lock
      -- no longer matches the captured values and the row is skipped.
      AND t.metadata ->> 'graphDispatchedAt' IS NOT DISTINCT FROM tg.stamp_text
      AND t.metadata ->> 'graphDispatchedTo' IS NOT DISTINCT FROM tg.recipient_text
      AND t.claimed_by_session_id IS NULL
      AND t.status <> 'completed'
    RETURNING t.id
  )
  SELECT coalesce(jsonb_agg(u.id), '[]'::jsonb) INTO v_cleared FROM updated u;

  RETURN jsonb_build_object(
    'success', true,
    'cleared', jsonb_array_length(v_cleared),
    'taskIds', v_cleared
  );
END;
$$;

COMMENT ON FUNCTION public.reconcile_graph_dispatch_stamps(timestamptz, integer) IS
  'Clear stale graphDispatchedAt stamps so interrupted turns are re-dispatched on the next sweep. Requires the recorded recipient (graphDispatchedTo) to have a session on the group thread whose turn died at or after the stamp (the shutdown breadcrumb or lifecycle failed), and none of that recipient''s sessions, ended or not, to look alive; never touches claimed nodes, unattributed stamps, or stamps newer than p_stale_before.';

-- CREATE OR REPLACE keeps the function's ACL; restated so this file is correct
-- on its own (see 20260901084438 for why the roles must be named).
REVOKE ALL ON FUNCTION public.reconcile_graph_dispatch_stamps(timestamptz, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reconcile_graph_dispatch_stamps(timestamptz, integer) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_graph_dispatch_stamps(timestamptz, integer) TO service_role;
