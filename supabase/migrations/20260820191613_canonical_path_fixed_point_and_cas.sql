-- PR #517 round 4 (Lumen round-3 review, two P0s, both live-proven).
--
-- P0-1 — the normalizer was not a fixed point and accepted non-canonical
-- input: '..' was neither resolved nor rejected (P and P/child/.. both
-- granted, two fresh leases on one real directory), '/a/././b' needed two
-- passes, relative paths were legal, and the trailing-slash strip mapped
-- filesystem root '/' to '' — conflating it with the pathless
-- (defaultWorkingDirectory) sentinel class.
--
-- Resolution: REJECT non-canonical input instead of guessing at it. The
-- caller resolves real paths; the DB accepts only absolute paths with no
-- '.'/'..' segments. What normalization remains (slash collapse, trailing
-- slash) is idempotent by construction, and '/' survives as itself.
-- Rejection propagates as an RPC/trigger error, which every TS boundary
-- already treats as fail-closed (lost / conflict / refused write).
--
-- P0-2 — target-path TOCTOU: grant_studio_lease read the target's path
-- BEFORE taking the advisory lock and its CAS never re-proved it. Schedule:
-- hold P1's lock; queue grant(A@P1) past its read; move unleased A to P2;
-- grant(B@P2) → granted; release P1; queued grant proceeds under P1's lock
-- but writes a row now backed by P2 → two fresh leases on P2. The path
-- integrity trigger locks only the DESTINATION backing, so it cannot close
-- this window.
--
-- Resolution: the CAS now asserts the row still belongs to the backing the
-- lock serializes — a moved row matches zero rows and the grant reports
-- lost. Applied to BOTH branches (the handover CAS reads the path in the
-- same window). studio_path_conflict gets the analogous guard: a post-lock
-- re-read of the target's backing; movement reports conflict (fail-closed —
-- "could not verify which tree this is" never authorizes anything).

-- 1) normalize_worktree_path: canonical input or error --------------------
CREATE OR REPLACE FUNCTION public.normalize_worktree_path(p text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $function$
DECLARE
  v text;
BEGIN
  IF p IS NULL THEN RETURN NULL; END IF;
  IF p = '' THEN RETURN ''; END IF;
  IF left(p, 1) <> '/' THEN
    RAISE EXCEPTION 'worktree_path must be absolute: %', p;
  END IF;
  IF p ~ '(^|/)\.\.?(/|$)' THEN
    RAISE EXCEPTION 'worktree_path must not contain . or .. segments: %', p;
  END IF;
  v := regexp_replace(p, '/{2,}', '/', 'g');
  IF length(v) > 1 THEN
    v := regexp_replace(v, '/$', '');
  END IF;
  RETURN v;
END;
$function$;

-- 2) grant_studio_lease: the CAS proves the backing it locked -------------
CREATE OR REPLACE FUNCTION public.grant_studio_lease(p_studio_id uuid, p_user_id uuid, p_lease jsonb, p_expected_prior jsonb DEFAULT NULL::jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
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

  -- The CAS carries the backing predicate: if the row moved between the
  -- pre-lock read and here, it no longer belongs to the backing this lock
  -- serializes, zero rows match, and the grant is lost (P0-2).
  IF p_expected_prior IS NULL THEN
    UPDATE studios SET lease = p_lease
     WHERE id = p_studio_id AND user_id = p_user_id
       AND status IN ('active', 'idle') AND lease IS NULL
       AND (
         CASE WHEN v_pathless
           THEN COALESCE(public.normalize_worktree_path(worktree_path), '') = ''
           ELSE public.normalize_worktree_path(worktree_path) = v_path
         END
       );
  ELSE
    UPDATE studios SET lease = p_lease
     WHERE id = p_studio_id AND user_id = p_user_id
       AND status IN ('active', 'idle')
       AND lease->>'sessionId' = p_expected_prior->>'sessionId'
       AND lease->>'acquiredAt' = p_expected_prior->>'acquiredAt'
       AND lease->>'heartbeatAt' = p_expected_prior->>'heartbeatAt'
       AND (
         CASE WHEN v_pathless
           THEN COALESCE(public.normalize_worktree_path(worktree_path), '') = ''
           ELSE public.normalize_worktree_path(worktree_path) = v_path
         END
       );
  END IF;
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  IF v_rows = 1 THEN
    RETURN jsonb_build_object('outcome', 'granted');
  END IF;
  RETURN jsonb_build_object('outcome', 'lost');
END;
$function$;

-- 3) studio_path_conflict: movement during the check is a conflict --------
CREATE OR REPLACE FUNCTION public.studio_path_conflict(p_studio_id uuid, p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_path text;
  v_path_now text;
  v_pathless boolean;
  v_conflict record;
BEGIN
  SELECT public.normalize_worktree_path(worktree_path) INTO v_path
    FROM studios
   WHERE id = p_studio_id AND user_id = p_user_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('conflict', true);
  END IF;

  v_pathless := (v_path IS NULL OR v_path = '');
  PERFORM pg_advisory_xact_lock(hashtext(
    CASE WHEN v_pathless
      THEN 'studio-pathless:' || p_user_id::text
      ELSE 'studio-path:' || p_user_id::text || ':' || v_path
    END
  ));

  -- Re-read under the lock: a row that moved backings between the read and
  -- the lock is not the row this lock serializes. Fail closed (P0-2 analog).
  SELECT public.normalize_worktree_path(worktree_path) INTO v_path_now
    FROM studios
   WHERE id = p_studio_id AND user_id = p_user_id;
  IF NOT FOUND OR v_path_now IS DISTINCT FROM v_path THEN
    RETURN jsonb_build_object('conflict', true);
  END IF;

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
$function$;

-- Privileges: CREATE OR REPLACE preserves existing grants/revocations
-- (EXECUTE revoked from PUBLIC/anon/authenticated in 6b r1; service_role
-- only). normalize_worktree_path stays callable as before.
