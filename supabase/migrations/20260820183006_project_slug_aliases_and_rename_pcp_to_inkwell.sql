-- Rename the PCP project's slug to 'inkwell' and add project slug aliases so
-- historical prefixes keep resolving to the same project.
--
-- The thread-key parser treats an unrecognized first segment as a TYPE, so
-- without an alias every future 'pcp:issue:x' key would silently pin
-- key_type='pcp'. Aliases parse to the project's CANONICAL slug: the pin is
-- always the current slug regardless of which prefix the sender used.

-- 1) Alias table -------------------------------------------------------------
CREATE TABLE public.project_slug_aliases (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  alias text NOT NULL,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, alias)
);

ALTER TABLE public.project_slug_aliases ENABLE ROW LEVEL SECURITY;

CREATE POLICY project_slug_aliases_service ON public.project_slug_aliases
  FOR ALL USING (true);

-- 2) Namespace integrity for aliases ----------------------------------------
-- An alias lives in the same namespace as project slugs and thread-key types:
-- it must shadow neither. Same advisory-lock key family as the existing
-- namespace triggers so all three tables serialize on the contested name.
CREATE OR REPLACE FUNCTION public.enforce_alias_namespace()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('tk-namespace:' || NEW.alias));
  IF EXISTS (
    SELECT 1 FROM public.thread_key_types t
    WHERE t.type = NEW.alias AND (t.user_id IS NULL OR t.user_id = NEW.user_id)
  ) THEN
    RAISE EXCEPTION 'alias "%" collides with a registered thread-key type', NEW.alias;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.projects p
    WHERE p.user_id = NEW.user_id AND p.slug = NEW.alias
  ) THEN
    RAISE EXCEPTION 'alias "%" collides with an existing project slug', NEW.alias;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER enforce_alias_namespace
  BEFORE INSERT OR UPDATE ON public.project_slug_aliases
  FOR EACH ROW EXECUTE FUNCTION public.enforce_alias_namespace();

-- 3) Types must not collide with aliases either ------------------------------
CREATE OR REPLACE FUNCTION public.enforce_type_not_project_slug()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('tk-namespace:' || NEW.type));
  IF NEW.user_id IS NULL THEN
    IF EXISTS (SELECT 1 FROM public.projects p WHERE p.slug = NEW.type) THEN
      RAISE EXCEPTION 'type name "%" collides with an existing project slug', NEW.type;
    END IF;
    IF EXISTS (SELECT 1 FROM public.project_slug_aliases a WHERE a.alias = NEW.type) THEN
      RAISE EXCEPTION 'type name "%" collides with an existing project slug alias', NEW.type;
    END IF;
  ELSE
    IF EXISTS (
      SELECT 1 FROM public.projects p WHERE p.user_id = NEW.user_id AND p.slug = NEW.type
    ) THEN
      RAISE EXCEPTION 'type name "%" collides with your project slug', NEW.type;
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.project_slug_aliases a WHERE a.user_id = NEW.user_id AND a.alias = NEW.type
    ) THEN
      RAISE EXCEPTION 'type name "%" collides with your project slug alias', NEW.type;
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

-- 4) New project slugs must not collide with aliases -------------------------
-- Excludes aliases pointing at the same project row, so renaming a project
-- back to one of its own aliases stays legal (delete the redundant alias after).
CREATE OR REPLACE FUNCTION public.enforce_project_slug_not_type()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.slug IS NULL THEN
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('tk-namespace:' || NEW.slug));
  IF EXISTS (
    SELECT 1 FROM public.thread_key_types t
    WHERE t.type = NEW.slug AND (t.user_id IS NULL OR t.user_id = NEW.user_id)
  ) THEN
    RAISE EXCEPTION 'project slug "%" collides with a registered thread-key type', NEW.slug;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.project_slug_aliases a
    WHERE a.user_id = NEW.user_id AND a.alias = NEW.slug AND a.project_id <> NEW.id
  ) THEN
    RAISE EXCEPTION 'project slug "%" collides with another project''s slug alias', NEW.slug;
  END IF;
  RETURN NEW;
END;
$function$;

-- 5) Alias-aware parsing: pin the CANONICAL slug ------------------------------
CREATE OR REPLACE FUNCTION public.compute_thread_key_pin(p_user_id uuid, p_key text, OUT o_project text, OUT o_type text, OUT o_id text)
RETURNS record
LANGUAGE plpgsql
STABLE
SET search_path TO 'public'
AS $function$
DECLARE
  segs text[];
  v_canonical text;
BEGIN
  o_project := NULL; o_type := NULL; o_id := NULL;
  segs := string_to_array(p_key, ':');
  IF array_length(segs, 1) IS NULL OR array_length(segs, 1) < 2
     OR segs[1] = '' OR segs[2] = '' THEN
    RETURN;
  END IF;

  v_canonical := NULL;
  IF array_length(segs, 1) >= 3 AND segs[3] <> '' THEN
    SELECT p.slug INTO v_canonical
    FROM public.projects p
    WHERE p.user_id = p_user_id AND p.slug = segs[1];
    IF v_canonical IS NULL THEN
      SELECT p.slug INTO v_canonical
      FROM public.project_slug_aliases a
      JOIN public.projects p ON p.id = a.project_id
      WHERE a.user_id = p_user_id AND a.alias = segs[1];
    END IF;
  END IF;

  IF v_canonical IS NOT NULL THEN
    o_project := v_canonical;
    o_type := segs[2];
    o_id := array_to_string(segs[3:], ':');
  ELSE
    o_project := NULL;
    o_type := segs[1];
    o_id := array_to_string(segs[2:], ':');
  END IF;
END;
$function$;

-- 6) Rename, alias, and pin repair -------------------------------------------
UPDATE public.projects SET slug = 'inkwell' WHERE slug = 'pcp';

INSERT INTO public.project_slug_aliases (user_id, alias, project_id)
SELECT p.user_id, 'pcp', p.id FROM public.projects p WHERE p.slug = 'inkwell';

-- Repair pinned key_project values. Pins are immutable by design; this is a
-- sanctioned one-time repair, so the trigger is disabled for exactly this
-- statement. The updated_at trigger is disabled too: a pin repair is not
-- thread activity and must not reorder inboxes.
ALTER TABLE public.inbox_threads DISABLE TRIGGER enforce_thread_key_immutability;
ALTER TABLE public.inbox_threads DISABLE TRIGGER update_inbox_threads_updated_at;

UPDATE public.inbox_threads SET key_project = 'inkwell' WHERE key_project = 'pcp';

ALTER TABLE public.inbox_threads ENABLE TRIGGER update_inbox_threads_updated_at;
ALTER TABLE public.inbox_threads ENABLE TRIGGER enforce_thread_key_immutability;
