-- Generation on BOTH sides of the routing-hold lifecycle (Lumen, #514 r4).
--
-- Round 3 made the CLEAR conditional on the hold predating the route doing
-- the clearing. That closed one direction and left the reverse open:
--
--   1. a failing dispatch starts (attempt generation T1) and stalls
--   2. a later dispatch succeeds, assigns, and clears — there is no hold yet,
--      so the clear does nothing at all
--   3. the stalled dispatch finally stamps, unconditionally
--   → the thread shows a routing hold that a newer successful route already
--     disproved
--
-- Fix: the clear ALWAYS records a recovery marker per agent, even when it
-- removes no hold — that record is the whole point — and the stamp refuses
-- when its attempt began before the recorded recovery.
--
-- metadata.routingRecovery is an object keyed by agentId so one agent's
-- recovery never speaks for another's.

DROP FUNCTION IF EXISTS public.stamp_routing_hold(uuid, uuid, jsonb);
DROP FUNCTION IF EXISTS public.clear_routing_hold(uuid, uuid, text, timestamptz);

CREATE OR REPLACE FUNCTION public.stamp_routing_hold(
  p_thread_id uuid,
  p_user_id uuid,
  p_agent_id text,
  p_attempt_started timestamptz,
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
     AND user_id = p_user_id
     -- Refuse to stamp behind a newer successful route for this agent.
     AND (
       metadata -> 'routingRecovery' ->> p_agent_id IS NULL
       OR (metadata -> 'routingRecovery' ->> p_agent_id)::timestamptz < p_attempt_started
     );
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END;
$$;

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
  had_hold boolean;
BEGIN
  SELECT (metadata -> 'routingHold' ->> 'agentId' = p_agent_id
          AND (metadata -> 'routingHold' ->> 'heldAt')::timestamptz <= p_routed_since)
    INTO had_hold
    FROM inbox_threads
   WHERE id = p_thread_id AND user_id = p_user_id;

  -- The recovery marker is recorded unconditionally: a success with no hold
  -- present is exactly the case that must block a stalled older attempt from
  -- stamping afterwards. Only the hold removal is conditional.
  UPDATE inbox_threads
     SET metadata =
           CASE WHEN COALESCE(had_hold, false)
                THEN metadata - 'routingHold'
                ELSE COALESCE(metadata, '{}'::jsonb)
           END
           || jsonb_build_object(
                'routingRecovery',
                COALESCE(metadata -> 'routingRecovery', '{}'::jsonb)
                  || jsonb_build_object(p_agent_id, p_routed_since)
              )
   WHERE id = p_thread_id
     AND user_id = p_user_id;
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN CASE WHEN COALESCE(had_hold, false) THEN affected ELSE 0 END;
END;
$$;

REVOKE ALL ON FUNCTION public.stamp_routing_hold(uuid, uuid, text, timestamptz, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.clear_routing_hold(uuid, uuid, text, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.stamp_routing_hold(uuid, uuid, text, timestamptz, jsonb) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.clear_routing_hold(uuid, uuid, text, timestamptz) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.stamp_routing_hold(uuid, uuid, text, timestamptz, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.clear_routing_hold(uuid, uuid, text, timestamptz) TO service_role;
