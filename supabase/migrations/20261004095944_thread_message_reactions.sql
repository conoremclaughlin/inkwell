-- Reactions on thread messages (ink://specs/inkling-reactions, v1).
--
-- One emoji on one inbox_thread_messages row, by one reactor: a person or an
-- SB, named by id and never by slug. A reaction is not a message. It wakes
-- nobody, moves no unread count and no thread recency, and it is never
-- approval of anything: no gate verdict, permission grant, plan, send or
-- purchase may read this table as consent.
--
-- Who may react (a member of the thread, never in a background thread, and
-- the inkling gate) is the API's to decide. What every writer must obey lives
-- here: one reactor per row, each (message, reactor, emoji) once, at most six
-- emoji per reactor on one message, and the reaction's thread and workspace
-- are its message's.

CREATE TABLE IF NOT EXISTS public.thread_message_reactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL REFERENCES public.inbox_thread_messages(id) ON DELETE CASCADE,
  -- The message's thread and that thread's workspace, checked by the guard
  -- trigger below, so the composite keys can hold the reactor to them.
  thread_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  reactor_user_id uuid REFERENCES public.users(id) ON DELETE CASCADE,
  reactor_sb_id uuid,
  -- One grapheme, at most 16 UTF-16 units, is the API's rule. char_length
  -- counts code points, never more than UTF-16 units, so this only backs the
  -- API up: it refuses an empty string and anything plainly longer.
  emoji text NOT NULL CHECK (char_length(emoji) BETWEEN 1 AND 16),
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT thread_message_reactions_one_reactor
    CHECK ((reactor_user_id IS NOT NULL) <> (reactor_sb_id IS NOT NULL)),
  CONSTRAINT thread_message_reactions_thread_workspace_fkey
    FOREIGN KEY (thread_id, workspace_id)
    REFERENCES public.inbox_threads (id, workspace_id) ON DELETE CASCADE,
  -- An SB reacts only inside its own workspace, by construction, the same
  -- composite key inbox_thread_participants uses.
  CONSTRAINT thread_message_reactions_sb_workspace_fkey
    FOREIGN KEY (reactor_sb_id, workspace_id)
    REFERENCES public.agent_identities (id, workspace_id) ON DELETE CASCADE
);

-- Adding a reaction twice changes nothing: the second insert fails here and
-- the API answers with what is already stored.
CREATE UNIQUE INDEX IF NOT EXISTS thread_message_reactions_message_reactor_emoji_key
  ON public.thread_message_reactions (message_id, COALESCE(reactor_user_id, reactor_sb_id), emoji);

CREATE INDEX IF NOT EXISTS thread_message_reactions_thread_idx
  ON public.thread_message_reactions (thread_id);
CREATE INDEX IF NOT EXISTS thread_message_reactions_reactor_user_idx
  ON public.thread_message_reactions (reactor_user_id) WHERE reactor_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS thread_message_reactions_reactor_sb_idx
  ON public.thread_message_reactions (reactor_sb_id) WHERE reactor_sb_id IS NOT NULL;

-- The per-reactor limit and the thread/workspace check, for every writer.
--
-- A trigger rather than a count in the API, because a count and an insert
-- are two statements: two requests that each saw five emoji would both
-- insert and leave seven. The advisory lock serialises one reactor's writes
-- on one message, and only those, so the count it reads after taking the
-- lock includes whatever the other writer committed. Re-adding an emoji the
-- reactor already has is not counted against the limit; the unique index
-- refuses it and the API reports the reaction as already there.
CREATE OR REPLACE FUNCTION public.thread_message_reactions_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_thread_id uuid;
  v_workspace_id uuid;
  v_reactor uuid := COALESCE(NEW.reactor_user_id, NEW.reactor_sb_id);
  v_others integer;
BEGIN
  SELECT m.thread_id, t.workspace_id
    INTO v_thread_id, v_workspace_id
    FROM public.inbox_thread_messages m
    JOIN public.inbox_threads t ON t.id = m.thread_id
   WHERE m.id = NEW.message_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'thread_message_reactions: message % does not exist', NEW.message_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF NEW.thread_id IS DISTINCT FROM v_thread_id
     OR NEW.workspace_id IS DISTINCT FROM v_workspace_id THEN
    RAISE EXCEPTION 'thread_message_reactions: a reaction''s thread and workspace must be its message''s'
      USING ERRCODE = 'check_violation';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'thread_message_reactions:' || NEW.message_id::text || ':' || v_reactor::text, 0
    )
  );

  SELECT count(*)
    INTO v_others
    FROM public.thread_message_reactions r
   WHERE r.message_id = NEW.message_id
     AND COALESCE(r.reactor_user_id, r.reactor_sb_id) = v_reactor
     AND r.emoji <> NEW.emoji
     AND r.id <> NEW.id;
  IF v_others >= 6 THEN
    RAISE EXCEPTION 'reaction_limit_reached: at most 6 reactions per reactor on one message'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER thread_message_reactions_guard
  BEFORE INSERT OR UPDATE ON public.thread_message_reactions
  FOR EACH ROW
  EXECUTE FUNCTION public.thread_message_reactions_guard();

-- Server-only, like every table the API now adds: the service role bypasses
-- RLS, and no client role reads or writes it. inbox_thread_messages still
-- carries the permissive USING (true) policy from before that convention;
-- copying it here would open reactions to the publishable key.
ALTER TABLE public.thread_message_reactions ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.thread_message_reactions IS
  'Emoji reactions on inbox_thread_messages, by a person or an SB (by id). Not a message: wakes nobody, moves no unread count or recency. Never approval: no gate verdict, permission, plan, send or purchase reads this table. Spec: ink://specs/inkling-reactions.';
