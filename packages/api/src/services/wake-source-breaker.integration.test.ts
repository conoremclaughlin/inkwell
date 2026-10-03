/**
 * The no-progress breaker against a real database, through the real send path
 * (spec session-lifecycle-model §5, task T1).
 *
 * Replays PR #349's shape: an active strategy group, a pending task, and an
 * owner whose every woken turn ends with nothing changed. The watchdog's
 * message goes through handleSendToInbox and the agent gateway exactly as on
 * the server; a registered handler stands in for the server's trigger handler
 * and its finished turn, calling the same completion hook the server calls.
 * No LLM runs.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { getDataComposer, type DataComposer } from '../data/composer';
import { getAgentGateway, type AgentTriggerPayload } from '../channels/agent-gateway';
import { handleSendToInbox } from '../mcp/tools/inbox-handlers';
import { handleTriggerAgent } from '../mcp/tools/agent-triggers';
import { StrategyService } from './strategy.service';
import {
  WakeSourceBreaker,
  issueWakeSourceTag,
  recordWakeSourceCompletion,
  type WakeSourceTag,
} from './wake-source-breaker';
import {
  ensureEchoIntegrationFixture,
  ensureSuiteIdentity,
  INTEGRATION_TEST_USER_ID,
} from '../test/integration-fixtures';

/** Suite-owned identities, so no other suite's rows are touched. */
const OWNER = 'echo-wake-breaker-owner';
const TRIAGE = 'echo-wake-breaker-triage';
const USER = INTEGRATION_TEST_USER_ID;
const projectRoot = resolve(__dirname, '../../../../');

type Mode = 'no-change' | 'progress';

