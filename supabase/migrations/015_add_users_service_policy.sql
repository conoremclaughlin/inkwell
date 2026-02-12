-- Add service role policy to users table
--
-- The users table has RLS enabled (001_initial_schema.sql) with only
-- auth.uid()-based policies. These policies are non-functional because
-- users.id is a PCP-internal UUID (uuid_generate_v4()), NOT the Supabase
-- Auth UID that auth.uid() returns.
--
-- The server accesses this table via service role key, which bypasses RLS.
-- However, as a safety net (and to match the pattern used by agent_identities,
-- user_identity, and other tables), add an explicit service role policy.

CREATE POLICY "Service role full access to users"
  ON users FOR ALL
  USING ((auth.jwt() ->> 'role'::text) = 'service_role'::text);
