-- Add provider column to agent_identities.
--
-- backend  = the runtime/harness that runs the agent (ink, claude-code, codex-cli, gemini)
-- provider = the LLM provider the runtime delegates to (claude-code, codex-cli, gemini)
--
-- For non-ink backends, provider is typically the same as backend.
-- For ink, provider specifies which LLM the ink runtime uses underneath.

ALTER TABLE agent_identities
  ADD COLUMN IF NOT EXISTS provider text;

-- Backfill: copy current backend values into provider.
-- Today backend holds the LLM provider, not the runtime — this preserves that info
-- before callers start setting backend='ink'.
UPDATE agent_identities
  SET provider = backend
  WHERE provider IS NULL AND backend IS NOT NULL;
