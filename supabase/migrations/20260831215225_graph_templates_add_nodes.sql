-- Workflow graph, step 4 (partial): node authoring for template constructors
-- (spec: ink://specs/workflow-graph v10 §Templates, §Graph integrity)
--
-- WHY THIS EXISTS
--
-- Until now the graph had no way to CREATE a typed node. `create_task` writes
-- work rows only; `apply_task_graph` rewires edges between nodes that already
-- exist. Every gate in production so far was inserted by hand. A template
-- constructor cannot emit a shape it has no call to build, so the presets in
-- §Templates stayed theoretical.
--
-- `add_graph_nodes` is that call. It is deliberately ADDITIVE — it creates
-- nodes and adds edges, and removes neither:
--
--   * A template instantiating a fresh graph and a mid-flight injection ("we
--     just realised this PR needs a UI review after all") are the same
--     operation with different inputs. One mechanism, not two.
--   * Removal and rewiring stay with `apply_task_graph`, whose complete-
--     desired-edge-set semantics already carry the review history for what it
--     means to take an edge away. Nothing here can silently unwire a graph.
--
-- Nodes are addressed by `node_slug`, so a constructor names its own parts
-- ("sibling-review") without knowing the UUIDs it is about to create, and a
-- re-run of the same template is a no-op rather than a duplicate. Edge
-- endpoints accept a slug or a raw task UUID, because an injection has to
-- attach to nodes that predate the template.
--
-- Obligations inherited from apply_task_graph, deliberately duplicated rather
-- than referenced, because a caller that skipped them would corrupt the graph:
--
--   * serialized per group (row lock BEFORE any read) + graph_version CAS;
--   * acyclicity validated over the UNION of existing and proposed edges —
--     each half can be acyclic while the union is not;
--   * an inbound change to a PASSED gate is refused outright (its verdict is
--     a per-attempt fact downstream may already have consumed);
--   * a non-terminal gate whose inbound set changed gets a fresh window —
--     back to not_ready, dwell cleared, claim released, gate_version bumped
--     so an in-flight verdict CAS-bounces (spec v7);
--   * one revision row per version, carrying constructor provenance.
--
-- Node INSERTs need no executor GUC of their own — enforce_graph_execution_path
-- treats a pending/not_ready insert as authoring. The GUC is set because the
-- gate RESETS below are executor transitions.

CREATE OR REPLACE FUNCTION public.add_graph_nodes(
  p_user_id uuid,
  p_task_group_id uuid,
  p_expected_version bigint,
  p_nodes jsonb,
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
  v_new_version bigint;
  v_invalid jsonb;
  v_has_cycle boolean;
  v_nodes_added jsonb := '[]'::jsonb;
  v_nodes_existing jsonb := '[]'::jsonb;
  v_edges_added jsonb;
  v_passed_gates jsonb;
  v_reset jsonb := '[]'::jsonb;
  v_gate record;
  v_node record;
  v_next_order int;
  v_new_id uuid;
  v_eval jsonb;
BEGIN
  -- Transaction-local; the gate resets below are executor transitions.
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
  IF v_group.status NOT IN ('active', 'paused') THEN
    RETURN jsonb_build_object('success', false, 'reason', 'group-not-active',
      'groupStatus', v_group.status);
  END IF;
  v_current_version := v_group.graph_version;
  IF v_current_version <> p_expected_version THEN
    RETURN jsonb_build_object('success', false, 'reason', 'version-conflict',
      'currentVersion', v_current_version);
  END IF;

  -- ── Node validation ───────────────────────────────────────────────────
  DROP TABLE IF EXISTS _proposed_nodes;
  CREATE TEMP TABLE _proposed_nodes ON COMMIT DROP AS
  SELECT
    ord,
    n ->> 'slug'                         AS slug,
    coalesce(n ->> 'type', 'work')       AS task_type,
    n ->> 'title'                        AS title,
    n ->> 'description'                  AS description,
    coalesce(n ->> 'priority', 'medium') AS priority,
    nullif(n ->> 'assigneeIdentityId', '')::uuid AS assignee_identity_id,
    nullif(n ->> 'assigneeUserId', '')::uuid     AS assignee_user_id,
    n -> 'verification'                  AS verification
  FROM jsonb_array_elements(coalesce(p_nodes, '[]'::jsonb)) WITH ORDINALITY AS t(n, ord);

  SELECT jsonb_agg(jsonb_build_object('slug', slug, 'problem', problem))
  INTO v_invalid
  FROM (
    SELECT slug,
      CASE
        WHEN slug IS NULL OR btrim(slug) = '' THEN 'missing-slug'
        WHEN title IS NULL OR btrim(title) = '' THEN 'missing-title'
        WHEN task_type NOT IN ('work', 'verification') THEN 'bad-type'
        WHEN task_type = 'verification'
             AND (assignee_identity_id IS NULL) = (assignee_user_id IS NULL)
          THEN 'gate-needs-exactly-one-assignee'
        WHEN task_type = 'work'
             AND (assignee_identity_id IS NOT NULL OR assignee_user_id IS NOT NULL
                  OR verification IS NOT NULL)
          THEN 'work-node-carries-gate-fields'
        ELSE NULL
      END AS problem
    FROM _proposed_nodes
  ) checked
  WHERE problem IS NOT NULL;
  IF v_invalid IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'reason', 'invalid-nodes',
      'invalid', v_invalid);
  END IF;

  -- Duplicate slugs WITHIN the request: the unique index would catch this at
  -- insert time as an exception, which aborts the whole transaction instead
  -- of returning a reason the caller can act on.
  SELECT jsonb_agg(dup.slug) INTO v_invalid
  FROM (SELECT slug FROM _proposed_nodes GROUP BY slug HAVING count(*) > 1) dup;
  IF v_invalid IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'reason', 'duplicate-slugs',
      'slugs', v_invalid);
  END IF;

  -- ── Edge resolution, SYMBOLIC — before anything is written ──────────
  --
  -- Validation runs to completion before the first INSERT. A structured
  -- refusal returns normally, which COMMITS whatever the function already
  -- wrote; an early node insert would therefore survive an edge refusal and
  -- leave half a template in the graph (caught by the integration suite).
  --
  -- Nodes are addressed by a KEY that exists whether or not the row does:
  -- its node_slug, falling back to its UUID for rows authored before slugs.
  -- Proposed nodes join the key space unwritten, so an edge may reference a
  -- node this very call is about to create.
  DROP TABLE IF EXISTS _node_keys;
  CREATE TEMP TABLE _node_keys ON COMMIT DROP AS
  SELECT coalesce(t.node_slug, t.id::text) AS key, t.id, t.task_type, t.gate_state
  FROM tasks t
  WHERE t.task_group_id = p_task_group_id AND t.user_id = p_user_id;

  INSERT INTO _node_keys (key, id, task_type, gate_state)
  SELECT p.slug, NULL, p.task_type, NULL
  FROM _proposed_nodes p
  WHERE NOT EXISTS (SELECT 1 FROM _node_keys k WHERE k.key = p.slug);

  -- A reference resolves as a slug first: a slug is scoped to this group, a
  -- UUID that happens to spell one is not this group's business.
  DROP TABLE IF EXISTS _resolved_edges;
  CREATE TEMP TABLE _resolved_edges ON COMMIT DROP AS
  SELECT DISTINCT e ->> 'from' AS from_ref, e ->> 'to' AS to_ref,
         fk.key AS from_key, tk.key AS to_key
  FROM jsonb_array_elements(coalesce(p_edges, '[]'::jsonb)) e
  LEFT JOIN LATERAL (
    SELECT k.key FROM _node_keys k
    WHERE k.key = e ->> 'from' OR k.id::text = e ->> 'from'
    ORDER BY (k.key = e ->> 'from') DESC LIMIT 1
  ) fk ON true
  LEFT JOIN LATERAL (
    SELECT k.key FROM _node_keys k
    WHERE k.key = e ->> 'to' OR k.id::text = e ->> 'to'
    ORDER BY (k.key = e ->> 'to') DESC LIMIT 1
  ) tk ON true;

  SELECT jsonb_agg(jsonb_build_object('from', from_ref, 'to', to_ref,
           'problem',
           CASE WHEN from_key IS NULL OR to_key IS NULL THEN 'unknown-node'
                ELSE 'self' END))
  INTO v_invalid
  FROM _resolved_edges
  WHERE from_key IS NULL OR to_key IS NULL OR from_key = to_key;
  IF v_invalid IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'reason', 'invalid-edges',
      'invalid', v_invalid);
  END IF;

  -- ── Acyclicity over the UNION, in key space ─────────────────────────
  -- Existing edges alone are acyclic and the proposed set alone may be too;
  -- only their union is the graph that will exist.
  DROP TABLE IF EXISTS _union_edges;
  CREATE TEMP TABLE _union_edges ON COMMIT DROP AS
  SELECT from_key, to_key FROM _resolved_edges
  UNION
  SELECT coalesce(fs.node_slug, fs.id::text), coalesce(ts.node_slug, ts.id::text)
  FROM task_edges te
  JOIN tasks fs ON fs.id = te.from_task
  JOIN tasks ts ON ts.id = te.to_task
  WHERE fs.task_group_id = p_task_group_id AND fs.user_id = p_user_id;

  WITH RECURSIVE reach(origin, node) AS (
    SELECT e.from_key, e.to_key FROM _union_edges e
    UNION
    SELECT r.origin, e.to_key
    FROM reach r JOIN _union_edges e ON e.from_key = r.node
  )
  SELECT EXISTS (SELECT 1 FROM reach WHERE origin = node) INTO v_has_cycle;
  IF v_has_cycle THEN
    RETURN jsonb_build_object('success', false, 'reason', 'cycle');
  END IF;

  -- Edges this call actually introduces. An edge touching a node that does
  -- not exist yet is new by construction; between two existing nodes it is
  -- new only if task_edges does not already hold it.
  DROP TABLE IF EXISTS _new_edges;
  CREATE TEMP TABLE _new_edges ON COMMIT DROP AS
  SELECT r.from_key, r.to_key
  FROM _resolved_edges r
  JOIN _node_keys f ON f.key = r.from_key
  JOIN _node_keys t ON t.key = r.to_key
  WHERE f.id IS NULL OR t.id IS NULL
     OR NOT EXISTS (SELECT 1 FROM task_edges te
                    WHERE te.from_task = f.id AND te.to_task = t.id);

  -- A PASSED gate's verdict stands on the inbound set it was decided
  -- against. Adding a premise afterwards would leave a decided gate
  -- standing on evidence for a different graph.
  SELECT jsonb_agg(DISTINCT k.id) INTO v_passed_gates
  FROM _new_edges n
  JOIN _node_keys k ON k.key = n.to_key
  WHERE k.id IS NOT NULL AND k.task_type = 'verification' AND k.gate_state = 'passed';
  IF v_passed_gates IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'reason', 'passed-gate-inbound',
      'gates', v_passed_gates);
  END IF;

  -- ── Writes ────────────────────────────────────────────────────────────
  -- Validation is complete: from here every statement is a write, and the
  -- only remaining exits are success.
  SELECT coalesce(max(task_order), -1) + 1 INTO v_next_order
  FROM tasks WHERE task_group_id = p_task_group_id AND user_id = p_user_id;

  FOR v_node IN SELECT * FROM _proposed_nodes ORDER BY ord LOOP
    SELECT id INTO v_new_id
    FROM tasks
    WHERE task_group_id = p_task_group_id AND user_id = p_user_id
      AND node_slug = v_node.slug;

    IF FOUND THEN
      -- Re-instantiating the same template, or injecting a fragment that
      -- partially landed before. The existing node keeps its config and its
      -- history; only the edges below are reconciled.
      v_nodes_existing := v_nodes_existing || jsonb_build_object(
        'slug', v_node.slug, 'id', v_new_id);
      CONTINUE;
    END IF;

    INSERT INTO tasks (
      user_id, task_group_id, title, description, priority, status,
      task_type, node_slug, assignee_identity_id, assignee_user_id,
      verification, gate_state, task_order, created_by
    ) VALUES (
      p_user_id, p_task_group_id, v_node.title, v_node.description,
      v_node.priority, 'pending',
      v_node.task_type, v_node.slug, v_node.assignee_identity_id,
      v_node.assignee_user_id, v_node.verification,
      CASE WHEN v_node.task_type = 'verification' THEN 'not_ready' ELSE NULL END,
      v_next_order, coalesce(p_constructor, 'graph-template')
    ) RETURNING id INTO v_new_id;

    UPDATE _node_keys SET id = v_new_id WHERE key = v_node.slug;
    v_next_order := v_next_order + 1;
    v_nodes_added := v_nodes_added || jsonb_build_object(
      'slug', v_node.slug, 'id', v_new_id, 'type', v_node.task_type,
      'title', v_node.title);
  END LOOP;

  -- Nothing removed, ever: this call adds.
  INSERT INTO task_edges (from_task, to_task)
  SELECT f.id, t.id
  FROM _resolved_edges r
  JOIN _node_keys f ON f.key = r.from_key
  JOIN _node_keys t ON t.key = r.to_key
  ON CONFLICT (from_task, to_task) DO NOTHING;

  SELECT coalesce(jsonb_agg(jsonb_build_object('from', f.id, 'to', t.id)), '[]'::jsonb)
  INTO v_edges_added
  FROM _new_edges n
  JOIN _node_keys f ON f.key = n.from_key
  JOIN _node_keys t ON t.key = n.to_key;

  -- ── Version, revision, fresh windows ──────────────────────────────────
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
    jsonb_build_object(
      'nodesAdded', v_nodes_added,
      'nodesExisting', v_nodes_existing,
      'edgesAdded', v_edges_added,
      'edgesRemoved', '[]'::jsonb)
  );

  FOR v_gate IN
    SELECT t.id, t.gate_attempt, t.gate_version, t.claimed_by_session_id, t.claim_token
    FROM tasks t
    WHERE t.task_group_id = p_task_group_id
      AND t.user_id = p_user_id
      AND t.task_type = 'verification'
      AND t.gate_state IN ('not_ready', 'open', 'in_progress')
      AND t.id IN (SELECT (e ->> 'to')::uuid FROM jsonb_array_elements(v_edges_added) e)
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

  -- Same as apply_task_graph: a PAUSED group accepts authoring but stays
  -- frozen for execution — evaluating would open gates and start clocks no
  -- session may act on. start_graph_execution sweeps it on resume.
  IF v_group.status = 'active' THEN
    v_eval := _graph_evaluate_group(p_user_id, p_task_group_id);
  END IF;

  RETURN jsonb_build_object('success', true, 'graphVersion', v_new_version,
    'nodesAdded', v_nodes_added, 'nodesExisting', v_nodes_existing,
    'edgesAdded', v_edges_added, 'resetGates', v_reset,
    'evaluation', v_eval, 'evaluationDeferred', v_group.status <> 'active');
END;
$$;

REVOKE ALL ON FUNCTION public.add_graph_nodes(
  uuid, uuid, bigint, jsonb, jsonb, uuid, uuid, boolean, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.add_graph_nodes(
  uuid, uuid, bigint, jsonb, jsonb, uuid, uuid, boolean, text, text, text) TO service_role;

COMMENT ON FUNCTION public.add_graph_nodes(
  uuid, uuid, bigint, jsonb, jsonb, uuid, uuid, boolean, text, text, text) IS
  'Additive graph authoring for template constructors: creates typed nodes by node_slug and adds edges, never removing either. Serialized per group with a graph_version CAS; validates acyclicity over the union of existing and proposed edges; refuses inbound changes to passed gates; grants non-terminal gates a fresh window. Removal and rewiring remain with apply_task_graph.';
