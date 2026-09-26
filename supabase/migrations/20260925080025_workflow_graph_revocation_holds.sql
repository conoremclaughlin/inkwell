-- Workflow graph — revocation, supersession and authority holds.
--
-- Spec: ink://specs/workflow-graph-revocation v10 (v7 approved by Lumen,
-- 5ca4f973), amending ink://specs/workflow-graph v10; required by
-- ink://specs/review-requests v28, whose clearance gate sits in front of a
-- push.
--
-- What v10 could not say: a gate's `passed` was terminal per attempt and
-- retry accepted `failed` only. A publication clearance can be WRONG after it
-- is given (the reviewer withdraws), the candidate can CHANGE after or during
-- review, and a pass already consumed by a publication can never be undone,
-- only recorded against. This migration is the AUTHORITY family of the
-- amendment:
--
--   revoke_gate       passed -> not_ready, attempt+1, SAME binding; the
--                     withdrawal stays unresolved for that binding until a
--                     pass on it or a lift. If the pass was already consumed
--                     the gate FAILS with reason revoked-after-publication and
--                     nothing is undone.
--   supersede_gate    an authorized request change: new binding and author
--                     set, the old attempt invalidated (claims released,
--                     prepared operations invalidated), from any state before
--                     consumption; refused `already-published` after it.
--   lift_withdrawal   the only non-verdict resolution of a withdrawal:
--                     owner or admin, reason required, attributed.
--   holds             loss of authorization is carried by task_authority_holds
--                     WITH PROVENANCE (kind, cause, source gate, attempt,
--                     binding), placed over the source's descendant closure in
--                     the same transaction, released per cause, and consulted
--                     by every dispatch predicate and by group completion.
--                     Re-running the evaluator does not implement this: a
--                     completed bridge still satisfies its own descendants
--                     under SATISFIES (Lumen, 9ec66ab5 §4), so the rule is
--                     explicit and carried by rows, never by a timestamp.
--
-- The publication-operation family (prepare / consume / outcome / dispatch /
-- ingest, resolve_conflict) is the second migration, on its own PR. Its
-- tables are created HERE because a hold can be caused by an operation and
-- because revocation must know whether a pass was consumed. Nothing in this
-- file writes those tables except the invalidation of prepared records, and
-- no dispatch path reads them yet.
--
-- Lock discipline. The executor RPCs of step 2 take the group row FOR SHARE
-- and one task row FOR UPDATE. The authority RPCs here take the GROUP row FOR
-- UPDATE, like apply_task_graph, because placing holds locks every descendant
-- of the source: two revocations with overlapping closures would otherwise
-- lock those rows in different orders (each its own source first, then the
-- closure by id) and could deadlock. FOR UPDATE serializes them against each
-- other and excludes the FOR SHARE RPCs for the duration. Inside, task rows
-- are locked in id order, as the evaluator does.

-- ── The gate's request: binding, author set, request revision ───────────
--
-- A clearance gate decides a specific candidate. The binding (the publication
-- tuple, hashed) and the author set recorded from session identity — never
-- reconstructed from git — live on the gate row as executor-owned columns:
-- authored at INSERT, replaced only by supersede_gate, fenced from every other
-- writer once the group is graph-mode. Ordinary review gates leave them NULL,
-- and every rule below treats a NULL binding as "the same binding" through IS
-- NOT DISTINCT FROM, so revocation works on gates that carry none.

ALTER TABLE public.tasks ADD COLUMN gate_binding jsonb;
ALTER TABLE public.tasks ADD COLUMN gate_binding_hash text;
ALTER TABLE public.tasks ADD COLUMN gate_authors jsonb;
ALTER TABLE public.tasks ADD COLUMN gate_request_revision int NOT NULL DEFAULT 0;
ALTER TABLE public.tasks ADD CONSTRAINT gate_request_on_verification CHECK (
  task_type = 'verification'
  OR (gate_binding IS NULL AND gate_binding_hash IS NULL AND gate_authors IS NULL
      AND gate_request_revision = 0)
);
-- Author sets are validated on the way in: an array of {kind, id} with kind in
-- sb|user and id a UUID. Membership below compares UUID identity, so a
-- mixed-case id recorded by one client still names the same principal
-- (Lumen, PR #678: text equality let an uppercase author pass its own gate).
CREATE OR REPLACE FUNCTION public.graph_authors_valid(p_set jsonb)
RETURNS boolean
LANGUAGE sql IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT p_set IS NULL OR (
    jsonb_typeof(p_set) = 'array'
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_set) a
      WHERE jsonb_typeof(a) <> 'object'
         OR a ->> 'kind' IS NULL OR a ->> 'kind' NOT IN ('sb', 'user')
         OR _graph_safe_uuid(a ->> 'id') IS NULL
    )
  );
$$;
ALTER TABLE public.tasks ADD CONSTRAINT gate_authors_valid CHECK (graph_authors_valid(gate_authors));

-- ── Event kinds ─────────────────────────────────────────────────────────
--
-- The column-level CHECK from step 1 carries the auto-generated name; look it
-- up rather than assume it, so a renamed constraint cannot leave the old list
-- silently in force beside the new one.

DO $$
DECLARE
  v_names text[];
BEGIN
  -- 'retry_requested' appears in the event-kind list and nowhere else;
  -- event_one_actor also names event kinds, so it is excluded by name.
  SELECT array_agg(c.conname) INTO v_names
  FROM pg_constraint c
  WHERE c.conrelid = 'public.task_gate_events'::regclass
    AND c.contype = 'c'
    AND c.conname <> 'event_one_actor'
    AND pg_get_constraintdef(c.oid) LIKE '%retry_requested%';
  IF v_names IS NULL OR array_length(v_names, 1) <> 1 THEN
    RAISE EXCEPTION 'task_gate_events: expected exactly one event CHECK constraint, found %', v_names;
  END IF;
  EXECUTE format('ALTER TABLE public.task_gate_events DROP CONSTRAINT %I', v_names[1]);
END;
$$;

ALTER TABLE public.task_gate_events ADD CONSTRAINT task_gate_events_event_check CHECK (event IN
  ('scheduled', 'opened', 'claimed', 'claim_released', 'claim_reclaimed',
   'passed', 'failed', 'retry_requested', 'reassigned',
   'revoked', 'superseded', 'hold_placed', 'hold_released', 'withdrawal_lifted',
   'exception_published', 'debt_discharged'));

-- Holds and their release are placed by the server inside another actor's
-- transaction; a supersession may be executed by an explicit system actor on
-- a verified request change; an exception's publication is recorded on
-- ingest. Those carry no actor of their own. Everything else keeps the
-- exactly-one-actor rule.
ALTER TABLE public.task_gate_events DROP CONSTRAINT event_one_actor;
ALTER TABLE public.task_gate_events ADD CONSTRAINT event_one_actor CHECK (
  event IN ('scheduled', 'claimed', 'claim_released', 'claim_reclaimed', 'opened',
            'hold_placed', 'hold_released', 'superseded', 'exception_published')
  OR ((actor_identity_id IS NULL) <> (actor_user_id IS NULL))
);

-- A withdrawal is scoped by BINDING, not by attempt: attempt 2 over the same
-- candidate is still that candidate (Lumen, 1e24407b §5). The hash rides on
-- the verdict, revocation and supersession events; a lift names the event it
-- resolves.
ALTER TABLE public.task_gate_events ADD COLUMN binding_hash text;
ALTER TABLE public.task_gate_events ADD COLUMN resolves_event_id uuid
  REFERENCES public.task_gate_events(id);

-- ── Publication operations (schema only here; RPCs in the second PR) ────

