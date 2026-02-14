-- Integration Health: tracks the status of external service integrations per user.
-- SBs report integration failures here via the update_integration_health MCP tool.
-- One row per user per service (upsert on status change).

CREATE TABLE integration_health (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  service text NOT NULL,
  status text NOT NULL DEFAULT 'healthy',
  error_code text,
  error_message text,
  last_check_at timestamp with time zone DEFAULT now(),
  last_healthy_at timestamp with time zone,
  reported_by_agent_id text,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (user_id, service),
  CONSTRAINT integration_health_status_check CHECK (status IN ('healthy', 'degraded', 'error', 'not_configured'))
);

-- Index for fast lookup by user
CREATE INDEX idx_integration_health_user_id ON integration_health(user_id);

-- Index for finding unhealthy integrations
CREATE INDEX idx_integration_health_status ON integration_health(status) WHERE status != 'healthy';

-- RLS
ALTER TABLE integration_health ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access to integration_health" ON integration_health
FOR ALL
USING ((auth.jwt() ->> 'role'::text) = 'service_role'::text);

CREATE POLICY "Users can view own integration health" ON integration_health
FOR SELECT
USING (auth.uid() = user_id);

-- Updated_at trigger
CREATE TRIGGER set_integration_health_updated_at
  BEFORE UPDATE ON integration_health
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();
