-- Close the path-lock escapes (Lumen, PR #517 round 1 — all reproduced live):
--
--   1. Same-thread siblings both granted. A thread is not one writer: two
--      sessions on one thread write concurrently, and the v14 adoption rule
--      already refuses fresh/live same-thread holders at row level. The
--      sibling scan now has NO exceptions: ANY sibling lease conflicts.
--   2. A stale sibling was ignored, then its unlocked row-local renewal made
--      both leases fresh. Stale is not proof of departure (v14 §Liveness) —
--      the sweep's claim-and-rescue owns stale leases, not a fresh grant on a
--      sibling row. Stale siblings now conflict too; callers divert to
--      overflow while the sweep does its job.
--   3. Textual paths are not canonical backing identity: '/tmp/x' and
--      '/tmp/x/.' both granted, and a NULL path has no lock key or equality
--      at all. Paths are normalized (textually) for both the lock key and
--      sibling equality; NULL-path studios back no shared tree and fall back
--      to a row-scoped lock key. Symlink aliasing is documented out of scope:
--      worktree paths come from our own provisioning, which writes canonical
--      absolute paths; the normalizer guards textual drift, not the
--      filesystem graph.
--
-- Also: studio_path_conflict() — the SAME scan as a standalone, advisory-
-- locked check, for the recovery path to run AFTER claiming its row and
-- BEFORE any stash/reset mutates the tree (round-1 blocker 4: rescue could
-- stomp a live sibling writer's checkout and discover the conflict only at
-- handover).

CREATE OR REPLACE FUNCTION public.normalize_worktree_path(p text)
RETURNS text
LANGUAGE sql IMMUTABLE
AS $$
  SELECT CASE WHEN p IS NULL THEN NULL ELSE
    -- collapse '//'+, resolve '/./', strip trailing '/.' and trailing '/'
    regexp_replace(
      regexp_replace(
        regexp_replace(
          regexp_replace(p, '/{2,}', '/', 'g'),
        '/\./', '/', 'g'),
      '/\.$', ''),
    '/$', '')
  END
$$;

CREATE OR REPLACE FUNCTION public.grant_studio_lease(
  p_studio_id uuid,
  p_user_id uuid,
  p_lease jsonb,
  p_expected_prior jsonb DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_path text;
  v_lock_key text;
  v_conflict record;
  v_rows int;
BEGIN
  SELECT public.normalize_worktree_path(worktree_path) INTO v_path
    FROM studios
   WHERE id = p_studio_id AND user_id = p_user_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'lost');
  END IF;

  -- NULL-path studios back no shared tree: serialize on the row itself.
  v_lock_key := CASE
    WHEN v_path IS NULL OR v_path = ''
      THEN 'studio-row:' || p_studio_id::text
    ELSE 'studio-path:' || p_user_id::text || ':' || v_path
  END;
  PERFORM pg_advisory_xact_lock(hashtext(v_lock_key));

  IF v_path IS NOT NULL AND v_path <> '' THEN
    -- ANY sibling lease conflicts — no thread exception (a thread is not one
    -- writer), no staleness exception (stale is not proof of departure; the
    -- sweep rescues, we do not trample).
    SELECT s.id, s.lease INTO v_conflict
      FROM studios s
     WHERE s.user_id = p_user_id
       AND public.normalize_worktree_path(s.worktree_path) = v_path
       AND s.id <> p_studio_id
       AND s.lease IS NOT NULL
     LIMIT 1;
    IF FOUND THEN
      RETURN jsonb_build_object(
        'outcome', 'path-conflict',
        'conflictStudioId', v_conflict.id,
        'conflictHolder', v_conflict.lease
      );
    END IF;
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

-- Drop the old 5-arg signature so exactly one function remains.
DROP FUNCTION IF EXISTS public.grant_studio_lease(uuid, uuid, jsonb, jsonb, bigint);

-- The same scan as a standalone check, for recovery to run AFTER its row
-- claim and BEFORE any rescue mutates the tree. Advisory-locked so it cannot
-- interleave with a concurrent grant's scan+CAS.
CREATE OR REPLACE FUNCTION public.studio_path_conflict(
  p_studio_id uuid,
  p_user_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_path text;
  v_conflict record;
BEGIN
  SELECT public.normalize_worktree_path(worktree_path) INTO v_path
    FROM studios
   WHERE id = p_studio_id AND user_id = p_user_id;
  IF NOT FOUND OR v_path IS NULL OR v_path = '' THEN
    RETURN jsonb_build_object('conflict', false);
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('studio-path:' || p_user_id::text || ':' || v_path));

  SELECT s.id, s.lease INTO v_conflict
    FROM studios s
   WHERE s.user_id = p_user_id
     AND public.normalize_worktree_path(s.worktree_path) = v_path
     AND s.id <> p_studio_id
     AND s.lease IS NOT NULL
   LIMIT 1;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'conflict', true,
      'conflictStudioId', v_conflict.id,
      'conflictHolder', v_conflict.lease
    );
  END IF;
  RETURN jsonb_build_object('conflict', false);
END;
$$;

REVOKE ALL ON FUNCTION public.grant_studio_lease(uuid, uuid, jsonb, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.grant_studio_lease(uuid, uuid, jsonb, jsonb) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.grant_studio_lease(uuid, uuid, jsonb, jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.studio_path_conflict(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.studio_path_conflict(uuid, uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.studio_path_conflict(uuid, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.normalize_worktree_path(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.normalize_worktree_path(text) TO service_role;