CREATE TABLE public.publication_operations (
  id uuid PRIMARY KEY,                                             -- minted by the publisher, journaled locally
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  task_group_id uuid REFERENCES public.task_groups(id),            -- nullable: no-request / cancelled cases still ingest
  gate_task_id uuid REFERENCES public.tasks(id),
  gate_attempt int,
  publish_task_id uuid REFERENCES public.tasks(id),
  binding jsonb NOT NULL,                                          -- repo, url, ref, old, new, object-set hash, tuple hash
  policy_ref jsonb NOT NULL,                                       -- trusted source, object id, version
  authority text NOT NULL CHECK (authority IN ('clearance', 'exception')),
  authority_event_id uuid REFERENCES public.task_gate_events(id),  -- the passed verdict, for clearance
  authorizer_identity_id uuid REFERENCES public.agent_identities(id),
  authorizer_user_id uuid REFERENCES public.users(id),             -- exactly one authorizer; never in the author set
  executor_session_id uuid REFERENCES public.sessions(id),
  executor_identity_id uuid REFERENCES public.agent_identities(id),
  reason text,                                                     -- required for exception
  execution_modes text[] NOT NULL DEFAULT '{online-only}',         -- authorization terms, never rewritten
  accepts_unverified_server_state boolean NOT NULL DEFAULT false,
  intent_hash text NOT NULL,
  prepared_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT op_one_authorizer CHECK ((authorizer_identity_id IS NULL) <> (authorizer_user_id IS NULL)),
  CONSTRAINT op_exception_reason CHECK (authority <> 'exception' OR reason IS NOT NULL),
  CONSTRAINT op_offline_needs_acceptance CHECK (
    NOT ('offline-permitted' = ANY (execution_modes)) OR accepts_unverified_server_state),
  -- v10 (Conor, 25 Sep): the offline opt-in exists on exception operations
  -- only. A clearance IS the live check; it is never consumed offline.
  CONSTRAINT op_offline_is_exception CHECK (
    NOT ('offline-permitted' = ANY (execution_modes)) OR authority = 'exception')
);
CREATE INDEX publication_operations_gate_idx
  ON public.publication_operations (gate_task_id, gate_attempt);
CREATE INDEX publication_operations_publish_idx
  ON public.publication_operations (publish_task_id);

CREATE TABLE public.publication_operation_events (                 -- append-only, sequenced
  operation_id uuid NOT NULL REFERENCES public.publication_operations(id) ON DELETE CASCADE,
  seq int NOT NULL,
  phase text NOT NULL CHECK (phase IN ('prepared', 'consumed', 'outcome', 'invalidated', 'conflict_resolved')),
  connectivity text CHECK (connectivity IN ('online', 'offline')),                -- on consumed
  server_state_verified boolean,                                                 -- on consumed
  server_watermark jsonb,                                                        -- on consumed: gate_version + event seq last verified
  exposure text CHECK (exposure IN ('none', 'unknown', 'sent')),                  -- on outcome
  refs text CHECK (refs IN ('none', 'partial', 'all', 'rejected', 'unknown')),    -- on outcome
  source text NOT NULL CHECK (source IN ('online', 'journal')),
  actor_identity_id uuid REFERENCES public.agent_identities(id),                 -- on conflict_resolved: exactly one
  actor_user_id uuid REFERENCES public.users(id),
  evidence jsonb,
  observed_at timestamptz NOT NULL,
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (operation_id, seq)
);

CREATE TABLE public.observation_conflicts (                        -- retained, never merged
  operation_id uuid NOT NULL REFERENCES public.publication_operations(id) ON DELETE CASCADE,
  seq int NOT NULL,
  conflicting jsonb NOT NULL,
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (operation_id, seq)
);

-- ── Holds with provenance ───────────────────────────────────────────────

CREATE TABLE public.task_authority_holds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES public.tasks(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('authority-withdrawn', 'publication-unconfirmed', 'observation-conflict')),
  cause_event_id uuid REFERENCES public.task_gate_events(id),
  cause_operation_id uuid REFERENCES public.publication_operations(id),
  source_gate_id uuid REFERENCES public.tasks(id),
  source_attempt int,
  binding_hash text,
  placed_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  released_by jsonb,                                               -- gate event id, or operation event (id, seq)
  CONSTRAINT hold_one_cause CHECK ((cause_event_id IS NULL) <> (cause_operation_id IS NULL))
);
CREATE INDEX task_authority_holds_open_idx
  ON public.task_authority_holds (task_id) WHERE released_at IS NULL;
CREATE INDEX task_authority_holds_source_idx
  ON public.task_authority_holds (source_gate_id) WHERE released_at IS NULL;
CREATE INDEX task_authority_holds_cause_event_idx
  ON public.task_authority_holds (cause_event_id) WHERE released_at IS NULL;

ALTER TABLE public.publication_operations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access to publication_operations"
  ON public.publication_operations USING (true) WITH CHECK (true);
ALTER TABLE public.publication_operation_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access to publication_operation_events"
  ON public.publication_operation_events USING (true) WITH CHECK (true);
ALTER TABLE public.observation_conflicts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access to observation_conflicts"
  ON public.observation_conflicts USING (true) WITH CHECK (true);
ALTER TABLE public.task_authority_holds ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access to task_authority_holds"
  ON public.task_authority_holds USING (true) WITH CHECK (true);

-- ── Predicates ──────────────────────────────────────────────────────────

-- A node dispatches only when it carries no unreleased hold (spec §Holds).
CREATE OR REPLACE FUNCTION public.graph_hold_blocks(p_task_id uuid)
RETURNS boolean
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM task_authority_holds h
    WHERE h.task_id = p_task_id AND h.released_at IS NULL
  );
$$;

-- "A source carrying an unreleased hold does not satisfy new dispatch" (spec
-- §Interaction with v10 rules). Holds are placed over the closure that exists
-- when authority is lost; a node attached to a held completed source AFTER
-- that has no hold of its own, and SATISFIES alone would ready it (Lumen,
-- PR #678). So readiness reads the inbound set through this predicate: every
-- source satisfies AND no source is held.
CREATE OR REPLACE FUNCTION public.graph_inbound_blocked(p_task_id uuid)
RETURNS boolean
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM task_edges e JOIN tasks s ON s.id = e.from_task
    WHERE e.to_task = p_task_id
      AND (NOT graph_satisfies(s.task_type, s.status, s.gate_state)
           OR graph_hold_blocks(s.id))
  );
$$;

-- Principal membership in a recorded set of {kind: 'sb'|'user', id}, by UUID
-- identity: the recorded text is parsed, never compared as text.
CREATE OR REPLACE FUNCTION public.graph_principal_in(
  p_set jsonb, p_identity_id uuid, p_user_id uuid
) RETURNS boolean
LANGUAGE sql IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT p_set IS NOT NULL AND jsonb_typeof(p_set) = 'array' AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_set) a
    WHERE (p_identity_id IS NOT NULL AND a ->> 'kind' = 'sb'
           AND _graph_safe_uuid(a ->> 'id') = p_identity_id)
       OR (p_user_id IS NOT NULL AND a ->> 'kind' = 'user'
           AND _graph_safe_uuid(a ->> 'id') = p_user_id)
  );
$$;

-- The withdrawals and failures of a gate that are still unresolved FOR A
-- BINDING: a revoked or failed verdict event with that binding, not lifted,
-- and not followed by a passed verdict on the same binding. An automatic new
-- attempt never resolves one (spec §Eligibility; cases 18–19). The second PR's
-- force refuses on a non-empty result; supersession and retry leave it alone.
CREATE OR REPLACE FUNCTION public.graph_unresolved_withdrawals(
  p_task_id uuid, p_binding_hash text
) RETURNS SETOF uuid
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $$
  SELECT w.id
  FROM task_gate_events w
  WHERE w.task_id = p_task_id
    AND w.event IN ('revoked', 'failed')
    AND w.binding_hash IS NOT DISTINCT FROM p_binding_hash
    AND NOT EXISTS (
      SELECT 1 FROM task_gate_events l
      WHERE l.task_id = p_task_id AND l.event = 'withdrawal_lifted'
        AND l.resolves_event_id = w.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM task_gate_events p
      WHERE p.task_id = p_task_id AND p.event = 'passed'
        AND p.binding_hash IS NOT DISTINCT FROM p_binding_hash
        -- "Later" by the gate's own revision, never by wall clock: every
        -- event carries the gate_version it was written at, and a pass that
        -- resolves a withdrawal is always at a higher one (the withdrawal
        -- bumps the version; the re-open bumps it again).
        AND p.gate_version > w.gate_version
    );
$$;

-- Every descendant of a node over task_edges: deduplicating reachability,
-- V²-bounded, never path enumeration (the step-1 lesson).
CREATE OR REPLACE FUNCTION public._graph_descendants(p_task_id uuid)
RETURNS SETOF uuid
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $$
  WITH RECURSIVE reach(node) AS (
    SELECT e.to_task FROM task_edges e WHERE e.from_task = p_task_id
    UNION
    SELECT e.to_task FROM reach r JOIN task_edges e ON e.from_task = r.node
  )
  SELECT node FROM reach;
