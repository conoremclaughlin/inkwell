-- Workflow graph, steps 2-3 (spec: ink://specs/workflow-graph v10, APPROVED).
--
-- Step 1 gave graph groups a stored representation (task_edges, serialized
-- mutations, read-model derivation). This migration gives them an EXECUTOR:
--
--   step 2: readiness evaluation (SATISFIES predicate), push-forward
--           propagation, dwell windows, dependency-failure surfacing,
--           session-owned claims
--   step 3: verdict + retry RPCs for verification gates — kept deliberately
--           simple (Conor, 2026-08-21): one actor verifies another's work,
--           or a session records an automated check (CI/GH). No remediation
--           edges, no evidence registry — those wait for real use.
--
-- Design: ONE readiness evaluator (_graph_evaluate_group) performs all gate
-- transitions and computes the ready/scheduled/failed report. Every mutation
-- RPC (complete, verdict, retry) calls it in the same transaction — the
-- spec's "downstream transitions are inside the source transaction, never
-- deferred" — and the reconciliation sweep calls the SAME evaluator, so
-- crash recovery and time-driven gate opening are one mechanism, not two.
--
-- Lock discipline (ONE order everywhere — Lumen round 2 P1, reproduced
-- deadlock): GROUP before TASK. Every executor RPC reads the task's group
-- id WITHOUT locking, locks the group row FOR SHARE, then locks the task
-- row FOR UPDATE and REVALIDATES that it still belongs to the locked group
-- (a concurrent move between the unlocked read and the lock returns a
-- structured 'concurrent-move' refusal — retry, never a wrong-group
-- mutation). apply_task_graph already runs group (FOR UPDATE) → task, so
-- edge FK locks and gate resets can no longer deadlock against a verdict
-- holding a task row and waiting on the group. The evaluator visits gate
-- rows in id order; every transition is a per-row CAS.
--
-- Known residual: the legacy-write fences (enforce_blocked_by_source,
-- enforce_graph_execution_path) fire INSIDE a task UPDATE (task lock held
-- by the statement) and then read the group FOR SHARE — an inversion by
-- construction of BEFORE-row triggers. The only writes on that path in a
-- graph group are ILLEGAL ones the trigger is about to refuse; if one
-- deadlocks against a live mutation instead, PostgreSQL kills it with an
-- error — the same terminal outcome as the refusal, just a blunter
-- message. Legit linear-group writes never contend: apply_task_graph
-- refuses linear groups before taking task locks.

-- ── Satisfaction predicates (spec §Semantics) ───────────────────────────
--
-- work source:         `completed` satisfies; `skipped` never does.
-- verification source: only gate_state = 'passed'.
-- Unsatisfiable-terminal (dependency failure): failed/skipped work,
-- archived work, failed gates. `failed` must block and surface, never
-- release downstream.

CREATE OR REPLACE FUNCTION public.graph_satisfies(
  p_task_type text, p_status text, p_gate_state text
) RETURNS boolean
LANGUAGE sql IMMUTABLE
AS $$
  SELECT (p_task_type = 'work' AND p_status = 'completed')
      OR (p_task_type = 'verification' AND p_gate_state = 'passed');
$$;

CREATE OR REPLACE FUNCTION public.graph_unsatisfiable(
  p_task_type text, p_status text, p_gate_state text, p_outcome text
) RETURNS boolean
LANGUAGE sql IMMUTABLE
AS $$
  SELECT (p_task_type = 'work'
          AND (p_status = 'archived'
               OR (p_status = 'blocked' AND p_outcome IN ('failed', 'skipped'))))
      OR (p_task_type = 'verification' AND p_gate_state = 'failed');
$$;

-- ── The readiness evaluator ─────────────────────────────────────────────
--
-- Group-local, bounded, runs under the caller's group FOR SHARE. Performs
-- the gate transitions (dwell stamping, CAS-open) and returns the full
-- actionable report. Internal: called only from the RPCs below.
--
-- Gate lifecycle here (v7 dwell semantics):
--   deps satisfied, no dwell stamp → stamp dwell_started_at / eligible_at
--     (= dwell + notBeforeSeconds from verification config; 0 when absent);
--     'scheduled' event only when a real window exists
--   eligible_at reached → CAS not_ready → open, 'opened' event, clock starts
--
-- Readiness for work is DERIVED, never stored: a pending, unclaimed work
-- node with every inbound source satisfying. The sweep can therefore always
-- recompute what a lost post-commit dispatch forgot.

CREATE OR REPLACE FUNCTION public._graph_evaluate_group(
  p_user_id uuid,
  p_task_group_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now timestamptz := now();
  v_gate record;
  v_not_before numeric;
  v_eligible timestamptz;
  v_opened jsonb := '[]'::jsonb;
  v_ready_work jsonb;
  v_open_gates jsonb;
  v_scheduled jsonb;
  v_dep_failures jsonb;
  v_group_complete boolean;
  v_counts record;
BEGIN
  -- Mark this transaction as the executor path (see
  -- enforce_graph_execution_path): transaction-local, resets at commit.
  PERFORM set_config('app.graph_executor', 'on', true);
  -- Gate transitions, id order (see lock discipline above).
  FOR v_gate IN
    SELECT t.id, t.title, t.gate_attempt, t.gate_version,
           t.dwell_started_at, t.eligible_at, t.verification,
           t.assignee_identity_id, t.assignee_user_id
    FROM tasks t
    WHERE t.task_group_id = p_task_group_id
      AND t.user_id = p_user_id
      AND t.task_type = 'verification'
      AND t.gate_state = 'not_ready'
      AND NOT EXISTS (
        SELECT 1 FROM task_edges e JOIN tasks s ON s.id = e.from_task
        WHERE e.to_task = t.id
          AND NOT graph_satisfies(s.task_type, s.status, s.gate_state)
      )
    ORDER BY t.id
    FOR UPDATE OF t
  LOOP
    v_eligible := v_gate.eligible_at;
    IF v_gate.dwell_started_at IS NULL THEN
      -- Dependencies just became satisfied: the dwell window starts now.
      v_not_before := coalesce((v_gate.verification ->> 'notBeforeSeconds')::numeric, 0);
      v_eligible := v_now + make_interval(secs => v_not_before);
      UPDATE tasks SET dwell_started_at = v_now, eligible_at = v_eligible
      WHERE id = v_gate.id;
      IF v_not_before > 0 THEN
        INSERT INTO task_gate_events (user_id, task_id, event, attempt, gate_version,
                                      assignee_identity_id, assignee_user_id)
        VALUES (p_user_id, v_gate.id, 'scheduled', v_gate.gate_attempt, v_gate.gate_version,
                v_gate.assignee_identity_id, v_gate.assignee_user_id);
      END IF;
    END IF;

    IF v_now >= coalesce(v_eligible, v_now) THEN
      UPDATE tasks
      SET gate_state = 'open', gate_opened_at = v_now, gate_version = gate_version + 1
      WHERE id = v_gate.id AND gate_state = 'not_ready';
      IF FOUND THEN
        INSERT INTO task_gate_events (user_id, task_id, event, attempt, gate_version,
                                      assignee_identity_id, assignee_user_id)
        VALUES (p_user_id, v_gate.id, 'opened', v_gate.gate_attempt, v_gate.gate_version + 1,
                v_gate.assignee_identity_id, v_gate.assignee_user_id);
        v_opened := v_opened || jsonb_build_object(
          'id', v_gate.id, 'title', v_gate.title, 'attempt', v_gate.gate_attempt,
          'assigneeIdentityId', v_gate.assignee_identity_id,
          'assigneeUserId', v_gate.assignee_user_id);
      END IF;
    END IF;
  END LOOP;

  -- Ready work: pending, unclaimed, every inbound source satisfying.
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'id', w.id, 'title', w.title,
           'assigneeIdentityId', w.assignee_identity_id,
           'assigneeUserId', w.assignee_user_id) ORDER BY w.id), '[]'::jsonb)
  INTO v_ready_work
  FROM tasks w
  WHERE w.task_group_id = p_task_group_id AND w.user_id = p_user_id
    AND w.task_type = 'work' AND w.status = 'pending'
    AND w.claimed_by_session_id IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM task_edges e JOIN tasks s ON s.id = e.from_task
      WHERE e.to_task = w.id
        AND NOT graph_satisfies(s.task_type, s.status, s.gate_state)
    );

  -- Open, unclaimed gates: someone is being waited on.
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'id', g.id, 'title', g.title, 'attempt', g.gate_attempt,
           'gateVersion', g.gate_version, 'openedAt', g.gate_opened_at,
           'assigneeIdentityId', g.assignee_identity_id,
           'assigneeUserId', g.assignee_user_id) ORDER BY g.id), '[]'::jsonb)
  INTO v_open_gates
  FROM tasks g
  WHERE g.task_group_id = p_task_group_id AND g.user_id = p_user_id
    AND g.task_type = 'verification' AND g.gate_state = 'open'
    AND g.claimed_by_session_id IS NULL;

  -- Dwelling gates: scheduled, not stalled, never READY until eligible.
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'id', d.id, 'title', d.title, 'eligibleAt', d.eligible_at) ORDER BY d.id), '[]'::jsonb)
  INTO v_scheduled
  FROM tasks d
  WHERE d.task_group_id = p_task_group_id AND d.user_id = p_user_id
    AND d.task_type = 'verification' AND d.gate_state = 'not_ready'
    AND d.dwell_started_at IS NOT NULL AND d.eligible_at > v_now;

  -- Dependency failures: a non-terminal node with an unsatisfiable inbound
  -- source can never become ready — a distinct condition, surfaced named.
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'id', f.id, 'title', f.title, 'sources', f.sources) ORDER BY f.id), '[]'::jsonb)
  INTO v_dep_failures
  FROM (
    SELECT t.id, t.title,
           jsonb_agg(jsonb_build_object(
             'id', s.id, 'title', s.title,
             'state', CASE WHEN s.task_type = 'verification'
                           THEN s.gate_state ELSE coalesce(s.outcome, s.status) END,
             'attempt', CASE WHEN s.task_type = 'verification'
                             THEN s.gate_attempt END)
             ORDER BY s.id) AS sources
    FROM tasks t
    JOIN task_edges e ON e.to_task = t.id
    JOIN tasks s ON s.id = e.from_task
    WHERE t.task_group_id = p_task_group_id AND t.user_id = p_user_id
      AND NOT (t.status IN ('completed', 'archived')
               OR (t.status = 'blocked' AND t.outcome IS NOT NULL))
      AND graph_unsatisfiable(s.task_type, s.status, s.gate_state, s.outcome)
    GROUP BY t.id, t.title
  ) f;

  SELECT count(*) FILTER (WHERE NOT (t.status IN ('completed', 'archived')
                                     OR (t.status = 'blocked' AND t.outcome IS NOT NULL))) AS open_count,
         count(*) FILTER (WHERE t.task_type = 'verification'
                            AND t.gate_state IS DISTINCT FROM 'passed') AS unpassed_gates,
         count(*) AS total,
         count(*) FILTER (WHERE t.status = 'completed') AS completed,
         count(*) FILTER (WHERE t.status = 'blocked' AND t.outcome = 'failed') AS failed,
         count(*) FILTER (WHERE t.status = 'blocked' AND t.outcome = 'skipped') AS skipped
  INTO v_counts
  FROM tasks t
  WHERE t.task_group_id = p_task_group_id AND t.user_id = p_user_id;
  -- A failed gate is terminal PER ATTEMPT, never for the group: completion
  -- requires every verification gate PASSED, so retry stays reachable
  -- (completed groups are unswept and unclaimable — Lumen round 2 P1).
  v_group_complete := v_counts.open_count = 0 AND v_counts.unpassed_gates = 0
    AND v_counts.total > 0;

  RETURN jsonb_build_object(
    'readyWork', v_ready_work,
    'openedGates', v_opened,
    'openGates', v_open_gates,
    'scheduledGates', v_scheduled,
    'dependencyFailures', v_dep_failures,
    'groupComplete', v_group_complete,
    'counts', jsonb_build_object(
      'total', v_counts.total, 'completed', v_counts.completed,
      'failed', v_counts.failed, 'skipped', v_counts.skipped)
  );
