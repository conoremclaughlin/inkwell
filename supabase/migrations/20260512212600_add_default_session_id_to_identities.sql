-- Add default_session_id to agent_identities for explicit session routing.
-- When set, threadKey misses route to this session instead of creating new ones.
-- When null, normal per-thread session creation behavior applies.

ALTER TABLE agent_identities
  ADD COLUMN IF NOT EXISTS default_session_id uuid REFERENCES sessions(id) ON DELETE SET NULL;

-- Revert Myra's session_scope back to global (default_session_id replaces the signal).
-- Guarded: only sets default_session_id if the target session exists in this environment.
UPDATE agent_identities
  SET session_scope = 'global',
      default_session_id = CASE
        WHEN EXISTS (SELECT 1 FROM sessions WHERE id = 'c1950bdb-a181-4a4e-8042-9eb19348cdaf')
        THEN 'c1950bdb-a181-4a4e-8042-9eb19348cdaf'::uuid
        ELSE NULL
      END
  WHERE id = '77abea5c-9787-4901-af06-d8ab2f4116e4'
    AND agent_id = 'myra';
