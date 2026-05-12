-- Add default_session_id to agent_identities for explicit session routing.
-- When set, threadKey misses route to this session instead of creating new ones.
-- When null, normal per-thread session creation behavior applies.

ALTER TABLE agent_identities
  ADD COLUMN IF NOT EXISTS default_session_id uuid REFERENCES sessions(id) ON DELETE SET NULL;

-- Revert Myra's session_scope back to global (default_session_id replaces the signal)
UPDATE agent_identities
  SET session_scope = 'global',
      default_session_id = 'c1950bdb-a181-4a4e-8042-9eb19348cdaf'
  WHERE id = '77abea5c-9787-4901-af06-d8ab2f4116e4'
    AND agent_id = 'myra';
