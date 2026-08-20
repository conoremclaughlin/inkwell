-- A session is PROVEN when its runtime declares (turnGated) that it GATES
-- every turn on an acknowledged prompt post — the Ink REPL refuses turns
-- otherwise — and the lifecycle route stamps this alongside cli_turn_at.
-- The lease sweep's narrow not-mid-turn release proof (PR #506) is only
-- valid for proven sessions: for them a NULL marker really means no turn is
-- running. Producers that proceed regardless (hook CLIs) never set this —
-- a historical bit from them would vouch for turns whose prompt post was
-- swallowed — and the sweep falls back to the conservative release rule
-- (not live AND (stale OR terminal)). Deliberately never backfilled.
ALTER TABLE sessions ADD COLUMN cli_turn_proven_at timestamptz;
