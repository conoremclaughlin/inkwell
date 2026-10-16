-- Existing grants retain the app-only contract. Ordinary hosted companions
-- require a new, explicitly consented pairing; tokens do not carry this field.
ALTER TABLE public.browser_companion_grants
  ADD COLUMN recipient_id uuid REFERENCES public.agent_identities(id) ON DELETE CASCADE;

CREATE INDEX browser_companion_grants_recipient_idx
  ON public.browser_companion_grants (recipient_id)
  WHERE recipient_id IS NOT NULL;

COMMENT ON COLUMN public.browser_companion_grants.recipient_id IS
  'Explicit ordinary hosted recipient for this pairing. NULL retains app-only access; never an implicit workspace-wide grant.';
