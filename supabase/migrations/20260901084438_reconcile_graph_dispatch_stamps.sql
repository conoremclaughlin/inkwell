-- Startup recovery for graph dispatch stamps (task cf92c746, direction 1).
--
-- The sweep stamps graphDispatchedAt on a node when it dispatches and skips
-- that node for 30 minutes afterwards. Right for a node a live session is
-- working; wrong for a turn that was killed before it ran, which then waits
-- out the whole window for a turn that is never coming.
--
-- The cleanup happens ENTIRELY IN SQL. What it is allowed to clear narrowed
-- across three rounds of review on PR #559 (Lumen), each round removing an
-- assumption that turned out to be false:
--
--   1. ATOMICITY (r1). The first cut read each row's metadata, deleted one key
--      in JS, and wrote the whole JSONB back keyed only on task id. A dispatch
--      landing between the read and the write had its fresh stamp erased by a
--      stale snapshot. `metadata - 'graphDispatchedAt'` is applied in place.
--
--   2. OWNERSHIP (r1). The first cut assumed every dispatch stamp that
--      outlived a process was stale, on the theory that dispatched sessions
--      are always children of the dispatching server. FALSE: when a CLI is
--      attached or recently polling, the trigger skips spawning
--      (shouldSkipSpawn) and an existing CLI session takes the work, then
--      outlives the server. A second API process is the same failure.
--
--   3. EVIDENCE MUST POST-DATE THE STAMP (r2). "Some finished session on the
--      thread" is thread-wide and PERMANENT, so one interrupted session would
--      authorise clearing every stamp written on that thread ever after.
--
--   4. EVIDENCE MUST BE ABOUT THE RECIPIENT (r3). Time-scoping still let any
--      OTHER agent's finished session on a multi-agent thread vouch for this
--      dispatch. A thread routinely carries several agents — a work node's
--      owner and a gate's reviewer sit on the same thread_key — so this is the
--      normal case, not an exotic one. Both the evidence and the liveness veto
--      are now scoped to the identity the dispatch actually went to
--      (tasks.metadata->>'graphDispatchedTo', matching sessions.sb_id).
--
-- The rule: a stamp is cleared only when the session that RECEIVED it has
-- finished at or after the stamp was written, and nothing of that recipient's
-- on the thread still looks alive. A stamp with no recorded recipient never
-- qualifies — that fails closed for pre-existing stamps and self-heals on the
-- next dispatch. Every uncertainty keeps the stamp, which costs at most the
-- existing 30-minute wait; guessing wrong costs a duplicate dispatch onto live
-- work.

-- Stamps are written by our own code, but a malformed value must not abort the
-- whole reconciliation with a cast error.
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

CREATE OR REPLACE FUNCTION public._graph_safe_uuid(p text)
RETURNS uuid
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
  RETURN p::uuid;
EXCEPTION
  WHEN others THEN
    RETURN NULL;
END;
$$;

