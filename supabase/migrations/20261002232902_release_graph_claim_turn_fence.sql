-- A claim release can be fenced on its holder's turn (session lifecycle §6,
-- task T6 c1516218; Lumen's review of PR #724).
--
-- release_graph_claim CAS'd only on the claim token. Its callers decide on a
-- snapshot of the holder session and then call it:
--   - the sweep's reclaim reads the holder and its presence, then reclaims;
--   - the turn-boundary release reads the session's turn_epoch, then
--     releases.
-- A successor turn that takes the session in between (a resumed server run,
-- a CLI prompt's claim) keeps the claim token unchanged, so the release
-- still matched and the claim was taken from under the new turn. Lumen
-- reproduced it with the real lease service and run registry.
--
-- The new optional pair p_fence_turn_epoch / p_expected_turn_epoch makes the
-- release conditional, inside this transaction, on the holder session's
-- turn_epoch still being the one the caller decided on (NULL included, for a
-- row that never had one). The session row is read FOR SHARE after the task
-- lock, so a concurrent epoch write either committed first (and the fence
-- refuses with 'turn-moved') or waits until this release has committed. No
-- SQL function writes sessions and then tasks, so the added lock order cannot
-- invert another's. Callers that pass neither parameter behave exactly as
-- before.
--
-- The argument list changes, so the old signature is dropped rather than
-- overloaded: two candidates differing only in defaulted trailing arguments
-- make PostgREST's resolution ambiguous.

DROP FUNCTION IF EXISTS public.release_graph_claim(uuid, uuid, uuid, uuid, boolean, text);

CREATE FUNCTION public.release_graph_claim(
  p_user_id uuid,
  p_task_id uuid,
  p_claim_token uuid,
  p_session_id uuid DEFAULT NULL,
  p_reclaim boolean DEFAULT false,
  p_reason text DEFAULT NULL,
  p_fence_turn_epoch boolean DEFAULT false,
  p_expected_turn_epoch text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_task record;
  v_group_id uuid;
BEGIN
  -- Mark this transaction as the executor path (see
  -- enforce_graph_execution_path): transaction-local, resets at commit.
  PERFORM set_config('app.graph_executor', 'on', true);
  -- GROUP before TASK (see lock discipline in 20260821210308).
  SELECT task_group_id INTO v_group_id FROM tasks
  WHERE id = p_task_id AND user_id = p_user_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'reason', 'task-not-found');
  END IF;
  IF v_group_id IS NOT NULL THEN
    PERFORM 1 FROM task_groups WHERE id = v_group_id FOR SHARE;
  END IF;

  SELECT * INTO v_task FROM tasks
  WHERE id = p_task_id AND user_id = p_user_id
  FOR UPDATE;
  IF NOT FOUND OR v_task.task_group_id IS DISTINCT FROM v_group_id THEN
    RETURN jsonb_build_object('success', false, 'reason', 'concurrent-move');
  END IF;
  IF v_task.claimed_by_session_id IS NULL OR v_task.claim_token IS DISTINCT FROM p_claim_token THEN
    RETURN jsonb_build_object('success', false, 'reason', 'claim-mismatch');
  END IF;
  IF NOT p_reclaim AND v_task.claimed_by_session_id IS DISTINCT FROM p_session_id THEN
    RETURN jsonb_build_object('success', false, 'reason', 'claim-mismatch');
  END IF;

  -- The turn fence: the holder session must still be on the turn the caller
  -- judged. A missing session row is not that turn either.
  IF p_fence_turn_epoch THEN
    PERFORM 1 FROM sessions
    WHERE id = v_task.claimed_by_session_id
      AND user_id = p_user_id
      AND turn_epoch IS NOT DISTINCT FROM p_expected_turn_epoch
    FOR SHARE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('success', false, 'reason', 'turn-moved');
    END IF;
  END IF;

  UPDATE tasks SET
    claimed_by_session_id = NULL,
    claim_token = NULL,
    claimed_at = NULL,
    status = 'pending',
    gate_state = CASE WHEN task_type = 'verification' THEN 'open' ELSE gate_state END,
    gate_version = CASE WHEN task_type = 'verification' THEN gate_version + 1 ELSE gate_version END
  WHERE id = p_task_id;

  INSERT INTO task_gate_events (user_id, task_id, event, attempt, gate_version,
                                session_id, claim_token, reason)
  VALUES (p_user_id, p_task_id,
          CASE WHEN p_reclaim THEN 'claim_reclaimed' ELSE 'claim_released' END,
          v_task.gate_attempt,
          CASE WHEN v_task.task_type = 'verification'
               THEN v_task.gate_version + 1 ELSE v_task.gate_version END,
          v_task.claimed_by_session_id, p_claim_token, p_reason);

  RETURN jsonb_build_object('success', true, 'reclaimed', p_reclaim);
END;
$$;

COMMENT ON FUNCTION public.release_graph_claim(uuid, uuid, uuid, uuid, boolean, text, boolean, text) IS
  'Release (holder) or reclaim (sweep) a graph claim by token CAS. With p_fence_turn_epoch, the release also requires the holder session''s turn_epoch to equal p_expected_turn_epoch at release time (reason turn-moved otherwise).';

REVOKE ALL ON FUNCTION public.release_graph_claim(uuid, uuid, uuid, uuid, boolean, text, boolean, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.release_graph_claim(uuid, uuid, uuid, uuid, boolean, text, boolean, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_graph_claim(uuid, uuid, uuid, uuid, boolean, text, boolean, text) TO service_role;