END;
$$;

-- ── Claims: session-owned, momentary (spec principle 9) ─────────────────
--
-- Presence is never busyness; the claim token is required on completion so
-- a session that lost its claim cannot complete over the reclaimer.

CREATE OR REPLACE FUNCTION public.claim_graph_task(
  p_user_id uuid,
  p_task_id uuid,
  p_session_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_task record;
  v_group record;
  v_group_id uuid;
  v_token uuid;
BEGIN
  -- Mark this transaction as the executor path (see
  -- enforce_graph_execution_path): transaction-local, resets at commit.
  PERFORM set_config('app.graph_executor', 'on', true);
  -- GROUP before TASK (see lock discipline): unlocked read for the group
  -- id, group FOR SHARE, task FOR UPDATE, then revalidate membership.
  SELECT task_group_id INTO v_group_id FROM tasks
  WHERE id = p_task_id AND user_id = p_user_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'reason', 'task-not-found');
  END IF;
  IF v_group_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'reason', 'not-graph-mode');
  END IF;

  SELECT execution_model, status INTO v_group
  FROM task_groups WHERE id = v_group_id
  FOR SHARE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'reason', 'group-not-found');
  END IF;
  IF v_group.execution_model <> 'graph' THEN
    RETURN jsonb_build_object('success', false, 'reason', 'not-graph-mode');
  END IF;
  IF v_group.status <> 'active' THEN
    RETURN jsonb_build_object('success', false, 'reason', 'group-not-active',
      'groupStatus', v_group.status);
  END IF;

  SELECT * INTO v_task FROM tasks
  WHERE id = p_task_id AND user_id = p_user_id
  FOR UPDATE;
  IF NOT FOUND OR v_task.task_group_id IS DISTINCT FROM v_group_id THEN
    RETURN jsonb_build_object('success', false, 'reason', 'concurrent-move');
  END IF;

  IF v_task.claimed_by_session_id IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'reason', 'already-claimed',
      'heldBySessionId', v_task.claimed_by_session_id, 'claimedAt', v_task.claimed_at);
  END IF;

  IF v_task.task_type = 'work' THEN
    IF v_task.status <> 'pending' THEN
      RETURN jsonb_build_object('success', false, 'reason', 'not-claimable',
        'status', v_task.status);
    END IF;
    IF EXISTS (
      SELECT 1 FROM task_edges e JOIN tasks s ON s.id = e.from_task
      WHERE e.to_task = p_task_id
        AND NOT graph_satisfies(s.task_type, s.status, s.gate_state)
    ) THEN
      RETURN jsonb_build_object('success', false, 'reason', 'not-ready');
    END IF;
  ELSE
    -- Approval gates are never claimed (spec §Node types): the assignee
    -- records the verdict directly.
    IF coalesce(v_task.verification ->> 'mode', 'executable') <> 'executable' THEN
      RETURN jsonb_build_object('success', false, 'reason', 'approval-gate');
    END IF;
    IF v_task.gate_state <> 'open' THEN
      RETURN jsonb_build_object('success', false, 'reason', 'gate-not-open',
        'gateState', v_task.gate_state);
    END IF;
  END IF;

  -- gen_random_uuid lives in pg_catalog, so it resolves under this
  -- function's pinned search_path (uuid_generate_v4 does not).
  v_token := gen_random_uuid();
  UPDATE tasks SET
    claimed_by_session_id = p_session_id,
    claim_token = v_token,
    claimed_at = now(),
    status = 'in_progress',
    gate_state = CASE WHEN task_type = 'verification' THEN 'in_progress' ELSE gate_state END,
    gate_version = CASE WHEN task_type = 'verification' THEN gate_version + 1 ELSE gate_version END
  WHERE id = p_task_id;

  INSERT INTO task_gate_events (user_id, task_id, event, attempt, gate_version,
                                session_id, claim_token,
                                assignee_identity_id, assignee_user_id)
  VALUES (p_user_id, p_task_id, 'claimed', v_task.gate_attempt,
          CASE WHEN v_task.task_type = 'verification'
               THEN v_task.gate_version + 1 ELSE v_task.gate_version END,
          p_session_id, v_token,
          v_task.assignee_identity_id, v_task.assignee_user_id);

  RETURN jsonb_build_object('success', true, 'claimToken', v_token,
    'taskId', p_task_id, 'taskType', v_task.task_type,
    'gateVersion', CASE WHEN v_task.task_type = 'verification'
                        THEN v_task.gate_version + 1 ELSE v_task.gate_version END,
    'attempt', v_task.gate_attempt);
