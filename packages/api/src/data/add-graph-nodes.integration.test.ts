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
});
