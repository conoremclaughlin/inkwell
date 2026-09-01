-- Startup recovery for graph dispatch stamps (task cf92c746, direction 1).
--
-- The sweep stamps graphDispatchedAt on a node when it dispatches and skips
-- that node for 30 minutes afterwards. Right for a node a live session is
-- working; wrong for a turn that was killed before it ran, which then waits
-- out the whole window for a turn that is never coming.
--
-- The cleanup happens ENTIRELY IN SQL, for reasons found across two rounds of
-- review on PR #559 (Lumen):
--
--   1. ATOMICITY (r1). The first cut read each row's metadata, deleted one key
--      in JS, and wrote the whole JSONB back keyed only on task id. A dispatch
--      landing between the read and the write had its fresh stamp erased by a
--      stale snapshot. `metadata - 'graphDispatchedAt'` is applied in place
--      here, so no other key and no newer value is ever carried over.
--
--   2. OWNERSHIP (r1). The first cut assumed every dispatch stamp that
--      outlived a process was stale, on the theory that dispatched sessions
--      are always children of the dispatching server. That is FALSE: when a
--      CLI is attached or recently polling, the trigger deliberately skips
--      spawning (shouldSkipSpawn) and an existing CLI session takes the work.
--      That session outlives the server. A second API process against the same
--      database is the same failure.
--
--   3. EVIDENCE MUST BE ABOUT THIS DISPATCH (r2). Requiring "some finished
--      session on the thread" was not enough: that evidence is thread-wide and
--      PERMANENT, so one interrupted session last week would authorise
--      clearing every stamp written on that thread forever after. The gap that
--      opens is real — a freshly dispatched recipient that has not reached
--      `running` yet (or a legitimate turn quieter than the liveness window)
--      does not match `alive`, and its live stamp would be cleared. The
--      finished session must therefore have finished AT OR AFTER the stamp it
--      is being used to invalidate.
--
-- The rule: a stamp is cleared only when some session on the group's thread
-- finished at or after that stamp was written, AND no session on that thread
-- currently looks alive. Every uncertainty keeps the stamp, which costs at
-- most the existing 30-minute wait; guessing wrong costs a duplicate dispatch
-- onto live work.

-- A stamp is written by our own code as an ISO string, but a malformed value
-- must not abort the whole reconciliation with a cast error.
CREATE OR REPLACE FUNCTION public._graph_safe_ts(p text)
RETURNS timestamptz
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
  RETURN p::timestamptz;
EXCEPTION
  WHEN others THEN
    RETURN NULL;
END;
$$;

COMMENT ON FUNCTION public._graph_safe_ts(text) IS
  'Internal. Parse a timestamptz, or NULL if unparseable, so one bad dispatch stamp cannot abort reconciliation.';

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
  -- Anything that still looks alive on the thread vetoes the whole group. A
  -- CLI-attached or polling session is the case round 1 got wrong: it holds
  -- the dispatch without a claim and survives a server restart.
  alive AS (
    SELECT DISTINCT g.id
    FROM g
    JOIN sessions s
      ON s.user_id = g.user_id
     AND (s.thread_key = g.tkey OR s.active_thread_key = g.tkey)
    WHERE s.ended_at IS NULL
      AND (
        (s.cli_attached AND s.updated_at > v_since)
        OR (s.cli_poll_at IS NOT NULL AND s.cli_poll_at > v_since)
        OR (s.cli_turn_at IS NOT NULL AND s.cli_turn_at > v_since)
        OR (s.lifecycle = 'running' AND s.updated_at > v_since)
      )
  ),
  targets AS (
    SELECT t.id
    FROM tasks t
    JOIN g ON g.id = t.task_group_id
    CROSS JOIN LATERAL (
      SELECT public._graph_safe_ts(t.metadata ->> 'graphDispatchedAt') AS stamp_at
    ) st
    WHERE t.claimed_by_session_id IS NULL
      AND t.status <> 'completed'
      AND t.metadata ? 'graphDispatchedAt'
      AND st.stamp_at IS NOT NULL
      -- A stamp at or after p_stale_before belongs to the caller's own run and
      -- is never stale. This is what makes a concurrent dispatch safe without
      -- a separate CAS: its stamp is newer than the cutoff and drops out here.
      AND st.stamp_at < p_stale_before
      AND NOT EXISTS (SELECT 1 FROM alive a WHERE a.id = g.id)
      -- Evidence scoped to THIS stamp: a session on the thread that finished
      -- at or after the dispatch was written. Older terminal sessions prove
      -- nothing about a dispatch that came later.
      AND EXISTS (
        SELECT 1
        FROM sessions s
        WHERE s.user_id = g.user_id
          AND (s.thread_key = g.tkey OR s.active_thread_key = g.tkey)
          AND (
            s.metadata ? 'interruptedAt'
            OR s.ended_at IS NOT NULL
            OR s.lifecycle IN ('failed', 'completed')
          )
          AND coalesce(
                public._graph_safe_ts(s.metadata ->> 'interruptedAt'),
                s.ended_at,
                s.updated_at
              ) >= st.stamp_at
      )
  ),
  updated AS (
    UPDATE tasks t
    SET metadata = t.metadata - 'graphDispatchedAt'
    WHERE t.id IN (SELECT id FROM targets)
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
  'Clear stale graphDispatchedAt stamps so interrupted turns are re-dispatched on the next sweep. Requires a session on the group thread that finished at or after the stamp, and no live session on that thread; never touches claimed nodes or stamps newer than p_stale_before.';

-- ---------------------------------------------------------------------------
-- Privileges
--
-- SECURITY DEFINER + PostgreSQL's default PUBLIC EXECUTE is a cross-user
-- mutator reachable by any PostgREST caller holding the anon or authenticated
-- role. reconcile_graph_dispatch_stamps takes no user id at all — it operates
-- over every active graph group — so it is the last function that should be
-- callable by anyone but the server (Lumen, PR #559 round 2 P0).
--
-- claim_graph_task already follows this pattern; this one did not.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.reconcile_graph_dispatch_stamps(timestamptz, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reconcile_graph_dispatch_stamps(timestamptz, integer) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_graph_dispatch_stamps(timestamptz, integer) TO service_role;

REVOKE ALL ON FUNCTION public._graph_safe_ts(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._graph_safe_ts(text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public._graph_safe_ts(text) TO service_role;

-- add_graph_nodes shipped in #555 with the same default-PUBLIC hole, and it is
-- a SECURITY DEFINER mutator that writes graph nodes and edges. It is not this
-- PR's feature, but it is the same defect, I introduced it, and leaving a known
-- hole open next to the one being closed is not defensible. The wider audit —
-- 77 of 94 public functions are anon-executable — is deliberately NOT attempted
-- here; it needs the threat model settled first and is filed separately.
REVOKE ALL ON FUNCTION public.add_graph_nodes(uuid, uuid, bigint, jsonb, jsonb, uuid, uuid, boolean, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.add_graph_nodes(uuid, uuid, bigint, jsonb, jsonb, uuid, uuid, boolean, text, text, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.add_graph_nodes(uuid, uuid, bigint, jsonb, jsonb, uuid, uuid, boolean, text, text, text) TO service_role;