END;
$$;

-- Voluntary release (session moving on) and sweep-driven reclaim share one
-- shell: both CAS on the token, only release also requires the holder's
-- session. Reclaim's liveness proof (not mid-turn, fail-closed) is the
-- APPLICATION's job — the lease service owns turn signals; this function
-- only makes the handover atomic.

CREATE OR REPLACE FUNCTION public.release_graph_claim(
  p_user_id uuid,
  p_task_id uuid,
  p_claim_token uuid,
  p_session_id uuid DEFAULT NULL,
  p_reclaim boolean DEFAULT false,
  p_reason text DEFAULT NULL
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
  -- GROUP before TASK (see lock discipline). A claim only ever exists on a
  -- graph-group task, so the group lock serializes this release against
  -- apply_task_graph's gate resets in the one shared order.
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

-- ── Graph-mode work completion — claim-token-gated (spec §Verdicts) ─────
--
-- The ONLY way a graph-mode work node reaches a terminal state. Completes,
-- clears the claim, and transitions newly-ready downstream nodes inside
-- this same transaction; only external wakeups are post-commit.

CREATE OR REPLACE FUNCTION public.complete_graph_task(
  p_user_id uuid,
  p_task_id uuid,
  p_session_id uuid,
  p_claim_token uuid,
  p_outcome text,
  p_reason text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_task record;
  v_group record;
  v_group_id uuid;
  v_eval jsonb;
BEGIN
  -- Mark this transaction as the executor path (see
  -- enforce_graph_execution_path): transaction-local, resets at commit.
  PERFORM set_config('app.graph_executor', 'on', true);
  IF p_outcome NOT IN ('completed', 'failed', 'skipped') THEN
    RETURN jsonb_build_object('success', false, 'reason', 'invalid-outcome');
  END IF;

  -- GROUP before TASK (see lock discipline).
  SELECT task_group_id INTO v_group_id FROM tasks
  WHERE id = p_task_id AND user_id = p_user_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'reason', 'task-not-found');
  END IF;
  IF v_group_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'reason', 'not-graph-mode');
  END IF;

  SELECT execution_model, status INTO v_group
  FROM task_groups WHERE id = v_group_id
  FOR SHARE;
  IF NOT FOUND OR v_group.execution_model <> 'graph' THEN
    RETURN jsonb_build_object('success', false, 'reason', 'not-graph-mode');
  END IF;
  -- A cancelled/completed group is DONE: a late completion must not
  -- resurrect it into a finalizable state (Lumen round 3 P1).
  IF v_group.status <> 'active' THEN
    RETURN jsonb_build_object('success', false, 'reason', 'group-not-active',
      'groupStatus', v_group.status);
  END IF;

  SELECT * INTO v_task FROM tasks
  WHERE id = p_task_id AND user_id = p_user_id
  FOR UPDATE;
  IF NOT FOUND OR v_task.task_group_id IS DISTINCT FROM v_group_id THEN
    RETURN jsonb_build_object('success', false, 'reason', 'concurrent-move');
  END IF;
  IF v_task.task_type <> 'work' THEN
    RETURN jsonb_build_object('success', false, 'reason', 'verification-node',
      'hint', 'verification nodes take verdicts via record_gate_verdict, never completion');
  END IF;

  IF v_task.claimed_by_session_id IS DISTINCT FROM p_session_id
     OR v_task.claim_token IS DISTINCT FROM p_claim_token
     OR p_claim_token IS NULL THEN
    RETURN jsonb_build_object('success', false, 'reason', 'claim-mismatch');
  END IF;

  UPDATE tasks SET
    status = CASE WHEN p_outcome = 'completed' THEN 'completed' ELSE 'blocked' END,
    outcome = p_outcome,
    outcome_reason = p_reason,
    completed_at = now(),
    claimed_by_session_id = NULL,
    claim_token = NULL,
    claimed_at = NULL
  WHERE id = p_task_id;

  INSERT INTO task_gate_events (user_id, task_id, event, attempt, gate_version,
                                session_id, claim_token, reason)
  VALUES (p_user_id, p_task_id, 'claim_released', v_task.gate_attempt, v_task.gate_version,
          p_session_id, p_claim_token, p_outcome);

  -- Push: a satisfying completion propagates forward now; an unsatisfying
  -- one still evaluates so the dependency-failure report is fresh.
  v_eval := _graph_evaluate_group(p_user_id, v_task.task_group_id);

  RETURN jsonb_build_object('success', true, 'outcome', p_outcome,
    'taskId', p_task_id, 'evaluation', v_eval);
END;
$$;

-- ── Step 3: verdicts — one transaction AND a CAS (spec §Verdicts) ───────
--
-- Authority, kept simple: a claimed (executable) gate is decided by its
-- claim holder — session + token. An unclaimed gate is decided by its
-- assignee — the named verifier. That covers both target cases: an SB/human
-- verifying someone else's work, and a session running an automated check.

