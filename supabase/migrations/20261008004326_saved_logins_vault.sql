-- Saved logins on Supabase Vault: a person's own, like a password manager's
-- (packages/api/src/services/saved-logins/vault-store.ts).
--
-- Each saved login is two Vault secrets: what may be listed (name, address,
-- username) and its secrets (password, authenticator setup key). No value is
-- kept outside vault.secrets. Vault encrypts each secret under the database's
-- root key, bound to the secret's own id. Inside the encrypted text each value
-- also names the person, the login and the half it belongs to, and the server
-- refuses one that names anything else, so a row pointed at someone else's
-- secret doesn't open.
--
-- Key custody: on a local or self-hosted stack the Vault root key lives with
-- the database, on the same machine, and unless supabase/config.toml sets
-- [db] root_key it is the Supabase CLI's built-in one. That protects a copy of
-- the tables at best, not a copy of the machine: it is not managed key
-- custody, which needs a hosted database. The server can read every value: it
-- is not end-to-end encryption.
--
-- The SQL surface, granted to service_role only:
--
-- saved_login_secrets, which person owns each saved-login secret. Every one
-- has a row here from the transaction that made it, and the row goes with the
-- person (ON DELETE CASCADE), taking its secret with it (the trigger below).
-- Its foreign key to users is what serializes making a secret against
-- deleting the person: the insert locks the person's row until it commits, a
-- person deleted first refuses it, and one deleted after takes it along. So
-- no secret outlives its owner, whatever a racing write does.
--
-- saved_logins, which two secrets are each login's. A person's rows go with
-- them. Its two secret ids are foreign keys to saved_login_secrets, checked at
-- commit, so a row never points at a secret that is gone, and a transaction
-- that deletes a secret a row points at fails: cleaning up after a write that
-- failed can't break a login whose write landed after all.
--
-- create_saved_login_secret(p_owner uuid, p_value text) returns uuid: the one
-- way a value is encrypted, and owned. vault.create_secret writes its argument
-- to a row before encrypting it, which leaves the plaintext in the WAL and in a
-- dead row version (measured on Vault 0.3.1). This gives create_secret an
-- empty placeholder, records the owner, and hands the value to
-- vault.update_secret, which encrypts it as it writes. The vault schema isn't
-- exposed through PostgREST, so a query can't call either function itself.
--
-- saved_logins_opened, each login with its two halves decrypted, so a read
-- sees a row and the secrets it points at in one statement; an edit that
-- lands at the same time is seen whole or not at all. It is security_invoker:
-- it reads with the caller's own Vault privileges, which anon and
-- authenticated don't have even if a grant here were wrong. A query that
-- doesn't select a half doesn't decrypt it.
--
-- Two trigger functions, because vault.secrets has no key to these tables and
-- only a trigger ties a secret's lifetime to a row's:
--   - delete_saved_login_secrets_of_login(), on saved_logins: when a login is
--     deleted, or an edit points it at new secrets, its old secrets' ownership
--     rows go in the same statement;
--   - delete_vault_secret_of_owner_row(), on saved_login_secrets: when an
--     ownership row goes, for any reason, its Vault secret goes with it.
-- TRUNCATE fires neither.

CREATE TABLE IF NOT EXISTS public.saved_login_secrets (
  secret_id uuid PRIMARY KEY
    CONSTRAINT saved_login_secrets_secret_fkey REFERENCES vault.secrets(id),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS saved_login_secrets_user_id_idx ON public.saved_login_secrets (user_id);

ALTER TABLE public.saved_login_secrets ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.saved_login_secrets FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON TABLE public.saved_login_secrets TO service_role;

CREATE TABLE IF NOT EXISTS public.saved_logins (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  -- Checked at commit: deleting a person cascades to this table and to
  -- saved_login_secrets in an order Postgres chooses, and a check at the end
  -- of each cascade would refuse the one that runs first.
  item_secret_id uuid NOT NULL UNIQUE
    CONSTRAINT saved_logins_item_secret_fkey REFERENCES public.saved_login_secrets(secret_id)
    DEFERRABLE INITIALLY DEFERRED,
  secret_secret_id uuid NOT NULL UNIQUE
    CONSTRAINT saved_logins_secret_secret_fkey REFERENCES public.saved_login_secrets(secret_id)
    DEFERRABLE INITIALLY DEFERRED,
  -- Bumped by each edit, which must name the revision it read.
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT saved_logins_two_secrets CHECK (item_secret_id <> secret_secret_id)
);

CREATE INDEX IF NOT EXISTS saved_logins_user_id_idx ON public.saved_logins (user_id);

CREATE TRIGGER saved_logins_updated_at
  BEFORE UPDATE ON public.saved_logins
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.saved_logins ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.saved_logins FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.saved_logins TO service_role;

CREATE OR REPLACE FUNCTION public.create_saved_login_secret(p_owner uuid, p_value text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  created uuid;
BEGIN
  IF p_owner IS NULL OR p_value IS NULL THEN
    RAISE EXCEPTION 'A saved-login secret needs an owner and a value' USING ERRCODE = '22004';
  END IF;
  created := vault.create_secret('', NULL, 'saved_login:' || p_owner::text);
  -- Refused if the owner is gone; otherwise holds them until this commits.
  INSERT INTO public.saved_login_secrets (secret_id, user_id) VALUES (created, p_owner);
  PERFORM vault.update_secret(created, p_value);
  RETURN created;
END
$$;

REVOKE ALL ON FUNCTION public.create_saved_login_secret(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_saved_login_secret(uuid, text) TO service_role;

CREATE OR REPLACE VIEW public.saved_logins_opened
  WITH (security_invoker = true) AS
SELECT
  l.id,
  l.user_id,
  l.revision,
  l.created_at,
  l.updated_at,
  i.decrypted_secret AS item_value,
  s.decrypted_secret AS secret_value
FROM public.saved_logins l
JOIN vault.decrypted_secrets i ON i.id = l.item_secret_id
JOIN vault.decrypted_secrets s ON s.id = l.secret_secret_id;

REVOKE ALL ON public.saved_logins_opened FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.saved_logins_opened TO service_role;

CREATE OR REPLACE FUNCTION public.delete_saved_login_secrets_of_login()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM public.saved_login_secrets
    WHERE user_id = OLD.user_id
      AND secret_id IN (OLD.item_secret_id, OLD.secret_secret_id);
  ELSE
    DELETE FROM public.saved_login_secrets
    WHERE user_id = OLD.user_id
      AND ((secret_id = OLD.item_secret_id AND OLD.item_secret_id IS DISTINCT FROM NEW.item_secret_id)
        OR (secret_id = OLD.secret_secret_id AND OLD.secret_secret_id IS DISTINCT FROM NEW.secret_secret_id));
  END IF;
  RETURN NULL;
END
$$;

REVOKE ALL ON FUNCTION public.delete_saved_login_secrets_of_login() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER saved_logins_delete_secrets
  AFTER DELETE OR UPDATE OF item_secret_id, secret_secret_id ON public.saved_logins
  FOR EACH ROW
  EXECUTE FUNCTION public.delete_saved_login_secrets_of_login();

CREATE OR REPLACE FUNCTION public.delete_vault_secret_of_owner_row()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  DELETE FROM vault.secrets WHERE id = OLD.secret_id;
  RETURN NULL;
END
$$;

REVOKE ALL ON FUNCTION public.delete_vault_secret_of_owner_row() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER saved_login_secrets_delete_vault_secret
  AFTER DELETE ON public.saved_login_secrets
  FOR EACH ROW
  EXECUTE FUNCTION public.delete_vault_secret_of_owner_row();
