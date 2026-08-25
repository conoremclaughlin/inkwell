-- Serialize per-user task_group numbering.
--
-- assign_task_group_number_and_slug() computes `MAX(group_number) + 1` for the
-- user and then inserts. Two transactions inserting for the same user overlap
-- on that read — both see the same MAX, both claim the same number, and the
-- second one to commit violates idx_task_groups_user_group_number:
--
--   duplicate key value violates unique constraint "idx_task_groups_user_group_number"
--
-- MVCC guarantees this: the MAX read cannot see the other transaction's
-- uncommitted row, so nothing about the read-then-write is safe on its own.
-- The unique index correctly refuses the collision, which turns a numbering
-- race into a failed create.
--
-- This is not only a test-suite artifact. It broke CI on main because vitest
-- runs integration files in parallel against one seeded user, but the same
-- window is open in production any time two agents create a group for the
-- same user at once — which is ordinary behaviour for a multi-agent system.
--
-- Fix: take a transaction-scoped advisory lock on the user before reading
-- MAX, so concurrent inserts for that user queue instead of racing. The lock
-- releases at commit or rollback, needs no cleanup, and is keyed per user, so
-- inserts for different users never contend.
--
-- The slug branch has the identical race (two groups with the same title
-- resolve the same candidate slug and collide on idx_task_groups_user_slug).
-- Taking the lock at the top of the function covers both.
--
-- hashtext() returns int4 and can collide across different user ids. A
-- collision costs two unrelated users a brief serialization, never
-- correctness, so the single-argument lock is preferred over packing the uuid
-- into two int4 keys.

CREATE OR REPLACE FUNCTION public.assign_task_group_number_and_slug()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  base_slug text;
  candidate_slug text;
  collision_exists boolean;
BEGIN
  -- Serialize numbering and slug assignment per user. Held until the
  -- transaction ends; concurrent inserts for the same user wait here rather
  -- than reading a MAX that is about to be stale.
  PERFORM pg_advisory_xact_lock(hashtext(NEW.user_id::text));

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