CREATE OR REPLACE FUNCTION public.record_gate_verdict(
  p_user_id uuid,
  p_task_id uuid,
  p_verdict text,
  p_expected_attempt int,
  p_expected_gate_version bigint,
  p_actor_identity_id uuid DEFAULT NULL,
  p_actor_user_id uuid DEFAULT NULL,
  p_session_id uuid DEFAULT NULL,
  p_claim_token uuid DEFAULT NULL,
  p_evidence jsonb DEFAULT NULL,
  p_reason text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_task record;
  v_group record;
  v_group_id uuid;
  v_eval jsonb;
  v_new_version bigint;
BEGIN
  -- Mark this transaction as the executor path (see
  -- enforce_graph_execution_path): transaction-local, resets at commit.
  PERFORM set_config('app.graph_executor', 'on', true);
  IF p_verdict NOT IN ('passed', 'failed') THEN
    RETURN jsonb_build_object('success', false, 'reason', 'invalid-verdict');
  END IF;
  IF num_nonnulls(p_actor_identity_id, p_actor_user_id) <> 1 THEN
    RETURN jsonb_build_object('success', false, 'reason', 'exactly-one-actor');
  END IF;

  -- GROUP before TASK (see lock discipline).
  SELECT task_group_id INTO v_group_id FROM tasks
  WHERE id = p_task_id AND user_id = p_user_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'reason', 'task-not-found');
  END IF;
  IF v_group_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'reason', 'not-graph-mode');
  END IF;

  SELECT execution_model, status INTO v_group
  FROM task_groups WHERE id = v_group_id
  FOR SHARE;
  IF NOT FOUND OR v_group.execution_model <> 'graph' THEN
    RETURN jsonb_build_object('success', false, 'reason', 'not-graph-mode');
  END IF;
  IF v_group.status <> 'active' THEN
    RETURN jsonb_build_object('success', false, 'reason', 'group-not-active',
      'groupStatus', v_group.status);
  END IF;

  SELECT * INTO v_task FROM tasks
  WHERE id = p_task_id AND user_id = p_user_id
  FOR UPDATE;
  IF NOT FOUND OR v_task.task_group_id IS DISTINCT FROM v_group_id THEN
    RETURN jsonb_build_object('success', false, 'reason', 'concurrent-move');
  END IF;
  IF v_task.task_type <> 'verification' THEN
    RETURN jsonb_build_object('success', false, 'reason', 'not-verification');
  END IF;

  IF v_task.gate_state NOT IN ('open', 'in_progress') THEN
    RETURN jsonb_build_object('success', false, 'reason', 'gate-not-open',
      'gateState', v_task.gate_state);
  END IF;
  -- Revalidate dependency satisfaction at verdict time (spec §Verdicts
  -- step 2; Lumen round 1 P1). apply_task_graph resets affected gates on
  -- inbound mutation, so this refusal should be unreachable — but a verdict
  -- deciding a gate whose inbound no longer satisfies must never land on
  -- the strength of a stale opening.
  IF EXISTS (
    SELECT 1 FROM task_edges e JOIN tasks s ON s.id = e.from_task
    WHERE e.to_task = p_task_id
      AND NOT graph_satisfies(s.task_type, s.status, s.gate_state)
  ) THEN
    RETURN jsonb_build_object('success', false, 'reason', 'dependencies-unsatisfied');
  END IF;
  -- Attempt + version CAS: late attempt-1 results never decide attempt 2 —
  -- including from a released-and-reused studio.
  IF v_task.gate_attempt <> p_expected_attempt THEN
    RETURN jsonb_build_object('success', false, 'reason', 'attempt-conflict',
      'currentAttempt', v_task.gate_attempt);
  END IF;
  IF v_task.gate_version <> p_expected_gate_version THEN
    RETURN jsonb_build_object('success', false, 'reason', 'version-conflict',
      'currentGateVersion', v_task.gate_version);
  END IF;

  IF v_task.claimed_by_session_id IS NOT NULL THEN
    IF v_task.claimed_by_session_id IS DISTINCT FROM p_session_id
       OR v_task.claim_token IS DISTINCT FROM p_claim_token THEN
      RETURN jsonb_build_object('success', false, 'reason', 'claim-mismatch');
    END IF;
  ELSE
    -- IS NOT TRUE, not NOT(...): with one assignee column NULL the plain
    -- comparison yields NULL, and IF NOT NULL silently skips the refusal —
    -- a non-assignee verdict would pass the gate (caught by psql smoke).
    IF ((p_actor_identity_id IS NOT NULL
         AND p_actor_identity_id = v_task.assignee_identity_id)
        OR (p_actor_user_id IS NOT NULL
            AND p_actor_user_id = v_task.assignee_user_id)) IS NOT TRUE THEN
      RETURN jsonb_build_object('success', false, 'reason', 'not-assignee');
    END IF;
  END IF;

  IF p_verdict = 'passed' AND p_evidence IS NULL THEN
    RETURN jsonb_build_object('success', false, 'reason', 'evidence-required');
  END IF;
  IF p_verdict = 'failed' AND p_reason IS NULL THEN
    RETURN jsonb_build_object('success', false, 'reason', 'reason-required');
  END IF;

  v_new_version := v_task.gate_version + 1;
  UPDATE tasks SET
    gate_state = p_verdict,
    gate_version = v_new_version,
    status = CASE WHEN p_verdict = 'passed' THEN 'completed' ELSE 'blocked' END,
    outcome = CASE WHEN p_verdict = 'passed' THEN 'completed' ELSE 'failed' END,
    outcome_reason = p_reason,
    completed_at = now(),
    claimed_by_session_id = NULL,
    claim_token = NULL,
    claimed_at = NULL
  WHERE id = p_task_id;

  INSERT INTO task_gate_events (user_id, task_id, event, attempt, gate_version,
                                session_id, claim_token,
                                actor_identity_id, actor_user_id,
                                assignee_identity_id, assignee_user_id,
                                evidence, reason)
  VALUES (p_user_id, p_task_id, p_verdict, v_task.gate_attempt, v_new_version,
          p_session_id, p_claim_token,
          p_actor_identity_id, p_actor_user_id,
          v_task.assignee_identity_id, v_task.assignee_user_id,
          p_evidence, p_reason);

  v_eval := _graph_evaluate_group(p_user_id, v_task.task_group_id);

  RETURN jsonb_build_object('success', true, 'verdict', p_verdict,
    'taskId', p_task_id, 'attempt', v_task.gate_attempt,
    'gateVersion', v_new_version, 'evaluation', v_eval);
END;
$$;

-- Retry = a new attempt on the SAME node: fresh clock, fresh dwell window,
-- attempt incremented, prior evidence immutable in the event log. Never a
-- new node, never a silent reset.

CREATE OR REPLACE FUNCTION public.retry_gate(
  p_user_id uuid,
  p_task_id uuid,
  p_expected_attempt int,
  p_actor_identity_id uuid DEFAULT NULL,
  p_actor_user_id uuid DEFAULT NULL,
  p_reason text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_task record;
  v_group record;
  v_group_id uuid;
  v_eval jsonb;
BEGIN
  -- Mark this transaction as the executor path (see
  -- enforce_graph_execution_path): transaction-local, resets at commit.
  PERFORM set_config('app.graph_executor', 'on', true);
  IF num_nonnulls(p_actor_identity_id, p_actor_user_id) <> 1 THEN
    RETURN jsonb_build_object('success', false, 'reason', 'exactly-one-actor');
  END IF;

  -- GROUP before TASK (see lock discipline).
  SELECT task_group_id INTO v_group_id FROM tasks
  WHERE id = p_task_id AND user_id = p_user_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'reason', 'task-not-found');
  END IF;
  IF v_group_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'reason', 'not-graph-mode');
  END IF;

  SELECT execution_model, status INTO v_group
  FROM task_groups WHERE id = v_group_id
  FOR SHARE;
  IF NOT FOUND OR v_group.execution_model <> 'graph' THEN
    RETURN jsonb_build_object('success', false, 'reason', 'not-graph-mode');
  END IF;
  IF v_group.status <> 'active' THEN
    RETURN jsonb_build_object('success', false, 'reason', 'group-not-active',
      'groupStatus', v_group.status);
  END IF;

  SELECT * INTO v_task FROM tasks
  WHERE id = p_task_id AND user_id = p_user_id
  FOR UPDATE;
  IF NOT FOUND OR v_task.task_group_id IS DISTINCT FROM v_group_id THEN
    RETURN jsonb_build_object('success', false, 'reason', 'concurrent-move');
  END IF;
  IF v_task.task_type <> 'verification' THEN
    RETURN jsonb_build_object('success', false, 'reason', 'not-verification');
  END IF;

  IF v_task.gate_state <> 'failed' THEN
    RETURN jsonb_build_object('success', false, 'reason', 'not-failed',
      'gateState', v_task.gate_state);
  END IF;
  IF v_task.gate_attempt <> p_expected_attempt THEN
    RETURN jsonb_build_object('success', false, 'reason', 'attempt-conflict',
      'currentAttempt', v_task.gate_attempt);
  END IF;

  UPDATE tasks SET
    gate_state = 'not_ready',
    gate_attempt = gate_attempt + 1,
    gate_version = gate_version + 1,
    gate_opened_at = NULL,
    dwell_started_at = NULL,
    eligible_at = NULL,
    status = 'pending',
    outcome = NULL,
    outcome_reason = NULL,
    completed_at = NULL
  WHERE id = p_task_id;

  INSERT INTO task_gate_events (user_id, task_id, event, attempt, gate_version,
                                actor_identity_id, actor_user_id,
                                assignee_identity_id, assignee_user_id, reason)
  VALUES (p_user_id, p_task_id, 'retry_requested',
          v_task.gate_attempt + 1, v_task.gate_version + 1,
          p_actor_identity_id, p_actor_user_id,
          v_task.assignee_identity_id, v_task.assignee_user_id, p_reason);

  -- Dependencies are typically still satisfied — this re-schedules the
  -- fresh dwell window (and opens immediately when there is none).
  v_eval := _graph_evaluate_group(p_user_id, v_task.task_group_id);

  RETURN jsonb_build_object('success', true, 'taskId', p_task_id,
    'attempt', v_task.gate_attempt + 1, 'evaluation', v_eval);
