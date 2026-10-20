-- Explicit Data API grants for service_role on everything already in public.
--
-- Supabase is ending the automatic grant on new tables in "public". From
-- 2026-10-30 a new table in an existing hosted project gets no SELECT,
-- INSERT, UPDATE or DELETE for anon, authenticated or service_role, and
-- sequences lose their USAGE and SELECT the same way. Supabase CLI 2.102.0
-- and later can apply the same rule to `supabase start` and `db reset`
-- (supabase/supabase discussion 45329). Tables that already exist keep the
-- grants they were created with.
--
-- service_role bypasses RLS, not GRANT. The API reaches every table through
-- PostgREST as service_role, so a table it holds no privilege on answers
-- with 42501 "permission denied for table".
--
-- A database that already exists has its grants, so this file changes nothing
-- on the local stack as it stands: on 2026-10-20, service_role held all four
-- privileges on all 98 relations in public, every one owned by postgres, and
-- public had no sequences. It is for a build from an empty database under the
-- new rule (a fresh integration stack, a new machine, a new or branched
-- project), where every table created above this point would otherwise come
-- up with no privileges for service_role.
--
-- Only service_role is granted. anon and authenticated get no table access:
-- the web package uses Supabase for auth only, and its data goes through the
-- API.
--
-- One table's own migration grants less than this. saved_login_secrets is
-- given SELECT, INSERT and DELETE, without UPDATE, but the default grant
-- gave service_role UPDATE on it as well, and the local stack holds it today.
-- This file makes a fresh build match the stack as it is; narrowing that
-- table is a separate change.
--
-- From here on, the migration that creates a table, view, sequence or function
-- in public grants service_role on it itself (README.md, "Grants").
--
-- ALL TABLES covers tables, partitioned tables, views, materialized views and
-- foreign tables. Sequences get USAGE, SELECT and UPDATE, which is what the
-- default grant gave them. Granting a privilege that is already held changes
-- nothing, so the file can run twice.

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO service_role;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO service_role;

-- Functions lose their automatic grant too. The old default privileges gave
-- EXECUTE on every new function to anon, authenticated and service_role; the
-- new ones give it to the owner alone. These seven had no grant of their own.
-- Measured on a fresh build with the rule on (CLI 2.121.0,
-- auto_expose_new_tables = false): without these lines, the API's RPC calls
-- to the first three answer 42501 "permission denied for function". The other
-- four are trigger functions. On the live stack service_role already holds
-- EXECUTE on all seven.
--
-- They are granted by name. GRANT EXECUTE ON ALL FUNCTIONS would also give
-- service_role the _graph_* helpers, which earlier migrations deliberately
-- withhold from it.

GRANT EXECUTE ON FUNCTION public.claim_turn_epoch(uuid, boolean, timestamp with time zone, uuid, jsonb, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.fence_turn_attempts(uuid, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.repoint_sessions_off_ephemeral(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.delete_saved_login_secrets_of_login() TO service_role;
GRANT EXECUTE ON FUNCTION public.delete_vault_secret_of_owner_row() TO service_role;
GRANT EXECUTE ON FUNCTION public.handle_session_running_write() TO service_role;
GRANT EXECUTE ON FUNCTION public.refuse_session_turn_scope_change() TO service_role;
