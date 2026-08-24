-- r4 P0-1 completion: the INSERT trigger validated worktree_path only for
-- pre-leased rows (early return on NEW.lease IS NULL), so the public path
-- writer still admitted arbitrary strings on ordinary inserts. Every insert
-- now passes the canonical-form gate; the collision scan remains pre-leased
-- only (an unleased row cannot conflict with anyone by existing).
CREATE OR REPLACE FUNCTION public.enforce_insert_lease_integrity()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_path text;
  v_pathless boolean;
  v_collides boolean;
BEGIN
  -- Canonical-form gate for EVERY insert: strings the lease machinery would
  -- later refuse must not enter the table at all.
  v_path := public.normalize_worktree_path(NEW.worktree_path);
  IF NEW.lease IS NULL THEN
    RETURN NEW;
  END IF;
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
$function$;
