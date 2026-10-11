-- A person's pin on one of their threads
--
-- Pinning is a choice one person makes about a thread they are in, so it
-- lives on their own participant row: no new table and no function. The
-- threads list reads it from the viewer's row only, and
-- PUT /api/admin/threads/pin writes it with one plain UPDATE filtered by
-- (thread_id, user_id), so a person can never set another person's pin.
--
-- Three states, because the app has default pins: NULL is "no choice yet"
-- (the app applies its defaults), true is pinned, and false is unpinned on
-- purpose, which a default must not override.

ALTER TABLE public.inbox_thread_participants
  ADD COLUMN IF NOT EXISTS pinned boolean;

-- An SB's participant row carries no pin: pinning is a person's choice.
-- Every existing row reads NULL, so the check holds on them all.
ALTER TABLE public.inbox_thread_participants
  DROP CONSTRAINT IF EXISTS inbox_thread_participants_pinned_person_only;
ALTER TABLE public.inbox_thread_participants
  ADD CONSTRAINT inbox_thread_participants_pinned_person_only
  CHECK (pinned IS NULL OR user_id IS NOT NULL);

COMMENT ON COLUMN public.inbox_thread_participants.pinned IS
  'This person''s pin on the thread: NULL no choice yet (the app applies its default pins), true pinned, false unpinned on purpose. Only ever set on a person''s row.';
