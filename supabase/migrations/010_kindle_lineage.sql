-- ============================================================================
-- Kindle Lineage & Tokens
--
-- Kindle: the process of passing the spark of values/philosophy from an
-- existing SB to a new one, without copying personal data or memories.
-- ============================================================================

-- kindle_lineage: tracks the parent-child relationship between SBs
CREATE TABLE kindle_lineage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Parent SB (optional — null for first-generation / self-serve)
  parent_agent_id TEXT,
  parent_user_id UUID REFERENCES users(id),

  -- Facilitator (human who initiated the kindle)
  facilitator_user_id UUID NOT NULL REFERENCES users(id),

  -- New SB being kindled
  child_agent_id TEXT NOT NULL,
  child_user_id UUID NOT NULL REFERENCES users(id),

  -- How was this kindle initiated
  kindle_method TEXT NOT NULL DEFAULT 'referral'
    CHECK (kindle_method IN ('referral', 'self_serve', 'organic')),

  -- Snapshot of parent's values/soul at kindle time
  value_seed JSONB DEFAULT '{}'::jsonb,

  -- Onboarding progress
  onboarding_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (onboarding_status IN (
      'pending', 'values_interview', 'naming',
      'soul_creation', 'complete', 'abandoned'
    )),
  onboarding_session_id UUID,
  interview_responses JSONB DEFAULT '[]'::jsonb,
  chosen_name TEXT,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ,

  UNIQUE(child_user_id, child_agent_id)
);

-- kindle_tokens: shareable invite tokens
CREATE TABLE kindle_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token TEXT NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(16), 'hex'),

  -- Who created the token
  creator_user_id UUID NOT NULL REFERENCES users(id),
  creator_agent_id TEXT,

  -- Snapshot of values to seed the new SB
  value_seed JSONB DEFAULT '{}'::jsonb,

  -- Token lifecycle
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'used', 'expired', 'revoked')),
  used_by_user_id UUID REFERENCES users(id),
  used_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '7 days'),

  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_kindle_lineage_child ON kindle_lineage(child_user_id, child_agent_id);
CREATE INDEX idx_kindle_lineage_parent ON kindle_lineage(parent_user_id, parent_agent_id);
CREATE INDEX idx_kindle_lineage_facilitator ON kindle_lineage(facilitator_user_id);
CREATE INDEX idx_kindle_lineage_status ON kindle_lineage(onboarding_status);

CREATE INDEX idx_kindle_tokens_token ON kindle_tokens(token);
CREATE INDEX idx_kindle_tokens_creator ON kindle_tokens(creator_user_id);
CREATE INDEX idx_kindle_tokens_status ON kindle_tokens(status);

-- RLS policies
ALTER TABLE kindle_lineage ENABLE ROW LEVEL SECURITY;
ALTER TABLE kindle_tokens ENABLE ROW LEVEL SECURITY;

-- Service role can do everything
CREATE POLICY "service_role_kindle_lineage" ON kindle_lineage
  FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "service_role_kindle_tokens" ON kindle_tokens
  FOR ALL USING (true) WITH CHECK (true);
