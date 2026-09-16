-- Close two bypasses of the round-2 integrity triggers (Lumen, PR #516
-- round 3 — both reproduced live against the shared DB):
--
--   1. pin_thread_key_on_insert computed pins only WHEN key_type IS NULL, so
--      a caller supplying forged non-null pins stored them verbatim — and the
--      round-one app binary (running until the next server restart) supplies
--      pins on every thread create. Authority that defers to its caller is
--      not authority: pins are now computed UNCONDITIONALLY on insert and
--      caller-supplied values are overwritten.
--
--   2. The namespace triggers fired on UPDATE OF type / UPDATE OF slug but
--      not on owner changes, so moving a type override (or project) between
--      users could commit a collision the insert path forbids: slug 'x' on
--      user A + type 'x' on user B, then move the type to A. The triggers now
--      also fire on user_id changes, re-running the cross-check against the
--      NEW owner's namespace.

CREATE OR REPLACE FUNCTION public.pin_thread_key_on_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  pin record;
BEGIN
  -- Unconditional: the DB is the ONLY pinning authority. Whatever the caller
  -- supplied — nothing, correct values, or forged ones — the stored identity
  -- is the computed one.
  SELECT * INTO pin FROM public.compute_thread_key_pin(NEW.user_id, NEW.thread_key);
  NEW.key_project := pin.o_project;
  NEW.key_type := pin.o_type;
  NEW.key_id := pin.o_id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_type_not_project_slug ON public.thread_key_types;
CREATE TRIGGER enforce_type_not_project_slug
  BEFORE INSERT OR UPDATE OF type, user_id ON public.thread_key_types
  FOR EACH ROW EXECUTE FUNCTION public.enforce_type_not_project_slug();

DROP TRIGGER IF EXISTS enforce_project_slug_not_type ON public.projects;
CREATE TRIGGER enforce_project_slug_not_type
  BEFORE INSERT OR UPDATE OF slug, user_id ON public.projects
  FOR EACH ROW EXECUTE FUNCTION public.enforce_project_slug_not_type();
