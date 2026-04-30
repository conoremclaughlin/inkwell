-- Add auto-incrementing group_number and slug to task_groups
-- for human-friendly threadKeys like taskgroup:42 or taskgroup:lifecycle-fidelity

ALTER TABLE public.task_groups
  ADD COLUMN group_number integer NOT NULL DEFAULT 0,
  ADD COLUMN slug text;

-- Auto-assign group_number and slug on insert
CREATE OR REPLACE FUNCTION public.assign_task_group_number_and_slug()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  base_slug text;
  candidate_slug text;
  collision_exists boolean;
BEGIN
  -- Auto-assign group_number (next sequential per user)
  IF NEW.group_number IS NULL THEN
    SELECT COALESCE(MAX(group_number), 0) + 1
    INTO NEW.group_number
    FROM task_groups
    WHERE user_id = NEW.user_id;
  END IF;

  -- Auto-generate slug from title if not provided
  IF NEW.slug IS NULL AND NEW.title IS NOT NULL THEN
    base_slug := left(
      regexp_replace(
        regexp_replace(lower(trim(NEW.title)), '[^a-z0-9]+', '-', 'g'),
        '^-+|-+$', '', 'g'
      ),
      64
    );

    IF base_slug = '' THEN
      base_slug := 'group';
    END IF;

    candidate_slug := base_slug;

    SELECT EXISTS(
      SELECT 1 FROM task_groups
      WHERE user_id = NEW.user_id AND slug = candidate_slug
    ) INTO collision_exists;

    IF collision_exists THEN
      candidate_slug := base_slug || '-' || NEW.group_number::text;
    END IF;

    NEW.slug := candidate_slug;
  END IF;

  RETURN NEW;
END;
$function$;

CREATE TRIGGER task_group_assign_number_slug
  BEFORE INSERT ON public.task_groups
  FOR EACH ROW EXECUTE FUNCTION public.assign_task_group_number_and_slug();

-- Unique indexes scoped per user
CREATE UNIQUE INDEX idx_task_groups_user_group_number ON public.task_groups(user_id, group_number);
CREATE UNIQUE INDEX idx_task_groups_user_slug ON public.task_groups(user_id, slug) WHERE slug IS NOT NULL;
