-- A session has PROVEN it owns the hook turn signal once its runtime posts a
-- prompt lifecycle event (cli_turn_at's single writer stamps this alongside).
-- The lease sweep's narrow not-mid-turn release proof (PR #506) is only valid
-- for proven sessions: for producers that never write cli_turn_at, a NULL
-- marker is ambiguity, not evidence, and the sweep must fall back to the
-- conservative release rule (not live AND (stale OR terminal)).
ALTER TABLE sessions ADD COLUMN cli_turn_proven_at timestamptz;