$$;

-- Every ancestor of a node over task_edges: the same deduplicating
-- reachability, upstream.
CREATE OR REPLACE FUNCTION public._graph_ancestors(p_task_id uuid)
RETURNS SETOF uuid
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $$
  WITH RECURSIVE up(node) AS (
    SELECT e.from_task FROM task_edges e WHERE e.to_task = p_task_id
    UNION
    SELECT e.from_task FROM up r JOIN task_edges e ON e.to_task = r.node
  )
  SELECT node FROM up;
$$;

-- The phase of an operation is a projection of its events, never a column.
CREATE OR REPLACE FUNCTION public._publication_operation_phase(p_operation_id uuid)
RETURNS text
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $$
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM publication_operation_events e
                 WHERE e.operation_id = p_operation_id AND e.phase = 'invalidated') THEN 'invalidated'
    WHEN EXISTS (SELECT 1 FROM publication_operation_events e
                 WHERE e.operation_id = p_operation_id AND e.phase = 'consumed') THEN 'consumed'
    ELSE 'prepared'
  END;
$$;

-- Was any operation on this gate attempt consumed? Before consumption a pass
-- can be withdrawn cleanly; after it the transfer may have happened.
CREATE OR REPLACE FUNCTION public._graph_gate_consumed(p_gate_task_id uuid, p_attempt int)
RETURNS boolean
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM publication_operations o
    WHERE o.gate_task_id = p_gate_task_id
      AND (p_attempt IS NULL OR o.gate_attempt = p_attempt)
      AND _publication_operation_phase(o.id) = 'consumed'
  );
$$;

-- A claim released by a hold or a supersession bounces the holder's late
-- completion or verdict with the cause, not a bare claim-mismatch (spec
-- §Holds table). Read from the event that released it.
CREATE OR REPLACE FUNCTION public._graph_claim_bounce_reason(p_task_id uuid, p_claim_token uuid)
RETURNS text
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $$
  SELECT coalesce((
    SELECT e.reason FROM task_gate_events e
    WHERE e.task_id = p_task_id AND p_claim_token IS NOT NULL
      AND e.claim_token = p_claim_token AND e.event = 'claim_released'
      AND e.reason IN ('upstream-revoked', 'superseded')
    ORDER BY e.created_at DESC LIMIT 1
  ), 'claim-mismatch');
$$;

-- Who may withdraw a pass (spec §Revocation — enumerated, scoped, validated):
-- the verdict actor of the attempt, the current assignee, any recorded author
-- of the candidate, the group's owner, or an owner/admin of one of the owner's
-- workspaces. Returns which, or NULL. It confers nothing else.
CREATE OR REPLACE FUNCTION public._graph_revocation_authority(
  p_task_id uuid, p_attempt int, p_group_user_id uuid,
  p_assignee_identity_id uuid, p_assignee_user_id uuid, p_authors jsonb,
  p_actor_identity_id uuid, p_actor_user_id uuid
) RETURNS text
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $$
  SELECT CASE
    WHEN p_actor_user_id IS NOT NULL AND p_actor_user_id = p_group_user_id THEN 'owner'
    WHEN EXISTS (
      SELECT 1 FROM task_gate_events e
      WHERE e.task_id = p_task_id AND e.attempt = p_attempt AND e.event = 'passed'
        AND ((p_actor_identity_id IS NOT NULL AND e.actor_identity_id = p_actor_identity_id)
          OR (p_actor_user_id IS NOT NULL AND e.actor_user_id = p_actor_user_id))
    ) THEN 'verdict-actor'
    WHEN (p_actor_identity_id IS NOT NULL AND p_actor_identity_id = p_assignee_identity_id)
      OR (p_actor_user_id IS NOT NULL AND p_actor_user_id = p_assignee_user_id) THEN 'assignee'
    WHEN graph_principal_in(p_authors, p_actor_identity_id, p_actor_user_id) THEN 'author'
    WHEN p_actor_user_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM workspace_members wm JOIN workspaces w ON w.id = wm.workspace_id
      WHERE w.user_id = p_group_user_id AND wm.user_id = p_actor_user_id
        AND wm.role IN ('owner', 'admin')
    ) THEN 'admin'
    ELSE NULL
  END;
$$;

CREATE OR REPLACE FUNCTION public._graph_owner_or_admin(p_group_user_id uuid, p_actor_user_id uuid)
RETURNS boolean
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $$
  SELECT p_actor_user_id IS NOT NULL AND (
    p_actor_user_id = p_group_user_id
    OR EXISTS (
      SELECT 1 FROM workspace_members wm JOIN workspaces w ON w.id = wm.workspace_id
      WHERE w.user_id = p_group_user_id AND wm.user_id = p_actor_user_id
        AND wm.role IN ('owner', 'admin')
    )
  );
$$;

-- Who may change a gate's request (spec §Supersession): the initiating
-- principal — a recorded author of the candidate, the group's owner, an
-- owner/admin of the owner's workspaces — or an explicit system actor on a
-- verified request change. Never the reviewer whose stale result exposed a
-- mismatch: the assignee as such has no supersession authority.
CREATE OR REPLACE FUNCTION public._graph_supersession_authority(
  p_group_user_id uuid, p_authors jsonb,
  p_actor_identity_id uuid, p_actor_user_id uuid, p_system_actor boolean
) RETURNS text
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $$
  SELECT CASE
    WHEN p_system_actor THEN 'system'
    WHEN graph_principal_in(p_authors, p_actor_identity_id, p_actor_user_id) THEN 'author'
    WHEN _graph_owner_or_admin(p_group_user_id, p_actor_user_id) THEN
      CASE WHEN p_actor_user_id = p_group_user_id THEN 'owner' ELSE 'admin' END
    ELSE NULL
  END;
$$;


-- ── Hold placement and release ──────────────────────────────────────────

-- A prepared-but-unconsumed operation on a node whose authority was lost is
-- invalidated: an `invalidated` phase event, never a deleted row. Nothing
-- consumed is touched (spec §Consumption: after it, the outcome is recorded).
CREATE OR REPLACE FUNCTION public._graph_invalidate_prepared_operations(
  p_user_id uuid, p_task_id uuid, p_reason text
) RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_op record;
  v_count int := 0;
BEGIN
  FOR v_op IN
    SELECT o.id FROM publication_operations o
    WHERE o.user_id = p_user_id
      AND (o.gate_task_id = p_task_id OR o.publish_task_id = p_task_id)
      AND _publication_operation_phase(o.id) = 'prepared'
    ORDER BY o.id
    FOR UPDATE
  LOOP
    INSERT INTO publication_operation_events (operation_id, seq, phase, source, evidence, observed_at)
    SELECT v_op.id, coalesce(max(e.seq), 0) + 1, 'invalidated', 'online',
           jsonb_build_object('reason', p_reason, 'taskId', p_task_id), now()
    FROM publication_operation_events e WHERE e.operation_id = v_op.id;
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
$$;

