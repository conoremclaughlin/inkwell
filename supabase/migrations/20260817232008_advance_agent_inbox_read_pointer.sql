-- Atomic monotonic advance for the LEGACY agent_inbox read pointer.
-- Spec: ink://specs/inkmail-read-state §2 — extended to agent_inbox, which the
-- spec's Non-goals deferred as "legacy agent_inbox unification". The thread
-- pointer got this treatment in PR #454; agent_inbox kept the raw
-- select-then-upsert and inherited every failure mode §2 was written to close.
--
-- The regression this fixes was observed in production (Myra, 2026-08-17): a
-- filtered get_inbox page whose newest row was older than the stored pointer
-- overwrote it BACKWARDS (2026-08-06 -> 2026-06-18), because the application
-- upsert wrote the page maximum unconditionally. GREATEST() makes the advance
-- monotonic in a single statement, so neither a stale page nor a concurrent
-- writer can move the pointer back over messages already delivered.
--
-- Wall-clock advances are banned for the same reason as the thread pointer:
-- the pointer only ever advances THROUGH a real message's created_at, so a
-- message inserted between the read and the write cannot be marked read.
-- Callers that want "read up to time T" resolve T to a real message first.
--
-- Recipient scoping is validated here rather than trusted from the caller: the
-- message must actually be addressed to (p_user_id, p_agent_id), so one agent
-- cannot advance another's pointer by passing a foreign message id.

CREATE OR REPLACE FUNCTION public.advance_agent_inbox_read_pointer(
  p_user_id uuid,
  p_agent_id text,
  p_through_message_id uuid
) RETURNS timestamptz AS $$
DECLARE
  v_created_at timestamptz;
  v_result timestamptz;
BEGIN
  SELECT created_at INTO v_created_at
  FROM public.agent_inbox
  WHERE id = p_through_message_id
    AND recipient_user_id = p_user_id
    AND recipient_agent_id = p_agent_id;

  IF v_created_at IS NULL THEN
    RAISE EXCEPTION 'advance_agent_inbox_read_pointer: message % is not addressed to %/%',
      p_through_message_id, p_user_id, p_agent_id;
  END IF;

  INSERT INTO public.agent_inbox_read_status (user_id, agent_id, last_read_at)
  VALUES (p_user_id, p_agent_id, v_created_at)
  ON CONFLICT (user_id, agent_id)
  DO UPDATE SET last_read_at =
    GREATEST(agent_inbox_read_status.last_read_at, EXCLUDED.last_read_at)
  RETURNING last_read_at INTO v_result;

  RETURN v_result;
END;
$$ LANGUAGE plpgsql;

-- Deliberately NOT repairing pointers that the unconditional upsert already
-- regressed. A backwards pointer causes re-delivery, never loss, and guessing
-- which messages an agent "must have seen" is exactly the reasoning that hid a
-- task for 11 days. Affected mailboxes redeliver once and then settle.
