-- Workflow graph, step 1 (spec: ink://specs/workflow-graph v10, APPROVED).
--
-- First-class forward edges replace blocked_by as the stored dependency
-- representation for graph-mode groups. Our execution is PUSH: a completion
-- event propagates forward along edges; blocked_by was the compiled pull
-- form of a system nothing pulls (Conor's ruling, 2026-08-18). An edge is a
-- join-table row, nothing more.
--
-- One canonical edge source per execution model:
--   linear (legacy) : blocked_by stays the frozen representation while the
--                     group drains on the old executor
--   graph           : task_edges is the ONLY stored source; the API read
--                     model derives blockedBy for existing consumers
--
-- Gate/claim columns and task_gate_events land here so the whole contract's
-- schema ships atomically; the state machinery that writes them is steps 2-3.

-- ── Edges ───────────────────────────────────────────────────────────────

CREATE TABLE public.task_edges (
  from_task  uuid NOT NULL REFERENCES public.tasks(id) ON DELETE CASCADE,
  to_task    uuid NOT NULL REFERENCES public.tasks(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (from_task, to_task),
  CHECK (from_task <> to_task)
);
-- The PK serves outgoing lookup (the push); this index serves readiness
-- checks, inbound rendering, and cascades.
CREATE INDEX task_edges_to_from_idx ON public.task_edges (to_task, from_task);

-- ── Execution model + mutation serialization + provenance ───────────────

ALTER TABLE public.task_groups ADD COLUMN execution_model text NOT NULL DEFAULT 'linear'
  CHECK (execution_model IN ('linear', 'graph'));
ALTER TABLE public.task_groups ADD COLUMN graph_version bigint NOT NULL DEFAULT 0;

-- Every graph mutation appends exactly one immutable revision record:
-- version, exactly one actor, constructor provenance, node/edge diff.
-- Application-append-only.
CREATE TABLE public.task_graph_revisions (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  task_group_id uuid NOT NULL REFERENCES public.task_groups(id) ON DELETE CASCADE,
  graph_version bigint NOT NULL,
  actor_identity_id uuid REFERENCES public.agent_identities(id),
  actor_user_id uuid REFERENCES public.users(id),
  system_actor boolean NOT NULL DEFAULT false,
  constructor text,
  constructor_version text,
  config_hash text,
  diff jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT revision_one_actor CHECK (
    num_nonnulls(actor_identity_id, actor_user_id) + system_actor::int = 1
  ),
  UNIQUE (task_group_id, graph_version)
);

-- ── Node typing, gates, claims (columns are projections; events are
--    authoritative — the machinery that writes them is steps 2-3) ────────

ALTER TABLE public.tasks ADD COLUMN task_type text NOT NULL DEFAULT 'work'
  CHECK (task_type IN ('work', 'verification'));
ALTER TABLE public.tasks ADD COLUMN node_slug text;
ALTER TABLE public.tasks ADD COLUMN assignee_identity_id uuid REFERENCES public.agent_identities(id);
ALTER TABLE public.tasks ADD COLUMN assignee_user_id uuid REFERENCES public.users(id);
ALTER TABLE public.tasks ADD COLUMN gate_state text
  CHECK (gate_state IN ('not_ready', 'open', 'in_progress', 'passed', 'failed'));
ALTER TABLE public.tasks ADD COLUMN gate_version bigint NOT NULL DEFAULT 0;
ALTER TABLE public.tasks ADD COLUMN gate_attempt int NOT NULL DEFAULT 1;
ALTER TABLE public.tasks ADD COLUMN gate_opened_at timestamptz;
ALTER TABLE public.tasks ADD COLUMN dwell_started_at timestamptz;
ALTER TABLE public.tasks ADD COLUMN eligible_at timestamptz;
ALTER TABLE public.tasks ADD COLUMN claimed_by_session_id uuid REFERENCES public.sessions(id);
ALTER TABLE public.tasks ADD COLUMN claim_token uuid;
ALTER TABLE public.tasks ADD COLUMN claimed_at timestamptz;
ALTER TABLE public.tasks ADD COLUMN verification jsonb;

CREATE UNIQUE INDEX tasks_group_node_slug_idx ON public.tasks (task_group_id, node_slug)
  WHERE node_slug IS NOT NULL;
ALTER TABLE public.tasks ADD CONSTRAINT gate_fields_match_type CHECK (
  (task_type = 'verification') = (gate_state IS NOT NULL)
);
ALTER TABLE public.tasks ADD CONSTRAINT gate_one_assignee CHECK (
  task_type <> 'verification'
  OR ((assignee_identity_id IS NULL) <> (assignee_user_id IS NULL))
);

CREATE TABLE public.task_gate_events (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  task_id uuid NOT NULL REFERENCES public.tasks(id) ON DELETE CASCADE,
  event text NOT NULL CHECK (event IN
    ('scheduled', 'opened', 'claimed', 'claim_released', 'claim_reclaimed',
     'passed', 'failed', 'retry_requested', 'reassigned')),
  attempt int NOT NULL,
  gate_version bigint NOT NULL,
  session_id uuid REFERENCES public.sessions(id),
  claim_token uuid,
  actor_identity_id uuid REFERENCES public.agent_identities(id),
  actor_user_id uuid REFERENCES public.users(id),
  assignee_identity_id uuid REFERENCES public.agent_identities(id),
  assignee_user_id uuid REFERENCES public.users(id),
  evidence jsonb,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT event_one_actor CHECK (
    event IN ('scheduled', 'claimed', 'claim_released', 'claim_reclaimed', 'opened')
    OR ((actor_identity_id IS NULL) <> (actor_user_id IS NULL))
  )
);
CREATE INDEX task_gate_events_task_idx ON public.task_gate_events (task_id, created_at);

-- ── RLS (service-role safety net, matching the rest of the schema) ──────

ALTER TABLE public.task_edges ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access to task_edges" ON public.task_edges
  USING (true) WITH CHECK (true);
ALTER TABLE public.task_graph_revisions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access to task_graph_revisions" ON public.task_graph_revisions
  USING (true) WITH CHECK (true);
ALTER TABLE public.task_gate_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access to task_gate_events" ON public.task_gate_events
  USING (true) WITH CHECK (true);

-- ── Serialized graph mutation ───────────────────────────────────────────
--
-- One transaction is not enough: at READ COMMITTED, concurrent mutations
-- each validate a clean snapshot and commit an invalid union (concurrent
-- A→B and B→A: no cycle in either snapshot, cycle in the union). Every
-- mutation locks the group row BEFORE reading, CASes graph_version,
-- validates the COMPLETE desired graph, applies it, and appends the
-- revision — all in this one function, which is one transaction.
--
-- p_edges is the complete desired edge set: [{"from": uuid, "to": uuid}].
-- Fan-out-convergence enforcement arrives with continuous compilation
-- (step 4); this step validates structure: ownership, within-group,
-- no self-edges, acyclic.

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
  v_current_version bigint;
  v_invalid jsonb;
  v_has_cycle boolean;
  v_added jsonb;
  v_removed jsonb;
  v_new_version bigint;
BEGIN
  IF num_nonnulls(p_actor_identity_id, p_actor_user_id) + p_system_actor::int <> 1 THEN
    RETURN jsonb_build_object('success', false, 'reason', 'exactly-one-actor');
  END IF;

  -- Lock BEFORE reading anything about the graph.
  SELECT graph_version INTO v_current_version
  FROM task_groups
  WHERE id = p_task_group_id AND user_id = p_user_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'reason', 'group-not-found');
  END IF;
  IF v_current_version <> p_expected_version THEN
    RETURN jsonb_build_object('success', false, 'reason', 'version-conflict',
      'currentVersion', v_current_version);
  END IF;

  DROP TABLE IF EXISTS _desired_edges;
  CREATE TEMP TABLE _desired_edges ON COMMIT DROP AS
    SELECT DISTINCT (e->>'from')::uuid AS from_task, (e->>'to')::uuid AS to_task
    FROM jsonb_array_elements(coalesce(p_edges, '[]'::jsonb)) e;

  -- Structural validation: self-edges, and endpoints that are not this
  -- user's tasks in this group. Reported explicitly, never partially applied.
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

  WITH RECURSIVE walk(node, path, cyc) AS (
    SELECT e.to_task, ARRAY[e.from_task, e.to_task], false
    FROM _desired_edges e
    UNION ALL
    SELECT e.to_task, w.path || e.to_task, e.to_task = ANY(w.path)
    FROM walk w JOIN _desired_edges e ON e.from_task = w.node
    WHERE NOT w.cyc
  )
  SELECT coalesce(bool_or(cyc), false) INTO v_has_cycle FROM walk;
  IF v_has_cycle THEN
    RETURN jsonb_build_object('success', false, 'reason', 'cycle');
  END IF;

  -- Diff against the group's current stored set (edges are within-group by
  -- construction, so from_task membership identifies the group's edges).
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

  -- Delete-missing + insert-new preserves created_at on surviving edges.
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

  RETURN jsonb_build_object('success', true, 'graphVersion', v_new_version,
    'added', v_added, 'removed', v_removed);
END;
$$;

-- ── Validated conversion: linear → graph ────────────────────────────────
--
-- Preflight, never blind: live blocked_by arrays may hold dangling, self,
-- cross-scope, cross-group, cyclic, or duplicate entries. Conversion
-- deduplicates, reports every invalid entry explicitly, inserts only a
-- fully valid graph, and flips execution_model LAST inside this same
-- transaction. On any failure the group stays linear with its array intact.
-- blocked_by holds BLOCKERS: element b of task t becomes edge b → t.
-- Only not-started/paused groups convert (execution_phase idle|paused);
-- active linear groups finish on the old executor.

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

  WITH RECURSIVE walk(node, path, cyc) AS (
    SELECT c.to_task, ARRAY[c.from_task, c.to_task], false
    FROM _candidate_edges c
    UNION ALL
    SELECT c.to_task, w.path || c.to_task, c.to_task = ANY(w.path)
    FROM walk w JOIN _candidate_edges c ON c.from_task = w.node
    WHERE NOT w.cyc
  )
  SELECT coalesce(bool_or(cyc), false) INTO v_has_cycle FROM walk;
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

REVOKE ALL ON FUNCTION public.apply_task_graph(uuid, uuid, bigint, jsonb, uuid, uuid, boolean, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.apply_task_graph(uuid, uuid, bigint, jsonb, uuid, uuid, boolean, text, text, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_task_graph(uuid, uuid, bigint, jsonb, uuid, uuid, boolean, text, text, text) TO service_role;
REVOKE ALL ON FUNCTION public.convert_task_group_to_graph(uuid, uuid, bigint, uuid, uuid, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.convert_task_group_to_graph(uuid, uuid, bigint, uuid, uuid, boolean) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.convert_task_group_to_graph(uuid, uuid, bigint, uuid, uuid, boolean) TO service_role;