-- Place one hold of kind p_kind on every node of the closure (the source's
-- descendants, plus the source itself when asked), recording provenance, and
-- apply the spec's per-state effect in the same transaction:
--   not_ready / pending          hold only (dwell cleared so the window is
--                                fresh when the hold lifts)
--   open gate                    not_ready, fresh dwell, gate_version+1
--   claimed work or gate         claim released (reason upstream-revoked),
--                                token fenced, prepared operations invalidated
--   completed work / passed gate immutable; hold only
--   failed gate, failed/skipped/archived work: unchanged, no hold
-- Idempotent per (node, cause). Caller holds the group row FOR UPDATE; rows
-- are locked in id order.
CREATE OR REPLACE FUNCTION public._graph_place_holds(
  p_user_id uuid,
  p_task_group_id uuid,
  p_source_task_id uuid,
  p_include_source boolean,
  p_kind text,
  p_cause_event_id uuid,
  p_cause_operation_id uuid,
  p_source_gate_id uuid,
  p_source_attempt int,
  p_binding_hash text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_node record;
  v_hold_id uuid;
  v_new_version bigint;
  v_released boolean;
  v_placed jsonb := '[]'::jsonb;
BEGIN
  FOR v_node IN
    SELECT t.*
    FROM tasks t
    WHERE t.task_group_id = p_task_group_id
      AND t.user_id = p_user_id
      AND (t.id IN (SELECT _graph_descendants(p_source_task_id))
           OR (p_include_source AND t.id = p_source_task_id))
    ORDER BY t.id
    FOR UPDATE
  LOOP
    IF (v_node.task_type = 'verification' AND v_node.gate_state = 'failed')
       OR (v_node.task_type = 'work'
           AND (v_node.status = 'archived'
                OR (v_node.status = 'blocked' AND v_node.outcome IN ('failed', 'skipped')))) THEN
      CONTINUE;
    END IF;
    -- One hold per (node, cause): a node already holding this cause — a
    -- closure member reached again through a newly inserted edge — is
    -- left as it is.
    IF EXISTS (
      SELECT 1 FROM task_authority_holds h
      WHERE h.task_id = v_node.id AND h.released_at IS NULL
        AND h.cause_event_id IS NOT DISTINCT FROM p_cause_event_id
        AND h.cause_operation_id IS NOT DISTINCT FROM p_cause_operation_id
    ) THEN
      CONTINUE;
    END IF;

    INSERT INTO task_authority_holds (task_id, kind, cause_event_id, cause_operation_id,
                                      source_gate_id, source_attempt, binding_hash)
    VALUES (v_node.id, p_kind, p_cause_event_id, p_cause_operation_id,
            p_source_gate_id, p_source_attempt, p_binding_hash)
    RETURNING id INTO v_hold_id;

    v_released := false;
    v_new_version := v_node.gate_version;
    IF v_node.claimed_by_session_id IS NOT NULL THEN
      v_released := true;
      IF v_node.task_type = 'verification' THEN
        v_new_version := v_node.gate_version + 1;
      END IF;
      INSERT INTO task_gate_events (user_id, task_id, event, attempt, gate_version,
                                    session_id, claim_token, reason)
      VALUES (p_user_id, v_node.id, 'claim_released', v_node.gate_attempt, v_new_version,
              v_node.claimed_by_session_id, v_node.claim_token, 'upstream-revoked');
      PERFORM _graph_invalidate_prepared_operations(p_user_id, v_node.id, 'upstream-revoked');
    END IF;

    IF v_node.task_type = 'verification' AND v_node.gate_state IN ('open', 'in_progress') THEN
      v_new_version := v_node.gate_version + 1;
      UPDATE tasks SET
        gate_state = 'not_ready',
        gate_version = v_new_version,
        gate_opened_at = NULL,
        dwell_started_at = NULL,
        eligible_at = NULL,
        status = 'pending',
        claimed_by_session_id = NULL,
        claim_token = NULL,
        claimed_at = NULL
      WHERE id = v_node.id;
    ELSIF v_node.task_type = 'verification' AND v_node.gate_state = 'not_ready' THEN
      UPDATE tasks SET dwell_started_at = NULL, eligible_at = NULL WHERE id = v_node.id;
    ELSIF v_released THEN
      UPDATE tasks SET
        status = 'pending',
        claimed_by_session_id = NULL,
        claim_token = NULL,
        claimed_at = NULL
      WHERE id = v_node.id;
    END IF;

    INSERT INTO task_gate_events (user_id, task_id, event, attempt, gate_version, reason, evidence)
    VALUES (p_user_id, v_node.id, 'hold_placed', v_node.gate_attempt, v_new_version, p_kind,
            jsonb_build_object('holdId', v_hold_id, 'kind', p_kind,
                               'sourceGateId', p_source_gate_id, 'sourceAttempt', p_source_attempt,
                               'bindingHash', p_binding_hash,
                               'causeEventId', p_cause_event_id,
                               'causeOperationId', p_cause_operation_id,
                               'claimReleased', v_released));
    v_placed := v_placed || jsonb_build_object('taskId', v_node.id, 'holdId', v_hold_id,
                                               'claimReleased', v_released);
  END LOOP;
  RETURN v_placed;
END;
$$;

-- Release the named holds (those still open), one `hold_released` event per
-- node. Which holds to release is the caller's decision, per cause: a pass on
-- the source gate for the same binding, a lift of the withdrawal that placed
-- them, or (second PR) a confirming outcome or an attributed conflict
-- resolution. Releasing never rewrites a completed fact.
CREATE OR REPLACE FUNCTION public._graph_release_holds(
  p_user_id uuid, p_hold_ids uuid[], p_released_by jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_hold record;
  v_released jsonb := '[]'::jsonb;
BEGIN
  FOR v_hold IN
    SELECT h.id, h.task_id, h.kind, h.source_gate_id, h.source_attempt,
           t.gate_attempt, t.gate_version
    FROM task_authority_holds h
    JOIN tasks t ON t.id = h.task_id
    WHERE h.id = ANY (p_hold_ids) AND h.released_at IS NULL AND t.user_id = p_user_id
    ORDER BY h.task_id, h.id
    FOR UPDATE OF h
  LOOP
    UPDATE task_authority_holds SET released_at = now(), released_by = p_released_by
    WHERE id = v_hold.id;
    INSERT INTO task_gate_events (user_id, task_id, event, attempt, gate_version, reason, evidence)
    VALUES (p_user_id, v_hold.task_id, 'hold_released', v_hold.gate_attempt, v_hold.gate_version,
            v_hold.kind,
            jsonb_build_object('holdId', v_hold.id, 'kind', v_hold.kind,
                               'sourceGateId', v_hold.source_gate_id,
                               'sourceAttempt', v_hold.source_attempt,
                               'releasedBy', p_released_by));
    v_released := v_released || jsonb_build_object('taskId', v_hold.task_id, 'holdId', v_hold.id);
  END LOOP;
  RETURN v_released;
END;
$$;

-- ── The evaluator, amended: held nodes never dispatch, held groups never complete

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
  v_held jsonb;
  v_group_complete boolean;
  v_counts record;
BEGIN
  -- Mark this transaction as the executor path (see
  -- enforce_graph_execution_path): transaction-local, resets at commit.
  PERFORM set_config('app.graph_executor', 'on', true);
  -- Gate transitions, id order (see lock discipline). A gate under an
  -- unreleased hold stays not_ready: no dwell stamp, no opening, no clock.
  FOR v_gate IN
    SELECT t.id, t.title, t.gate_attempt, t.gate_version,
           t.dwell_started_at, t.eligible_at, t.verification,
           t.assignee_identity_id, t.assignee_user_id
    FROM tasks t
    WHERE t.task_group_id = p_task_group_id
      AND t.user_id = p_user_id
      AND t.task_type = 'verification'
      AND t.gate_state = 'not_ready'
      AND NOT graph_hold_blocks(t.id)
      AND NOT graph_inbound_blocked(t.id)
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

  -- Ready work: pending, unclaimed, unheld, every inbound source satisfying
  -- and none of them held. A held completed source still "satisfies" under
  -- SATISFIES; its descendants in the closure carry their own holds, and a
  -- descendant attached later is caught by the source's hold.
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'id', w.id, 'title', w.title,
           'assigneeIdentityId', w.assignee_identity_id,
           'assigneeUserId', w.assignee_user_id) ORDER BY w.id), '[]'::jsonb)
  INTO v_ready_work
  FROM tasks w
  WHERE w.task_group_id = p_task_group_id AND w.user_id = p_user_id
    AND w.task_type = 'work' AND w.status = 'pending'
    AND w.claimed_by_session_id IS NULL
    AND NOT graph_hold_blocks(w.id)
    AND NOT graph_inbound_blocked(w.id);

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

  -- Held nodes, with every unreleased hold's provenance: what lost authority
  -- and why, so the incident surface and the canvas can say so by name.
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'id', hn.id, 'title', hn.title, 'holds', hn.holds) ORDER BY hn.id), '[]'::jsonb)
  INTO v_held
  FROM (
    SELECT t.id, t.title,
           jsonb_agg(jsonb_build_object(
             'id', h.id, 'kind', h.kind,
             'sourceGateId', h.source_gate_id, 'sourceAttempt', h.source_attempt,
             'bindingHash', h.binding_hash,
             'causeEventId', h.cause_event_id, 'causeOperationId', h.cause_operation_id,
             'placedAt', h.placed_at) ORDER BY h.placed_at, h.id) AS holds
    FROM tasks t
    JOIN task_authority_holds h ON h.task_id = t.id AND h.released_at IS NULL
    WHERE t.task_group_id = p_task_group_id AND t.user_id = p_user_id
    GROUP BY t.id, t.title
  ) hn;

  SELECT count(*) FILTER (WHERE NOT (t.status IN ('completed', 'archived')
                                     OR (t.status = 'blocked' AND t.outcome IS NOT NULL))) AS open_count,
         count(*) FILTER (WHERE t.task_type = 'verification'
                            AND t.gate_state IS DISTINCT FROM 'passed') AS unpassed_gates,
         count(*) FILTER (WHERE graph_hold_blocks(t.id)) AS held,
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
  -- The group cannot complete while any hold stands (spec §Holds), which is
  -- also the invariant for an unresolved operation conflict on a publish node
  -- with no descendants (Lumen, 5ca4f973; case 24d).
  v_group_complete := v_counts.open_count = 0 AND v_counts.unpassed_gates = 0
    AND v_counts.held = 0 AND v_counts.total > 0;

  RETURN jsonb_build_object(
    'readyWork', v_ready_work,
    'openedGates', v_opened,
    'openGates', v_open_gates,
    'scheduledGates', v_scheduled,
    'dependencyFailures', v_dep_failures,
    'heldNodes', v_held,
    'groupComplete', v_group_complete,
    'counts', jsonb_build_object(
      'total', v_counts.total, 'completed', v_counts.completed,
      'failed', v_counts.failed, 'skipped', v_counts.skipped,
      'held', v_counts.held)
  );