END;
$$;

-- ── Reconciliation sweep (spec §Durable push) ───────────────────────────
--
-- The single recovery mechanism: re-runs the same evaluator (recovering
-- stranded post-commit dispatches, CAS-opening dwelling gates at
-- eligible_at) and reports live claims for the application's fail-closed
-- liveness check. Push-first, never unrecoverable push-only.

CREATE OR REPLACE FUNCTION public.sweep_task_graph(
  p_user_id uuid,
  p_task_group_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_group record;
  v_eval jsonb;
  v_claims jsonb;
BEGIN
  SELECT execution_model, status INTO v_group
  FROM task_groups
  WHERE id = p_task_group_id AND user_id = p_user_id
  FOR SHARE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'reason', 'group-not-found');
  END IF;
  IF v_group.execution_model <> 'graph' THEN
    RETURN jsonb_build_object('success', false, 'reason', 'not-graph-mode');
  END IF;
  IF v_group.status <> 'active' THEN
    RETURN jsonb_build_object('success', false, 'reason', 'group-not-active',
      'groupStatus', v_group.status);
  END IF;

  v_eval := _graph_evaluate_group(p_user_id, p_task_group_id);

  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'taskId', c.id, 'title', c.title, 'taskType', c.task_type,
           'sessionId', c.claimed_by_session_id, 'claimToken', c.claim_token,
           'claimedAt', c.claimed_at) ORDER BY c.claimed_at), '[]'::jsonb)
  INTO v_claims
  FROM tasks c
  WHERE c.task_group_id = p_task_group_id AND c.user_id = p_user_id
    AND c.claimed_by_session_id IS NOT NULL;

  RETURN jsonb_build_object('success', true, 'evaluation', v_eval, 'claims', v_claims);
END;
$$;

-- ── The executor path is DB-atomic, not advisory ────────────────────────
--
-- Same lesson as enforce_blocked_by_source (step 1, Lumen round 1): an
-- application-level "graph tasks must use claim/complete/verdict" check is
-- check-then-write and therefore advisory. This trigger makes the refusal
-- part of the write's own transaction: execution-owned columns (status,
-- outcome, gate projections, claim fields) on graph-mode tasks change only
-- inside the executor RPCs, which mark their transaction with a local GUC.
-- update_task, legacy completeTask, admin endpoints, and ad-hoc SQL all
-- hit the fence; metadata/title/priority edits pass untouched.

CREATE OR REPLACE FUNCTION public.enforce_graph_execution_path()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_group record;
  v_exec_change boolean := false;
  v_config_change boolean := false;
BEGIN
  IF current_setting('app.graph_executor', true) = 'on' THEN
    RETURN NEW;
  END IF;

  -- Tier 0 — membership. task_group_id was in the trigger's column list
  -- but neither change predicate consulted it, so direct moves bypassed
  -- the whole fence and could strand cross-group edges no mutation could
  -- remove (Lumen round 3 P1). Spec §Task moves: pre-start SET moves go
  -- through a serialized RPC that does not exist yet — until it does, a
  -- task's graph membership is fixed. Groups locked in id order so two
  -- concurrent movers cannot deadlock.
  IF TG_OP = 'UPDATE' AND NEW.task_group_id IS DISTINCT FROM OLD.task_group_id THEN
    DECLARE
      v_side uuid;
      v_side_model text;
    BEGIN
      FOR v_side IN
        SELECT g_id FROM unnest(ARRAY[OLD.task_group_id, NEW.task_group_id]) AS g(g_id)
        WHERE g_id IS NOT NULL
        ORDER BY g_id
      LOOP
        SELECT execution_model INTO v_side_model
        FROM task_groups WHERE id = v_side FOR SHARE;
        IF v_side_model = 'graph' THEN
          RAISE EXCEPTION
            'graph membership is fixed — tasks cannot move into or out of a graph-mode group (spec: pre-start set moves need the serialized move RPC)';
        END IF;
      END LOOP;
    END;
    RETURN NEW;
  END IF;

  IF NEW.task_group_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Tier 1 — executor-owned, ALWAYS fenced for graph groups: lifecycle
  -- state, verdict/outcome projections, claims, and server-owned timing
  -- (a direct eligible_at rewrite would force an hour-dwell gate open on
  -- the next sweep — Lumen round 1 P1; outcome_reason joined in round 2).
  IF TG_OP = 'UPDATE' AND NOT (
       NEW.status IS NOT DISTINCT FROM OLD.status
   AND NEW.outcome IS NOT DISTINCT FROM OLD.outcome
   AND NEW.outcome_reason IS NOT DISTINCT FROM OLD.outcome_reason
   AND NEW.gate_state IS NOT DISTINCT FROM OLD.gate_state
   AND NEW.gate_attempt IS NOT DISTINCT FROM OLD.gate_attempt
   AND NEW.gate_version IS NOT DISTINCT FROM OLD.gate_version
   AND NEW.gate_opened_at IS NOT DISTINCT FROM OLD.gate_opened_at
   AND NEW.dwell_started_at IS NOT DISTINCT FROM OLD.dwell_started_at
   AND NEW.eligible_at IS NOT DISTINCT FROM OLD.eligible_at
   AND NEW.completed_at IS NOT DISTINCT FROM OLD.completed_at
   AND NEW.claimed_by_session_id IS NOT DISTINCT FROM OLD.claimed_by_session_id
   AND NEW.claim_token IS NOT DISTINCT FROM OLD.claim_token
   AND NEW.claimed_at IS NOT DISTINCT FROM OLD.claimed_at) THEN
    v_exec_change := true;
  END IF;

  -- Tier 2 — gate config and authority, frozen once execution has STARTED
  -- (Lumen round 2 P1: flipping an OPEN gate from executable/no-dwell to
  -- approval/3600s rewrites its meaning mid-attempt; assignee changes must
  -- be explicit and evented, which no path provides yet). Pre-start
  -- authoring (execution_phase 'idle') stays free.
  IF TG_OP = 'UPDATE' AND NOT (
       NEW.verification IS NOT DISTINCT FROM OLD.verification
   AND NEW.assignee_identity_id IS NOT DISTINCT FROM OLD.assignee_identity_id
   AND NEW.assignee_user_id IS NOT DISTINCT FROM OLD.assignee_user_id) THEN
    v_config_change := true;
  END IF;

  IF TG_OP = 'UPDATE' AND NOT v_exec_change AND NOT v_config_change THEN
    RETURN NEW;
  END IF;
  -- INSERTs are inert unless they arrive pre-executed (non-pending status,
  -- a claim, timing stamps, or a gate already past not_ready). Config and
  -- assignees at INSERT are authoring, always allowed.
  IF TG_OP = 'INSERT'
     AND NEW.status = 'pending'
     AND NEW.outcome IS NULL
     AND NEW.outcome_reason IS NULL
     AND NEW.claimed_by_session_id IS NULL
     AND NEW.gate_opened_at IS NULL
     AND NEW.dwell_started_at IS NULL
     AND NEW.eligible_at IS NULL
     AND NEW.completed_at IS NULL
     AND (NEW.gate_state IS NULL OR NEW.gate_state = 'not_ready') THEN
    RETURN NEW;
  END IF;

  SELECT execution_model, execution_phase INTO v_group
  FROM task_groups
  WHERE id = NEW.task_group_id
  FOR SHARE;

  IF v_group.execution_model = 'graph' THEN
    IF TG_OP = 'INSERT' OR v_exec_change THEN
      RAISE EXCEPTION
        'execution state is executor-owned for graph-mode groups — use claim_task / complete_task(claimToken) / record_gate_verdict / retry_gate';
    END IF;
    IF v_config_change AND v_group.execution_phase <> 'idle' THEN
      RAISE EXCEPTION
        'gate config and assignees are frozen once graph execution starts — author before start_graph_execution';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_graph_execution_path ON public.tasks;
