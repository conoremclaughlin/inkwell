-- A conversation's mode (ink://specs/inkling-multi-person-groups, D8): the
-- thread's own persisted marker of whether a space's conversation is
-- 'public' to the space's members or 'private' to its participants. NULL is
-- every other thread: Inkwell's own threads, and a conversation created
-- without a mode.
--
-- Set only at insert, by the send that creates the thread (findOrCreateThread),
-- and only on an inkling conversation. No server update path can carry it
-- (inbox-threads-conversation-mode-writes.test.ts pins that). Immutability is
-- enforced in server code only: a DB-level guard would be a trigger, which
-- needs Conor's OK first (Oct 4 rule; D9 approved one trigger, on sessions,
-- and nothing else), so a service-role or raw SQL write could still change it.
--
-- 'public' makes an inkling conversation readable by every member of its
-- space and joinable by posting (thread-read-access.ts, the thread and turn
-- gates). NULL and 'private' read as before: participant-only (D3).
--
-- Re-timestamped from 20261016011435 so it sorts after
-- 20261016075003_workspace_members_calendar_share.sql, which merged first.

ALTER TABLE public.inbox_threads
  ADD COLUMN IF NOT EXISTS conversation_mode text
  CONSTRAINT inbox_threads_conversation_mode_check
    CHECK (conversation_mode IS NULL OR conversation_mode IN ('public', 'private'));
