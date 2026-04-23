-- Agent session scope configuration
--
-- Controls whether an SB uses per-sender session isolation.
-- Values:
--   'global'     — default, all senders share one session (today's behavior)
--   'per_sender'  — each external sender gets an isolated session + memories
--
-- Aligns with OpenClaw's session.scope naming convention.

ALTER TABLE agent_identities ADD COLUMN IF NOT EXISTS session_scope text DEFAULT 'global';

COMMENT ON COLUMN agent_identities.session_scope IS
  'Session isolation mode: global (shared) or per_sender (isolated per external sender)';
