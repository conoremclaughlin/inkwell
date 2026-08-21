-- Path-serialized lease grants (Phase 6b; task c82daba1 work item a; Lumen
-- PR #516 r2 condition 3).
--
-- The lease is a write lock on the WORKING TREE, but rows are the lock's
-- storage unit and several rows can name the same tree: resolveMainStudio
-- gives each SB its own row for the same checkout ((worktree_path, agent_id)
-- unique index — live: pcp main has 3 rows, inkread 2). Row-scoped CAS
-- therefore admits two concurrent writers to one tree: both scan, both see
-- their own row vacant, both grant.
--
-- Scanning sibling rows first and then CASing is STILL racy — two callers on
-- two rows both pass the scan before either writes. The check and the grant
-- must be one atomic unit at the layer every path converges: a SQL function
-- holding an advisory xact lock on the canonical backing identity
-- (user_id + worktree_path) across scan AND grant.
--
-- Grant semantics preserved exactly from the JS ladder (spec v14 §invariants:
-- one grant site, validated snapshot, exact-prior-lease CAS for handovers):
--   p_expected_prior IS NULL     → vacant grant  (lease IS NULL + acquirable)
--   p_expected_prior IS NOT NULL → handover/adopt grant (exact prior match
--                                  incl. heartbeatAt + acquirable)
--
-- A sibling lease conflicts only when it is a DIFFERENT thread's and fresh
-- (heartbeat within p_stale_ms — same constant as the JS staleness rule,
-- passed in so there is one source of truth). A stale sibling is reclaimable
-- by the sweep and must not block; a same-thread sibling is this thread
-- already holding the tree through another row, not a second writer.

CREATE OR REPLACE FUNCTION public.grant_studio_lease(
  p_studio_id uuid,
  p_user_id uuid,
  p_lease jsonb,
  p_expected_prior jsonb DEFAULT NULL,
  p_stale_ms bigint DEFAULT 1800000
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_path text;
  v_conflict record;
  v_rows int;
BEGIN
  SELECT worktree_path INTO v_path
    FROM studios
   WHERE id = p_studio_id AND user_id = p_user_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'lost');
  END IF;

  -- Serialize every grant attempt against this backing tree.
  PERFORM pg_advisory_xact_lock(hashtext('studio-path:' || p_user_id::text || ':' || v_path));

  -- Path-wide conflict scan, atomic with the grant below by virtue of the lock.
  SELECT s.id, s.lease INTO v_conflict
    FROM studios s
   WHERE s.user_id = p_user_id
     AND s.worktree_path = v_path
     AND s.id <> p_studio_id
     AND s.lease IS NOT NULL
     AND s.lease->>'threadKey' IS DISTINCT FROM p_lease->>'threadKey'
     AND (
       COALESCE(
         (s.lease->>'heartbeatAt')::timestamptz,
         (s.lease->>'acquiredAt')::timestamptz
       ) > now() - make_interval(secs => p_stale_ms / 1000.0)
     )
   LIMIT 1;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'outcome', 'path-conflict',
      'conflictStudioId', v_conflict.id,
      'conflictHolder', v_conflict.lease
    );
  END IF;

  IF p_expected_prior IS NULL THEN
    UPDATE studios
       SET lease = p_lease
     WHERE id = p_studio_id
       AND user_id = p_user_id
       AND status IN ('active', 'idle')
       AND lease IS NULL;
  ELSE
    UPDATE studios
       SET lease = p_lease
     WHERE id = p_studio_id
       AND user_id = p_user_id
       AND status IN ('active', 'idle')
       AND lease->>'sessionId' = p_expected_prior->>'sessionId'
       AND lease->>'acquiredAt' = p_expected_prior->>'acquiredAt'
       AND lease->>'heartbeatAt' = p_expected_prior->>'heartbeatAt';
  END IF;
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  IF v_rows = 1 THEN
    RETURN jsonb_build_object('outcome', 'granted');
  END IF;
  RETURN jsonb_build_object('outcome', 'lost');
END;
$$;

REVOKE ALL ON FUNCTION public.grant_studio_lease(uuid, uuid, jsonb, jsonb, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.grant_studio_lease(uuid, uuid, jsonb, jsonb, bigint) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.grant_studio_lease(uuid, uuid, jsonb, jsonb, bigint) TO service_role;