CREATE TRIGGER enforce_graph_execution_path
  BEFORE INSERT OR UPDATE OF status, outcome, outcome_reason, gate_state, gate_attempt,
    gate_version, gate_opened_at, dwell_started_at, eligible_at, completed_at,
    claimed_by_session_id, claim_token, claimed_at, verification,
    assignee_identity_id, assignee_user_id, task_group_id ON public.tasks
  FOR EACH ROW EXECUTE FUNCTION public.enforce_graph_execution_path();

-- ── apply_task_graph, amended: mutation is an executor event ────────────
--
-- Redefines the step-1 function (Lumen, round 1 P1). Two obligations the
-- step-1 version predates:
--
-- 1. "Retry and inbound/config mutation establish a fresh window" (v7):
--    mutating a non-terminal gate's inbound set resets it to not_ready
--    with a fresh dwell, releases any claim, and bumps gate_version so
--    in-flight verdicts CAS-bounce. Without this, adding an unsatisfied
--    edge to an OPEN gate left it decidable on the strength of a stale
--    opening. Terminal gates (passed/failed) are per-attempt facts and
--    stay untouched.
-- 2. Readiness propagates on mutation events, not just completions: the
--    same-transaction evaluation opens/schedules whatever the new graph
--    makes ready (e.g. cutting a failed edge unblocks downstream now, not
--    at the next sweep) and returns the evaluation for post-commit
--    dispatch.

CREATE OR REPLACE FUNCTION public.apply_task_graph(
  p_user_id uuid,
  p_task_group_id uuid,
  p_expected_version bigint,
  p_edges jsonb,
  p_actor_identity_id uuid DEFAULT NULL,
  p_actor_user_id uuid DEFAULT NULL,
  p_system_actor boolean DEFAULT false,
  p_constructor text DEFAULT NULL,
  p_constructor_version text DEFAULT NULL,
  p_config_hash text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_group record;
  v_current_version bigint;
  v_invalid jsonb;
  v_has_cycle boolean;
  v_added jsonb;
  v_removed jsonb;
  v_new_version bigint;
  v_gate record;
  v_passed_gates jsonb;
  v_reset jsonb := '[]'::jsonb;
  v_eval jsonb;
BEGIN
  -- Mark this transaction as the executor path (see
  -- enforce_graph_execution_path): the gate resets below are executor
  -- transitions. Transaction-local, resets at commit.
  PERFORM set_config('app.graph_executor', 'on', true);

  IF num_nonnulls(p_actor_identity_id, p_actor_user_id) + p_system_actor::int <> 1 THEN
    RETURN jsonb_build_object('success', false, 'reason', 'exactly-one-actor');
  END IF;

  -- Lock BEFORE reading anything about the graph.
  SELECT graph_version, execution_model, status INTO v_group
  FROM task_groups
  WHERE id = p_task_group_id AND user_id = p_user_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'reason', 'group-not-found');
  END IF;
  IF v_group.execution_model <> 'graph' THEN
    RETURN jsonb_build_object('success', false, 'reason', 'not-graph-mode');
  END IF;
  -- A completed/cancelled group is off the executor: it is unswept and
  -- unclaimable, so a mutation could never take effect — refuse loudly
  -- rather than store an inert graph (Lumen round 2).
  IF v_group.status NOT IN ('active', 'paused') THEN
    RETURN jsonb_build_object('success', false, 'reason', 'group-not-active',
      'groupStatus', v_group.status);
  END IF;
  v_current_version := v_group.graph_version;
  IF v_current_version <> p_expected_version THEN
    RETURN jsonb_build_object('success', false, 'reason', 'version-conflict',
      'currentVersion', v_current_version);
  END IF;

  DROP TABLE IF EXISTS _desired_edges;
  CREATE TEMP TABLE _desired_edges ON COMMIT DROP AS
    SELECT DISTINCT (e->>'from')::uuid AS from_task, (e->>'to')::uuid AS to_task
    FROM jsonb_array_elements(coalesce(p_edges, '[]'::jsonb)) e;

  SELECT jsonb_agg(jsonb_build_object('from', d.from_task, 'to', d.to_task,
           'problem',
           CASE
             WHEN d.from_task = d.to_task THEN 'self'
             WHEN f.id IS NULL OR t.id IS NULL THEN 'unknown-task'
             ELSE 'cross-group'
           END))
  INTO v_invalid
  FROM _desired_edges d
  LEFT JOIN tasks f ON f.id = d.from_task AND f.user_id = p_user_id
  LEFT JOIN tasks t ON t.id = d.to_task AND t.user_id = p_user_id
  WHERE d.from_task = d.to_task
     OR f.id IS NULL OR t.id IS NULL
     OR f.task_group_id IS DISTINCT FROM p_task_group_id
     OR t.task_group_id IS DISTINCT FROM p_task_group_id;
  IF v_invalid IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'reason', 'invalid-edges',
      'invalid', v_invalid);
  END IF;

  WITH RECURSIVE reach(origin, node) AS (
    SELECT e.from_task, e.to_task FROM _desired_edges e
    UNION
    SELECT r.origin, e.to_task
    FROM reach r JOIN _desired_edges e ON e.from_task = r.node
  )
  SELECT EXISTS (SELECT 1 FROM reach WHERE origin = node) INTO v_has_cycle;
  IF v_has_cycle THEN
    RETURN jsonb_build_object('success', false, 'reason', 'cycle');
  END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object('from', te.from_task, 'to', te.to_task)), '[]'::jsonb)
  INTO v_removed
  FROM task_edges te
  JOIN tasks tk ON tk.id = te.from_task
  WHERE tk.task_group_id = p_task_group_id
    AND NOT EXISTS (SELECT 1 FROM _desired_edges d
                    WHERE d.from_task = te.from_task AND d.to_task = te.to_task);

  SELECT coalesce(jsonb_agg(jsonb_build_object('from', d.from_task, 'to', d.to_task)), '[]'::jsonb)
  INTO v_added
  FROM _desired_edges d
  WHERE NOT EXISTS (SELECT 1 FROM task_edges te
                    WHERE te.from_task = d.from_task AND te.to_task = d.to_task);

  -- A PASSED gate's verdict is a per-attempt fact whose downstream may
  -- already have consumed it — restating its premises by mutating inbound
  -- would leave a decided gate standing on evidence for a different graph
  -- (Lumen round 2 P1). Refused outright: remediate with new nodes or
  -- explicit cancellation, never a silent restatement. FAILED gates stay
  -- mutable — retry_gate establishes the fresh attempt that will read the
  -- new inbound set.
  SELECT jsonb_agg(DISTINCT changed.to_id) INTO v_passed_gates
  FROM (
    SELECT (e ->> 'to')::uuid AS to_id FROM jsonb_array_elements(v_added) e
    UNION
    SELECT (e ->> 'to')::uuid FROM jsonb_array_elements(v_removed) e
  ) changed
  JOIN tasks t ON t.id = changed.to_id
  WHERE t.task_type = 'verification' AND t.gate_state = 'passed';
  IF v_passed_gates IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'reason', 'passed-gate-inbound',
      'gates', v_passed_gates);
  END IF;

  DELETE FROM task_edges te
  USING tasks tk
  WHERE te.from_task = tk.id AND tk.task_group_id = p_task_group_id
    AND NOT EXISTS (SELECT 1 FROM _desired_edges d
                    WHERE d.from_task = te.from_task AND d.to_task = te.to_task);
  INSERT INTO task_edges (from_task, to_task)
  SELECT d.from_task, d.to_task FROM _desired_edges d
  ON CONFLICT (from_task, to_task) DO NOTHING;

  v_new_version := v_current_version + 1;
  UPDATE task_groups SET graph_version = v_new_version WHERE id = p_task_group_id;

  INSERT INTO task_graph_revisions (
    user_id, task_group_id, graph_version,
    actor_identity_id, actor_user_id, system_actor,
    constructor, constructor_version, config_hash, diff
  ) VALUES (
    p_user_id, p_task_group_id, v_new_version,
    p_actor_identity_id, p_actor_user_id, p_system_actor,
    p_constructor, p_constructor_version, p_config_hash,
    jsonb_build_object('edgesAdded', v_added, 'edgesRemoved', v_removed)
  );

  -- Fresh window for every NON-TERMINAL gate whose inbound set changed:
  -- back to not_ready, dwell cleared, claim released, version bumped
  -- (stale verdicts bounce on the CAS). Id order, same as the evaluator.
  FOR v_gate IN
    SELECT t.id, t.gate_attempt, t.gate_version, t.claimed_by_session_id, t.claim_token
    FROM tasks t
    WHERE t.task_group_id = p_task_group_id
      AND t.user_id = p_user_id
      AND t.task_type = 'verification'
      AND t.gate_state IN ('not_ready', 'open', 'in_progress')
      AND t.id IN (
        SELECT (e->>'to')::uuid FROM jsonb_array_elements(v_added) e
        UNION
        SELECT (e->>'to')::uuid FROM jsonb_array_elements(v_removed) e
      )
    ORDER BY t.id
    FOR UPDATE
  LOOP
    IF v_gate.claimed_by_session_id IS NOT NULL THEN
      INSERT INTO task_gate_events (user_id, task_id, event, attempt, gate_version,
                                    session_id, claim_token, reason)
      VALUES (p_user_id, v_gate.id, 'claim_released', v_gate.gate_attempt,
              v_gate.gate_version + 1, v_gate.claimed_by_session_id,
              v_gate.claim_token, 'inbound-mutation');
    END IF;
    UPDATE tasks SET
      gate_state = 'not_ready',
      gate_version = gate_version + 1,
      gate_opened_at = NULL,
      dwell_started_at = NULL,
      eligible_at = NULL,
      status = 'pending',
      claimed_by_session_id = NULL,
      claim_token = NULL,
      claimed_at = NULL
    WHERE id = v_gate.id;
    v_reset := v_reset || to_jsonb(v_gate.id);
  END LOOP;

  -- A PAUSED group accepts authoring, but pause means FROZEN for
  -- execution: evaluating here would open gates (starting their
  -- actionable clocks) and emit ready work no session may claim
  -- (claim_graph_task refuses non-active groups) — Lumen round 4 P1.
  -- Evaluation and dispatch are deferred to resume: start_graph_execution
  -- sweeps the group the moment it is active again.
  IF v_group.status = 'active' THEN
    v_eval := _graph_evaluate_group(p_user_id, p_task_group_id);
  END IF;

  RETURN jsonb_build_object('success', true, 'graphVersion', v_new_version,
    'added', v_added, 'removed', v_removed, 'resetGates', v_reset,
    'evaluation', v_eval, 'evaluationDeferred', v_group.status <> 'active');
