-- Compare ATTEMPT generations, not wall-clock stamp times (Lumen, #514 r5).
--
-- The round-4 clear compared the hold's `heldAt` against the successful
-- route's `routedSince`. Those are different clocks measuring different
-- things, and overlapping operations break it:
--
--   F(ail) starts T1 ─────────────── stamps at T3
--   S(uccess) starts T2 ──────────────────────── clears at T4
--
--   heldAt=T3 > routedSince=T2, so the clear declines and the older failure's
--   hold survives a newer success. The hold is stamped late, but it BELONGS
--   to the older attempt.
--
-- The hold now carries `attemptStartedAt` — its generation — and the clear
-- compares generation to generation: T1 <= T2, so it clears. When the hold
-- genuinely belongs to a newer attempt its generation is later and it stays.
--
-- Also fixed here:
--   * the SELECT-then-UPDATE window is gone; one statement decides and writes
--   * routingRecovery takes GREATEST rather than overwriting, so a delayed
--     older clear cannot regress the marker a newer one already advanced

DROP FUNCTION IF EXISTS public.clear_routing_hold(uuid, uuid, text, timestamptz);

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
     SET metadata =
           (CASE
              WHEN metadata -> 'routingHold' ->> 'agentId' = p_agent_id
               AND COALESCE(
                     (metadata -> 'routingHold' ->> 'attemptStartedAt')::timestamptz,
                     (metadata -> 'routingHold' ->> 'heldAt')::timestamptz
                   ) <= p_routed_since
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

  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END;
$$;

REVOKE ALL ON FUNCTION public.clear_routing_hold(uuid, uuid, text, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.clear_routing_hold(uuid, uuid, text, timestamptz) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.clear_routing_hold(uuid, uuid, text, timestamptz) TO service_role;
