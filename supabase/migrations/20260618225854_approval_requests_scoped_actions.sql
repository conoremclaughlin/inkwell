-- Add grant-agent and grant-studio actions to approval_requests
-- These support persistent approval scopes (approve agent / approve studio)
-- that write back to the tool policy for permanent grants.

ALTER TABLE approval_requests
  DROP CONSTRAINT approval_requests_valid_action,
  ADD CONSTRAINT approval_requests_valid_action CHECK (
    action IS NULL OR action IN (
      'grant',          -- one-shot approval
      'grant-session',  -- approved for the rest of this session
      'grant-agent',    -- permanently approved at agent scope
      'grant-studio',   -- permanently approved at studio scope
      'allow',          -- permanently allowed (legacy alias for grant-agent)
      'deny'            -- denied
    )
  );
