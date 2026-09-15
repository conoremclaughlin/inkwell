-- Harden the routing-hold RPCs (Lumen, PR #514 round 3).
--
-- Two defects in the round-2 versions:
--
-- 1. PRIVILEGE. SECURITY DEFINER functions keep PostgreSQL's default
--    PUBLIC EXECUTE, so anon/authenticated could call them with any thread
--    UUID and mutate rows RLS would otherwise protect. Execute is now
--    revoked from PUBLIC and granted only to service_role, AND the functions
--    verify the thread belongs to the passed user — defence in depth, so a
--    future grant mistake is not immediately exploitable.
--
-- 2. GENERATION. clear_routing_hold matched on agentId alone, so a slow
--    successful route could delete a NEWER refusal hold stamped by a later
--    dispatch for the same agent — the thread would read as routable while
--    genuinely stalled. Awaiting one callback does not serialize
--    AgentGateway callbacks, so ordering cannot be assumed. The clear is now
--    conditional on the hold being older than the route that is clearing it.

DROP FUNCTION IF EXISTS public.stamp_routing_hold(uuid, jsonb);
DROP FUNCTION IF EXISTS public.clear_routing_hold(uuid, text);

CREATE OR REPLACE FUNCTION public.stamp_routing_hold(
  p_thread_id uuid,
  p_user_id uuid,
  p_hold jsonb
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  affected integer;
BEGIN
  UPDATE inbox_threads
     SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('routingHold', p_hold)
   WHERE id = p_thread_id
     AND user_id = p_user_id;
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END;
$$;

-- Clears only THIS agent's hold, and only when that hold predates the route
-- doing the clearing. A hold stamped after p_routed_since belongs to a later
-- dispatch and must survive.
CREATE OR REPLACE FUNCTION public.clear_routing_hold(
  p_thread_id uuid,
  p_user_id uuid,
  p_agent_id text,
  p_routed_since timestamptz
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  affected integer;
BEGIN
  UPDATE inbox_threads
     SET metadata = metadata - 'routingHold'
   WHERE id = p_thread_id
     AND user_id = p_user_id
     AND metadata -> 'routingHold' ->> 'agentId' = p_agent_id
     AND (metadata -> 'routingHold' ->> 'heldAt')::timestamptz <= p_routed_since;
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END;
$$;

REVOKE ALL ON FUNCTION public.stamp_routing_hold(uuid, uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.clear_routing_hold(uuid, uuid, text, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.stamp_routing_hold(uuid, uuid, jsonb) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.clear_routing_hold(uuid, uuid, text, timestamptz) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.stamp_routing_hold(uuid, uuid, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.clear_routing_hold(uuid, uuid, text, timestamptz) TO service_role;
