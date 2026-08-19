-- Atomic routing-hold stamping and clearing (spec: trigger-studio-routing
-- Phase 3b, §Refusing to route).
--
-- Both operations were read-modify-write in application code, which loses
-- concurrent writes to inbox_threads.metadata: two dispatches racing can
-- resurrect a cleared hold, erase a newer one, or clobber unrelated keys
-- written between the read and the write (Lumen, PR #514 round 2).
--
-- jsonb merge/delete happen inside a single UPDATE so there is no window,
-- and both functions report affected rows so callers can distinguish "no
-- matching hold" from "write failed" rather than assuming success.

CREATE OR REPLACE FUNCTION public.stamp_routing_hold(
  p_thread_id uuid,
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
   WHERE id = p_thread_id;
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END;
$$;

-- Clears ONLY the named agent's hold: a thread can be held for one
-- participant while routable for another, and a blanket delete would hide a
-- second agent's genuine stall.
CREATE OR REPLACE FUNCTION public.clear_routing_hold(
  p_thread_id uuid,
  p_agent_id text
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
     AND metadata -> 'routingHold' ->> 'agentId' = p_agent_id;
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END;
$$;

GRANT EXECUTE ON FUNCTION public.stamp_routing_hold(uuid, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.clear_routing_hold(uuid, text) TO service_role;
