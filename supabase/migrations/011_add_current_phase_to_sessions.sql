-- Add current_phase to sessions for real-time work status tracking.
-- Part of the session/memory redesign (C+ model): sessions become structural,
-- memories become narrative. Phase transitions auto-create memories for blockers.
--
-- Phase values: investigating, implementing, reviewing, blocked:<reason>, waiting:<reason>, paused, complete
-- See spec: pcp://specs/session-memory-redesign

ALTER TABLE sessions ADD COLUMN current_phase TEXT;

-- Index for phase-based queries (e.g., "find all blocked sessions")
CREATE INDEX idx_sessions_current_phase ON sessions(current_phase) WHERE ended_at IS NULL;
