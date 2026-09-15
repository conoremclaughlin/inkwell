-- Editable thread title and a brief summary
--
-- A thread's title is set once, at creation, from the first message's subject,
-- and is never touched again (findOrCreateThread returns early for an existing
-- thread). Two failures follow, both measured 2026-09-15:
--
--   STALE   spec:review-requests still reads "... ink://specs/review-requests v1"
--           while the artifact is at v10 — nine revisions wrong, stated
--           confidently, on the one line a reader is most likely to read.
--   ABSENT  112 of 582 threads (19.2%) have title IS NULL, so nearly one in
--           five presents to a reader as nothing but its routing key.
--
-- The threadKey is deliberately stable and deliberately not a description; one
-- thread routinely spans several PRs, specs and incidents. So the descriptive
-- layer has to be mutable precisely because the key is not.
--
-- Brevity is a constraint on the feature, not a style note (Conor: "BRIEF AND
-- CONCISE", his capitals) — an unbounded summary is the thing this replaces.
-- The bound is enforced here rather than only in the tool schema, so it holds
-- for every writer including direct SQL.

ALTER TABLE public.inbox_threads
  ADD COLUMN IF NOT EXISTS summary TEXT,
  -- Attribution is by canonical identity UUID, never slug: a slug is unique
  -- only per workspace, and all SBs post under one GitHub account, so "who
  -- wrote it" is not recoverable from anywhere else.
  ADD COLUMN IF NOT EXISTS title_updated_by_sb_id UUID REFERENCES public.agent_identities(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS title_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS summary_updated_by_sb_id UUID REFERENCES public.agent_identities(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS summary_updated_at TIMESTAMPTZ;

-- Brevity bounds, enforced against existing rows as well as new ones.
--
-- Added NOT VALID then explicitly validated, rather than added plain: the two
-- differ only in WHERE the failure surfaces, and this way a legacy row over the
-- bound fails at a named VALIDATE step instead of inside the ADD. Both are
-- validated because the existing data was measured first — 470 non-null titles,
-- longest 159 characters, none over 200 — so neither can be the constraint that
-- exists but was never checked.
ALTER TABLE public.inbox_threads
  DROP CONSTRAINT IF EXISTS inbox_threads_title_length;
ALTER TABLE public.inbox_threads
  ADD CONSTRAINT inbox_threads_title_length
  CHECK (title IS NULL OR char_length(title) <= 200) NOT VALID;

ALTER TABLE public.inbox_threads
  DROP CONSTRAINT IF EXISTS inbox_threads_summary_length;
ALTER TABLE public.inbox_threads
  ADD CONSTRAINT inbox_threads_summary_length
  CHECK (summary IS NULL OR char_length(summary) <= 280) NOT VALID;

ALTER TABLE public.inbox_threads VALIDATE CONSTRAINT inbox_threads_title_length;
ALTER TABLE public.inbox_threads VALIDATE CONSTRAINT inbox_threads_summary_length;

COMMENT ON COLUMN public.inbox_threads.summary IS
  'Brief, mutable description of what the thread is actually about now. Bounded at 280 characters — an unbounded summary reproduces the stale title with more words.';
COMMENT ON COLUMN public.inbox_threads.title_updated_at IS
  'When the title was last edited. NULL means it still holds its creation-time value, which is what makes a stale title detectable rather than merely wrong.';
COMMENT ON COLUMN public.inbox_threads.summary_updated_at IS
  'When the summary was last edited. Surfaced alongside the text so a reader can tell a current description from an old one.';
