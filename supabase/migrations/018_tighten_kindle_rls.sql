-- Drop USING(true) policies on kindle tables
--
-- Migration 010 created these policies named "service_role_*" but with
-- USING(true), making them wide-open to any role including anon.
-- The server uses service_role key (bypasses RLS), so replacing with
-- proper service-role-only policies.

DROP POLICY IF EXISTS "service_role_kindle_lineage" ON kindle_lineage;
DROP POLICY IF EXISTS "service_role_kindle_tokens" ON kindle_tokens;

CREATE POLICY "Service role full access to kindle_lineage"
  ON kindle_lineage FOR ALL
  USING ((auth.jwt() ->> 'role'::text) = 'service_role'::text);

CREATE POLICY "Service role full access to kindle_tokens"
  ON kindle_tokens FOR ALL
  USING ((auth.jwt() ->> 'role'::text) = 'service_role'::text);
