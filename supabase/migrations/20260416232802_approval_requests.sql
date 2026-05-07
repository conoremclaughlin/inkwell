-- 2FA Permission Approval Requests
-- Tracks elevated permission requests from agent sessions and their resolution.
-- Grants can ONLY be written by platform listeners (system layer), never by agents.

CREATE TABLE approval_requests (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  studio_id UUID REFERENCES studios(id) ON DELETE SET NULL,
  session_id UUID REFERENCES sessions(id) ON DELETE SET NULL,
  requesting_agent_id TEXT NOT NULL,

  -- What's being requested
  tool TEXT NOT NULL,
  args TEXT,
  reason TEXT,

  -- Resolution
  status TEXT NOT NULL DEFAULT 'pending',
  action TEXT,  -- 'grant', 'grant-session', 'allow', 'deny'
  granted_tools TEXT[],  -- tool patterns that were approved
  granted_by TEXT,  -- 'platform:telegram:<platformId>' or 'platform:whatsapp:<phone>'
  resolved_at TIMESTAMPTZ,

  -- Config
  timeout_seconds INTEGER NOT NULL DEFAULT 300,
  expires_at TIMESTAMPTZ NOT NULL,

  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  CONSTRAINT approval_requests_valid_status CHECK (
    status IN ('pending', 'granted', 'denied', 'expired', 'cancelled')
  ),
  CONSTRAINT approval_requests_valid_action CHECK (
    action IS NULL OR action IN ('grant', 'grant-session', 'allow', 'deny')
  )
);

-- Indexes
CREATE INDEX idx_approval_requests_user_id ON approval_requests(user_id);
CREATE INDEX idx_approval_requests_studio_id ON approval_requests(studio_id);
CREATE INDEX idx_approval_requests_session_id ON approval_requests(session_id);
CREATE INDEX idx_approval_requests_status ON approval_requests(status) WHERE status = 'pending';
CREATE INDEX idx_approval_requests_expires_at ON approval_requests(expires_at) WHERE status = 'pending';

-- Auto-update updated_at
CREATE TRIGGER update_approval_requests_updated_at
  BEFORE UPDATE ON approval_requests
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- RLS
ALTER TABLE approval_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access on approval_requests"
  ON approval_requests FOR ALL
  USING (true)
  WITH CHECK (true);

-- Also add permission_grant and permission_request to inbox_thread_messages message_type constraint
ALTER TABLE inbox_thread_messages
  DROP CONSTRAINT inbox_thread_messages_valid_type,
  ADD CONSTRAINT inbox_thread_messages_valid_type CHECK (
    message_type IN ('message', 'task_request', 'session_resume', 'notification', 'system', 'permission_request', 'permission_grant')
  );