describe('no-progress breaker (integration)', () => {
  let dc: DataComposer;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let raw: any;
  let ownerSbId: string;
  let triageSbId: string;
  let workspaceId: string;
  let breaker: WakeSourceBreaker;
  let service: StrategyService;

  const threadKey = `thread:wake-breaker-${randomUUID()}`;
  let groupId: string;
  let taskId: string;
  let nextTaskId: string;

  /** What the stand-in agent does with each woken turn. */
  let mode: Mode = 'no-change';
  /** Every finished wake, in order, after its completion was recorded. */
  const handled: AgentTriggerPayload[] = [];

  const isWatchdog = (p: AgentTriggerPayload) =>
    (p.metadata as Record<string, unknown> | undefined)?.reason === 'watchdog';

  /** Wait for a finished wake matching `match`, newer than `since`. */
  async function waitForWake(
    since: number,
    match: (p: AgentTriggerPayload) => boolean,
    timeoutMs = 10_000
  ): Promise<AgentTriggerPayload> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = handled.slice(since).find(match);
      if (found) return found;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('no matching wake arrived');
  }

  async function breakerRow() {
    const { data } = await raw
      .from('wake_source_breakers')
      .select('*')
      .eq('user_id', USER)
      .eq('source', 'strategy_watchdog')
      .eq('work_id', groupId)
      .maybeSingle();
    return data;
  }

  beforeAll(async () => {
    dc = await getDataComposer();
    raw = dc.getClient();
    const fixture = await ensureEchoIntegrationFixture(dc);
    workspaceId = fixture.workspaceId;
    ownerSbId = await ensureSuiteIdentity(dc, fixture, OWNER);
    triageSbId = await ensureSuiteIdentity(dc, fixture, TRIAGE);

    // The owner's live session on the strategy thread: a watchdog wake is
    // sent as the owner, and its trigger needs the sender's session.
    const { data: session, error: sessionError } = await raw
      .from('sessions')
      .insert({
        user_id: USER,
        agent_id: OWNER,
        sb_id: ownerSbId,
        thread_key: threadKey,
        lifecycle: 'idle',
        started_at: new Date().toISOString(),
      })
      .select('id')
      .single();
    if (sessionError || !session) throw new Error(`session fixture: ${sessionError?.message}`);

    const group = await dc.repositories.taskGroups.create({
      user_id: USER,
      sb_id: ownerSbId,
      title: `__wake_breaker_integration_${randomUUID().slice(0, 8)}`,
      description: 'Integration test fixture',
      priority: 'low',
      tags: ['__test'],
      metadata: { repoRoot: projectRoot },
      thread_key: threadKey,
      strategy: 'persistence',
      strategy_config: {},
    });
    groupId = group.id;
    const task = await dc.repositories.tasks.create({
      user_id: USER,
      title: 'Fixture task that never moves',
      task_group_id: groupId,
      task_order: 0,
      priority: 'low',
      created_by: 'integration-test',
    });
    taskId = task.id;
    // The task a real step of progress moves on to.
    const next = await dc.repositories.tasks.create({
      user_id: USER,
      title: 'Fixture task after it',
      task_group_id: groupId,
      task_order: 1,
      priority: 'low',
      created_by: 'integration-test',
    });
    nextTaskId = next.id;

    breaker = new WakeSourceBreaker(dc, { notifySlug: TRIAGE });
    service = new StrategyService(dc);
    service.setWakeBreaker(breaker);

    const gateway = getAgentGateway();
    gateway.registerHandler(OWNER, async (payload) => {
      if (payload.routeOnly) return;
      if (mode === 'progress' && isWatchdog(payload)) {
        // Real progress: the turn finishes its task and the strategy moves on,
        // as complete_task would. Taking a task up (in_progress) is not
        // progress: it is what a claim does (Lumen, #725 finding 1).
        await raw.from('tasks').update({ status: 'completed' }).eq('id', taskId);
        await raw.from('task_groups').update({ current_task_index: 1 }).eq('id', groupId);
      }
      // The server's trigger handler, after a successful turn.
      await recordWakeSourceCompletion(
        dc,
        USER,
        { ...(payload.metadata ?? {}), triggerTurnCompleted: true },
        breaker
      );
      handled.push(payload);
    });
    gateway.registerHandler(TRIAGE, async () => undefined);
  }, 30_000);

  afterAll(async () => {
    const gateway = getAgentGateway();
    gateway.unregisterHandler(OWNER);
    gateway.unregisterHandler(TRIAGE);
    if (!raw) return;
    await raw.from('wake_source_breakers').delete().eq('user_id', USER).eq('work_id', groupId);
    const { data: threads } = await raw
      .from('inbox_threads')
      .select('id')
      .in('thread_key', [threadKey, 'ops:wake-breaker:strategy_watchdog'])
      .eq('workspace_id', workspaceId);
    for (const t of threads ?? []) {
      await raw.from('inbox_thread_read_status').delete().eq('thread_id', t.id);
      await raw.from('inbox_thread_messages').delete().eq('thread_id', t.id);
      await raw.from('inbox_thread_participants').delete().eq('thread_id', t.id);
      await raw.from('inbox_threads').delete().eq('id', t.id);
    }
    if (groupId) {
      await raw.from('task_group_comments').delete().eq('task_group_id', groupId);
      await raw.from('activity_stream').delete().eq('task_group_id', groupId);
      await raw
        .from('scheduled_reminders')
        .delete()
        .contains('metadata', { groupId } as never);
    }
    await raw.from('tasks').delete().in('id', [taskId, nextTaskId].filter(Boolean));
    if (groupId) await raw.from('task_groups').delete().eq('id', groupId);
    await raw.from('sessions').delete().eq('user_id', USER).in('agent_id', [OWNER, TRIAGE]);
    await raw.from('agent_identities').delete().in('id', [ownerSbId, triageSbId]);
  }, 30_000);

  it("trips after three woken turns that change nothing (PR #349's shape)", async () => {
    for (let i = 1; i <= 3; i += 1) {
      const since = handled.length;
      const result = await service.triggerWatchdog(groupId);
      expect(result.outcome).toBe('fired');
      await waitForWake(since, isWatchdog);
      const row = await breakerRow();
      expect(row?.no_progress_count).toBe(i);
    }

    const row = await breakerRow();
    expect(row?.tripped_at).not.toBeNull();
    expect(row?.trip_count).toBe(1);
    expect(row?.owner_sb_id).toBe(ownerSbId);
    expect(row?.last_notice_at).not.toBeNull();

    // One notice on the work item, for its owner.
    const { data: comments } = await raw
      .from('task_group_comments')
      .select('content, metadata')
      .eq('task_group_id', groupId);
    const notices = (comments ?? []).filter(
      (c: { metadata: Record<string, unknown> | null }) => c.metadata?.wakeBreaker
    );
    expect(notices).toHaveLength(1);
    expect(notices[0].content).toContain('No-progress breaker tripped');

    // One notice to triage.
    const { data: triageThread } = await raw
      .from('inbox_threads')
      .select('id')
      .eq('thread_key', 'ops:wake-breaker:strategy_watchdog')
      .eq('workspace_id', workspaceId)
      .maybeSingle();
    expect(triageThread).not.toBeNull();
    const { data: triageMessages } = await raw
      .from('inbox_thread_messages')
      .select('metadata')
      .eq('thread_id', triageThread.id);
    const forThisGroup = (triageMessages ?? []).filter(
      (m: { metadata: Record<string, unknown> }) =>
        (m.metadata?.wakeBreaker as Record<string, unknown> | undefined)?.workId === groupId
    );
    expect(forThisGroup).toHaveLength(1);
  }, 60_000);

  it('the next watchdog check pauses the strategy and wakes nobody', async () => {
    const before = handled.length;
    const result = await service.triggerWatchdog(groupId);
    expect(result.outcome).toBe('skipped');
    expect(result).toMatchObject({ reason: expect.stringContaining('no-progress breaker') });
    const group = await dc.repositories.taskGroups.findById(groupId);
    expect(group?.status).toBe('paused');
    await new Promise((r) => setTimeout(r, 300));
    expect(handled.length).toBe(before);
  });

  /**
   * A tag a caller puts in metadata, signed with this process's key: the worst
   * case, a copy of a genuine tag. Only the ingress strip keeps it out, so
   * these tests prove the strip; the signature check has its own unit tests.
   */
  function signedForgery(): WakeSourceTag {
    return issueWakeSourceTag({
      source: 'strategy_watchdog',
      workKind: 'task_group',
      workId: groupId,
      revision: '',
      fingerprint: 'forged',
      dispatchedAt: new Date().toISOString(),
      taskGroupId: groupId,
      ownerSbId: ownerSbId,
    });
  }

  it('a human message still delivers, and a forged tag counts for nothing', async () => {
    const before = await breakerRow();
    const since = handled.length;
    await handleSendToInbox(
      {
        userId: USER,
        recipientSlug: OWNER,
        threadKey,
        content: 'Is anything blocking this?',
        // A caller cannot count attempts against someone's source.
        metadata: { wakeSource: signedForgery() },
      },
      dc,
      { sender: { principal: { kind: 'user', userId: USER }, workspaceId } }
    );
    const delivered = await waitForWake(
      since,
      (p) => (p.metadata as Record<string, unknown> | undefined)?.reason !== 'watchdog'
    );
    expect((delivered.metadata as Record<string, unknown> | undefined)?.wakeSource).toBeUndefined();
    const after = await breakerRow();
    expect(after?.no_progress_count).toBe(before?.no_progress_count);
    expect(after?.version).toBe(before?.version);
  }, 30_000);

  // Lumen, #725 finding 2: trigger_agent forwarded caller metadata verbatim.
  it('a forged tag through trigger_agent counts for nothing', async () => {
    const before = await breakerRow();
    const since = handled.length;
    await handleTriggerAgent(
      {
        userId: USER,
        toSlug: OWNER,
        fromSlug: TRIAGE,
        triggerType: 'message',
        priority: 'normal',
        threadKey,
        summary: 'forged accounting probe',
        metadata: { note: 'kept', wakeSource: signedForgery() },
      } as never,
      dc
    );
    const delivered = await waitForWake(
      since,
      (p) => (p.metadata as Record<string, unknown> | undefined)?.note === 'kept'
    );
    expect((delivered.metadata as Record<string, unknown>).wakeSource).toBeUndefined();
    const after = await breakerRow();
    expect(after?.no_progress_count).toBe(before?.no_progress_count);
    expect(after?.version).toBe(before?.version);
  }, 30_000);

  it('resume starts a fresh count, and progress keeps it at zero', async () => {
    await service.resumeStrategy(groupId, USER);
    let row = await breakerRow();
    expect(row?.no_progress_count).toBe(0);
    expect(row?.tripped_at).toBeNull();
    // The trip's history survives the reset.
    expect(row?.last_tripped_at).not.toBeNull();

    mode = 'progress';
    let since = handled.length;
    expect((await service.triggerWatchdog(groupId)).outcome).toBe('fired');
    await waitForWake(since, isWatchdog);
    row = await breakerRow();
    expect(row?.no_progress_count).toBe(0);

    mode = 'no-change';
    for (let i = 1; i <= 2; i += 1) {
      since = handled.length;
      expect((await service.triggerWatchdog(groupId)).outcome).toBe('fired');
      await waitForWake(since, isWatchdog);
    }
    row = await breakerRow();
    expect(row?.no_progress_count).toBe(2);
    expect(row?.tripped_at).toBeNull();
  }, 60_000);

  it('a heartbeat-shaped completion never creates a breaker row', async () => {
    const otherWork = randomUUID();
    for (let i = 0; i < 3; i += 1) {
      const result = await recordWakeSourceCompletion(
        dc,
        USER,
        { triggerType: 'heartbeat', reminderId: otherWork, triggerTurnCompleted: true },
        breaker
      );
      expect(result).toBeNull();
    }
    const { data } = await raw
      .from('wake_source_breakers')
      .select('id')
      .eq('user_id', USER)
      .eq('work_id', otherWork);
    expect(data ?? []).toHaveLength(0);
  });

  // Lumen, #725 finding 1, through the real RPCs: claim_graph_task and
  // release_graph_claim each bump a verification gate's gate_version, and the
  // claim moves it to in_progress. A gate worker whose turns only claim and
  // release must trip, including when a completion is read before its
  // fire-and-forget boundary release lands.
  it('graph: turns that only claim and release a gate trip the breaker', async () => {
    const graphGroup = randomUUID();
    const gate = randomUUID();
    const { data: worker, error: workerError } = await raw
      .from('sessions')
      .insert({ user_id: USER, agent_id: OWNER, sb_id: ownerSbId, lifecycle: 'idle' })
      .select('id')
      .single();
    if (workerError || !worker) throw new Error(`worker session: ${workerError?.message}`);
    const groups = dc.repositories.taskGroups;
    try {
      await raw
        .from('task_groups')
        .insert([{ id: graphGroup, user_id: USER, title: 'breaker graph' }]);
      await raw.from('tasks').insert([
        {
          id: gate,
          user_id: USER,
          task_group_id: graphGroup,
          title: 'gate',
          task_type: 'verification',
          gate_state: 'not_ready',
          assignee_identity_id: ownerSbId,
        },
      ]);
      const converted = await groups.convertToGraph({
        userId: USER,
        taskGroupId: graphGroup,
        expectedVersion: 0,
        systemActor: true,
      });
      expect(converted.success).toBe(true);
      await groups.sweepTaskGraph({ userId: USER, taskGroupId: graphGroup });
      const gateRow = async () =>
        (await raw.from('tasks').select('gate_state, gate_version').eq('id', gate).single()).data;
      expect((await gateRow())?.gate_state).toBe('open');

      const graphBreaker = new WakeSourceBreaker(dc, { notifySlug: TRIAGE });
      const outcomes: string[] = [];
      for (let i = 0; i < 3; i += 1) {
        const versionBefore = (await gateRow())?.gate_version;
        const fingerprint = await graphBreaker.readFingerprint(USER, 'graph_node', gate);
        expect(fingerprint).not.toBeNull();
        const tag = issueWakeSourceTag({
          source: 'graph_dispatch',
          workKind: 'graph_node',
          workId: gate,
          revision: '0',
          fingerprint: fingerprint!,
          dispatchedAt: new Date().toISOString(),
          taskGroupId: graphGroup,
          ownerSbId,
        });
        const claim = await groups.claimGraphTask({
          userId: USER,
          taskId: gate,
          sessionId: worker.id,
        });
        expect(claim.success).toBe(true);
        // The completion is read while the claim is still on the gate.
        const result = await graphBreaker.recordCompletedAttempt(USER, tag);
        outcomes.push(result.outcome);
        const released = await groups.releaseGraphClaim({
          userId: USER,
          taskId: gate,
          claimToken: claim.claimToken as string,
          sessionId: worker.id,
          reason: 'turn boundary',
        });
        expect(released.success).toBe(true);
        // The claim fence really moved, twice, and the state really came back.
        const after = await gateRow();
        expect(after?.gate_state).toBe('open');
        expect(after?.gate_version).toBe((versionBefore as number) + 2);
        expect(await graphBreaker.readFingerprint(USER, 'graph_node', gate)).toBe(fingerprint);
      }
      expect(outcomes).toEqual(['no_progress', 'no_progress', 'tripped']);
    } finally {
      await raw.from('wake_source_breakers').delete().eq('user_id', USER).eq('work_id', gate);
      await raw.from('task_comments').delete().eq('task_id', gate);
      await raw.from('task_gate_events').delete().eq('task_id', gate);
      await raw.from('tasks').delete().eq('id', gate);
      await raw.from('task_graph_revisions').delete().eq('task_group_id', graphGroup);
      await raw.from('task_groups').delete().eq('id', graphGroup);
      await raw.from('sessions').delete().eq('id', worker.id);
    }
  }, 60_000);
});
