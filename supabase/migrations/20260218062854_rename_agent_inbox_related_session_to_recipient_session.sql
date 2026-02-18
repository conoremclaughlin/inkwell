-- Rename agent_inbox.related_session_id -> recipient_session_id for directional clarity

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'agent_inbox'
      AND column_name = 'related_session_id'
  ) AND NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'agent_inbox'
      AND column_name = 'recipient_session_id'
  ) THEN
    ALTER TABLE public.agent_inbox
      RENAME COLUMN related_session_id TO recipient_session_id;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'agent_inbox_related_session_id_fkey'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'agent_inbox_recipient_session_id_fkey'
  ) THEN
    ALTER TABLE public.agent_inbox
      RENAME CONSTRAINT agent_inbox_related_session_id_fkey TO agent_inbox_recipient_session_id_fkey;
  END IF;
END $$;

ALTER INDEX IF EXISTS public.idx_agent_inbox_session
  RENAME TO idx_agent_inbox_recipient_session;

COMMENT ON COLUMN public.agent_inbox.recipient_session_id IS 'For session_resume messages, the recipient session to continue';
