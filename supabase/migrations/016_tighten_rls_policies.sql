-- Tighten RLS across all public tables
--
-- Problem: Several tables either have no RLS enabled or have overly permissive
-- USING(true) policies. The Supabase publishable key (anon key) is exposed in
-- the browser, meaning anyone can make PostgREST queries. Without proper RLS,
-- tables like mcp_tokens (containing refresh tokens) and memories are readable
-- by any client with the anon key.
--
-- Fix: Enable RLS on all unprotected tables and drop USING(true) policies.
-- The server uses the service_role key which bypasses RLS entirely, so these
-- changes only affect client-side (browser) access — which should be blocked.
--
-- NOTE: The auth.uid() = id/user_id policies on many tables are currently
-- non-functional (PCP user IDs ≠ Supabase Auth UIDs). That's a separate issue.
-- The important thing here is that no table is wide-open to anon/authenticated.

-- =====================================================
-- 1. Enable RLS on tables that don't have it
-- =====================================================

ALTER TABLE activity_stream ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE artifact_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcp_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE skill_installations ENABLE ROW LEVEL SECURITY;
ALTER TABLE skill_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE skills ENABLE ROW LEVEL SECURITY;

-- =====================================================
-- 2. Drop overly permissive USING(true) policies
--
-- These allowed ANY role (including anon) full access.
-- The service_role key bypasses RLS entirely, so server-
-- side access is unaffected by removing these.
-- =====================================================

DROP POLICY IF EXISTS "memories_service_policy" ON memories;
DROP POLICY IF EXISTS "memory_history_service_policy" ON memory_history;
DROP POLICY IF EXISTS "sessions_service_policy" ON sessions;
DROP POLICY IF EXISTS "session_logs_service_policy" ON session_logs;
DROP POLICY IF EXISTS "context_history_service_policy" ON context_history;
DROP POLICY IF EXISTS "mini_app_records_service_policy" ON mini_app_records;
