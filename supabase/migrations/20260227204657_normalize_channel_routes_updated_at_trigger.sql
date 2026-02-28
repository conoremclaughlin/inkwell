-- Normalize updated_at triggers to the canonical helper function:
--   public.update_updated_at_column()
-- This ensures existing environments converge even if older migrations created
-- table-specific helper functions or used the transient update_updated_at() name.

DROP TRIGGER IF EXISTS channel_routes_updated_at ON public.channel_routes;

CREATE TRIGGER channel_routes_updated_at
  BEFORE UPDATE ON public.channel_routes
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS trigger_agent_sessions_updated_at ON public.agent_sessions;
CREATE TRIGGER trigger_agent_sessions_updated_at
  BEFORE UPDATE ON public.agent_sessions
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS update_connected_accounts_updated_at ON public.connected_accounts;
CREATE TRIGGER update_connected_accounts_updated_at
  BEFORE UPDATE ON public.connected_accounts
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS contacts_updated_at ON public.contacts;
CREATE TRIGGER contacts_updated_at
  BEFORE UPDATE ON public.contacts
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS trigger_project_tasks_updated_at ON public.project_tasks;
CREATE TRIGGER trigger_project_tasks_updated_at
  BEFORE UPDATE ON public.project_tasks
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

DROP FUNCTION IF EXISTS public.update_agent_sessions_updated_at();
DROP FUNCTION IF EXISTS public.update_connected_accounts_timestamp();
DROP FUNCTION IF EXISTS public.update_contacts_updated_at();
DROP FUNCTION IF EXISTS public.update_project_tasks_updated_at();
