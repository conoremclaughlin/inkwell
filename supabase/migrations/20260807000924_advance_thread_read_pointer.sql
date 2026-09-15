-- Atomic monotonic advance for thread read pointers.
-- Spec: ink://specs/inkmail-read-state §2 (approved 2026-08-06).
--
-- Replaces application-side select-then-upsert, which races: two concurrent
-- deliveries can both read T0 and write T2 then T1, regressing the pointer.
-- GREATEST() in a single statement makes the advance atomic and monotonic.
-- Wall-clock NOW() writes are banned — the pointer only ever advances through
-- a real message's created_at, so a concurrently inserted, never-seen message
-- can't be marked read.

CREATE OR REPLACE FUNCTION public.advance_thread_read_pointer(
  p_thread_id uuid,
  p_agent_id text,
  p_through_message_id uuid
) RETURNS timestamptz AS $$
DECLARE
  v_created_at timestamptz;
  v_result timestamptz;
BEGIN
  SELECT created_at INTO v_created_at
  FROM public.inbox_thread_messages
  WHERE id = p_through_message_id AND thread_id = p_thread_id;

  IF v_created_at IS NULL THEN
    RAISE EXCEPTION 'advance_thread_read_pointer: message % not found in thread %',
      p_through_message_id, p_thread_id;
  END IF;

  INSERT INTO public.inbox_thread_read_status (thread_id, agent_id, last_read_at)
  VALUES (p_thread_id, p_agent_id, v_created_at)
  ON CONFLICT (thread_id, agent_id)
  DO UPDATE SET last_read_at = GREATEST(inbox_thread_read_status.last_read_at, EXCLUDED.last_read_at)
  RETURNING last_read_at INTO v_result;

  RETURN v_result;
END;
$$ LANGUAGE plpgsql;
