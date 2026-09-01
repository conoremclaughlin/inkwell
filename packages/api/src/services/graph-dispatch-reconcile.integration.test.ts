/**
 * reconcileInterruptedDispatches — startup recovery for interrupted turns.
 *
 * The bug this covers is SILENT: a node stays stamped as dispatched, the sweep
 * keeps skipping it for 30 minutes, and nothing anywhere reports a problem.
 * Nobody is blocked by an error; the work simply stops. So the primary test is
 * not "does the stamp disappear" but "does the sweep dispatch the node
 * afterwards, when it refused to before" — the before/after on real dispatch
 * behaviour, driven through dispatchEvaluation itself.
 *
 * The dangerous direction is the opposite one, and it is what PR #559 review
 * caught: clearing a stamp that belongs to a session which is still alive
 * re-dispatches work someone is already doing. Two guards exist for that and
 * both are pinned here — a live CLI session on the thread vetoes the group,
 * and a stamp newer than the cutoff is never touched. Neither is visible to a
 * mock, because both live in the RPC's SQL.
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

/** Far enough ahead that every stamp these tests write counts as stale. */
const LATER = () => new Date(Date.now() + 60_000);

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
  const groupIds: string[] = [];
  const sessionIds: string[] = [];

  /** A graph-mode group on its own thread, with one unclaimed work node. */
  async function newGraphGroupWithWork(
    title: string
  ): Promise<{ groupId: string; taskId: string; threadKey: string }> {
    const groupId = randomUUID();
    const threadKey = `graph:${groupId}`;
    // Work nodes carry no assignee (add_graph_nodes refuses it as a gate
    // field), so the dispatch recipient resolves via the group owner.
    const { error } = await client
      .from('task_groups')
      .insert({ id: groupId, user_id: USER, title, sb_id: reviewer, thread_key: threadKey });
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
    return { groupId, taskId: data!.id, threadKey };
  }

  async function newSession(fields: Record<string, unknown>): Promise<string> {
    const { data, error } = await client
      .from('sessions')
      .insert({ user_id: USER, ...fields } as never)
      .select('id')
      .single();
    if (error) throw new Error(`fixture session: ${error.message}`);
    sessionIds.push(data!.id);
    return data!.id;
  }

  /** Exactly what the shutdown path leaves behind (interrupt-active-runs.ts). */
  const interruptedSession = (threadKey: string) =>
    newSession({
      thread_key: threadKey,
      lifecycle: 'idle',
      status: 'resumable',
      metadata: { interruptedAt: new Date().toISOString(), interruptedReason: 'server-shutdown' },
    });

  /** Stand in for a dispatch that happened in a process that no longer exists. */
  async function stamp(
    taskId: string,
    extra: Record<string, unknown> = {},
    at: Date = new Date()
  ): Promise<void> {
    const { error } = await client
      .from('tasks')
      .update({ metadata: { ...extra, graphDispatchedAt: at.toISOString() } } as never)
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
    const evaluation = {
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
      repositories: { taskGroups: groups, activityStream: new ActivityStreamRepository(client) },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    executor = new GraphExecutorService(composer);

    const { data } = await client.from('agent_identities').select('id').limit(1).maybeSingle();
    if (!data?.id) throw new Error('fixture: no agent identity');
    reviewer = data.id;
  });

  afterAll(async () => {
    for (const id of groupIds) {
      await client.from('tasks').delete().eq('task_group_id', id);
      await client.from('task_groups').delete().eq('id', id);
    }
    for (const id of sessionIds) await client.from('sessions').delete().eq('id', id);
  });

  /**
   * The whole point, stated as behaviour: the sweep refuses the node, the
   * reconciliation runs, the sweep now dispatches it. Asserting only that the
   * key vanished would pass even if the dedupe check read some other field.
   */
  it('turns a node the sweep was skipping back into one it dispatches', async () => {
    const { groupId, taskId, threadKey } = await newGraphGroupWithWork('__reconcile_redispatch');
    await stamp(taskId);
    await interruptedSession(threadKey);

    const before = await dispatchOnce(groupId, taskId);
    expect(before.skipped).toContain(taskId);
    expect(before.triggered).not.toContain(taskId);

    const result = await executor.reconcileInterruptedDispatches(LATER());
    expect(result.cleared).toBeGreaterThanOrEqual(1);

    const after = await dispatchOnce(groupId, taskId);
    expect(after.triggered).toContain(taskId);
  });

  /**
   * BLOCKER 1 (Lumen, PR #559). The original version assumed a stamp that
   * outlived the process was stale, because dispatched sessions are the
   * server's own children. They are not always: when a CLI is attached or
   * recently polling, the trigger skips spawning and an existing CLI session
   * takes the work — and it survives the restart holding an unclaimed
   * dispatch. Clearing that stamp re-dispatches live work.
   */
  it('refuses to clear when a CLI session on the thread is still alive', async () => {
    const { taskId, threadKey } = await newGraphGroupWithWork('__reconcile_cli_alive');
    await stamp(taskId);
    // Both present: the turn that died AND a CLI that is still here. Liveness
    // has to win over the evidence of death, or the veto is useless.
    await interruptedSession(threadKey);
    await newSession({
      thread_key: threadKey,
      cli_attached: true,
      lifecycle: 'running',
      updated_at: new Date().toISOString(),
    });

    await executor.reconcileInterruptedDispatches(LATER());

    expect((await metadataOf(taskId)).graphDispatchedAt).toBeDefined();
  });

  it('refuses to clear when a session on the thread polled recently', async () => {
    const { taskId, threadKey } = await newGraphGroupWithWork('__reconcile_cli_poll');
    await stamp(taskId);
    await interruptedSession(threadKey);
    await newSession({ thread_key: threadKey, cli_poll_at: new Date().toISOString() });

    await executor.reconcileInterruptedDispatches(LATER());

    expect((await metadataOf(taskId)).graphDispatchedAt).toBeDefined();
  });

  /**
   * BLOCKER 2 (Lumen, PR #559). The original cleared the key with a
   * read-modify-write on the whole metadata blob, so a dispatch landing
   * mid-round had its fresh stamp erased by a stale snapshot. The cutoff makes
   * a newer stamp invisible to the sweep-up entirely.
   */
  it('leaves a stamp newer than the cutoff alone', async () => {
    const { taskId, threadKey } = await newGraphGroupWithWork('__reconcile_fresh_stamp');
    await interruptedSession(threadKey);
    const cutoff = new Date();
    // A dispatch that lands after recovery began.
    await stamp(taskId, {}, new Date(cutoff.getTime() + 5_000));

    await executor.reconcileInterruptedDispatches(cutoff);

    expect((await metadataOf(taskId)).graphDispatchedAt).toBeDefined();
  });

  /**
   * Death is never inferred from a restart any more: with no finished session
   * on the thread, there is no evidence the turn is over.
   */
  it('does nothing without positive evidence that a session on the thread finished', async () => {
    const { taskId } = await newGraphGroupWithWork('__reconcile_no_evidence');
    await stamp(taskId);

    await executor.reconcileInterruptedDispatches(LATER());

    expect((await metadataOf(taskId)).graphDispatchedAt).toBeDefined();
  });

  /**
   * The key is removed in place, so the failure mode to pin is carrying over a
   * stale snapshot of everything else in the column.
   */
  it('clears only the dispatch stamp and leaves the rest of metadata intact', async () => {
    const { taskId, threadKey } = await newGraphGroupWithWork('__reconcile_metadata');
    await stamp(taskId, { repoRoot: '/somewhere', attempts: 3 });
    await interruptedSession(threadKey);

    await executor.reconcileInterruptedDispatches(LATER());

    const meta = await metadataOf(taskId);
    expect(meta.graphDispatchedAt).toBeUndefined();
    expect(meta.repoRoot).toBe('/somewhere');
    expect(meta.attempts).toBe(3);
  });

  /**
   * A claimed node belongs to a session that may well be alive and mid-turn.
   * The evaluator also filters claimed nodes out of its ready sets, so this is
   * defence in depth — which is the point.
   */
  it('leaves a claimed node stamped, however stale the stamp looks', async () => {
    const { taskId, threadKey } = await newGraphGroupWithWork('__reconcile_claimed');
    await stamp(taskId);
    await interruptedSession(threadKey);
    // Claimed through the real RPC: execution state is executor-owned and the
    // DB refuses a hand-written claimed_by_session_id outright.
    const holder = await newSession({});
    const claim = await groups.claimGraphTask({ userId: USER, taskId, sessionId: holder });
    if (claim.success !== true) throw new Error(`fixture claim: ${JSON.stringify(claim)}`);

    await executor.reconcileInterruptedDispatches(LATER());

    expect((await metadataOf(taskId)).graphDispatchedAt).toBeDefined();
  });

  /**
   * Scope: only groups the sweep would act on. A paused group is deliberately
   * not executing, and quietly re-arming its nodes at every restart would
   * resume work nobody asked to resume.
   */
  it('does not touch a paused group', async () => {
    const { groupId, taskId, threadKey } = await newGraphGroupWithWork('__reconcile_paused');
    await stamp(taskId);
    await interruptedSession(threadKey);
    await client
      .from('task_groups')
      .update({ status: 'paused' } as never)
      .eq('id', groupId);

    await executor.reconcileInterruptedDispatches(LATER());

    expect((await metadataOf(taskId)).graphDispatchedAt).toBeDefined();
  });

  it('survives running twice', async () => {
    const { taskId, threadKey } = await newGraphGroupWithWork('__reconcile_idempotent');
    await stamp(taskId);
    await interruptedSession(threadKey);

    const first = await executor.reconcileInterruptedDispatches(LATER());
    expect(first.cleared).toBeGreaterThanOrEqual(1);

    await executor.reconcileInterruptedDispatches(LATER());
    expect((await metadataOf(taskId)).graphDispatchedAt).toBeUndefined();
  });

  /** One malformed stamp must not abort the round for everything else. */
  it('tolerates an unparseable dispatch stamp', async () => {
    const bad = await newGraphGroupWithWork('__reconcile_bad_stamp');
    await client
      .from('tasks')
      .update({ metadata: { graphDispatchedAt: 'not-a-timestamp' } } as never)
      .eq('id', bad.taskId);
    await interruptedSession(bad.threadKey);

    const good = await newGraphGroupWithWork('__reconcile_bad_stamp_neighbour');
    await stamp(good.taskId);
    await interruptedSession(good.threadKey);

    await executor.reconcileInterruptedDispatches(LATER());

    expect((await metadataOf(good.taskId)).graphDispatchedAt).toBeUndefined();
    expect((await metadataOf(bad.taskId)).graphDispatchedAt).toBe('not-a-timestamp');
  });

  /**
   * ROUND 2 P1 (Lumen). Requiring merely "some finished session on the thread"
   * made the evidence thread-wide and permanent: one interrupted session would
   * authorise clearing every stamp written on that thread forever after. The
   * gap is real — a freshly dispatched recipient that has not reached
   * `running` yet does not match `alive`, so its live stamp would be cleared
   * on the strength of week-old evidence. Evidence must post-date the stamp it
   * invalidates.
   */
  it('ignores a terminal session that finished BEFORE the stamp was written', async () => {
    const { taskId, threadKey } = await newGraphGroupWithWork('__reconcile_old_evidence');
    // Interrupted an hour ago...
    await newSession({
      thread_key: threadKey,
      lifecycle: 'idle',
      status: 'resumable',
      metadata: {
        interruptedAt: new Date(Date.now() - 3_600_000).toISOString(),
        interruptedReason: 'server-shutdown',
      },
    });
    // ...but this dispatch went out just now, to someone who has not started.
    await stamp(taskId);

    await executor.reconcileInterruptedDispatches(LATER());

    expect((await metadataOf(taskId)).graphDispatchedAt).toBeDefined();
  });

  /**
   * ROUND 2 P0 (Lumen). SECURITY DEFINER plus PostgreSQL's default PUBLIC
   * EXECUTE made this callable through PostgREST by anyone holding the anon or
   * authenticated role — and it takes no user id at all, so a single call
   * re-arms dispatches across every user's active graph groups. Asserting the
   * grant table would be weaker than this: what matters is that a real client
   * holding the public key is refused.
   */
  describe('privileges', () => {
    const ANON =
      process.env.SUPABASE_PUBLISHABLE_KEY ||
      process.env.SUPABASE_ANON_KEY ||
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    it.skipIf(!ANON)('refuses a caller holding the public anon key', async () => {
      const anonClient = createClient<Database>(SUPABASE_URL!, ANON!, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
      const { error } = await anonClient.rpc('reconcile_graph_dispatch_stamps', {
        p_stale_before: new Date().toISOString(),
      } as never);
      expect(error).not.toBeNull();
    });

    it.skipIf(!ANON)('refuses the anon key on the internal timestamp helper too', async () => {
      const anonClient = createClient<Database>(SUPABASE_URL!, ANON!, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error } = await (anonClient as any).rpc('_graph_safe_ts', { p: '2026-01-01' });
      expect(error).not.toBeNull();
    });

    it('still allows the service role that the server actually uses', async () => {
      const result = await executor.reconcileInterruptedDispatches(new Date(0));
      expect(result.cleared).toBe(0); // epoch cutoff: nothing qualifies, but the call must work
    });
  });
});