END;
$$;

-- ── convert_task_group_to_graph, amended (round 4): marks itself ───────
--
-- Redefines the step-1 function verbatim plus one line: the conversion
-- transaction sets the executor GUC, because the model fence below makes
-- execution_model conversion-owned and would otherwise refuse the flip
-- this function exists to perform.

CREATE OR REPLACE FUNCTION public.convert_task_group_to_graph(
  p_user_id uuid,
  p_task_group_id uuid,
  p_expected_version bigint,
  p_actor_identity_id uuid DEFAULT NULL,
  p_actor_user_id uuid DEFAULT NULL,
  p_system_actor boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_group record;
  v_report jsonb;
  v_has_cycle boolean;
  v_edge_count int;
  v_added jsonb;
  v_new_version bigint;
BEGIN
  -- Conversion IS the one legitimate execution_model writer — mark the
  -- transaction so the model fence admits the flip (Lumen round 4 P1).
  PERFORM set_config('app.graph_executor', 'on', true);
  IF num_nonnulls(p_actor_identity_id, p_actor_user_id) + p_system_actor::int <> 1 THEN
    RETURN jsonb_build_object('success', false, 'reason', 'exactly-one-actor');
  END IF;

  SELECT graph_version, execution_model, execution_phase INTO v_group
  FROM task_groups
  WHERE id = p_task_group_id AND user_id = p_user_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'reason', 'group-not-found');
  END IF;
  IF v_group.execution_model = 'graph' THEN
    RETURN jsonb_build_object('success', false, 'reason', 'already-graph');
  END IF;
  IF v_group.graph_version <> p_expected_version THEN
    RETURN jsonb_build_object('success', false, 'reason', 'version-conflict',
      'currentVersion', v_group.graph_version);
  END IF;
  IF v_group.execution_phase NOT IN ('idle', 'paused') THEN
    RETURN jsonb_build_object('success', false, 'reason', 'execution-started',
      'executionPhase', v_group.execution_phase);
  END IF;

  DROP TABLE IF EXISTS _candidate_edges;
  CREATE TEMP TABLE _candidate_edges ON COMMIT DROP AS
    SELECT DISTINCT b.blocker AS from_task, t.id AS to_task
    FROM tasks t
    CROSS JOIN LATERAL unnest(coalesce(t.blocked_by, '{}'::uuid[])) AS b(blocker)
    WHERE t.task_group_id = p_task_group_id AND t.user_id = p_user_id;

  SELECT jsonb_agg(jsonb_build_object('from', c.from_task, 'to', c.to_task,
           'problem',
           CASE
             WHEN c.from_task = c.to_task THEN 'self'
             WHEN f.id IS NULL THEN 'dangling'
             WHEN f.user_id <> p_user_id THEN 'cross-user'
             ELSE 'cross-group'
           END))
  INTO v_report
  FROM _candidate_edges c
  LEFT JOIN tasks f ON f.id = c.from_task
  WHERE c.from_task = c.to_task
     OR f.id IS NULL
     OR f.user_id <> p_user_id
     OR f.task_group_id IS DISTINCT FROM p_task_group_id;
  IF v_report IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'reason', 'preflight-failed',
      'invalid', v_report);
  END IF;

  -- Deduplicating reachability (see apply_task_graph): V²-bounded, never
  -- path enumeration under the group lock.
  WITH RECURSIVE reach(origin, node) AS (
    SELECT c.from_task, c.to_task FROM _candidate_edges c
    UNION
    SELECT r.origin, c.to_task
    FROM reach r JOIN _candidate_edges c ON c.from_task = r.node
  )
  SELECT EXISTS (SELECT 1 FROM reach WHERE origin = node) INTO v_has_cycle;
  IF v_has_cycle THEN
    RETURN jsonb_build_object('success', false, 'reason', 'preflight-failed',
      'invalid', jsonb_build_array(jsonb_build_object('problem', 'cycle')));
  END IF;

  INSERT INTO task_edges (from_task, to_task)
  SELECT c.from_task, c.to_task FROM _candidate_edges c;
  GET DIAGNOSTICS v_edge_count = ROW_COUNT;

  SELECT coalesce(jsonb_agg(jsonb_build_object('from', c.from_task, 'to', c.to_task)), '[]'::jsonb)
  INTO v_added FROM _candidate_edges c;

  v_new_version := v_group.graph_version + 1;
  INSERT INTO task_graph_revisions (
    user_id, task_group_id, graph_version,
    actor_identity_id, actor_user_id, system_actor,
    constructor, constructor_version, diff
  ) VALUES (
    p_user_id, p_task_group_id, v_new_version,
    p_actor_identity_id, p_actor_user_id, p_system_actor,
    'linear-conversion', '1',
    jsonb_build_object('edgesAdded', v_added, 'convertedFrom', 'blocked_by')
  );

  -- The flip is LAST, visible only at commit. blocked_by is left intact as
  -- the historical array; it is no longer written or read for graph groups.
  UPDATE task_groups
  SET graph_version = v_new_version, execution_model = 'graph'
  WHERE id = p_task_group_id;

  RETURN jsonb_build_object('success', true, 'graphVersion', v_new_version,
    'edgeCount', v_edge_count);