END;
$$;

-- ── claim_graph_task, amended: a held node is not claimable ─────────────

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

  -- Dispatch is allowed only when the node carries no unreleased hold (spec
  -- §Holds): authority upstream was withdrawn, or a publication it depends
  -- on is unconfirmed or contradicted. Checked before readiness so the
  -- refusal names the cause rather than a stale "not ready".
  IF graph_hold_blocks(p_task_id) THEN
    RETURN jsonb_build_object('success', false, 'reason', 'held');
  END IF;

  IF v_task.task_type = 'work' THEN
    IF v_task.status <> 'pending' THEN
      RETURN jsonb_build_object('success', false, 'reason', 'not-claimable',
        'status', v_task.status);
    END IF;
    IF graph_inbound_blocked(p_task_id) THEN
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

-- ── complete_graph_task, amended: a fenced token bounces with its cause ─

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
    -- A token fenced by a hold or a supersession bounces with that cause.
    RETURN jsonb_build_object('success', false,
      'reason', _graph_claim_bounce_reason(p_task_id, p_claim_token));
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

-- ── record_gate_verdict, amended ────────────────────────────────────────
--
-- Three additions, none of which changes a verdict that was legal before:
--   1. the actor must not be in the gate's recorded author set (Review
--      Requests §e: reviewer ∉ authors; verified here, not only at authoring)
--   2. evidence that names a binding must name the gate's CURRENT binding —
--      a late verdict for candidate A never decides candidate B
--      (`binding-mismatch`, no mutation; case 5)
--   3. a PASS releases every authority-withdrawn hold this gate's withdrawal
--      placed for the same binding (spec §Release), and the verdict event
--      records the binding it decided.
-- The signature gains a trailing optional parameter, so the old overload is
-- dropped first: two overloads would leave PostgREST unable to choose.

DROP FUNCTION public.record_gate_verdict(uuid, uuid, text, int, bigint, uuid, uuid, uuid, uuid, jsonb, text);

CREATE FUNCTION public.record_gate_verdict(
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
  p_reason text DEFAULT NULL,
  p_binding_hash text DEFAULT NULL
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
  v_event_id uuid;
  v_hold_ids uuid[];
  v_released jsonb := '[]'::jsonb;
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
  IF graph_inbound_blocked(p_task_id) THEN
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
  -- Evidence about a candidate decides only that candidate.
  IF p_binding_hash IS NOT NULL AND p_binding_hash IS DISTINCT FROM v_task.gate_binding_hash THEN
    RETURN jsonb_build_object('success', false, 'reason', 'binding-mismatch',
      'currentBindingHash', v_task.gate_binding_hash);
  END IF;
  -- Reviewer ∉ authors, checked against the set recorded at request time.
  IF graph_principal_in(v_task.gate_authors, p_actor_identity_id, p_actor_user_id) THEN
    RETURN jsonb_build_object('success', false, 'reason', 'actor-is-author');
  END IF;

  IF v_task.claimed_by_session_id IS NOT NULL THEN
    IF v_task.claimed_by_session_id IS DISTINCT FROM p_session_id
       OR v_task.claim_token IS DISTINCT FROM p_claim_token THEN
      RETURN jsonb_build_object('success', false,
        'reason', _graph_claim_bounce_reason(p_task_id, p_claim_token));
    END IF;
  ELSE
    -- A token the caller still holds may have been fenced by a hold or a
    -- supersession: say so rather than "not-assignee".
    IF p_claim_token IS NOT NULL
       AND _graph_claim_bounce_reason(p_task_id, p_claim_token) <> 'claim-mismatch' THEN
      RETURN jsonb_build_object('success', false,
        'reason', _graph_claim_bounce_reason(p_task_id, p_claim_token));
    END IF;
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
                                evidence, reason, binding_hash)
  VALUES (p_user_id, p_task_id, p_verdict, v_task.gate_attempt, v_new_version,
          p_session_id, p_claim_token,
          p_actor_identity_id, p_actor_user_id,
          v_task.assignee_identity_id, v_task.assignee_user_id,
          p_evidence, p_reason, v_task.gate_binding_hash)
  RETURNING id INTO v_event_id;

  -- A pass on the same binding releases the holds this gate's withdrawal
  -- placed — and only those: another gate's holds on the same nodes stand
  -- until that gate passes too (case 17, both orders).
  IF p_verdict = 'passed' THEN
    SELECT array_agg(h.id) INTO v_hold_ids
    FROM task_authority_holds h
    JOIN tasks t ON t.id = h.task_id
    WHERE h.source_gate_id = p_task_id
      AND h.kind = 'authority-withdrawn'
      AND h.binding_hash IS NOT DISTINCT FROM v_task.gate_binding_hash
      AND h.released_at IS NULL
      AND t.task_group_id = v_group_id;
    IF v_hold_ids IS NOT NULL THEN
      v_released := _graph_release_holds(p_user_id, v_hold_ids,
        jsonb_build_object('gateEventId', v_event_id, 'event', 'passed'));
    END IF;
  END IF;

  v_eval := _graph_evaluate_group(p_user_id, v_task.task_group_id);

  RETURN jsonb_build_object('success', true, 'verdict', p_verdict,
    'taskId', p_task_id, 'attempt', v_task.gate_attempt,
    'gateVersion', v_new_version, 'eventId', v_event_id,
    'releasedHolds', v_released, 'evaluation', v_eval);
END;
$$;

