-- Add identity_id to scheduled_reminders for per-agent reminder routing.
-- Without this, all reminders route to the server's default agent (AGENT_ID env var).

ALTER TABLE public.scheduled_reminders
  ADD COLUMN IF NOT EXISTS identity_id uuid REFERENCES public.agent_identities(id);

CREATE INDEX IF NOT EXISTS idx_reminders_identity_id
  ON public.scheduled_reminders (identity_id)
  WHERE identity_id IS NOT NULL;
