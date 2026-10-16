-- A version on each member's calendar sharing (20261016075003), so a change
-- is made only from the revision its sender last read: this membership row at
-- this version. Every write names both and sets the next version in the same
-- UPDATE (routes/admin-calendar-share.ts); a write from an older version, or
-- from an earlier membership of the same person, changes nothing. That keeps
-- a grant whose answer was lost from landing after a later revoke the member
-- saw confirmed.
--
-- A plain column with a CHECK. No function or trigger.

ALTER TABLE public.workspace_members
  ADD COLUMN IF NOT EXISTS calendar_share_version integer NOT NULL DEFAULT 0
  CONSTRAINT workspace_members_calendar_share_version_check CHECK (calendar_share_version >= 0);
