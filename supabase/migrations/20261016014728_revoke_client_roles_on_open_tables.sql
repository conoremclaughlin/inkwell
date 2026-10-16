-- Close direct PostgREST access to tables that admit every role.
--
-- Two kinds of table let anyone holding the publishable key read and write
-- them directly, bypassing the API server:
--
-- 1. Eighteen tables with "safety net" policies of the form
--    `FOR ALL USING (true)` and no `TO` clause. Such a policy applies to every
--    role, anon and authenticated included.
-- 2. Four tables with row level security never enabled, so no policy is
--    consulted at all.
--
-- Supabase's default privileges grant anon and authenticated full table
-- access to every new table, so in both cases nothing stood between those
-- roles and the rows.
--
-- The API server reaches all of these through the service role, which keeps
-- its own grants (and bypasses RLS). No client reads them as anon or
-- authenticated: the web dashboard uses Supabase for authentication only, and
-- the mobile app, desktop shell and CLI reach data through the API. So the two
-- client roles' table privileges are revoked, as newer tables already do
-- (launched_processes, saved_logins, alert_*). The policies are left as they
-- are: without table privileges they no longer admit these roles.
--
-- Guarded by client-role-grants.integration.test.ts (every table open by
-- policy or with RLS off holds no anon or authenticated privilege) and by
-- open-table-revokes.test.ts (every such table in the migrations is revoked).
--
-- Rollback (restores the exposure; do not run without a replacement):
--   GRANT ALL ON TABLE public.<table> TO anon, authenticated;

-- 1. Permissive `USING (true)` policies with no `TO` clause.
REVOKE ALL ON TABLE public.agent_inbox_read_status FROM anon, authenticated;
REVOKE ALL ON TABLE public.approval_requests FROM anon, authenticated;
REVOKE ALL ON TABLE public.artifact_uri_aliases FROM anon, authenticated;
REVOKE ALL ON TABLE public.inbox_thread_messages FROM anon, authenticated;
REVOKE ALL ON TABLE public.inbox_thread_participants FROM anon, authenticated;
REVOKE ALL ON TABLE public.inbox_thread_read_status FROM anon, authenticated;
REVOKE ALL ON TABLE public.inbox_threads FROM anon, authenticated;
REVOKE ALL ON TABLE public.observation_conflicts FROM anon, authenticated;
REVOKE ALL ON TABLE public.project_slug_aliases FROM anon, authenticated;
REVOKE ALL ON TABLE public.publication_operation_events FROM anon, authenticated;
REVOKE ALL ON TABLE public.publication_operations FROM anon, authenticated;
REVOKE ALL ON TABLE public.session_observe_grants FROM anon, authenticated;
REVOKE ALL ON TABLE public.studio_lease_events FROM anon, authenticated;
REVOKE ALL ON TABLE public.task_authority_holds FROM anon, authenticated;
REVOKE ALL ON TABLE public.task_edges FROM anon, authenticated;
REVOKE ALL ON TABLE public.task_gate_events FROM anon, authenticated;
REVOKE ALL ON TABLE public.task_graph_revisions FROM anon, authenticated;
REVOKE ALL ON TABLE public.task_groups FROM anon, authenticated;

-- 2. Row level security never enabled.
REVOKE ALL ON TABLE public.memory_embedding_chunks FROM anon, authenticated;
REVOKE ALL ON TABLE public.memory_recall_benchmark_case_results FROM anon, authenticated;
REVOKE ALL ON TABLE public.memory_recall_benchmark_metrics FROM anon, authenticated;
REVOKE ALL ON TABLE public.memory_recall_benchmark_runs FROM anon, authenticated;
