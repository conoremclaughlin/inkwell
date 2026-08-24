-- Round 3 of PR #517 (Lumen — both defects reproduced live):
--
--   P0-2: worktree_path was a mutable side door. Grant A@P1 and B@P2, then
--   UPDATE A's path to 'P2/.' — two fresh leases on one canonical backing,
--   installed AROUND the grant fence. The path column is part of the lock's
--   identity, so it gets the same integrity treatment as the lease itself:
--   a leased row's path is immutable, and a path change may not move a row
--   onto a canonical backing that any leased row already occupies (checked
--   under the same advisory lock the grants use).
--
--   P0-3: NULL/empty-path rows got independent row-scoped locks, but at
--   runtime every pathless studio executes in the SAME shared
--   defaultWorkingDirectory — independent locks let two writers into one
--   real tree. Pathless rows are now ONE backing class per user: shared
--   lock key, mutual sibling conflicts.

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
  v_pathless boolean;
  v_conflict record;
  v_rows int;
BEGIN
  SELECT public.normalize_worktree_path(worktree_path) INTO v_path
    FROM studios
   WHERE id = p_studio_id AND user_id = p_user_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'lost');
  END IF;

  v_pathless := (v_path IS NULL OR v_path = '');
  -- Pathless studios all execute in the shared defaultWorkingDirectory at
  -- runtime — ONE canonical backing per user, not one per row (P0-3).
  PERFORM pg_advisory_xact_lock(hashtext(
    CASE WHEN v_pathless
      THEN 'studio-pathless:' || p_user_id::text
      ELSE 'studio-path:' || p_user_id::text || ':' || v_path
    END
  ));

  SELECT s.id, s.lease INTO v_conflict
    FROM studios s
   WHERE s.user_id = p_user_id
     AND s.id <> p_studio_id
     AND s.lease IS NOT NULL
     AND (
       CASE WHEN v_pathless
         THEN COALESCE(public.normalize_worktree_path(s.worktree_path), '') = ''
         ELSE public.normalize_worktree_path(s.worktree_path) = v_path
       END
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
    UPDATE studios SET lease = p_lease
     WHERE id = p_studio_id AND user_id = p_user_id
       AND status IN ('active', 'idle') AND lease IS NULL;
  ELSE
    UPDATE studios SET lease = p_lease
     WHERE id = p_studio_id AND user_id = p_user_id
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
  v_pathless boolean;
  v_conflict record;
BEGIN
  SELECT public.normalize_worktree_path(worktree_path) INTO v_path
    FROM studios
   WHERE id = p_studio_id AND user_id = p_user_id;
  IF NOT FOUND THEN
    -- Unverifiable target: report conflict, never a clear tree (fail closed).
    RETURN jsonb_build_object('conflict', true);
  END IF;

  v_pathless := (v_path IS NULL OR v_path = '');
  PERFORM pg_advisory_xact_lock(hashtext(
    CASE WHEN v_pathless
      THEN 'studio-pathless:' || p_user_id::text
      ELSE 'studio-path:' || p_user_id::text || ':' || v_path
    END
  ));

  SELECT s.id, s.lease INTO v_conflict
    FROM studios s
   WHERE s.user_id = p_user_id
     AND s.id <> p_studio_id
     AND s.lease IS NOT NULL
     AND (
       CASE WHEN v_pathless
         THEN COALESCE(public.normalize_worktree_path(s.worktree_path), '') = ''
         ELSE public.normalize_worktree_path(s.worktree_path) = v_path
       END
     )
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

-- P0-2: the path is part of the lock's identity — integrity-trigger it.
CREATE OR REPLACE FUNCTION public.enforce_worktree_path_integrity()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_old text;
  v_new text;
  v_new_pathless boolean;
  v_collides boolean;
BEGIN
  v_old := public.normalize_worktree_path(OLD.worktree_path);
  v_new := public.normalize_worktree_path(NEW.worktree_path);
  IF v_old IS NOT DISTINCT FROM v_new THEN
    RETURN NEW;  -- textual change within one canonical backing is free
  END IF;

  -- A leased row's tree cannot be moved out from under its writer.
  IF OLD.lease IS NOT NULL THEN
    RAISE EXCEPTION 'worktree_path is immutable while the studio is leased (studio %)', OLD.id;
  END IF;

  -- Nor may a row move ONTO a canonical backing a leased row occupies —
  -- that installs the sibling conflict around the grant fence. Same lock
  -- the grants take, so it cannot interleave with a concurrent grant.
  v_new_pathless := (v_new IS NULL OR v_new = '');
  PERFORM pg_advisory_xact_lock(hashtext(
    CASE WHEN v_new_pathless
      THEN 'studio-pathless:' || NEW.user_id::text
      ELSE 'studio-path:' || NEW.user_id::text || ':' || v_new
    END
  ));
  SELECT EXISTS (
    SELECT 1 FROM studios s
     WHERE s.user_id = NEW.user_id
       AND s.id <> NEW.id
       AND s.lease IS NOT NULL
       AND (
         CASE WHEN v_new_pathless
           THEN COALESCE(public.normalize_worktree_path(s.worktree_path), '') = ''
           ELSE public.normalize_worktree_path(s.worktree_path) = v_new
         END
       )
  ) INTO v_collides;
  IF v_collides THEN
    RAISE EXCEPTION 'worktree_path change collides with a leased studio on the same backing (studio %)', NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER enforce_worktree_path_integrity
  BEFORE UPDATE OF worktree_path ON public.studios
  FOR EACH ROW EXECUTE FUNCTION public.enforce_worktree_path_integrity();

-- Inserts arriving WITH a lease pre-set get the same collision check (rows
-- are legitimately inserted unleased; a pre-leased insert at an occupied
-- backing is the forged-pins lesson applied to leases).
CREATE OR REPLACE FUNCTION public.enforce_insert_lease_integrity()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_path text;
  v_pathless boolean;
  v_collides boolean;
BEGIN
  IF NEW.lease IS NULL THEN
    RETURN NEW;
  END IF;
  v_path := public.normalize_worktree_path(NEW.worktree_path);
  v_pathless := (v_path IS NULL OR v_path = '');
  PERFORM pg_advisory_xact_lock(hashtext(
    CASE WHEN v_pathless
      THEN 'studio-pathless:' || NEW.user_id::text
      ELSE 'studio-path:' || NEW.user_id::text || ':' || v_path
    END
  ));
  SELECT EXISTS (
    SELECT 1 FROM studios s
     WHERE s.user_id = NEW.user_id
       AND s.lease IS NOT NULL
       AND (
         CASE WHEN v_pathless
           THEN COALESCE(public.normalize_worktree_path(s.worktree_path), '') = ''
           ELSE public.normalize_worktree_path(s.worktree_path) = v_path
         END
       )
  ) INTO v_collides;
  IF v_collides THEN
    RAISE EXCEPTION 'pre-leased insert collides with a leased studio on the same backing';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER enforce_insert_lease_integrity
  BEFORE INSERT ON public.studios
  FOR EACH ROW EXECUTE FUNCTION public.enforce_insert_lease_integrity();
