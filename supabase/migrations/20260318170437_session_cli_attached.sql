-- Track whether a CLI session has a human attached (interactive REPL).
-- When cli_attached = true, triggers route messages to the pending queue
-- instead of spawning a new process.
-- See spec: pcp://specs/mcp-context-token

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS cli_attached boolean DEFAULT false;