COMMENT ON FUNCTION public._graph_safe_uuid(text) IS
  'Internal. Parse a uuid, or NULL if unparseable, so one bad recipient stamp cannot abort reconciliation.';

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
      -- A stamp at or after p_stale_before belongs to the caller's own run and
      -- is never stale. This is what makes a concurrent dispatch safe without
      -- a separate CAS: its stamp is newer than the cutoff and drops out here.
      AND st.stamp_at < p_stale_before
      -- No recorded recipient, no recovery. Nothing else can be established
      -- about who was supposed to act on it.
      AND st.recipient IS NOT NULL
      -- Nothing of the RECIPIENT'S on this thread still looks alive. A
      -- CLI-attached or polling session is the case round 1 got wrong: it
      -- holds the dispatch without a claim and survives a server restart.
      AND NOT EXISTS (
        SELECT 1
        FROM sessions s
        WHERE s.user_id = g.user_id
          AND s.sb_id = st.recipient
          AND (s.thread_key = g.tkey OR s.active_thread_key = g.tkey)
          AND s.ended_at IS NULL
          AND (
            (s.cli_attached AND s.updated_at > v_since)
            OR (s.cli_poll_at IS NOT NULL AND s.cli_poll_at > v_since)
            OR (s.cli_turn_at IS NOT NULL AND s.cli_turn_at > v_since)
            OR (s.lifecycle = 'running' AND s.updated_at > v_since)
          )
      )
      -- The RECIPIENT'S own turn is over, and it ended at or after this
      -- dispatch. Another agent's finished session proves nothing about it,
      -- and neither does one of the recipient's that ended before it.
      AND EXISTS (
        SELECT 1
        FROM sessions s
        WHERE s.user_id = g.user_id
          AND s.sb_id = st.recipient
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
    SET metadata = t.metadata - 'graphDispatchedAt' - 'graphDispatchedTo'
    FROM targets tg
    WHERE t.id = tg.id
      -- Compare-and-set on the row as it exists AT UPDATE TIME. `targets` is
      -- evaluated against this statement's snapshot; if a concurrent dispatch
      -- commits while the UPDATE waits on the row lock, Postgres re-checks
      -- these quals against the newly committed version, they no longer match
      -- the captured values, and the row is skipped. Matching on id alone
      -- would delete that fresh stamp — validated old, wrote new (Lumen, PR
      -- #559 round 4, reproduced on PG 17.6).
      AND t.metadata ->> 'graphDispatchedAt' IS NOT DISTINCT FROM tg.stamp_text
      AND t.metadata ->> 'graphDispatchedTo' IS NOT DISTINCT FROM tg.recipient_text
      -- Re-checked for the same reason: a claim or completion landing in that
      -- window means somebody took the work while we waited.
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
  'Clear stale graphDispatchedAt stamps so interrupted turns are re-dispatched on the next sweep. Requires the recorded recipient (graphDispatchedTo) to have a session on the group thread that finished at or after the stamp, and none of that recipient''s sessions to look alive; never touches claimed nodes, unattributed stamps, or stamps newer than p_stale_before.';

-- ---------------------------------------------------------------------------
-- Privileges
--
-- SECURITY DEFINER plus Supabase's default ACLs is a cross-user mutator
-- reachable by any PostgREST caller holding anon or authenticated.
-- reconcile_graph_dispatch_stamps takes no user id at all — it operates over
-- every active graph group — so it is the last function that should be
-- callable by anyone but the server (Lumen, PR #559 round 2 P0).
--
-- REVOKE ... FROM PUBLIC alone is NOT enough here, and that is not obvious.
-- Supabase installs ALTER DEFAULT PRIVILEGES (grantors supabase_admin and
-- postgres) that grant EXECUTE on public functions EXPLICITLY to anon and
-- authenticated. Measured on a scratch function:
--   CREATE                                  -> anon=true  authenticated=true
--   REVOKE ALL ... FROM PUBLIC              -> anon=true  authenticated=true
--   REVOKE ALL ... FROM anon, authenticated -> anon=false authenticated=false
-- So the roles must be named. claim_graph_task does this and measures locked;
-- a revoke that names only PUBLIC is decorative.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.reconcile_graph_dispatch_stamps(timestamptz, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reconcile_graph_dispatch_stamps(timestamptz, integer) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_graph_dispatch_stamps(timestamptz, integer) TO service_role;

REVOKE ALL ON FUNCTION public._graph_safe_ts(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._graph_safe_ts(text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public._graph_safe_ts(text) TO service_role;

REVOKE ALL ON FUNCTION public._graph_safe_uuid(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._graph_safe_uuid(text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public._graph_safe_uuid(text) TO service_role;

-- add_graph_nodes (#555) already revokes from PUBLIC, so this looks redundant
-- and was challenged in review as such. It is not: by the mechanism above,
-- that revoke leaves anon and authenticated holding EXECUTE, and the function
-- measures anon-executable on a database built from migrations. It is a
-- SECURITY DEFINER mutator that writes graph nodes and edges. The one-line
-- completion belongs next to the identical fix rather than in a backlog; the
-- integration suite asserts it through a real anon-key client. The wider sweep
-- — 77 of 94 public functions are anon-executable — is deliberately NOT
-- attempted here and is filed separately.
REVOKE ALL ON FUNCTION public.add_graph_nodes(uuid, uuid, bigint, jsonb, jsonb, uuid, uuid, boolean, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.add_graph_nodes(uuid, uuid, bigint, jsonb, jsonb, uuid, uuid, boolean, text, text, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.add_graph_nodes(uuid, uuid, bigint, jsonb, jsonb, uuid, uuid, boolean, text, text, text) TO service_role;
