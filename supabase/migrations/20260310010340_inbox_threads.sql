-- Group Threads for Cross-Agent Communication
-- Spec: pcp://specs/cross-agent-communication v7
--
-- Adds thread-first messaging: messages belong to threads, not individual recipients.
-- Late joiners see full history. Trigger rules depend on thread size and sender role.

-- Thread entity — created implicitly on first message with a threadKey
CREATE TABLE inbox_threads (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  thread_key TEXT NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_by_agent_id TEXT NOT NULL,
  title TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  closed_by_agent_id TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  closed_at TIMESTAMPTZ,

  CONSTRAINT inbox_threads_unique_key UNIQUE (user_id, thread_key),
  CONSTRAINT inbox_threads_valid_status CHECK (status IN ('open', 'closed'))
);

-- Who's in the thread
CREATE TABLE inbox_thread_participants (
  thread_id UUID NOT NULL REFERENCES inbox_threads(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (thread_id, agent_id)
);

-- Messages belong to the thread, not to individual recipients
CREATE TABLE inbox_thread_messages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  thread_id UUID NOT NULL REFERENCES inbox_threads(id) ON DELETE CASCADE,
  sender_agent_id TEXT NOT NULL,
  content TEXT NOT NULL,
  message_type TEXT NOT NULL DEFAULT 'message',
  priority TEXT NOT NULL DEFAULT 'normal',
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),

  CONSTRAINT inbox_thread_messages_valid_type CHECK (
    message_type IN ('message', 'task_request', 'session_resume', 'notification', 'system')
  ),
  CONSTRAINT inbox_thread_messages_valid_priority CHECK (
    priority IN ('low', 'normal', 'high', 'urgent')
  )
);

-- Per-agent read tracking without duplicating messages
CREATE TABLE inbox_thread_read_status (
  thread_id UUID NOT NULL REFERENCES inbox_threads(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  last_read_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (thread_id, agent_id)
);

-- Indexes
CREATE INDEX idx_inbox_threads_user_status ON inbox_threads (user_id, status);
CREATE INDEX idx_inbox_thread_messages_thread ON inbox_thread_messages (thread_id, created_at);
CREATE INDEX idx_inbox_thread_participants_agent ON inbox_thread_participants (agent_id, thread_id);

-- updated_at trigger (uses canonical helper from initial schema)
CREATE TRIGGER update_inbox_threads_updated_at
  BEFORE UPDATE ON inbox_threads
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- RLS
ALTER TABLE inbox_threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE inbox_thread_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE inbox_thread_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE inbox_thread_read_status ENABLE ROW LEVEL SECURITY;

-- Service role policies (server-side access via service key bypasses RLS,
-- but we add permissive policies as safety net per project convention)
CREATE POLICY inbox_threads_service ON inbox_threads FOR ALL USING (true);
CREATE POLICY inbox_thread_participants_service ON inbox_thread_participants FOR ALL USING (true);
CREATE POLICY inbox_thread_messages_service ON inbox_thread_messages FOR ALL USING (true);
CREATE POLICY inbox_thread_read_status_service ON inbox_thread_read_status FOR ALL USING (true);
