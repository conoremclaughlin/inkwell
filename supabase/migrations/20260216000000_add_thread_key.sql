ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS thread_key text;
ALTER TABLE public.agent_inbox ADD COLUMN IF NOT EXISTS thread_key text;

CREATE INDEX IF NOT EXISTS idx_sessions_thread_key_active
  ON public.sessions (user_id, agent_id, thread_key)
  WHERE ended_at IS NULL AND thread_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_agent_inbox_thread_key
  ON public.agent_inbox (recipient_user_id, recipient_agent_id, thread_key)
  WHERE thread_key IS NOT NULL;
