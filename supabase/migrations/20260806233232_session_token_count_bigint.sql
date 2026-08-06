-- sessions.token_count: integer → bigint
--
-- Lumen's LoCoMo full-corpus benchmark run (272 sessions seeded, 1,986
-- retrieval queries) accumulated 3,441,018,986 cumulative tokens on one
-- session — past int32 max (2,147,483,647). Every session-state update then
-- failed with Postgres 22003 ("value out of range for type integer"), which
-- surfaced as "[Trigger] SessionService failed: Unknown error" and left the
-- session unable to persist state at all.
--
-- Cumulative token counters are unbounded by design; bigint is the correct
-- type. PostgREST returns bigint as a JS number (safe far past this scale),
-- so no application-code change is needed.

ALTER TABLE public.sessions
  ALTER COLUMN token_count TYPE bigint;
