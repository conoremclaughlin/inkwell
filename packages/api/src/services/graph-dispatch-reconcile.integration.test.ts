/**
 * reconcileInterruptedDispatches — startup recovery for interrupted turns.
 *
 * The bug this covers is a SILENT one: a node stays stamped as dispatched,
 * the sweep keeps skipping it for 30 minutes, and nothing anywhere reports a
 * problem. Nobody is blocked by an error; the work simply stops. So the tests
 * that matter are not "does the stamp disappear" but "does the sweep dispatch
 * the node afterwards, when it refused to before" — the before/after on real
 * dispatch behaviour, driven through dispatchEvaluation itself.
 *
 * The safety property is the mirror image: a node another live session has
 * CLAIMED must keep its stamp and must not be re-dispatched. That one can only
 * be tested against the real column the SQL filters on.
 *
 * Requires .env.local with SUPABASE_URL + SUPABASE_SECRET_KEY.
 * Skipped automatically when credentials are unavailable.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import dotenv from 'dotenv';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { randomUUID } from 'crypto';
import { INTEGRATION_TEST_USER_ID } from '../test/integration-fixtures';
import type { Database } from '../data/supabase/types';
import { TaskGroupsRepository } from '../data/repositories/task-groups.repository';
import { ActivityStreamRepository } from '../data/repositories/activity-stream.repository';
import { GraphExecutorService, type GraphEvaluation } from './graph-executor.service';

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

// Dispatch must not actually wake anyone; what we assert is whether the
// executor DECIDED to dispatch, which is its return value.
vi.mock('../mcp/tools/inbox-handlers', () => ({
  handleSendToInbox: vi.fn().mockResolvedValue({ content: [] }),
}));
vi.mock('../auth/resolve-identity', () => ({
  resolveAgentSlug: vi.fn().mockResolvedValue('wren'),
}));

d('reconcileInterruptedDispatches (real DB)', () => {
  let client: SupabaseClient<Database>;
  let groups: TaskGroupsRepository;
  let executor: GraphExecutorService;
  let reviewer: string;
  let sessionId: string;
  const groupIds: string[] = [];

  /** A graph-mode group with one unclaimed, ready work node. */
  async function newGraphGroupWithWork(
    title: string
  ): Promise<{ groupId: string; taskId: string }> {
    const groupId = randomUUID();
    // Work nodes carry no assignee (add_graph_nodes refuses it as a gate
    // field), so the dispatch recipient resolves via the group owner.
    const { error } = await client
      .from('task_groups')
      .insert({ id: groupId, user_id: USER, title, sb_id: reviewer });
    if (error) throw new Error(`fixture group: ${error.message}`);
    groupIds.push(groupId);

    const converted = await groups.convertToGraph({
      userId: USER,
      taskGroupId: groupId,
      expectedVersion: 0,
      systemActor: true,
    });
    if (converted.success !== true)
      throw new Error(`fixture convert: ${JSON.stringify(converted)}`);

    const added = await groups.addGraphNodes({
      userId: USER,
      taskGroupId: groupId,
      expectedVersion: Number(converted.graphVersion ?? 1),
      nodes: [{ slug: 'work', type: 'work', title: 'do the thing' }],
      edges: [],
      systemActor: true,
    });
    if (added.success !== true) throw new Error(`fixture nodes: ${JSON.stringify(added)}`);

    const { data } = await client
      .from('tasks')
      .select('id')
      .eq('task_group_id', groupId)
      .eq('node_slug', 'work')
      .single();
    return { groupId, taskId: data!.id };
  }

  /** Stand in for a dispatch that happened in a process that no longer exists. */
  async function stamp(taskId: string, extra: Record<string, unknown> = {}): Promise<void> {
    const { error } = await client
      .from('tasks')
      .update({
        metadata: { ...extra, graphDispatchedAt: new Date().toISOString() },
      } as never)
      .eq('id', taskId);
    if (error) throw new Error(`fixture stamp: ${error.message}`);
  }

  async function metadataOf(taskId: string): Promise<Record<string, unknown>> {
    const { data } = await client.from('tasks').select('metadata').eq('id', taskId).single();
    return (data!.metadata || {}) as Record<string, unknown>;
  }

  /** The sweep's own dispatch decision for one ready work node. */
  async function dispatchOnce(groupId: string, taskId: string) {
    const group = await groups.findById(groupId);
    const evaluation: GraphEvaluation = {
      readyWork: [{ id: taskId, title: 'do the thing' }],
      openedGates: [],
      openGates: [],
      scheduledGates: [],
      dependencyFailures: [],
      groupComplete: false,
      counts: { total: 1, completed: 0, failed: 0, skipped: 0 },
    } as unknown as GraphEvaluation;
    return executor.dispatchEvaluation(USER, group!, evaluation, { dedupe: true });
  }

  beforeAll(async () => {
    client = createClient<Database>(SUPABASE_URL!, SUPABASE_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    groups = new TaskGroupsRepository(client);
    const composer = {
      getClient: () => client,
      repositories: {
        taskGroups: groups,
        activityStream: new ActivityStreamRepository(client),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    executor = new GraphExecutorService(composer);

    const { data } = await client.from('agent_identities').select('id').limit(1).maybeSingle();
    if (!data?.id) throw new Error('fixture: no agent identity');
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

  /**
   * The whole point, stated as behaviour: the sweep refuses the node, the
   * reconciliation runs, the sweep now dispatches it. Asserting only that the
   * key vanished would pass even if the dedupe check read some other field.
   */
  it('turns a node the sweep was skipping back into one it dispatches', async () => {
    const { groupId, taskId } = await newGraphGroupWithWork('__reconcile_redispatch');
    await stamp(taskId);

    const before = await dispatchOnce(groupId, taskId);
    expect(before.skipped).toContain(taskId);
    expect(before.triggered).not.toContain(taskId);

    const result = await executor.reconcileInterruptedDispatches();
    expect(result.cleared).toBeGreaterThanOrEqual(1);

    const after = await dispatchOnce(groupId, taskId);
    expect(after.triggered).toContain(taskId);
  });

  /**
   * Read-modify-write on a single JSONB column is how the stamp is cleared, so
   * the failure mode to pin is clobbering everything else in there.
   */
  it('clears only the dispatch stamp and leaves the rest of metadata intact', async () => {
    const { taskId } = await newGraphGroupWithWork('__reconcile_metadata');
    await stamp(taskId, { repoRoot: '/somewhere', attempts: 3 });

    await executor.reconcileInterruptedDispatches();

    const meta = await metadataOf(taskId);
    expect(meta.graphDispatchedAt).toBeUndefined();
    expect(meta.repoRoot).toBe('/somewhere');
    expect(meta.attempts).toBe(3);
  });

  /**
   * The safety property. A claimed node belongs to a session that may well be
   * alive and mid-turn; clearing its stamp is how this fix would turn into a
   * duplicate-dispatch bug. The evaluator also filters claimed nodes out of
   * its ready sets, so this is defence in depth — which is the point.
   */
  it('leaves a claimed node stamped, however stale the stamp looks', async () => {
    const { taskId } = await newGraphGroupWithWork('__reconcile_claimed');
    await stamp(taskId);

    // Claimed through the real RPC: execution state is executor-owned and the
    // DB refuses a hand-written claimed_by_session_id outright.
    const claim = await groups.claimGraphTask({ userId: USER, taskId, sessionId });
    if (claim.success !== true) throw new Error(`fixture claim: ${JSON.stringify(claim)}`);

    const result = await executor.reconcileInterruptedDispatches();
    expect(result.cleared).toBeGreaterThanOrEqual(0);

    const meta = await metadataOf(taskId);
    expect(meta.graphDispatchedAt).toBeDefined();
  });

  /**
   * Scope: only groups the sweep would act on. A paused group is deliberately
   * not executing, and quietly re-arming its nodes at every restart would
   * resume work nobody asked to resume.
   */
  it('does not touch a paused group', async () => {
    const { groupId, taskId } = await newGraphGroupWithWork('__reconcile_paused');
    await stamp(taskId);
    await client
      .from('task_groups')
      .update({ status: 'paused' } as never)
      .eq('id', groupId);

    await executor.reconcileInterruptedDispatches();

    const meta = await metadataOf(taskId);
    expect(meta.graphDispatchedAt).toBeDefined();
  });

  it('is a no-op it can survive running twice', async () => {
    const { taskId } = await newGraphGroupWithWork('__reconcile_idempotent');
    await stamp(taskId);

    const first = await executor.reconcileInterruptedDispatches();
    expect(first.cleared).toBeGreaterThanOrEqual(1);

    const second = await executor.reconcileInterruptedDispatches();
    const meta = await metadataOf(taskId);
    expect(meta.graphDispatchedAt).toBeUndefined();
    expect(second.groups).toBeGreaterThanOrEqual(1);
  });
});
