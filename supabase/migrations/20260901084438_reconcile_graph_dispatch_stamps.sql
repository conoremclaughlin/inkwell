-- Startup recovery for graph dispatch stamps (task cf92c746, direction 1).
--
-- The sweep stamps graphDispatchedAt on a node when it dispatches and skips
-- that node for 30 minutes afterwards. Right for a node a live session is
-- working; wrong for a turn that was killed before it ran, which then waits
-- out the whole window for a turn that is never coming.
--
-- This runs the cleanup ENTIRELY IN SQL, for two reasons found in review of
-- PR #559 (Lumen):
--
--   1. ATOMICITY. The first cut read each row's metadata, deleted one key in
--      JS, and wrote the whole JSONB back keyed only on task id. A dispatch
--      landing between the read and the write had its fresh stamp erased by a
--      stale snapshot. `metadata - 'graphDispatchedAt'` is applied in place
--      here, so no other key and no newer value is ever carried over.
--
--   2. OWNERSHIP. The first cut assumed every dispatch stamp that outlived a
--      process was stale, on the theory that dispatched sessions are always
--      children of the dispatching server. That is FALSE: when a CLI is
--      attached or recently polling, the trigger deliberately skips spawning
--      (shouldSkipSpawn) and an existing CLI session takes the work. That
--      session outlives the server. A second API process against the same
--      database is the same failure. So this refuses to infer death from a
--      restart, and instead requires positive evidence per group.
--
-- The rule: a group's stamps are cleared only when some session on its thread
-- is PROVABLY finished (a shutdown interrupt breadcrumb, an ended_at, or a
-- terminal lifecycle) AND no session on that thread currently looks alive.
-- Every uncertainty keeps the stamp, which costs at most the existing 30-minute
-- wait; guessing wrong costs a duplicate dispatch onto live work.

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
  'Parse a timestamptz, or NULL if unparseable. Used so one bad dispatch stamp cannot abort reconciliation.';

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
  -- Positive evidence that the turn on this thread is over. interruptedAt is
  -- the breadcrumb the shutdown path writes (interrupt-active-runs.ts); the
  -- other two cover sessions that ended normally or died reporting failure.
  dead AS (
    SELECT DISTINCT g.id
    FROM g
    JOIN sessions s
      ON s.user_id = g.user_id
     AND (s.thread_key = g.tkey OR s.active_thread_key = g.tkey)
    WHERE s.metadata ? 'interruptedAt'
       OR s.ended_at IS NOT NULL
       OR s.lifecycle IN ('failed', 'completed')
  ),
  -- Anything that still looks alive on the thread vetoes the whole group. A
  -- CLI-attached or polling session is the case the first cut got wrong: it
  -- holds the dispatch without a claim and survives a server restart.
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
    WHERE t.claimed_by_session_id IS NULL
      AND t.status <> 'completed'
      AND t.metadata ? 'graphDispatchedAt'
      -- A stamp at or after p_stale_before belongs to the caller's own run and
      -- is never stale. This is what makes a concurrent dispatch safe without
      -- a separate CAS: its stamp is newer than the cutoff and drops out here.
      AND public._graph_safe_ts(t.metadata ->> 'graphDispatchedAt') < p_stale_before
      AND g.id IN (SELECT id FROM dead)
      AND g.id NOT IN (SELECT id FROM alive)
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
  'Clear stale graphDispatchedAt stamps so interrupted turns are re-dispatched on the next sweep. Requires positive evidence of a finished session on the group thread and no live session on it; never touches claimed nodes or stamps newer than p_stale_before.';