-- ── revoke_gate ─────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.revoke_gate(
  p_user_id uuid,
  p_task_id uuid,
  p_expected_attempt int,
  p_expected_gate_version bigint,
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
  v_authority text;
  v_consumed boolean;
  v_event_id uuid;
  v_new_version bigint;
  v_holds jsonb;
  v_eval jsonb;
BEGIN
  PERFORM set_config('app.graph_executor', 'on', true);
  IF num_nonnulls(p_actor_identity_id, p_actor_user_id) <> 1 THEN
    RETURN jsonb_build_object('success', false, 'reason', 'exactly-one-actor');
  END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RETURN jsonb_build_object('success', false, 'reason', 'reason-required');
  END IF;

  -- GROUP (FOR UPDATE — hold placement locks the closure) before TASK.
  SELECT task_group_id INTO v_group_id FROM tasks
  WHERE id = p_task_id AND user_id = p_user_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'reason', 'task-not-found');
  END IF;
  IF v_group_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'reason', 'not-graph-mode');
  END IF;
  SELECT execution_model, status, user_id INTO v_group
  FROM task_groups WHERE id = v_group_id
  FOR UPDATE;
  IF NOT FOUND OR v_group.execution_model <> 'graph' THEN
    RETURN jsonb_build_object('success', false, 'reason', 'not-graph-mode');
  END IF;
  -- Terminal groups are immutable: a later discovery about a finished
  -- publication is a linked incident workflow, never a reopened group
  -- (spec §Terminal groups). This refusal is not the end of that path.
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
  IF v_task.gate_state <> 'passed' THEN
    RETURN jsonb_build_object('success', false, 'reason', 'not-passed',
      'gateState', v_task.gate_state);
  END IF;
  IF v_task.gate_attempt <> p_expected_attempt THEN
    RETURN jsonb_build_object('success', false, 'reason', 'attempt-conflict',
      'currentAttempt', v_task.gate_attempt);
  END IF;
  IF v_task.gate_version <> p_expected_gate_version THEN
    RETURN jsonb_build_object('success', false, 'reason', 'version-conflict',
      'currentGateVersion', v_task.gate_version);
  END IF;

  v_authority := _graph_revocation_authority(
    p_task_id, v_task.gate_attempt, v_group.user_id,
    v_task.assignee_identity_id, v_task.assignee_user_id, v_task.gate_authors,
    p_actor_identity_id, p_actor_user_id);
  IF v_authority IS NULL THEN
    RETURN jsonb_build_object('success', false, 'reason', 'not-authorized');
  END IF;

  v_consumed := _graph_gate_consumed(p_task_id, v_task.gate_attempt);
  v_new_version := v_task.gate_version + 1;

  -- The withdrawal, on the record: exactly one actor, reason required, the
  -- binding it withdraws authority over.
  INSERT INTO task_gate_events (user_id, task_id, event, attempt, gate_version,
                                actor_identity_id, actor_user_id,
                                assignee_identity_id, assignee_user_id,
                                reason, binding_hash, evidence)
  VALUES (p_user_id, p_task_id, 'revoked', v_task.gate_attempt, v_new_version,
          p_actor_identity_id, p_actor_user_id,
          v_task.assignee_identity_id, v_task.assignee_user_id,
          p_reason, v_task.gate_binding_hash,
          jsonb_build_object('authority', v_authority, 'afterConsumption', v_consumed))
  RETURNING id INTO v_event_id;

  -- Prepared operations under the withdrawn pass never enable a later push.
  PERFORM _graph_invalidate_prepared_operations(p_user_id, p_task_id, 'revoked');

  IF v_consumed THEN
    -- The pass has already been used. The gate FAILS for this attempt
    -- (retryable as any failed gate); the published operation is an
    -- incident, classified by the operation projections. Nothing is undone.
    UPDATE tasks SET
      gate_state = 'failed',
      gate_version = v_new_version,
      status = 'blocked',
      outcome = 'failed',
      outcome_reason = 'revoked-after-publication',
      completed_at = now()
    WHERE id = p_task_id;
  ELSE
    -- Same binding, decided again: attempt+1, fresh dwell, assignee and
    -- requirements preserved. Opens at once only with zero notBefore.
    UPDATE tasks SET
      gate_state = 'not_ready',
      gate_attempt = gate_attempt + 1,
      gate_version = v_new_version,
      gate_opened_at = NULL,
      dwell_started_at = NULL,
      eligible_at = NULL,
      status = 'pending',
      outcome = NULL,
      outcome_reason = NULL,
      completed_at = NULL
    WHERE id = p_task_id;
  END IF;

  -- Loss of authorization over the closure, in this transaction.
  v_holds := _graph_place_holds(p_user_id, v_group_id, p_task_id, false,
    'authority-withdrawn', v_event_id, NULL, p_task_id, v_task.gate_attempt,
    v_task.gate_binding_hash);

  v_eval := _graph_evaluate_group(p_user_id, v_group_id);

  RETURN jsonb_build_object('success', true, 'taskId', p_task_id,
    'eventId', v_event_id, 'authority', v_authority,
    'afterConsumption', v_consumed,
    'attempt', CASE WHEN v_consumed THEN v_task.gate_attempt ELSE v_task.gate_attempt + 1 END,
    'gateVersion', v_new_version, 'holds', v_holds, 'evaluation', v_eval);
END;
$$;

-- ── supersede_gate ──────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.supersede_gate(
  p_user_id uuid,
  p_task_id uuid,
  p_expected_attempt int,
  p_expected_gate_version bigint,
  p_expected_request_revision int,
  p_binding jsonb,
  p_binding_hash text,
  p_authors jsonb DEFAULT NULL,
  p_actor_identity_id uuid DEFAULT NULL,
  p_actor_user_id uuid DEFAULT NULL,
  p_system_actor boolean DEFAULT false,
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
  v_authority text;
  v_new_version bigint;
  v_revoked_event_id uuid;
  v_event_id uuid;
  v_holds jsonb := '[]'::jsonb;
  v_eval jsonb;
BEGIN
  PERFORM set_config('app.graph_executor', 'on', true);
  IF num_nonnulls(p_actor_identity_id, p_actor_user_id) + p_system_actor::int <> 1 THEN
    RETURN jsonb_build_object('success', false, 'reason', 'exactly-one-actor');
  END IF;
  IF p_binding IS NULL OR p_binding_hash IS NULL OR btrim(p_binding_hash) = '' THEN
    RETURN jsonb_build_object('success', false, 'reason', 'binding-required');
  END IF;
  IF NOT graph_authors_valid(p_authors) THEN
    RETURN jsonb_build_object('success', false, 'reason', 'authors-invalid');
  END IF;

  SELECT task_group_id INTO v_group_id FROM tasks
  WHERE id = p_task_id AND user_id = p_user_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'reason', 'task-not-found');
  END IF;
  IF v_group_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'reason', 'not-graph-mode');
  END IF;
  SELECT execution_model, status, user_id INTO v_group
  FROM task_groups WHERE id = v_group_id
  FOR UPDATE;
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
  -- CAS on attempt, version AND request revision: a supersession is an
  -- authorized change from an expected request, never a reaction to stale
  -- evidence.
  IF v_task.gate_attempt <> p_expected_attempt THEN
    RETURN jsonb_build_object('success', false, 'reason', 'attempt-conflict',
      'currentAttempt', v_task.gate_attempt);
  END IF;
  IF v_task.gate_version <> p_expected_gate_version THEN
    RETURN jsonb_build_object('success', false, 'reason', 'version-conflict',
      'currentGateVersion', v_task.gate_version);
  END IF;
  IF v_task.gate_request_revision <> p_expected_request_revision THEN
    RETURN jsonb_build_object('success', false, 'reason', 'revision-conflict',
      'currentRequestRevision', v_task.gate_request_revision);
  END IF;
  -- After consumption, in-place supersession is refused: a new candidate is
  -- a new linked request, and a completed publish node never becomes the
  -- publication of a different candidate (spec §Supersession).
  IF _graph_gate_consumed(p_task_id, NULL) THEN
    RETURN jsonb_build_object('success', false, 'reason', 'already-published');
  END IF;
  IF p_binding_hash IS NOT DISTINCT FROM v_task.gate_binding_hash THEN
    RETURN jsonb_build_object('success', false, 'reason', 'binding-unchanged');
  END IF;
  v_authority := _graph_supersession_authority(
    v_group.user_id, v_task.gate_authors,
    p_actor_identity_id, p_actor_user_id, p_system_actor);
  IF v_authority IS NULL THEN
    RETURN jsonb_build_object('success', false, 'reason', 'not-authorized');
  END IF;

  v_new_version := v_task.gate_version + 1;

  -- From open/in_progress: the reviewer's claim is released so an in-flight
  -- verdict bounces `superseded`.
  IF v_task.claimed_by_session_id IS NOT NULL THEN
    INSERT INTO task_gate_events (user_id, task_id, event, attempt, gate_version,
                                  session_id, claim_token, reason)
    VALUES (p_user_id, p_task_id, 'claim_released', v_task.gate_attempt, v_new_version,
            v_task.claimed_by_session_id, v_task.claim_token, 'superseded');
  END IF;

  -- From passed: revocation of the old binding plus the binding change. The
  -- old candidate's withdrawal stays unresolved for THAT binding.
  IF v_task.gate_state = 'passed' THEN
    INSERT INTO task_gate_events (user_id, task_id, event, attempt, gate_version,
                                  actor_identity_id, actor_user_id,
                                  assignee_identity_id, assignee_user_id,
                                  reason, binding_hash, evidence)
    VALUES (p_user_id, p_task_id, 'revoked', v_task.gate_attempt, v_new_version,
            CASE WHEN p_system_actor THEN v_task.assignee_identity_id ELSE p_actor_identity_id END,
            CASE WHEN p_system_actor AND v_task.assignee_identity_id IS NULL
                 THEN v_task.assignee_user_id ELSE p_actor_user_id END,
            v_task.assignee_identity_id, v_task.assignee_user_id,
            coalesce(p_reason, 'superseded'), v_task.gate_binding_hash,
            jsonb_build_object('authority', 'supersession', 'systemActor', p_system_actor,
                               'afterConsumption', false))
    RETURNING id INTO v_revoked_event_id;
  END IF;

  INSERT INTO task_gate_events (user_id, task_id, event, attempt, gate_version,
                                actor_identity_id, actor_user_id,
                                assignee_identity_id, assignee_user_id,
                                reason, binding_hash, evidence)
  VALUES (p_user_id, p_task_id, 'superseded', v_task.gate_attempt, v_new_version,
          p_actor_identity_id, p_actor_user_id,
          v_task.assignee_identity_id, v_task.assignee_user_id,
          p_reason, p_binding_hash,
          jsonb_build_object('fromBindingHash', v_task.gate_binding_hash,
                             'toBindingHash', p_binding_hash,
                             'fromRequestRevision', v_task.gate_request_revision,
                             'toRequestRevision', v_task.gate_request_revision + 1,
                             'fromState', v_task.gate_state,
                             'authority', v_authority,
                             'systemActor', p_system_actor,
                             'revokedEventId', v_revoked_event_id))
  RETURNING id INTO v_event_id;

  PERFORM _graph_invalidate_prepared_operations(p_user_id, p_task_id, 'superseded');

  -- The new attempt is over the new binding with the new author set.
  UPDATE tasks SET
    gate_binding = p_binding,
    gate_binding_hash = p_binding_hash,
    gate_authors = p_authors,
    gate_request_revision = gate_request_revision + 1,
    gate_state = 'not_ready',
    gate_attempt = gate_attempt + 1,
    gate_version = v_new_version,
    gate_opened_at = NULL,
    dwell_started_at = NULL,
    eligible_at = NULL,
    status = 'pending',
    outcome = NULL,
    outcome_reason = NULL,
    completed_at = NULL,
    claimed_by_session_id = NULL,
    claim_token = NULL,
    claimed_at = NULL
  WHERE id = p_task_id;

  IF v_revoked_event_id IS NOT NULL THEN
    v_holds := _graph_place_holds(p_user_id, v_group_id, p_task_id, false,
      'authority-withdrawn', v_revoked_event_id, NULL, p_task_id, v_task.gate_attempt,
      v_task.gate_binding_hash);
  END IF;

  v_eval := _graph_evaluate_group(p_user_id, v_group_id);

  RETURN jsonb_build_object('success', true, 'taskId', p_task_id,
    'eventId', v_event_id, 'revokedEventId', v_revoked_event_id,
    'authority', v_authority,
    'attempt', v_task.gate_attempt + 1, 'gateVersion', v_new_version,
    'requestRevision', v_task.gate_request_revision + 1,
    'holds', v_holds, 'evaluation', v_eval);
