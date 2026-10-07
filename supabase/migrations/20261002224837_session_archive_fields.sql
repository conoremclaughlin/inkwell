-- The one "do not route here automatically" signal, added beside the old one.
--
-- ink://specs/session-lifecycle-model v7 §2.2, task T2 (group 249b9da1).
-- A session is a transcript and can always be resumed; `ended_at` stops being
-- the routing fence, and `archived_at` replaces it. `archived_reason` records
-- why, because an explicit address to an archived session is decided by it:
--   backfill    the cutover archived history nothing validly pointed at; an
--               explicit address reopens it
--   deliberate  archive_session, by a human or by the SB about its own session
--   handoff     handoff_session moved every binding to a successor
--   empty       a race-loser row that never held a conversation
--
-- ADDITIVE ONLY. Nothing reads or writes these columns yet: the writers land
-- in T3 and the readers in T5, together, inside the T11 cutover window. Until
-- then every row reads archived_at NULL, which is why there is no unique
-- index here. The session-key index under `archived_at IS NULL` would fail on
-- the 315 rows (5 key groups) that collide once ended rows count, and it is
-- installed in T11 after the dry-run manifest resolves them.
--
-- The forward pointer (`metadata.handedOffTo`) and a backend's refusal to
-- resume a transcript (`metadata.resumeRefused`) live in metadata. Their
-- shapes are in services/sessions/types.ts.

ALTER TABLE sessions
  ADD COLUMN archived_at timestamptz,
  ADD COLUMN archived_reason text
    CHECK (archived_reason IN ('backfill', 'deliberate', 'handoff', 'empty'));

-- A reason without a timestamp, or the reverse, is not a state anything can
-- read: both are set together and cleared together (unarchive).
ALTER TABLE sessions
  ADD CONSTRAINT sessions_archived_reason_with_archived_at
    CHECK ((archived_at IS NULL) = (archived_reason IS NULL));

-- Non-unique partial indexes for the predicate the T5 readers will use,
-- mirroring today's ended_at partials for the same lookups.
CREATE INDEX idx_sessions_unarchived_lookup
  ON sessions (user_id, agent_id, studio_id)
  WHERE archived_at IS NULL;

CREATE INDEX idx_sessions_unarchived_thread_key
  ON sessions (user_id, agent_id, thread_key)
  WHERE archived_at IS NULL AND thread_key IS NOT NULL;

CREATE INDEX idx_sessions_unarchived_alias
  ON sessions (user_id, agent_id, alias)
  WHERE archived_at IS NULL AND alias IS NOT NULL;
