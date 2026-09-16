-- Pin thread-key parse at creation (grammar v2; Lumen re-review condition 2).
--
-- The parse is registry-driven: the first segment is a project only when it
-- matches a registered projects.slug. That makes a LIVE parse unstable —
-- creating project slug "foo" tomorrow would silently reinterpret today's
-- thread "foo:bar:baz" from (null, foo, bar:baz) to (foo, bar, baz), and a
-- rename/delete reverses it. Keys are immutable (grammar invariant 2); their
-- identity must be too. So the parse runs ONCE, at thread creation, against
-- the slug set of that moment, and is stored. Consumers read the stored
-- identity, never re-parse.

ALTER TABLE public.inbox_threads
  ADD COLUMN IF NOT EXISTS key_project text,
  ADD COLUMN IF NOT EXISTS key_type text,
  ADD COLUMN IF NOT EXISTS key_id text;

COMMENT ON COLUMN public.inbox_threads.key_type IS
  'Parsed thread-key type, pinned at creation (thread-key-grammar v2). Consumers use this, never a live re-parse.';

-- Backfill existing threads against the CURRENT slug set — the one-time
-- cutover parse the grammar spec calls for.
DO $$
DECLARE
  t record;
  segs text[];
  slug_match boolean;
BEGIN
  FOR t IN SELECT id, user_id, thread_key FROM public.inbox_threads WHERE key_type IS NULL LOOP
    segs := string_to_array(t.thread_key, ':');
    IF array_length(segs, 1) IS NULL OR array_length(segs, 1) < 2
       OR segs[1] = '' OR segs[2] = '' THEN
      CONTINUE;  -- not a typed key; stays untyped
    END IF;

    slug_match := false;
    IF array_length(segs, 1) >= 3 AND segs[3] <> '' THEN
      SELECT EXISTS (
        SELECT 1 FROM public.projects p
        WHERE p.user_id = t.user_id AND p.slug = segs[1]
      ) INTO slug_match;
    END IF;

    IF slug_match THEN
      UPDATE public.inbox_threads
         SET key_project = segs[1],
             key_type = segs[2],
             key_id = array_to_string(segs[3:], ':')
       WHERE id = t.id;
    ELSE
      UPDATE public.inbox_threads
         SET key_project = NULL,
             key_type = segs[1],
             key_id = array_to_string(segs[2:], ':')
       WHERE id = t.id;
    END IF;
  END LOOP;
END $$;

-- Conservative-template correction (Lumen re-review condition 4): even
-- spec/thread presence is too loose before escalation-on-write exists —
-- thread:studio-write-intent itself became implementation running builds.
-- ALL shipped templates stay 'write' until 6e; the flip to presence for
-- spec/thread/issue + the unknown default happens there, with escalation as
-- the net.
UPDATE public.thread_key_types
   SET write_intent = 'write',
       description = description || ' (presence planned once escalation-on-write ships — 6e)'
 WHERE user_id IS NULL
   AND type IN ('spec', 'thread')
   AND write_intent = 'presence';