END;
$$;

-- ── lift_withdrawal ─────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.lift_withdrawal(
  p_user_id uuid,
  p_task_id uuid,
  p_withdrawal_event_id uuid,
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
  v_withdrawal record;
  v_event_id uuid;
  v_hold_ids uuid[];
  v_released jsonb := '[]'::jsonb;
  v_eval jsonb;
BEGIN
  PERFORM set_config('app.graph_executor', 'on', true);
  IF num_nonnulls(p_actor_identity_id, p_actor_user_id) <> 1 THEN
    RETURN jsonb_build_object('success', false, 'reason', 'exactly-one-actor');
  END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RETURN jsonb_build_object('success', false, 'reason', 'reason-required');
  END IF;

  SELECT task_group_id INTO v_group_id FROM tasks
  WHERE id = p_task_id AND user_id = p_user_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'reason', 'task-not-found');
  END IF;
  IF v_group_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'reason', 'not-graph-mode');
  END IF;
  SELECT execution_model, status, user_id INTO v_group
  FROM task_groups WHERE id = v_group_id
  FOR UPDATE;
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

  -- Lifting is an owner's or admin's explicit, attributed act (spec
  -- §Eligibility): never the reviewer, never the author, never a retry.
  IF NOT _graph_owner_or_admin(v_group.user_id, p_actor_user_id) THEN
    RETURN jsonb_build_object('success', false, 'reason', 'not-authorized');
  END IF;

  SELECT e.id, e.event, e.binding_hash INTO v_withdrawal
  FROM task_gate_events e
  WHERE e.id = p_withdrawal_event_id AND e.task_id = p_task_id
    AND e.event IN ('revoked', 'failed');
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'reason', 'withdrawal-not-found');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM graph_unresolved_withdrawals(p_task_id, v_withdrawal.binding_hash) u
    WHERE u = p_withdrawal_event_id
  ) THEN
    RETURN jsonb_build_object('success', false, 'reason', 'already-resolved');
  END IF;

  INSERT INTO task_gate_events (user_id, task_id, event, attempt, gate_version,
                                actor_identity_id, actor_user_id,
                                assignee_identity_id, assignee_user_id,
                                reason, binding_hash, resolves_event_id)
  VALUES (p_user_id, p_task_id, 'withdrawal_lifted', v_task.gate_attempt, v_task.gate_version,
          p_actor_identity_id, p_actor_user_id,
          v_task.assignee_identity_id, v_task.assignee_user_id,
          p_reason, v_withdrawal.binding_hash, p_withdrawal_event_id)
  RETURNING id INTO v_event_id;

  -- A lift releases the holds ITS withdrawal placed, and no others.
  SELECT array_agg(h.id) INTO v_hold_ids
  FROM task_authority_holds h
  WHERE h.cause_event_id = p_withdrawal_event_id AND h.released_at IS NULL;
  IF v_hold_ids IS NOT NULL THEN
    v_released := _graph_release_holds(p_user_id, v_hold_ids,
      jsonb_build_object('gateEventId', v_event_id, 'event', 'withdrawal_lifted'));
  END IF;

  v_eval := _graph_evaluate_group(p_user_id, v_group_id);

  RETURN jsonb_build_object('success', true, 'taskId', p_task_id,
    'eventId', v_event_id, 'resolvesEventId', p_withdrawal_event_id,
    'releasedHolds', v_released, 'evaluation', v_eval);
END;
$$;

-- ── Group completion refuses while any hold stands ──────────────────────

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
  -- A hold is lost authorization that has not been resolved: a withdrawn
  -- pass awaiting its re-review or lift, or a publication that is
  -- unconfirmed or contradicted. Completing over one would declare finished
  -- work that may have been published without authority (spec §Holds;
  -- Lumen, 5ca4f973: the invariant holds even with no descendants).
  IF EXISTS (
    SELECT 1 FROM task_authority_holds h
    JOIN tasks t ON t.id = h.task_id
    WHERE t.task_group_id = NEW.id AND h.released_at IS NULL
  ) THEN
    RAISE EXCEPTION
      'graph-mode group cannot complete: unreleased authority holds remain — re-pass the withdrawn gate, lift the withdrawal, or resolve the conflict';
  END IF;
  RETURN NEW;
END;
$$;

