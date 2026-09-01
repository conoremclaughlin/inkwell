/**
 * add_graph_nodes — node authoring for template constructors (real DB)
 *
 * Everything worth testing here lives in plpgsql and is invisible to a mock:
 * the group lock and version CAS, acyclicity over the UNION of existing and
 * proposed edges, the passed-gate refusal, the fresh window an inbound change
 * grants a live gate, and the additive guarantee that nothing is ever removed.
 *
 * Requires .env.local with SUPABASE_URL + SUPABASE_SECRET_KEY.
 * Skipped automatically when credentials are unavailable.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import dotenv from 'dotenv';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { randomUUID } from 'crypto';
import { INTEGRATION_TEST_USER_ID } from '../test/integration-fixtures';
import type { Database } from './supabase/types';
import { TaskGroupsRepository } from './repositories/task-groups.repository';

const projectRoot = resolve(__dirname, '../../../../');
const envLocalPath = resolve(projectRoot, '.env.local');
if (existsSync(envLocalPath)) {
  const parsed = dotenv.parse(readFileSync(envLocalPath));
  for (const [key, value] of Object.entries(parsed)) {
    if (!process.env[key]) process.env[key] = value;
  }
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_KEY;
const d = SUPABASE_URL && SUPABASE_KEY ? describe : describe.skip;
const USER = INTEGRATION_TEST_USER_ID;

interface NodeRow {
  id: string;
  node_slug: string | null;
  task_type: string;
  gate_state: string | null;
  gate_version: number;
  status: string;
}

d('add_graph_nodes (real DB)', () => {
  let client: SupabaseClient<Database>;
  let groups: TaskGroupsRepository;
  let reviewer: string;
  let sessionId: string;
  const groupIds: string[] = [];

  /** A fresh graph-mode group — born linear and converted, as the DB requires. */
  async function newGraphGroup(title: string): Promise<{ id: string; version: number }> {
    const id = randomUUID();
    const { error } = await client.from('task_groups').insert({ id, user_id: USER, title });
    if (error) throw new Error(`fixture group: ${error.message}`);
    groupIds.push(id);
    const converted = await groups.convertToGraph({
      userId: USER,
      taskGroupId: id,
      expectedVersion: 0,
      systemActor: true,
    });
    if (converted.success !== true)
      throw new Error(`fixture convert: ${JSON.stringify(converted)}`);
    return { id, version: Number(converted.graphVersion ?? 1) };
  }

  async function nodesOf(groupId: string): Promise<NodeRow[]> {
    const { data } = await client
      .from('tasks')
      .select('id, node_slug, task_type, gate_state, gate_version, status')
      .eq('task_group_id', groupId)
      .order('task_order', { ascending: true });
    return (data ?? []) as NodeRow[];
  }

  async function inboundSlugs(groupId: string, slug: string): Promise<string[]> {
    const nodes = await nodesOf(groupId);
    const target = nodes.find((n) => n.node_slug === slug)!;
    const edges = await groups.getEdges(groupId);
    const bySlug = new Map(nodes.map((n) => [n.id, n.node_slug ?? n.id]));
    return edges
      .filter((e) => e.to_task === target.id)
      .map((e) => bySlug.get(e.from_task)!)
      .sort();
  }

  const version = async (groupId: string) =>
    Number((await groups.findById(groupId))!.graph_version ?? 0);

  /** The pr-ship shape, as the constructor emits it. */
  const prShipNodes = (reviewerId: string) => [
    { slug: 'work', type: 'work', title: 'implement' },
    {
      slug: 'sibling-review',
      type: 'verification',
      title: 'sibling review',
      assigneeIdentityId: reviewerId,
      verification: { mode: 'executable', requirements: [{ label: 'the exact commit' }] },
    },
    { slug: 'merge', type: 'work', title: 'merge' },
  ];
  const prShipEdges = [
    { from: 'work', to: 'sibling-review' },
    { from: 'sibling-review', to: 'merge' },
  ];

  beforeAll(async () => {
    client = createClient<Database>(SUPABASE_URL!, SUPABASE_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    groups = new TaskGroupsRepository(client);
    const { data } = await client.from('agent_identities').select('id').limit(1).maybeSingle();
    if (!data?.id) throw new Error('fixture: no agent identity for gate assignee');
    reviewer = data.id;

    const { data: session, error: sErr } = await client
      .from('sessions')
      .insert({ user_id: USER })
      .select('id')
      .single();
    if (sErr) throw new Error(`fixture session: ${sErr.message}`);
    sessionId = session.id;
  });

  afterAll(async () => {
    for (const id of groupIds) {
      await client.from('tasks').delete().eq('task_group_id', id);
      await client.from('task_groups').delete().eq('id', id);
    }
    if (sessionId) await client.from('sessions').delete().eq('id', sessionId);
  });

  it('builds the template shape: typed nodes, wired edges, gates born not_ready', async () => {
    const group = await newGraphGroup('itest add-nodes instantiate');
    const result = await groups.addGraphNodes({
      userId: USER,
      taskGroupId: group.id,
      expectedVersion: group.version,
      nodes: prShipNodes(reviewer),
      edges: prShipEdges,
      systemActor: true,
      constructorId: 'pr-ship',
      constructorVersion: '1',
      configHash: 'hash-a',
    });

    expect(result.success).toBe(true);
    const nodes = await nodesOf(group.id);
    expect(nodes.map((n) => n.node_slug)).toEqual(['work', 'sibling-review', 'merge']);

    const gate = nodes.find((n) => n.node_slug === 'sibling-review')!;
    expect(gate.task_type).toBe('verification');
    // A gate must be born not_ready or the CHECK constraint refuses the row;
    // the evaluator owns every transition after that.
    expect(gate.gate_state).toBe('not_ready');
    expect(nodes.find((n) => n.node_slug === 'work')!.gate_state).toBeNull();
    expect(await inboundSlugs(group.id, 'merge')).toEqual(['sibling-review']);
  });

  it('records constructor provenance on the revision', async () => {
    const group = await newGraphGroup('itest add-nodes provenance');
    await groups.addGraphNodes({
      userId: USER,
      taskGroupId: group.id,
      expectedVersion: group.version,
      nodes: prShipNodes(reviewer),
      edges: prShipEdges,
      systemActor: true,
      constructorId: 'pr-ship',
      constructorVersion: '7',
      configHash: 'hash-b',
    });
    const { data } = await client
      .from('task_graph_revisions')
      .select('constructor, constructor_version, config_hash, diff')
      .eq('task_group_id', group.id)
      .order('graph_version', { ascending: false })
      .limit(1)
      .maybeSingle();
    expect(data?.constructor).toBe('pr-ship');
    expect(data?.constructor_version).toBe('7');
    expect(data?.config_hash).toBe('hash-b');
    const diff = data?.diff as { nodesAdded: unknown[]; edgesAdded: unknown[] };
    expect(diff.nodesAdded).toHaveLength(3);
    expect(diff.edgesAdded).toHaveLength(2);
  });

  it('re-running the same template adds nothing — matched by slug, not duplicated', async () => {
    const group = await newGraphGroup('itest add-nodes idempotent');
    await groups.addGraphNodes({
      userId: USER,
      taskGroupId: group.id,
      expectedVersion: group.version,
      nodes: prShipNodes(reviewer),
      edges: prShipEdges,
      systemActor: true,
    });
    const again = await groups.addGraphNodes({
      userId: USER,
      taskGroupId: group.id,
      expectedVersion: await version(group.id),
      nodes: prShipNodes(reviewer),
      edges: prShipEdges,
      systemActor: true,
    });

    expect(again.success).toBe(true);
    expect(again.nodesAdded).toEqual([]);
    expect(again.edgesAdded).toEqual([]);
    expect((again.nodesExisting as unknown[]).map((n) => (n as { slug: string }).slug)).toEqual([
      'work',
      'sibling-review',
      'merge',
    ]);
    expect((await nodesOf(group.id)).map((n) => n.node_slug)).toEqual([
      'work',
      'sibling-review',
      'merge',
    ]);
  });

  it('injects a gate into a running graph and rewires the node downstream of it', async () => {
    const group = await newGraphGroup('itest add-nodes injection');
    await groups.addGraphNodes({
      userId: USER,
      taskGroupId: group.id,
      expectedVersion: group.version,
      nodes: prShipNodes(reviewer),
      edges: prShipEdges,
      systemActor: true,
    });

    // Scope grew: this PR turned out to have a user-visible surface.
    const injected = await groups.addGraphNodes({
      userId: USER,
      taskGroupId: group.id,
      expectedVersion: await version(group.id),
      nodes: [
        {
          slug: 'visual-signoff',
          type: 'verification',
          title: 'visual sign-off',
          assigneeUserId: USER,
          verification: { mode: 'approval', requirements: [{ label: 'screenshots' }] },
        },
      ],
      edges: [
        { from: 'work', to: 'visual-signoff' },
        { from: 'visual-signoff', to: 'merge' },
      ],
      systemActor: true,
      constructorId: 'visual-signoff',
      constructorVersion: '1',
    });

    expect(injected.success).toBe(true);
    // The merge now waits on BOTH gates — an injection that did not rewire
    // the downstream node would let the merge through without the new gate.
    expect(await inboundSlugs(group.id, 'merge')).toEqual(['sibling-review', 'visual-signoff']);
    expect(await inboundSlugs(group.id, 'visual-signoff')).toEqual(['work']);
  });

  it('accepts a raw task UUID as an edge endpoint, for nodes that have no slug', async () => {
    const group = await newGraphGroup('itest add-nodes uuid anchor');
    const legacyId = randomUUID();
    const { error } = await client.from('tasks').insert({
      id: legacyId,
      user_id: USER,
      task_group_id: group.id,
      title: 'pre-existing, slugless',
      task_type: 'work',
    } as never);
    if (error) throw new Error(`fixture legacy node: ${error.message}`);

    const result = await groups.addGraphNodes({
      userId: USER,
      taskGroupId: group.id,
      expectedVersion: group.version,
      nodes: [{ slug: 'late-gate', type: 'work', title: 'late' }],
      edges: [{ from: legacyId, to: 'late-gate' }],
      systemActor: true,
    });

    expect(result.success).toBe(true);
    expect(await inboundSlugs(group.id, 'late-gate')).toEqual([legacyId]);
  });

  it('refuses a cycle that only exists in the UNION of old and new edges', async () => {
    const group = await newGraphGroup('itest add-nodes union cycle');
    await groups.addGraphNodes({
      userId: USER,
      taskGroupId: group.id,
      expectedVersion: group.version,
      nodes: [
        { slug: 'a', type: 'work', title: 'a' },
        { slug: 'b', type: 'work', title: 'b' },
      ],
      edges: [{ from: 'a', to: 'b' }],
      systemActor: true,
    });

    // b→a is acyclic ON ITS OWN. Only together with the stored a→b is it a
    // cycle — validating the proposed set in isolation would admit it.
    const refused = await groups.addGraphNodes({
      userId: USER,
      taskGroupId: group.id,
      expectedVersion: await version(group.id),
      nodes: [],
      edges: [{ from: 'b', to: 'a' }],
      systemActor: true,
    });

    expect(refused).toMatchObject({ success: false, reason: 'cycle' });
    expect(await groups.getEdges(group.id)).toHaveLength(1);
  });

  it('refuses an inbound edge to a PASSED gate — its verdict stands on the old premises', async () => {
    const group = await newGraphGroup('itest add-nodes passed gate');
    await groups.addGraphNodes({
      userId: USER,
      taskGroupId: group.id,
      expectedVersion: group.version,
      nodes: [...prShipNodes(reviewer), { slug: 'late', type: 'work', title: 'a late premise' }],
      edges: prShipEdges,
      systemActor: true,
    });

    const nodes = await nodesOf(group.id);
    const workId = nodes.find((n) => n.node_slug === 'work')!.id;

    // Drive the gate to passed the way production does: claim the work,
    // complete it (which opens the gate in the same transaction), then let
    // the assignee record a verdict.
    const claimed = await groups.claimGraphTask({ userId: USER, taskId: workId, sessionId });
    expect(claimed.success).toBe(true);
    const completed = await groups.completeGraphTask({
      userId: USER,
      taskId: workId,
      sessionId,
      claimToken: claimed.claimToken as string,
      outcome: 'completed',
    });
    expect(completed.success).toBe(true);

    const openGate = (await nodesOf(group.id)).find((n) => n.node_slug === 'sibling-review')!;
    expect(openGate.gate_state).toBe('open');
    const verdict = await groups.recordGateVerdict({
      userId: USER,
      taskId: openGate.id,
      verdict: 'passed',
      expectedAttempt: 1,
      expectedGateVersion: openGate.gate_version,
      actorIdentityId: reviewer,
      evidence: { note: 'itest' },
    });
    expect(verdict.success).toBe(true);
    expect(
      (await nodesOf(group.id)).find((n) => n.node_slug === 'sibling-review')!.gate_state
    ).toBe('passed');

    const refused = await groups.addGraphNodes({
      userId: USER,
      taskGroupId: group.id,
      expectedVersion: await version(group.id),
      nodes: [],
      edges: [{ from: 'late', to: 'sibling-review' }],
      systemActor: true,
    });
    expect(refused).toMatchObject({ success: false, reason: 'passed-gate-inbound' });
  });

  it('grants a live gate a fresh window when its inbound set changes', async () => {
    const group = await newGraphGroup('itest add-nodes fresh window');
    await groups.addGraphNodes({
      userId: USER,
      taskGroupId: group.id,
      expectedVersion: group.version,
      nodes: [...prShipNodes(reviewer), { slug: 'late', type: 'work', title: 'late premise' }],
      edges: prShipEdges,
      systemActor: true,
    });
    const before = (await nodesOf(group.id)).find((n) => n.node_slug === 'sibling-review')!;

    const result = await groups.addGraphNodes({
      userId: USER,
      taskGroupId: group.id,
      expectedVersion: await version(group.id),
      nodes: [],
      edges: [{ from: 'late', to: 'sibling-review' }],
      systemActor: true,
    });

    expect(result.success).toBe(true);
    const after = (await nodesOf(group.id)).find((n) => n.node_slug === 'sibling-review')!;
    expect(result.resetGates).toContain(before.id);
    expect(after.gate_state).toBe('not_ready');
    // The version bump is what makes an in-flight verdict CAS-bounce.
    expect(after.gate_version).toBeGreaterThan(before.gate_version);
  });

  it('never removes: an edge omitted from the call survives', async () => {
    const group = await newGraphGroup('itest add-nodes additive');
    await groups.addGraphNodes({
      userId: USER,
      taskGroupId: group.id,
      expectedVersion: group.version,
      nodes: prShipNodes(reviewer),
      edges: prShipEdges,
      systemActor: true,
    });

    // apply_task_graph would treat this as the complete desired set and drop
    // the other edge. add_graph_nodes must not.
    await groups.addGraphNodes({
      userId: USER,
      taskGroupId: group.id,
      expectedVersion: await version(group.id),
      nodes: [],
      edges: [{ from: 'work', to: 'sibling-review' }],
      systemActor: true,
    });

    expect(await inboundSlugs(group.id, 'merge')).toEqual(['sibling-review']);
    expect(await groups.getEdges(group.id)).toHaveLength(2);
  });

  it('CAS-refuses a stale version and changes nothing', async () => {
    const group = await newGraphGroup('itest add-nodes cas');
    const refused = await groups.addGraphNodes({
      userId: USER,
      taskGroupId: group.id,
      expectedVersion: group.version + 99,
      nodes: [{ slug: 'x', type: 'work', title: 'x' }],
      edges: [],
      systemActor: true,
    });
    expect(refused).toMatchObject({ success: false, reason: 'version-conflict' });
    expect(await nodesOf(group.id)).toHaveLength(0);
  });

  it('refuses malformed nodes before writing any of them', async () => {
    const group = await newGraphGroup('itest add-nodes validation');
    for (const [label, nodes] of [
      ['gate with no assignee', [{ slug: 'g', type: 'verification', title: 'g' }]],
      [
        'gate with two assignees',
        [
          {
            slug: 'g',
            type: 'verification',
            title: 'g',
            assigneeIdentityId: reviewer,
            assigneeUserId: USER,
          },
        ],
      ],
      [
        'work carrying gate fields',
        [{ slug: 'w', type: 'work', title: 'w', assigneeUserId: USER }],
      ],
      ['missing title', [{ slug: 'w', type: 'work' }]],
      ['missing slug', [{ type: 'work', title: 'w' }]],
      [
        'duplicate slugs in one call',
        [
          { slug: 'dup', type: 'work', title: 'a' },
          { slug: 'dup', type: 'work', title: 'b' },
        ],
      ],
    ] as Array<[string, Array<Record<string, unknown>>]>) {
      const refused = await groups.addGraphNodes({
        userId: USER,
        taskGroupId: group.id,
        expectedVersion: group.version,
        nodes,
        edges: [],
        systemActor: true,
      });
      expect(refused.success, label).toBe(false);
      expect(await nodesOf(group.id), label).toHaveLength(0);
    }
  });

  it('refuses an edge naming a node that does not exist', async () => {
    const group = await newGraphGroup('itest add-nodes unknown edge');
    const refused = await groups.addGraphNodes({
      userId: USER,
      taskGroupId: group.id,
      expectedVersion: group.version,
      nodes: [{ slug: 'only', type: 'work', title: 'only' }],
      edges: [{ from: 'only', to: 'ghost' }],
      systemActor: true,
    });
    expect(refused).toMatchObject({ success: false, reason: 'invalid-edges' });
    // The whole call is refused, so the valid node is not written either.
    expect(await nodesOf(group.id)).toHaveLength(0);
  });

  /**
   * The pr:555 review blockers. Each of these passed before the fix in the
   * sense that the call SUCCEEDED — which is the point: the failures were
   * silent, so only an assertion about the resulting graph catches them.
   */
  describe('pr:555 review blockers', () => {
    it('refuses when an existing slug is a different KIND of node than promised', async () => {
      const group = await newGraphGroup('itest blocker1 type');
      // Something already occupies the slug the template promises as a gate.
      await groups.addGraphNodes({
        userId: USER,
        taskGroupId: group.id,
        expectedVersion: group.version,
        nodes: [{ slug: 'sibling-review', type: 'work', title: 'not actually a gate' }],
        edges: [],
        systemActor: true,
      });

      const refused = await groups.addGraphNodes({
        userId: USER,
        taskGroupId: group.id,
        expectedVersion: await version(group.id),
        nodes: prShipNodes(reviewer),
        edges: prShipEdges,
        systemActor: true,
        constructorId: 'pr-ship',
      });

      expect(refused).toMatchObject({ success: false, reason: 'existing-node-conflict' });
      // Before the fix this succeeded, and the graph contained NO gate while
      // the revision claimed a pr-ship shape that has one.
      const gate = (await nodesOf(group.id)).find((n) => n.node_slug === 'sibling-review')!;
      expect(gate.task_type).toBe('work');
      expect(await groups.getEdges(group.id)).toHaveLength(0);
    });

    it('refuses when an existing gate has a different principal than promised', async () => {
      const group = await newGraphGroup('itest blocker1 assignee');
      await groups.addGraphNodes({
        userId: USER,
        taskGroupId: group.id,
        expectedVersion: group.version,
        nodes: [
          {
            slug: 'sibling-review',
            type: 'verification',
            title: 'gate held by the wrong principal',
            assigneeUserId: USER,
            verification: { mode: 'approval', requirements: [] },
          },
        ],
        edges: [],
        systemActor: true,
      });

      const refused = await groups.addGraphNodes({
        userId: USER,
        taskGroupId: group.id,
        expectedVersion: await version(group.id),
        nodes: prShipNodes(reviewer),
        edges: [],
        systemActor: true,
      });
      expect(refused).toMatchObject({ success: false, reason: 'existing-node-conflict' });
    });

    /**
     * Round 2: same type, same principal, different runtime semantics.
     * claim_graph_task REFUSES an approval gate, so an approval gate standing
     * in for an executable `sibling-review` dispatches a reviewer to a gate
     * they cannot claim — the shape looks right and the work cannot proceed.
     */
    it('refuses when an existing gate has the same principal but a different MODE', async () => {
      const group = await newGraphGroup('itest round2 mode');
      await groups.addGraphNodes({
        userId: USER,
        taskGroupId: group.id,
        expectedVersion: group.version,
        nodes: [
          {
            slug: 'sibling-review',
            type: 'verification',
            title: 'approval gate wearing the review slug',
            assigneeIdentityId: reviewer,
            verification: { mode: 'approval', requirements: [] },
          },
        ],
        edges: [],
        systemActor: true,
      });

      const refused = await groups.addGraphNodes({
        userId: USER,
        taskGroupId: group.id,
        expectedVersion: await version(group.id),
        nodes: prShipNodes(reviewer), // sibling-review is executable here
        edges: [],
        systemActor: true,
      });
      expect(refused).toMatchObject({ success: false, reason: 'existing-node-conflict' });
      expect((refused.conflicts as Array<{ problem: string }>)[0].problem).toBe('mode-differs');
    });

    it('refuses when an existing gate carries a different dwell window', async () => {
      const group = await newGraphGroup('itest round2 dwell');
      await groups.addGraphNodes({
        userId: USER,
        taskGroupId: group.id,
        expectedVersion: group.version,
        nodes: [
          {
            slug: 'sibling-review',
            type: 'verification',
            title: 'same gate, but it dwells for an hour first',
            assigneeIdentityId: reviewer,
            verification: { mode: 'executable', requirements: [], notBeforeSeconds: 3600 },
          },
        ],
        edges: [],
        systemActor: true,
      });

      const refused = await groups.addGraphNodes({
        userId: USER,
        taskGroupId: group.id,
        expectedVersion: await version(group.id),
        nodes: prShipNodes(reviewer), // no dwell
        edges: [],
        systemActor: true,
      });
      expect(refused).toMatchObject({ success: false, reason: 'existing-node-conflict' });
      expect((refused.conflicts as Array<{ problem: string }>)[0].problem).toBe('dwell-differs');
    });

    it('refuses a principal that does not exist, as a reason rather than an FK exception', async () => {
      const group = await newGraphGroup('itest round2 unknown principal');
      const ghost = randomUUID();
      const refused = await groups.addGraphNodes({
        userId: USER,
        taskGroupId: group.id,
        expectedVersion: group.version,
        nodes: [
          {
            slug: 'ghost-gate',
            type: 'verification',
            title: 'assigned to nobody at all',
            assigneeIdentityId: ghost,
            verification: { mode: 'executable', requirements: [] },
          },
        ],
        edges: [],
        systemActor: true,
      });
      // Before the fix this raised an FK violation, which the repository
      // rethrows — aborting the caller instead of answering it.
      expect(refused).toMatchObject({ success: false, reason: 'unknown-principal' });
      expect(await nodesOf(group.id)).toHaveLength(0);
    });

    it('accepts an existing gate whose checklist wording drifted — that is not a conflict', async () => {
      const group = await newGraphGroup('itest blocker1 wording');
      await groups.addGraphNodes({
        userId: USER,
        taskGroupId: group.id,
        expectedVersion: group.version,
        nodes: prShipNodes(reviewer),
        edges: prShipEdges,
        systemActor: true,
      });

      const reworded = prShipNodes(reviewer).map((n) =>
        n.slug === 'sibling-review'
          ? {
              ...n,
              verification: { mode: 'executable', requirements: [{ label: 'reworded entirely' }] },
            }
          : n
      );
      const result = await groups.addGraphNodes({
        userId: USER,
        taskGroupId: group.id,
        expectedVersion: await version(group.id),
        nodes: reworded,
        edges: prShipEdges,
        systemActor: true,
      });
      // Requirements are a checklist, not a contract — a template that
      // rewords its own guidance must still be re-runnable.
      expect(result.success).toBe(true);
    });

    /**
     * My first attempt at this test asserted only that a node got created,
     * and it passed against the ORIGINAL buggy function — the node was
     * created either way, so the assertion proved nothing. The divergence
     * only shows up in what VALIDATION reasoned about: with one namespace
     * the reference resolved to the pre-existing node, so a check about that
     * node's state fired for a reference the author meant for the new one.
     *
     * Hence a passed gate: under the bug the call is refused because the
     * OTHER node is a passed gate; under the fix the reference means the new
     * work node and there is nothing to refuse.
     */
    /**
     * This test took three attempts and the first two were worthless, which
     * is worth recording because both LOOKED like coverage:
     *
     *  1. Asserting only that a node got created — true under the bug too.
     *  2. Adding a passed gate for consequence, but giving it a SLUG. A
     *     slugged node keys on its slug, so nothing collided and both
     *     versions behaved identically.
     *
     * The collision needed the pre-existing node to be SLUGLESS, because
     * only then did the old key space fall back to its UUID and put a slug
     * and an id in the same namespace. With that, the reference resolves to
     * the old gate (refusal) under the bug and to the new node (success)
     * under the fix.
     */
    it('a slug spelled like a SLUGLESS node UUID resolves to its own node, not that one', async () => {
      const group = await newGraphGroup('itest blocker4 collision');
      const sluglessGateId = randomUUID();
      const { error } = await client.from('tasks').insert({
        id: sluglessGateId,
        user_id: USER,
        task_group_id: group.id,
        title: 'a gate authored before slugs existed',
        task_type: 'verification',
        gate_state: 'not_ready',
        assignee_identity_id: reviewer,
      } as never);
      if (error) throw new Error(`fixture slugless gate: ${error.message}`);

      await groups.addGraphNodes({
        userId: USER,
        taskGroupId: group.id,
        expectedVersion: group.version,
        nodes: [{ slug: 'w', type: 'work', title: 'upstream' }],
        edges: [{ from: 'w', to: sluglessGateId }],
        systemActor: true,
      });

      // Drive the slugless gate to passed, so mistaking a reference for it
      // has an observable consequence.
      const workId = (await nodesOf(group.id)).find((n) => n.node_slug === 'w')!.id;
      const claimed = await groups.claimGraphTask({ userId: USER, taskId: workId, sessionId });
      await groups.completeGraphTask({
        userId: USER,
        taskId: workId,
        sessionId,
        claimToken: claimed.claimToken as string,
        outcome: 'completed',
      });
      const opened = (await nodesOf(group.id)).find((n) => n.id === sluglessGateId)!;
      expect(opened.gate_state).toBe('open');
      await groups.recordGateVerdict({
        userId: USER,
        taskId: sluglessGateId,
        verdict: 'passed',
        expectedAttempt: 1,
        expectedGateVersion: opened.gate_version,
        actorIdentityId: reviewer,
        evidence: { note: 'collision fixture' },
      });

      // A new WORK node whose slug spells the passed gate's UUID, plus an
      // edge naming that string. The author means the new node.
      // The inbound edge must be one the graph does NOT already hold —
      // re-proposing the existing w→gate edge is not a new edge, so the
      // passed-gate guard never runs and both versions look alike. (That is
      // what made attempt three still pass under the bug.)
      const result = await groups.addGraphNodes({
        userId: USER,
        taskGroupId: group.id,
        expectedVersion: await version(group.id),
        nodes: [
          { slug: 'w2', type: 'work', title: 'a second upstream' },
          { slug: sluglessGateId, type: 'work', title: 'slug that looks like a uuid' },
        ],
        edges: [{ from: 'w2', to: sluglessGateId }],
        systemActor: true,
      });

      // Under one namespace this came back passed-gate-inbound: the
      // reference had resolved to the old gate, which the author never named.
      expect(result).toMatchObject({ success: true });
      const after = await nodesOf(group.id);
      const created = after.find((n) => n.node_slug === sluglessGateId)!;
      const w2 = after.find((n) => n.node_slug === 'w2')!;
      expect(created.id).not.toBe(sluglessGateId);
      expect(created.task_type).toBe('work');
      const edges = await groups.getEdges(group.id);
      expect(edges.some((e) => e.from_task === w2.id && e.to_task === created.id)).toBe(true);
      // Nothing new pointed at the old gate.
      expect(edges.some((e) => e.from_task === w2.id && e.to_task === sluglessGateId)).toBe(false);
    });

    it('a no-op re-run changes nothing at all — not the version, not the revision', async () => {
      const group = await newGraphGroup('itest blocker5 noop');
      await groups.addGraphNodes({
        userId: USER,
        taskGroupId: group.id,
        expectedVersion: group.version,
        nodes: prShipNodes(reviewer),
        edges: prShipEdges,
        systemActor: true,
        constructorId: 'pr-ship',
      });
      const settled = await version(group.id);
      const revisionsBefore = await client
        .from('task_graph_revisions')
        .select('id', { count: 'exact', head: true })
        .eq('task_group_id', group.id);

      const again = await groups.addGraphNodes({
        userId: USER,
        taskGroupId: group.id,
        expectedVersion: settled,
        nodes: prShipNodes(reviewer),
        edges: prShipEdges,
        systemActor: true,
        constructorId: 'pr-ship',
      });

      expect(again).toMatchObject({ success: true, noop: true });
      // The version is the CAS token every concurrent holder is guarding on.
      // Bumping it for a call that changed nothing invalidates their write
      // for no reason, and writes a revision describing no change.
      expect(again.graphVersion).toBe(settled);
      expect(await version(group.id)).toBe(settled);
      const revisionsAfter = await client
        .from('task_graph_revisions')
        .select('id', { count: 'exact', head: true })
        .eq('task_group_id', group.id);
      expect(revisionsAfter.count).toBe(revisionsBefore.count);
    });

    it('a real change still bumps the version and records exactly one revision', async () => {
      const group = await newGraphGroup('itest blocker5 real change');
      await groups.addGraphNodes({
        userId: USER,
        taskGroupId: group.id,
        expectedVersion: group.version,
        nodes: prShipNodes(reviewer),
        edges: prShipEdges,
        systemActor: true,
      });
      const settled = await version(group.id);

      const changed = await groups.addGraphNodes({
        userId: USER,
        taskGroupId: group.id,
        expectedVersion: settled,
        nodes: [{ slug: 'extra', type: 'work', title: 'extra' }],
        edges: [],
        systemActor: true,
      });
      expect(changed).toMatchObject({ success: true, noop: false });
      expect(changed.graphVersion).toBe(settled + 1);
    });
  });

  /**
   * PARITY WITH apply_task_graph.
   *
   * The PR claims add_graph_nodes copies apply_task_graph's serialization
   * obligations faithfully. Every test above asserts what add_graph_nodes
   * does — which is exactly the shape of test that encodes a belief instead
   * of checking a fact. If I mis-remembered one of apply_task_graph's rules
   * while copying it, those tests would pin my mistake and pass.
   *
   * So these drive the SAME logical mutation through BOTH functions against
   * identically-built graphs and require the outcomes to agree. When the two
   * must behave alike, the assertion belongs between them, not on each.
   * (Lumen caught this exact failure mode on pr:541 the same afternoon, in
   * an "old server" test that asserted fields the old server never sends.)
   */
  describe('parity with apply_task_graph', () => {
    /** Two identical graphs — one per function under comparison. */
    async function twinGraphs(label: string) {
      const build = async (suffix: string) => {
        const group = await newGraphGroup(`itest parity ${label} ${suffix}`);
        await groups.addGraphNodes({
          userId: USER,
          taskGroupId: group.id,
          expectedVersion: group.version,
          nodes: [...prShipNodes(reviewer), { slug: 'late', type: 'work', title: 'late premise' }],
          edges: prShipEdges,
          systemActor: true,
        });
        const nodes = await nodesOf(group.id);
        const idOf = (slug: string) => nodes.find((n) => n.node_slug === slug)!.id;
        return { id: group.id, idOf, nodes };
      };
      return { additive: await build('additive'), apply: await build('apply') };
    }

    /** The stored edge set plus one more — apply_task_graph wants the whole set. */
    async function edgesPlus(groupId: string, extra: { from: string; to: string }) {
      const stored = await groups.getEdges(groupId);
      return [...stored.map((e) => ({ from: e.from_task, to: e.to_task })), extra];
    }

    it('both refuse an inbound edge to a PASSED gate, with the same reason', async () => {
      const twins = await twinGraphs('passed-gate');
      for (const side of [twins.additive, twins.apply]) {
        const claimed = await groups.claimGraphTask({
          userId: USER,
          taskId: side.idOf('work'),
          sessionId,
        });
        await groups.completeGraphTask({
          userId: USER,
          taskId: side.idOf('work'),
          sessionId,
          claimToken: claimed.claimToken as string,
          outcome: 'completed',
        });
        const gate = (await nodesOf(side.id)).find((n) => n.node_slug === 'sibling-review')!;
        await groups.recordGateVerdict({
          userId: USER,
          taskId: gate.id,
          verdict: 'passed',
          expectedAttempt: 1,
          expectedGateVersion: gate.gate_version,
          actorIdentityId: reviewer,
          evidence: { note: 'parity' },
        });
      }

      const newEdge = (side: { idOf: (s: string) => string }) => ({
        from: side.idOf('late'),
        to: side.idOf('sibling-review'),
      });

      const viaAdditive = await groups.addGraphNodes({
        userId: USER,
        taskGroupId: twins.additive.id,
        expectedVersion: await version(twins.additive.id),
        nodes: [],
        edges: [newEdge(twins.additive)],
        systemActor: true,
      });
      const viaApply = await groups.applyTaskGraph({
        userId: USER,
        taskGroupId: twins.apply.id,
        expectedVersion: await version(twins.apply.id),
        edges: await edgesPlus(twins.apply.id, newEdge(twins.apply)),
        systemActor: true,
      });

      expect(viaAdditive.success).toBe(false);
      expect(viaAdditive.reason).toBe(viaApply.reason);
      expect(viaApply.reason).toBe('passed-gate-inbound');
    });

    it('both refuse a cycle, with the same reason', async () => {
      const twins = await twinGraphs('cycle');
      const backEdge = (side: { idOf: (s: string) => string }) => ({
        from: side.idOf('merge'),
        to: side.idOf('work'),
      });

      const viaAdditive = await groups.addGraphNodes({
        userId: USER,
        taskGroupId: twins.additive.id,
        expectedVersion: await version(twins.additive.id),
        nodes: [],
        edges: [backEdge(twins.additive)],
        systemActor: true,
      });
      const viaApply = await groups.applyTaskGraph({
        userId: USER,
        taskGroupId: twins.apply.id,
        expectedVersion: await version(twins.apply.id),
        edges: await edgesPlus(twins.apply.id, backEdge(twins.apply)),
        systemActor: true,
      });

      expect(viaAdditive.success).toBe(false);
      expect(viaAdditive.reason).toBe(viaApply.reason);
      expect(viaApply.reason).toBe('cycle');
    });

    it('both grant a live gate the same fresh window when its inbound set changes', async () => {
      const twins = await twinGraphs('fresh-window');
      const before = {
        additive: (await nodesOf(twins.additive.id)).find((n) => n.node_slug === 'sibling-review')!,
        apply: (await nodesOf(twins.apply.id)).find((n) => n.node_slug === 'sibling-review')!,
      };
      const newEdge = (side: { idOf: (s: string) => string }) => ({
        from: side.idOf('late'),
        to: side.idOf('sibling-review'),
      });

      const viaAdditive = await groups.addGraphNodes({
        userId: USER,
        taskGroupId: twins.additive.id,
        expectedVersion: await version(twins.additive.id),
        nodes: [],
        edges: [newEdge(twins.additive)],
        systemActor: true,
      });
      const viaApply = await groups.applyTaskGraph({
        userId: USER,
        taskGroupId: twins.apply.id,
        expectedVersion: await version(twins.apply.id),
        edges: await edgesPlus(twins.apply.id, newEdge(twins.apply)),
        systemActor: true,
      });

      expect(viaAdditive.success).toBe(true);
      expect(viaApply.success).toBe(true);
      expect(viaAdditive.resetGates).toEqual([before.additive.id]);
      expect(viaApply.resetGates).toEqual([before.apply.id]);

      const after = {
        additive: (await nodesOf(twins.additive.id)).find((n) => n.node_slug === 'sibling-review')!,
        apply: (await nodesOf(twins.apply.id)).find((n) => n.node_slug === 'sibling-review')!,
      };
      // Same resulting gate state and the same version delta on both paths —
      // the bump is what makes an in-flight verdict CAS-bounce.
      expect(after.additive.gate_state).toBe(after.apply.gate_state);
      expect(after.additive.gate_version - before.additive.gate_version).toBe(
        after.apply.gate_version - before.apply.gate_version
      );
    });

    it('both refuse the same way on a stale version and on a bad actor count', async () => {
      const twins = await twinGraphs('refusals');

      const staleAdditive = await groups.addGraphNodes({
        userId: USER,
        taskGroupId: twins.additive.id,
        expectedVersion: 999,
        nodes: [],
        edges: [],
        systemActor: true,
      });
      const staleApply = await groups.applyTaskGraph({
        userId: USER,
        taskGroupId: twins.apply.id,
        expectedVersion: 999,
        edges: [],
        systemActor: true,
      });
      expect(staleAdditive.reason).toBe(staleApply.reason);
      expect(staleApply.reason).toBe('version-conflict');

      // Two actors named at once: neither function may pick one.
      const actorsAdditive = await groups.addGraphNodes({
        userId: USER,
        taskGroupId: twins.additive.id,
        expectedVersion: await version(twins.additive.id),
        nodes: [],
        edges: [],
        actorIdentityId: reviewer,
        actorUserId: USER,
      });
      const actorsApply = await groups.applyTaskGraph({
        userId: USER,
        taskGroupId: twins.apply.id,
        expectedVersion: await version(twins.apply.id),
        edges: [],
        actorIdentityId: reviewer,
        actorUserId: USER,
      });
      expect(actorsAdditive.reason).toBe(actorsApply.reason);
      expect(actorsApply.reason).toBe('exactly-one-actor');
    });
  });
});
