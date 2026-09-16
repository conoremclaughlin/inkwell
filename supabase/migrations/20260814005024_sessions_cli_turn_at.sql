-- Hook-owned CLI turn signal (PR #492 round 4, Lumen P1).
--
-- cli_poll_at is an OPTIONAL channel-plugin heartbeat — interactive CLIs on
-- the supported no-plugin path never stamp it, so lease liveness based on it
-- reported them dead mid-turn. cli_turn_at is owned by the core lifecycle
-- hooks every supported CLI runs: stamped by on-prompt, cleared ONLY by the
-- real on-stop boundary (post-compact idle leaves it set — the same turn
-- resumes). Terminal APIs never touch it, so a terminal write cannot make a
-- dead CLI look alive or a live one look dead. Bounded by LEASE_STALE_MS at
-- read time so a crashed mid-turn CLI stops blocking after the staleness
-- window.

ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS cli_turn_at timestamptz;
