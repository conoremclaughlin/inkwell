-- What a member's calendar shares in a space (ink://specs/inkling-multi-person-groups,
-- D5-D7): 'none', where every member starts in every space, or 'busy', the
-- member's own "share my busy times here" switch. Busy is free/busy only, no
-- event contents, from now to a year ahead, never the past.
--
-- Connecting a calendar sets nothing here (D6). Only the member sets their own
-- row (routes/admin-calendar-share.ts); no admin or owner path writes it.
-- Richer levels come later, each added to the CHECK when it is built.
--
-- A plain column with a CHECK. No function or trigger.

ALTER TABLE public.workspace_members
  ADD COLUMN IF NOT EXISTS calendar_share text NOT NULL DEFAULT 'none'
  CONSTRAINT workspace_members_calendar_share_check CHECK (calendar_share IN ('none', 'busy'));