END;
$$;

-- ── Group completion is earned, never declared (Lumen round 1 P1) ───────
--
-- update_task_group(status:'completed') / close_task_group on a graph
-- group with live nodes would strand them: the sweep only reconciles
-- ACTIVE groups. The rule is predicate-based, not path-based: a graph
-- group reaches 'completed' only when every node is terminal — which is
-- exactly the state in which the executor's own finalization runs, so the
-- legitimate path needs no marker. 'cancelled' stays available as the
-- operator escape hatch.

CREATE OR REPLACE FUNCTION public.enforce_graph_group_completion()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Graph groups are BORN by conversion (Lumen round 5 P1): an INSERT
  -- arriving already-graph (or with a non-zero version) has no preflight
  -- and no revision history — every graph group's lineage must start at
  -- linear/version 0 and pass through convert_task_group_to_graph.
  IF TG_OP = 'INSERT' THEN
    IF current_setting('app.graph_executor', true) IS DISTINCT FROM 'on'
       AND (NEW.execution_model = 'graph' OR NEW.graph_version <> 0) THEN
      RAISE EXCEPTION
        'graph groups are born by conversion — INSERT linear at version 0, then convert_task_group_to_graph';
    END IF;
    RETURN NEW;
  END IF;

  -- execution_model is CONVERSION-owned (Lumen round 4 P1): a direct
  -- linear → graph flip bypasses preflight, revisioning, and blocked_by
  -- validation (yielding a version-0 zero-edge graph where everything is
  -- READY); graph → linear detaches the executor while leaving edges
  -- behind. Only the conversion RPC (executor GUC) may change it.
  IF NEW.execution_model IS DISTINCT FROM OLD.execution_model
     AND current_setting('app.graph_executor', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION
      'execution_model is conversion-owned — use convert_task_group_to_graph';
  END IF;
  -- graph_version is the mutation CAS: a direct write would let a stale
  -- apply land as if it were current, detached from the revision sequence
  -- (Lumen round 5 P1). Only the serialized mutation paths advance it.
  IF NEW.graph_version IS DISTINCT FROM OLD.graph_version
     AND current_setting('app.graph_executor', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION
      'graph_version is executor-owned — mutate through apply_task_graph / convert_task_group_to_graph';
  END IF;
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;
  -- OLD model, deliberately: a one-write {execution_model:'linear',
  -- status:'active'} on a cancelled GRAPH group must not slip past
  -- terminal finality by changing its clothes in the same statement
  -- (Lumen round 4 P1).
  IF OLD.execution_model <> 'graph' THEN
    RETURN NEW;
  END IF;
  -- Terminal is terminal: a cancelled group must stay cancelled (a late
  -- finalizer write was observed resurrecting cancelled → completed —
  -- Lumen round 3 P1), and a completed group must not quietly reopen.
  -- Un-cancelling, if ever wanted, deserves an explicit evented RPC.
  IF OLD.status IN ('completed', 'cancelled') THEN
    RAISE EXCEPTION
      'graph-mode group is terminal (%) — status cannot change', OLD.status;
  END IF;
  IF NEW.status <> 'completed' THEN
    RETURN NEW;
  END IF;
  IF EXISTS (
    SELECT 1 FROM tasks t
    WHERE t.task_group_id = NEW.id
      AND (NOT (t.status IN ('completed', 'archived')
                OR (t.status = 'blocked' AND t.outcome IS NOT NULL))
           OR (t.task_type = 'verification' AND t.gate_state IS DISTINCT FROM 'passed'))
  ) THEN
    RAISE EXCEPTION
      'graph-mode group cannot complete: non-terminal nodes or unpassed verification gates remain — retry the failed gate, or cancel to abandon';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_graph_group_completion ON public.task_groups;
CREATE TRIGGER enforce_graph_group_completion
  BEFORE INSERT OR UPDATE OF status, execution_model, graph_version ON public.task_groups
  FOR EACH ROW EXECUTE FUNCTION public.enforce_graph_group_completion();

-- ── Grants (house pattern: service-role only; evaluator internal) ───────

REVOKE ALL ON FUNCTION public.graph_satisfies(text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.graph_satisfies(text, text, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.graph_satisfies(text, text, text) TO service_role;

REVOKE ALL ON FUNCTION public.graph_unsatisfiable(text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.graph_unsatisfiable(text, text, text, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.graph_unsatisfiable(text, text, text, text) TO service_role;

-- Internal: reachable only through the RPCs above (SECURITY DEFINER bodies
-- execute as the function owner, which retains EXECUTE).
REVOKE ALL ON FUNCTION public._graph_evaluate_group(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._graph_evaluate_group(uuid, uuid) FROM anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.claim_graph_task(uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_graph_task(uuid, uuid, uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_graph_task(uuid, uuid, uuid) TO service_role;

REVOKE ALL ON FUNCTION public.release_graph_claim(uuid, uuid, uuid, uuid, boolean, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.release_graph_claim(uuid, uuid, uuid, uuid, boolean, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_graph_claim(uuid, uuid, uuid, uuid, boolean, text) TO service_role;

REVOKE ALL ON FUNCTION public.complete_graph_task(uuid, uuid, uuid, uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.complete_graph_task(uuid, uuid, uuid, uuid, text, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_graph_task(uuid, uuid, uuid, uuid, text, text) TO service_role;

REVOKE ALL ON FUNCTION public.record_gate_verdict(uuid, uuid, text, int, bigint, uuid, uuid, uuid, uuid, jsonb, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_gate_verdict(uuid, uuid, text, int, bigint, uuid, uuid, uuid, uuid, jsonb, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_gate_verdict(uuid, uuid, text, int, bigint, uuid, uuid, uuid, uuid, jsonb, text) TO service_role;

REVOKE ALL ON FUNCTION public.retry_gate(uuid, uuid, int, uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.retry_gate(uuid, uuid, int, uuid, uuid, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.retry_gate(uuid, uuid, int, uuid, uuid, text) TO service_role;

REVOKE ALL ON FUNCTION public.sweep_task_graph(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sweep_task_graph(uuid, uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sweep_task_graph(uuid, uuid) TO service_role;
