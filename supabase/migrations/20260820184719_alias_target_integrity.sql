-- Repair for project_slug_aliases (PR #518 review, Lumen round 1).
--
-- Three holes in the original table, each proven live:
--   1. alias.user_id was not tied to the target project's owner — user A
--      could alias user B's project and resolve A's keys to B's slug.
--   2. an alias could target a slugless project (or the slug could be
--      cleared later), collapsing the alias branch of compute_thread_key_pin
--      to "no canonical" and re-parsing the alias as a TYPE.
--   3. no grammar CHECK on alias (projects.slug has one).
--
-- The cross-table invariants are guarded on BOTH sides and serialized on one
-- advisory lock keyed by project id ('project-alias:<uuid>'): alias-side
-- checks the project, project-side checks the aliases, and without a shared
-- lock a concurrent alias-insert + slug-clear pair is a write skew where each
-- side passes its own check.

-- 3) Grammar: aliases obey the same slug grammar as projects.slug ------------
ALTER TABLE public.project_slug_aliases
  ADD CONSTRAINT project_slug_aliases_alias_check
  CHECK (alias ~ '^[a-z0-9][a-z0-9-]*$');

-- 1+2) Alias side: target must exist, be owned by the alias user, and have a
-- canonical slug --------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enforce_alias_target_integrity()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_owner uuid;
  v_slug text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('project-alias:' || NEW.project_id::text));
  SELECT p.user_id, p.slug INTO v_owner, v_slug
  FROM public.projects p WHERE p.id = NEW.project_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'alias "%" targets a project that does not exist', NEW.alias;
  END IF;
  IF v_owner IS DISTINCT FROM NEW.user_id THEN
    RAISE EXCEPTION 'alias "%" must belong to the target project''s owner', NEW.alias;
  END IF;
  IF v_slug IS NULL THEN
    RAISE EXCEPTION 'alias "%" targets a project with no canonical slug', NEW.alias;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER enforce_alias_target_integrity
  BEFORE INSERT OR UPDATE ON public.project_slug_aliases
  FOR EACH ROW EXECUTE FUNCTION public.enforce_alias_target_integrity();

-- 2) Project side: a slug cannot be cleared while aliases reference the
-- project, and an owner move carries the aliases to the new owner ------------
CREATE OR REPLACE FUNCTION public.enforce_project_alias_consistency()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  IF (NEW.slug IS NULL AND OLD.slug IS NOT NULL)
     OR NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    PERFORM pg_advisory_xact_lock(hashtext('project-alias:' || NEW.id::text));
  END IF;
  IF NEW.slug IS NULL AND OLD.slug IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.project_slug_aliases a WHERE a.project_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'cannot clear the slug of project % while aliases reference it', NEW.id;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER enforce_project_alias_consistency
  BEFORE UPDATE ON public.projects
  FOR EACH ROW EXECUTE FUNCTION public.enforce_project_alias_consistency();

-- Owner move: aliases follow the project, exactly as the slug itself does.
-- The cascade UPDATE re-fires the alias-side triggers per row, so the aliases
-- are re-validated under the NEW owner's namespace (type collisions, slug
-- collisions, unique (user_id, alias)) — any collision aborts the owner move.
CREATE OR REPLACE FUNCTION public.cascade_alias_owner_on_project_move()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    UPDATE public.project_slug_aliases
    SET user_id = NEW.user_id
    WHERE project_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER cascade_alias_owner_on_project_move
  AFTER UPDATE ON public.projects
  FOR EACH ROW EXECUTE FUNCTION public.cascade_alias_owner_on_project_move();
