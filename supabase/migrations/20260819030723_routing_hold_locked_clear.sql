-- Lock the row and report what actually happened (Lumen, #514 r5).
--
-- Two defects in the previous clear:
--   * the SELECT that decided whether to remove the hold was unlocked, so a
--     concurrent stamp could land between the decision and the write
--   * it returned the UPDATE's row count, which is now always 1 because the
--     recovery marker is always written — so callers could not tell
--     "removed a hold" from "recorded recovery only"
--
-- FOR UPDATE serialises the decision with the write on that row; the return
-- value once again means "a hold was removed".

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
  did_clear boolean;
  found boolean;
BEGIN
  -- Row lock: the decision below and the write that follows must not have a
  -- window between them for a concurrent stamp to slip through.
  SELECT
    true,
    (metadata -> 'routingHold' ->> 'agentId' = p_agent_id
     AND COALESCE(
           (metadata -> 'routingHold' ->> 'attemptStartedAt')::timestamptz,
           (metadata -> 'routingHold' ->> 'heldAt')::timestamptz
         ) <= p_routed_since)
    INTO found, did_clear
    FROM inbox_threads
   WHERE id = p_thread_id AND user_id = p_user_id
     FOR UPDATE;

  IF NOT COALESCE(found, false) THEN
    RETURN 0;
  END IF;

  UPDATE inbox_threads
     SET metadata =
           (CASE WHEN COALESCE(did_clear, false)
                 THEN metadata - 'routingHold'
                 ELSE COALESCE(metadata, '{}'::jsonb)
            END)
           || jsonb_build_object(
                'routingRecovery',
                COALESCE(metadata -> 'routingRecovery', '{}'::jsonb)
                  || jsonb_build_object(
                       p_agent_id,
                       GREATEST(
                         p_routed_since,
                         COALESCE(
                           (metadata -> 'routingRecovery' ->> p_agent_id)::timestamptz,
                           '-infinity'::timestamptz
                         )
                       )
                     )
              )
   WHERE id = p_thread_id
     AND user_id = p_user_id;

  RETURN CASE WHEN COALESCE(did_clear, false) THEN 1 ELSE 0 END;
END;
$$;

REVOKE ALL ON FUNCTION public.clear_routing_hold(uuid, uuid, text, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.clear_routing_hold(uuid, uuid, text, timestamptz) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.clear_routing_hold(uuid, uuid, text, timestamptz) TO service_role;
