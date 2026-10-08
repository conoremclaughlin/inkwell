-- Saved logins sealed by the server: the store a server uses instead of
-- Supabase Vault when SAVED_LOGINS_STORE=sealed
-- (packages/api/src/services/saved-logins/sealed-store.ts). Unused otherwise.
--
-- Nothing here is readable without the server's sealing key
-- (SAVED_LOGINS_SEALING_KEY). Each row is two AES-256-GCM sealed values
-- (services/saved-logins/sealing.ts):
--   - item_sealed:   what may be listed (name, address, username);
--   - secret_sealed: the password and the authenticator's setup key.
-- Each is bound to its row, its owner and its half, so a sealed value copied
-- to another row or person doesn't open. The table has no plaintext column
-- beyond the row's id, owner, revision and times. The server holds the key, so
-- this protects what is stored, not what the server can read: it is not
-- end-to-end encryption.
--
-- No function beyond the canonical updated_at trigger, and no policy. Row
-- level security is on with no policies, so only the service role the API uses
-- can read or write it. A person's rows go with them (ON DELETE CASCADE).

CREATE TABLE IF NOT EXISTS public.saved_logins_sealed (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  item_sealed text NOT NULL,
  secret_sealed text NOT NULL,
  -- Bumped by each edit, which must name the revision it read.
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT saved_logins_sealed_format CHECK (
    item_sealed LIKE 'v1.%' AND secret_sealed LIKE 'v1.%'
  )
);

CREATE INDEX IF NOT EXISTS saved_logins_sealed_user_id_idx ON public.saved_logins_sealed (user_id);

CREATE TRIGGER saved_logins_sealed_updated_at
  BEFORE UPDATE ON public.saved_logins_sealed
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.saved_logins_sealed ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.saved_logins_sealed FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.saved_logins_sealed TO service_role;
