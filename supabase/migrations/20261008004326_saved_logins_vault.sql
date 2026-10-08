-- Saved logins on Supabase Vault: a person's own, like a password manager's
-- (packages/api/src/services/saved-logins/vault-store.ts).
--
-- Each saved login is two Vault secrets: what may be listed (name, address,
-- username) and its secrets (password, authenticator setup key). This table
-- holds no value, only which person owns which two secrets. Vault encrypts
-- each secret under the database's root key, bound to the secret's own id.
-- Inside the encrypted text each value also names the person, the login and
-- the half it belongs to, and the server refuses one that names anything else,
-- so a row pointed at someone else's secret doesn't open.
--
-- Key custody: on a local or self-hosted stack the Vault root key lives with
-- the database, on the same machine. That protects a copy of the tables, not
-- a copy of the machine: it is not managed key custody, which needs a hosted
-- database. The server can read every value: it is not end-to-end encryption.
--
-- The SQL surface, granted to service_role only:
--
-- saved_logins, the table. A person's rows go with them (ON DELETE CASCADE),
-- and their secrets go with the rows (the trigger below). Its two secret ids
-- are foreign keys to vault.secrets, so a row never points at a secret that
-- is gone, and a secret a row points at can't be deleted: cleaning up after
-- a write that failed can't break a login whose write landed after all.
--
-- create_saved_login_secret(p_owner uuid, p_value text) returns uuid: the one
-- way a value is encrypted. vault.create_secret writes its argument to a row
-- before encrypting it, which leaves the plaintext in the WAL and in a dead
-- row version (measured on Vault 0.3.1). This gives create_secret an empty
-- placeholder and hands the value to vault.update_secret, which encrypts it
-- as it writes. The vault schema isn't exposed through PostgREST, so a query
-- can't call either function itself.
--
-- saved_login_vault_secrets, a view of the saved-login secrets, decrypted, to
-- read them by id and to delete ones no row points at. It is security_invoker:
-- it reads with the caller's own Vault privileges, which anon and
-- authenticated don't have even if a grant here were wrong.
--
-- delete_saved_login_vault_secrets(), the trigger function that deletes a
-- login's secrets in the same transaction as its row, whether the row is
-- deleted directly or by the cascade from users, and the old secrets when an
-- edit points the row at new ones. vault.secrets has no key to this table, so
-- only a trigger ties a secret's lifetime to its row's. It deletes only
-- secrets tagged with the row's own owner. TRUNCATE doesn't fire it.

CREATE TABLE IF NOT EXISTS public.saved_logins (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  item_secret_id uuid NOT NULL UNIQUE
    CONSTRAINT saved_logins_item_secret_fkey REFERENCES vault.secrets(id),
  secret_secret_id uuid NOT NULL UNIQUE
    CONSTRAINT saved_logins_secret_secret_fkey REFERENCES vault.secrets(id),
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
  PERFORM vault.update_secret(created, p_value);
  RETURN created;
END
$$;

REVOKE ALL ON FUNCTION public.create_saved_login_secret(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_saved_login_secret(uuid, text) TO service_role;

CREATE OR REPLACE VIEW public.saved_login_vault_secrets
  WITH (security_invoker = true) AS
SELECT s.id, s.description AS owner_tag, s.decrypted_secret AS value
FROM vault.decrypted_secrets s
WHERE starts_with(s.description, 'saved_login:');

REVOKE ALL ON public.saved_login_vault_secrets FROM PUBLIC, anon, authenticated;
GRANT SELECT, DELETE ON public.saved_login_vault_secrets TO service_role;

CREATE OR REPLACE FUNCTION public.delete_saved_login_vault_secrets()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM vault.secrets
    WHERE id IN (OLD.item_secret_id, OLD.secret_secret_id)
      AND description = 'saved_login:' || OLD.user_id::text;
  ELSE
    DELETE FROM vault.secrets
    WHERE description = 'saved_login:' || OLD.user_id::text
      AND ((id = OLD.item_secret_id AND OLD.item_secret_id IS DISTINCT FROM NEW.item_secret_id)
        OR (id = OLD.secret_secret_id AND OLD.secret_secret_id IS DISTINCT FROM NEW.secret_secret_id));
  END IF;
  RETURN NULL;
END
$$;

REVOKE ALL ON FUNCTION public.delete_saved_login_vault_secrets() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER saved_logins_delete_vault_secrets
  AFTER DELETE OR UPDATE OF item_secret_id, secret_secret_id ON public.saved_logins
  FOR EACH ROW
  EXECUTE FUNCTION public.delete_saved_login_vault_secrets();
