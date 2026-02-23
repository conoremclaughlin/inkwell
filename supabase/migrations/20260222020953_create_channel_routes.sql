-- Channel Routes: DB-driven message routing
-- Maps (platform, account, chat) → agent identity for incoming messages.
-- Replaces the static AGENT_ID env var with a specificity-based cascade.

CREATE TABLE channel_routes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  identity_id uuid NOT NULL REFERENCES agent_identities(id) ON DELETE CASCADE,
  platform text NOT NULL,              -- 'telegram', 'whatsapp', 'discord'
  platform_account_id text,            -- bot username/id (nullable = any account on this platform)
  chat_id text,                        -- specific chat/conversation (nullable = all chats on this account)
  is_active boolean NOT NULL DEFAULT true,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Resolution index: used for the specificity cascade lookup
CREATE INDEX idx_channel_routes_lookup
  ON channel_routes (user_id, platform, platform_account_id, chat_id)
  WHERE is_active = true;

-- Prevent duplicate routes at the same specificity level
CREATE UNIQUE INDEX idx_channel_routes_unique_route
  ON channel_routes (user_id, platform, COALESCE(platform_account_id, ''), COALESCE(chat_id, ''));

-- Auto-update updated_at
CREATE TRIGGER channel_routes_updated_at
  BEFORE UPDATE ON channel_routes
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- RLS: service role + user self-management (matches agent_identities pattern)
ALTER TABLE channel_routes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access to channel_routes" ON channel_routes
  FOR ALL USING ((auth.jwt() ->> 'role') = 'service_role');

CREATE POLICY "Users can view own channel routes" ON channel_routes
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own channel routes" ON channel_routes
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own channel routes" ON channel_routes
  FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own channel routes" ON channel_routes
  FOR DELETE USING (auth.uid() = user_id);

-- Seed: route all Telegram messages to Myra (platform-level default)
-- Uses DISTINCT ON to pick the latest Myra identity per user, regardless of workspace.
INSERT INTO channel_routes (user_id, identity_id, platform)
SELECT DISTINCT ON (ai.user_id)
  ai.user_id,
  ai.id,
  'telegram'
FROM agent_identities ai
WHERE ai.agent_id = 'myra'
ORDER BY ai.user_id, ai.updated_at DESC
ON CONFLICT DO NOTHING;

-- Seed: route all WhatsApp messages to Myra
INSERT INTO channel_routes (user_id, identity_id, platform)
SELECT DISTINCT ON (ai.user_id)
  ai.user_id,
  ai.id,
  'whatsapp'
FROM agent_identities ai
WHERE ai.agent_id = 'myra'
ORDER BY ai.user_id, ai.updated_at DESC
ON CONFLICT DO NOTHING;
