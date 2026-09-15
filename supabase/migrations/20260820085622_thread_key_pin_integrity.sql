-- Pin integrity: durable pinning, immutability, namespace serialization, and
-- repair of the first backfill's damage (Lumen, PR #516 round 2, conditions
-- 4–7).
--
-- Four defects this closes:
--   1. The one-time backfill was not a durable boundary — threads created by
--      the still-running old server binary after the migration have NULL pins
--      (live: thread:disk-full-2026-08-20). The DB, not the app, must own
--      pin completeness: a BEFORE INSERT trigger pins any row the app didn't.
--   2. Nothing prevented rewriting thread_key or the pinned identity.
--   3. The backfill UPDATE fired the updated_at trigger on all 417 rows,
--      falsifying every thread's activity timestamp (March threads read
--      2026-08-20). Repaired here from real activity data; both repairs run
--      with that trigger disabled so they cannot re-offend.
--   4. The reserved-namespace checks (type names vs project slugs) lived only
--      in two application prechecks, which race. Constraint triggers with a
--      shared advisory xact lock serialize the namespace at the DB.

-- ---------------------------------------------------------------------------
-- 1. One pin computation, used by the insert trigger and reconciliation.
--    Same rules as the TS parser (grammar v3 §Parse procedure); a parity
--    integration test guards drift between the two implementations.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.compute_thread_key_pin(
  p_user_id uuid,
  p_key text,
  OUT o_project text,
  OUT o_type text,
  OUT o_id text
)
LANGUAGE plpgsql STABLE
SET search_path = public
AS $$
DECLARE
  segs text[];
  slug_match boolean;
BEGIN
  o_project := NULL; o_type := NULL; o_id := NULL;
  segs := string_to_array(p_key, ':');
  IF array_length(segs, 1) IS NULL OR array_length(segs, 1) < 2
     OR segs[1] = '' OR segs[2] = '' THEN
    RETURN;  -- not a typed key
  END IF;

  slug_match := false;
  IF array_length(segs, 1) >= 3 AND segs[3] <> '' THEN
    SELECT EXISTS (
      SELECT 1 FROM public.projects p
      WHERE p.user_id = p_user_id AND p.slug = segs[1]
    ) INTO slug_match;
  END IF;

  IF slug_match THEN
    o_project := segs[1];
    o_type := segs[2];
    o_id := array_to_string(segs[3:], ':');
  ELSE
    o_project := NULL;
    o_type := segs[1];
    o_id := array_to_string(segs[2:], ':');
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. BEFORE INSERT: the DB is the pinning authority. The app may supply pins
--    (it no longer does); any row arriving without them is pinned here, so no
--    deploy gap can ever create an unpinned thread again.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pin_thread_key_on_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  pin record;
BEGIN
  IF NEW.key_type IS NULL THEN
    SELECT * INTO pin FROM public.compute_thread_key_pin(NEW.user_id, NEW.thread_key);
    NEW.key_project := pin.o_project;
    NEW.key_type := pin.o_type;
    NEW.key_id := pin.o_id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER pin_thread_key_before_insert
  BEFORE INSERT ON public.inbox_threads
  FOR EACH ROW EXECUTE FUNCTION public.pin_thread_key_on_insert();

-- ---------------------------------------------------------------------------
-- 3. BEFORE UPDATE: keys and pinned identities are immutable. NULL -> value
--    is allowed (reconciliation); value -> anything is not. thread_key never
--    changes (grammar invariant 2 — renames are an explicit migration, which
--    would drop/recreate this trigger deliberately).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enforce_thread_key_immutability()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.thread_key IS DISTINCT FROM OLD.thread_key THEN
    RAISE EXCEPTION 'thread_key is immutable (thread %)', OLD.id;
  END IF;
  IF OLD.key_type IS NOT NULL AND (
       NEW.key_type IS DISTINCT FROM OLD.key_type
    OR NEW.key_project IS DISTINCT FROM OLD.key_project
    OR NEW.key_id IS DISTINCT FROM OLD.key_id
  ) THEN
    RAISE EXCEPTION 'pinned key identity is immutable (thread %)', OLD.id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER enforce_thread_key_immutability
  BEFORE UPDATE ON public.inbox_threads
  FOR EACH ROW EXECUTE FUNCTION public.enforce_thread_key_immutability();

-- ---------------------------------------------------------------------------
-- 4. Namespace serialization. Both write sites take the SAME advisory xact
--    lock on the contested name, then cross-check, so save_project(slug=foo)
--    and set_thread_key_type(type=foo) cannot both commit. Template types
--    (user_id IS NULL) reserve the name against every user's project slugs;
--    user overrides reserve per user. The application prechecks remain for
--    friendly errors; these triggers are the authority.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enforce_type_not_project_slug()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('tk-namespace:' || NEW.type));
  IF NEW.user_id IS NULL THEN
    IF EXISTS (SELECT 1 FROM public.projects p WHERE p.slug = NEW.type) THEN
      RAISE EXCEPTION 'type name "%" collides with an existing project slug', NEW.type;
    END IF;
  ELSE
    IF EXISTS (
      SELECT 1 FROM public.projects p WHERE p.user_id = NEW.user_id AND p.slug = NEW.type
    ) THEN
      RAISE EXCEPTION 'type name "%" collides with your project slug', NEW.type;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER enforce_type_not_project_slug
  BEFORE INSERT OR UPDATE OF type ON public.thread_key_types
  FOR EACH ROW EXECUTE FUNCTION public.enforce_type_not_project_slug();

CREATE OR REPLACE FUNCTION public.enforce_project_slug_not_type()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
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
  RETURN NEW;
END;
$$;

CREATE TRIGGER enforce_project_slug_not_type
  BEFORE INSERT OR UPDATE OF slug ON public.projects
  FOR EACH ROW EXECUTE FUNCTION public.enforce_project_slug_not_type();

-- ---------------------------------------------------------------------------
-- 5. Repair, with the updated_at trigger DISABLED so neither pass re-offends.
-- ---------------------------------------------------------------------------
ALTER TABLE public.inbox_threads DISABLE TRIGGER update_inbox_threads_updated_at;

-- 5a. Reconcile the rollout gap: pin every unpinned thread (idempotent; safe
--     to re-run — it only touches NULL key_type rows).
UPDATE public.inbox_threads t
   SET (key_project, key_type, key_id) =
       (SELECT o_project, o_type, o_id FROM public.compute_thread_key_pin(t.user_id, t.thread_key))
 WHERE t.key_type IS NULL;

-- 5b. Reconstruct updated_at from real activity: the latest of thread
--     creation, last message, and close time. This repairs the 417 rows the
--     first backfill stamped with migration time, and is harmless for rows
--     whose true activity is already later.
UPDATE public.inbox_threads t
   SET updated_at = GREATEST(
         t.created_at,
         COALESCE((SELECT max(m.created_at) FROM public.inbox_thread_messages m
                    WHERE m.thread_id = t.id), t.created_at),
         COALESCE(t.closed_at, t.created_at)
       );

ALTER TABLE public.inbox_threads ENABLE TRIGGER update_inbox_threads_updated_at;
