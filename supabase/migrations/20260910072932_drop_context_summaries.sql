-- Drop context_summaries and its archive table context_history.
--
-- context_summaries backed the save_context / get_context tools and the
-- bootstrap "identity core" / project-context tiers. It was superseded in
-- January 2026: per-session state moved to sessions.context
-- (update_session_state) and identity moved to the constitution tables
-- (agent_identities, user_identity, workspaces). The last write to either
-- table was 2026-01-28. context_history exists only to archive
-- context_summaries updates, so it goes with it. The code that read them is
-- removed in the same PR.
--
-- CASCADE takes the triggers, policies, indexes and constraints; the archive
-- trigger function is dropped once no trigger references it.

DROP TABLE IF EXISTS public.context_summaries CASCADE;
DROP TABLE IF EXISTS public.context_history CASCADE;
DROP FUNCTION IF EXISTS public.archive_context_on_update();
