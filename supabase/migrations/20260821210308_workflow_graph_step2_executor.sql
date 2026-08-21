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
-- Lock discipline: mutation RPCs lock the task row FOR UPDATE, then the
-- group row FOR SHARE. FOR SHARE serializes every executor action against
-- apply_task_graph / convert_task_group_to_graph (FOR UPDATE) while letting
-- concurrent completions on different tasks proceed. The evaluator visits
-- gate rows in id order so two concurrent evaluations lock rows in the same
-- order (no deadlock); every transition is a per-row CAS.

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
                           THEN s.gate_state ELSE coalesce(s.outcome, s.status) END)
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
         count(*) AS total,
         count(*) FILTER (WHERE t.status = 'completed') AS completed,
         count(*) FILTER (WHERE t.status = 'blocked' AND t.outcome = 'failed') AS failed,
         count(*) FILTER (WHERE t.status = 'blocked' AND t.outcome = 'skipped') AS skipped
  INTO v_counts
  FROM tasks t
  WHERE t.task_group_id = p_task_group_id AND t.user_id = p_user_id;
  v_group_complete := v_counts.open_count = 0 AND v_counts.total > 0;

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
  v_token uuid;
BEGIN
  SELECT * INTO v_task FROM tasks
  WHERE id = p_task_id AND user_id = p_user_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'reason', 'task-not-found');
  END IF;
  IF v_task.task_group_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'reason', 'not-graph-mode');
  END IF;

  SELECT execution_model, status INTO v_group
  FROM task_groups WHERE id = v_task.task_group_id
  FOR SHARE;
  IF v_group.execution_model <> 'graph' THEN
    RETURN jsonb_build_object('success', false, 'reason', 'not-graph-mode');
  END IF;
  IF v_group.status <> 'active' THEN
    RETURN jsonb_build_object('success', false, 'reason', 'group-not-active',
      'groupStatus', v_group.status);
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
BEGIN
  SELECT * INTO v_task FROM tasks
  WHERE id = p_task_id AND user_id = p_user_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'reason', 'task-not-found');
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
  v_eval jsonb;
BEGIN
  IF p_outcome NOT IN ('completed', 'failed', 'skipped') THEN
    RETURN jsonb_build_object('success', false, 'reason', 'invalid-outcome');
  END IF;

  SELECT * INTO v_task FROM tasks
  WHERE id = p_task_id AND user_id = p_user_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'reason', 'task-not-found');
  END IF;
  IF v_task.task_group_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'reason', 'not-graph-mode');
  END IF;
  IF v_task.task_type <> 'work' THEN
    RETURN jsonb_build_object('success', false, 'reason', 'verification-node',
      'hint', 'verification nodes take verdicts via record_gate_verdict, never completion');
  END IF;

  SELECT execution_model INTO v_group
  FROM task_groups WHERE id = v_task.task_group_id
  FOR SHARE;
  IF v_group.execution_model <> 'graph' THEN
    RETURN jsonb_build_object('success', false, 'reason', 'not-graph-mode');
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
  v_eval jsonb;
  v_new_version bigint;
BEGIN
  IF p_verdict NOT IN ('passed', 'failed') THEN
    RETURN jsonb_build_object('success', false, 'reason', 'invalid-verdict');
  END IF;
  IF num_nonnulls(p_actor_identity_id, p_actor_user_id) <> 1 THEN
    RETURN jsonb_build_object('success', false, 'reason', 'exactly-one-actor');
  END IF;

  SELECT * INTO v_task FROM tasks
  WHERE id = p_task_id AND user_id = p_user_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'reason', 'task-not-found');
  END IF;
  IF v_task.task_type <> 'verification' THEN
    RETURN jsonb_build_object('success', false, 'reason', 'not-verification');
  END IF;

  SELECT execution_model INTO v_group
  FROM task_groups WHERE id = v_task.task_group_id
  FOR SHARE;
  IF v_group.execution_model <> 'graph' THEN
    RETURN jsonb_build_object('success', false, 'reason', 'not-graph-mode');
  END IF;

  IF v_task.gate_state NOT IN ('open', 'in_progress') THEN
    RETURN jsonb_build_object('success', false, 'reason', 'gate-not-open',
      'gateState', v_task.gate_state);
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
  v_eval jsonb;
BEGIN
  IF num_nonnulls(p_actor_identity_id, p_actor_user_id) <> 1 THEN
    RETURN jsonb_build_object('success', false, 'reason', 'exactly-one-actor');
  END IF;

  SELECT * INTO v_task FROM tasks
  WHERE id = p_task_id AND user_id = p_user_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'reason', 'task-not-found');
  END IF;
  IF v_task.task_type <> 'verification' THEN
    RETURN jsonb_build_object('success', false, 'reason', 'not-verification');
  END IF;

  SELECT execution_model INTO v_group
  FROM task_groups WHERE id = v_task.task_group_id
  FOR SHARE;
  IF v_group.execution_model <> 'graph' THEN
    RETURN jsonb_build_object('success', false, 'reason', 'not-graph-mode');
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
