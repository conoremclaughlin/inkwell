-- Observer-attach durable ledger locator (spec:observer-attach §4.5).
--
-- A dedicated column instead of a sessions.metadata key: the metadata JSON is
-- read-modify-written by several writers, so merging the locator into it races
-- them (last write wins, locator silently lost). A single-column UPDATE is
-- race-free and lets failures surface per-column.

ALTER TABLE public.sessions
  ADD COLUMN IF NOT EXISTS observer_ledger_path text;

COMMENT ON COLUMN public.sessions.observer_ledger_path IS
  'Absolute path of the session runtime''s canonical ledger (.jsonl), announced by the runtime via session_meta. Used by the observer channel for durable replay across bus eviction and server restarts.';