-- ── Holds travel with edges (Lumen, PR #678 rounds two and three) ──────
--
-- A hold is placed over the closure that exists when authority is lost.
-- The graph can change afterwards: an inbound edit can wire a completed,
-- unheld node beneath a held one, and everything downstream of that bridge
-- then sees only satisfied, unheld sources. Readiness that inspects
-- immediate sources cannot preserve the closure; the invariant has to be
-- maintained by the write that changes it.
--
-- What an edge carries is not the source's own hold rows but every
-- unresolved cause in its ANCESTRY: the unreleased holds of the source and
-- of every node upstream of it, and the unresolved withdrawals of every
-- gate upstream of it — the revoked gate itself carries no hold row (its
-- new attempt is the ordinary decide-again state) and a failed intermediate
-- was skipped by placement, yet an edge from either onto a completed bridge
-- would otherwise let the bridge's descendants out (round three). Each
-- cause is placed on the target and the target's descendants through
-- _graph_place_holds — same kind, cause, source gate, attempt and binding —
-- with the per-state effects placement has (an open gate closes with a
-- fresh window, a claim is released with reason upstream-revoked) and the
-- per-cause release later. Placement is idempotent per (node, cause), so a
-- re-added edge changes nothing. The trigger runs inside the serialized
-- mutation's own transaction under its group lock, whichever RPC inserted
-- the edge (apply_task_graph, add_graph_nodes, conversion): the fence lives
-- in the write, never beside it. AFTER ROW triggers fire once the whole
-- statement's rows are in, so the ancestry they read is the new graph.

CREATE OR REPLACE FUNCTION public._graph_edge_inherits_holds()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_target record;
  v_cause record;
BEGIN
  SELECT t.user_id, t.task_group_id INTO v_target
  FROM tasks t WHERE t.id = NEW.to_task;
  IF NOT FOUND OR v_target.task_group_id IS NULL THEN
    RETURN NEW;
  END IF;
  FOR v_cause IN
    WITH lineage AS (
      SELECT NEW.from_task AS id
      UNION
      SELECT _graph_ancestors(NEW.from_task)
    ),
    causes AS (
      -- (a) unreleased holds anywhere in the ancestry
      SELECT h.kind, h.cause_event_id, h.cause_operation_id,
             h.source_gate_id, h.source_attempt, h.binding_hash, h.placed_at AS since
      FROM task_authority_holds h
      WHERE h.task_id IN (SELECT id FROM lineage) AND h.released_at IS NULL
      UNION
      -- (b) unresolved withdrawals of any gate in the ancestry, which the
      --     gate itself does not carry as a hold
      SELECT 'authority-withdrawn', e.id, NULL::uuid,
             g.id, e.attempt, e.binding_hash, e.created_at
      FROM tasks g
      JOIN task_gate_events e ON e.task_id = g.id AND e.event = 'revoked'
      WHERE g.id IN (SELECT id FROM lineage)
        AND g.task_type = 'verification'
        AND e.id IN (SELECT graph_unresolved_withdrawals(g.id, e.binding_hash))
    )
    SELECT DISTINCT ON (cause_event_id, cause_operation_id)
           kind, cause_event_id, cause_operation_id, source_gate_id, source_attempt, binding_hash
    FROM causes
    ORDER BY cause_event_id, cause_operation_id, since
  LOOP
    PERFORM set_config('app.graph_executor', 'on', true);
    PERFORM _graph_place_holds(v_target.user_id, v_target.task_group_id, NEW.to_task, true,
      v_cause.kind, v_cause.cause_event_id, v_cause.cause_operation_id,
      v_cause.source_gate_id, v_cause.source_attempt, v_cause.binding_hash);
  END LOOP;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS task_edges_inherit_holds ON public.task_edges;
CREATE TRIGGER task_edges_inherit_holds
  AFTER INSERT ON public.task_edges
  FOR EACH ROW EXECUTE FUNCTION public._graph_edge_inherits_holds();

REVOKE ALL ON FUNCTION public._graph_edge_inherits_holds() FROM PUBLIC;
REVOKE ALL ON FUNCTION public._graph_edge_inherits_holds() FROM anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public._graph_ancestors(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._graph_ancestors(uuid) FROM anon, authenticated, service_role;

-- ── The execution-path fence covers the gate's request columns ──────────

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
  -- state, verdict/outcome projections, claims, server-owned timing
  -- (a direct eligible_at rewrite would force an hour-dwell gate open on
  -- the next sweep — Lumen round 1 P1; outcome_reason joined in round 2),
  -- and — since the revocation amendment — the gate's request: binding,
  -- author set and request revision change only through supersede_gate.
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
   AND NEW.claimed_at IS NOT DISTINCT FROM OLD.claimed_at
   AND NEW.gate_binding IS NOT DISTINCT FROM OLD.gate_binding
   AND NEW.gate_binding_hash IS NOT DISTINCT FROM OLD.gate_binding_hash
   AND NEW.gate_authors IS NOT DISTINCT FROM OLD.gate_authors
   AND NEW.gate_request_revision IS NOT DISTINCT FROM OLD.gate_request_revision) THEN
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
  -- a claim, timing stamps, or a gate already past not_ready). Config,
  -- assignees and the gate's request at INSERT are authoring, always
  -- allowed.
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
        'execution state is executor-owned for graph-mode groups — use claim_task / complete_task(claimToken) / record_gate_verdict / retry_gate / revoke_gate / supersede_gate';
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
    assignee_identity_id, assignee_user_id, task_group_id,
    gate_binding, gate_binding_hash, gate_authors, gate_request_revision ON public.tasks
  FOR EACH ROW EXECUTE FUNCTION public.enforce_graph_execution_path();

-- ── Grants (house pattern: service-role only; internals reachable only ──
--    through the RPCs). REVOKE from PUBLIC alone leaves anon and
--    authenticated holding EXECUTE under Supabase's default privileges; the
--    roles must be named (measured, 20260901084438).

REVOKE ALL ON FUNCTION public.graph_hold_blocks(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.graph_hold_blocks(uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.graph_hold_blocks(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.graph_inbound_blocked(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.graph_inbound_blocked(uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.graph_inbound_blocked(uuid) TO service_role;

REVOKE ALL ON FUNCTION public._graph_supersession_authority(uuid, jsonb, uuid, uuid, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._graph_supersession_authority(uuid, jsonb, uuid, uuid, boolean) FROM anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.graph_authors_valid(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.graph_authors_valid(jsonb) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.graph_authors_valid(jsonb) TO service_role;

REVOKE ALL ON FUNCTION public.graph_principal_in(jsonb, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.graph_principal_in(jsonb, uuid, uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.graph_principal_in(jsonb, uuid, uuid) TO service_role;

REVOKE ALL ON FUNCTION public.graph_unresolved_withdrawals(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.graph_unresolved_withdrawals(uuid, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.graph_unresolved_withdrawals(uuid, text) TO service_role;

REVOKE ALL ON FUNCTION public._graph_descendants(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._graph_descendants(uuid) FROM anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public._publication_operation_phase(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._publication_operation_phase(uuid) FROM anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public._graph_gate_consumed(uuid, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._graph_gate_consumed(uuid, int) FROM anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public._graph_claim_bounce_reason(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._graph_claim_bounce_reason(uuid, uuid) FROM anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public._graph_revocation_authority(uuid, int, uuid, uuid, uuid, jsonb, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._graph_revocation_authority(uuid, int, uuid, uuid, uuid, jsonb, uuid, uuid) FROM anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public._graph_owner_or_admin(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._graph_owner_or_admin(uuid, uuid) FROM anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public._graph_invalidate_prepared_operations(uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._graph_invalidate_prepared_operations(uuid, uuid, text) FROM anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public._graph_place_holds(uuid, uuid, uuid, boolean, text, uuid, uuid, uuid, int, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._graph_place_holds(uuid, uuid, uuid, boolean, text, uuid, uuid, uuid, int, text) FROM anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public._graph_release_holds(uuid, uuid[], jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._graph_release_holds(uuid, uuid[], jsonb) FROM anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.record_gate_verdict(uuid, uuid, text, int, bigint, uuid, uuid, uuid, uuid, jsonb, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_gate_verdict(uuid, uuid, text, int, bigint, uuid, uuid, uuid, uuid, jsonb, text, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_gate_verdict(uuid, uuid, text, int, bigint, uuid, uuid, uuid, uuid, jsonb, text, text) TO service_role;

REVOKE ALL ON FUNCTION public.revoke_gate(uuid, uuid, int, bigint, uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.revoke_gate(uuid, uuid, int, bigint, uuid, uuid, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_gate(uuid, uuid, int, bigint, uuid, uuid, text) TO service_role;

REVOKE ALL ON FUNCTION public.supersede_gate(uuid, uuid, int, bigint, int, jsonb, text, jsonb, uuid, uuid, boolean, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.supersede_gate(uuid, uuid, int, bigint, int, jsonb, text, jsonb, uuid, uuid, boolean, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.supersede_gate(uuid, uuid, int, bigint, int, jsonb, text, jsonb, uuid, uuid, boolean, text) TO service_role;

REVOKE ALL ON FUNCTION public.lift_withdrawal(uuid, uuid, uuid, uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.lift_withdrawal(uuid, uuid, uuid, uuid, uuid, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.lift_withdrawal(uuid, uuid, uuid, uuid, uuid, text) TO service_role;
