/**
 * GraphExecutorService — unit tests (mocked composer).
 *
 * The DB owns the transitions (integration-tested in
 * ../data/task-graph-executor.integration.test.ts); what these tests pin is
 * the app half's POSTURE:
 *   - reclaim fires only on process facts (a crash nobody is present for,
 *     or an idle window plus no open turn), never on ended_at or a completed
 *     status, and fails closed on every uncertainty (live, unverifiable,
 *     missing)
 *   - sweep dedupe never suppresses a fresh gate opening, and never
 *     re-triggers a recently-dispatched standing node
 *   - a complete evaluation finalizes the group instead of dispatching
 *   - human assignees are surfaced, not messaged into a void
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DataComposer } from '../data/composer';
import type { TaskGroup } from '../data/repositories/task-groups.repository';
import {
  GraphExecutorService,
  releaseGraphClaimsForSession,
  type GraphEvaluation,
  type GraphClaimRef,
} from './graph-executor.service';
import { handleSendToInbox } from '../mcp/tools/inbox-handlers';

vi.mock('../mcp/tools/inbox-handlers', () => ({
  handleSendToInbox: vi.fn().mockResolvedValue({ content: [] }),
}));
vi.mock('../auth/resolve-identity', () => ({
  resolveSbSlug: vi.fn().mockResolvedValue('wren'),
}));

// The #506 boundary primitive: tests drive it directly. Defaults to
// MID-TURN (the fail-closed answer) so no test accidentally passes because
// the mock was permissive.
const { midTurnMock, liveMock } = vi.hoisted(() => ({
  midTurnMock: vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
  // Presence, same fail-closed default: LIVE unless a test says otherwise.
  liveMock: vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
}));
vi.mock('./studio-lease.service', () => ({
  StudioLeaseService: class {
    isSessionMidTurn = midTurnMock;
    isSessionLive = liveMock;
  },
}));

const sendMock = vi.mocked(handleSendToInbox);

const USER = 'u-1';

const baseGroup = {
  id: 'g-1',
  user_id: USER,
  sb_id: 'ident-1',
  title: 'test group',
  status: 'active',
  execution_model: 'graph',
  execution_phase: 'worker_active',
  thread_key: 'thread:test',
  metadata: {},
} as unknown as TaskGroup;

const emptyEval: GraphEvaluation = {
  readyWork: [],
  openedGates: [],
  openGates: [],
  scheduledGates: [],
  dependencyFailures: [],
  groupComplete: false,
  counts: { total: 2, completed: 0, failed: 0, skipped: 0 },
};

interface ComposerConfig {
  sessionRow?: {
    id: string;
    status: string | null;
    ended_at: string | null;
    lifecycle?: string | null;
    turn_epoch?: string | null;
  } | null;
  sessionLookupError?: boolean;
  taskStamps?: Record<string, string>;
}

function makeComposer(cfg: ComposerConfig = {}) {
  const releases: Array<Record<string, unknown>> = [];
  const groupUpdates: Array<Record<string, unknown>> = [];
  const activities: Array<Record<string, unknown>> = [];
  const tablesRead: string[] = [];

  const client = {
    from(table: string) {
      tablesRead.push(table);
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        in: () =>
          Promise.resolve({
            data: Object.entries(cfg.taskStamps ?? {}).map(([id, at]) => ({
              id,
              metadata: { graphDispatchedAt: at },
            })),
            error: null,
          }),
        maybeSingle: () => {
          if (table === 'sessions') {
            return cfg.sessionLookupError
              ? Promise.resolve({ data: null, error: { message: 'boom' } })
              : Promise.resolve({ data: cfg.sessionRow ?? null, error: null });
          }
          return Promise.resolve({ data: { metadata: {} }, error: null });
        },
        update: () => ({ eq: () => Promise.resolve({ data: null, error: null }) }),
      };
      return chain;
    },
  };

  const composer = {
    getClient: () => client,
    repositories: {
      taskGroups: {
        releaseGraphClaim: vi.fn(async (params: Record<string, unknown>) => {
          releases.push(params);
          return { success: true };
        }),
        update: vi.fn(async (_id: string, input: Record<string, unknown>) => {
          groupUpdates.push(input);
          return baseGroup;
        }),
        findById: vi.fn(async () => baseGroup),
        sweepTaskGraph: vi.fn(),
        listActiveGraphGroups: vi.fn(async () => []),
      },
      activityStream: {
        logActivity: vi.fn(async (a: Record<string, unknown>) => {
          activities.push(a);
        }),
      },
    },
  };

  return {
    composer: composer as unknown as DataComposer,
    releases,
    groupUpdates,
    activities,
    tablesRead,
  };
}

const claim: GraphClaimRef = {
  taskId: 't-1',
  title: 'node',
  taskType: 'work',
  sessionId: 's-1',
  claimToken: 'tok-1',
  claimedAt: new Date().toISOString(),
};

/** A claim well past the idle-reclaim window (default 30 min). */
const oldClaim: GraphClaimRef = {
  ...claim,
  claimedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
};

function sweepResult(claims: GraphClaimRef[]) {
  return { success: true, evaluation: emptyEval, claims };
}

async function runSweep(cfg: ComposerConfig, claims: GraphClaimRef[]) {
  const ctx = makeComposer(cfg);
  const repos = ctx.composer.repositories.taskGroups as unknown as {
    listActiveGraphGroups: ReturnType<typeof vi.fn>;
    sweepTaskGraph: ReturnType<typeof vi.fn>;
  };
  repos.listActiveGraphGroups.mockResolvedValue([
    { id: 'g-1', user_id: USER, title: 'test group' },
  ]);
  repos.sweepTaskGraph.mockResolvedValue(sweepResult(claims));
  const service = new GraphExecutorService(ctx.composer);
  const result = await service.sweepAll();
  return { ...ctx, result };
}

describe('GraphExecutorService reclaim (fail-closed)', () => {
  beforeEach(() => {
    sendMock.mockClear();
    midTurnMock.mockClear();
    midTurnMock.mockResolvedValue(true);
    liveMock.mockClear();
    liveMock.mockResolvedValue(true);
  });

  it("reclaims at once from a crashed holder nobody is present for — lifecycle 'failed' (round-1 P1)", async () => {
    liveMock.mockResolvedValue(false);
    const { releases, result } = await runSweep(
      { sessionRow: { id: 's-1', status: 'active', ended_at: null, lifecycle: 'failed' } },
      [claim]
    );
    expect(result.reclaimed).toBe(1);
    expect(releases[0]).toMatchObject({ taskId: 't-1', claimToken: 'tok-1', reclaim: true });
    expect(liveMock).toHaveBeenCalledWith('s-1', USER);
  });

  /**
   * T6 (session lifecycle §6). A crashed row is a statement about the LAST
   * run. A turn that has started since (an attached CLI, a run admitted
   * before its running write) is present, and its claim is not ours to take.
   */
  it('keeps the claim of a crashed holder that is present again', async () => {
    liveMock.mockResolvedValue(true);
    const { releases, result } = await runSweep(
      { sessionRow: { id: 's-1', status: 'active', ended_at: null, lifecycle: 'failed' } },
      [claim]
    );
    expect(result.reclaimed).toBe(0);
    expect(releases).toHaveLength(0);
  });

  /**
   * T6. ended_at, status 'completed' and lifecycle 'completed' are written
   * by the agent (end_session, update_session_state) from inside a live turn,
   * and an ended session can be resumed. None of them is evidence the turn is
   * over: a fresh claim is kept, whatever the row says about the session.
   */
  it.each([
    ['ended_at', { status: 'active', ended_at: new Date().toISOString(), lifecycle: 'running' }],
    ["status 'completed'", { status: 'completed', ended_at: null, lifecycle: 'running' }],
    ["lifecycle 'completed'", { status: 'active', ended_at: null, lifecycle: 'completed' }],
  ])('a fresh claim survives %s on its holder — not proof the turn is over', async (_l, row) => {
    liveMock.mockResolvedValue(false);
    midTurnMock.mockResolvedValue(false);
    const { releases, result } = await runSweep({ sessionRow: { id: 's-1', ...row } }, [claim]);
    expect(result.reclaimed).toBe(0);
    expect(releases).toHaveLength(0);
  });

  it('an ended holder mid-turn keeps even an old claim', async () => {
    midTurnMock.mockResolvedValue(true);
    const { releases, result } = await runSweep(
      {
        sessionRow: {
          id: 's-1',
          status: 'completed',
          ended_at: new Date().toISOString(),
          lifecycle: 'completed',
        },
      },
      [oldClaim]
    );
    expect(result.reclaimed).toBe(0);
    expect(releases).toHaveLength(0);
  });

  it('an ended holder past the window loses its claim once provably not mid-turn', async () => {
    midTurnMock.mockResolvedValue(false);
    const { releases, result } = await runSweep(
      {
        sessionRow: {
          id: 's-1',
          status: 'completed',
          ended_at: new Date().toISOString(),
          lifecycle: 'completed',
        },
      },
      [oldClaim]
    );
    expect(result.reclaimed).toBe(1);
    expect(releases[0]).toMatchObject({ reclaim: true });
  });

  /**
   * PR #724 review (Lumen). Both paths decide on a snapshot of the holder,
   * and the claim token does not change when a new turn takes the session.
   * The release is therefore fenced on the turn_epoch read WITH the
   * decision, so release_graph_claim refuses if the turn moved since.
   */
  it.each([
    ['crashed, nothing present', { lifecycle: 'failed' }, claim],
    ['idle past the window, not mid-turn', { lifecycle: 'idle' }, oldClaim],
  ] as const)('fences the release on the epoch it decided on — %s', async (_l, row, c) => {
    liveMock.mockResolvedValue(false);
    midTurnMock.mockResolvedValue(false);
    const { releases, result } = await runSweep(
      {
        sessionRow: { id: 's-1', status: 'active', ended_at: null, turn_epoch: 'epoch-1', ...row },
      },
      [c]
    );
    expect(result.reclaimed).toBe(1);
    expect(releases[0]).toMatchObject({ fenceTurnEpoch: true, expectedTurnEpoch: 'epoch-1' });
  });

  it('fences on a NULL epoch too — a row that never had one must still not have one', async () => {
    liveMock.mockResolvedValue(false);
    const { releases } = await runSweep(
      { sessionRow: { id: 's-1', status: 'active', ended_at: null, lifecycle: 'failed' } },
      [claim]
    );
    expect(releases[0]).toMatchObject({ fenceTurnEpoch: true, expectedTurnEpoch: null });
  });

  /**
   * T6. Activity rows are fire-and-forget telemetry (agent_complete is logged
   * before the final session write, and a failed run logs error instead). The
   * decision never reads them, so a missing row cannot change it.
   */
  it('decides from the session row and presence alone — no activity row is read', async () => {
    liveMock.mockResolvedValue(false);
    const { tablesRead, result } = await runSweep(
      { sessionRow: { id: 's-1', status: 'active', ended_at: null, lifecycle: 'failed' } },
      [claim]
    );
    expect(result.reclaimed).toBe(1);
    expect(tablesRead.filter((t) => t !== 'sessions')).toEqual([]);
  });

  it('a fresh claim on a live session is kept without even consulting the turn signal', async () => {
    const { releases, result } = await runSweep(
      { sessionRow: { id: 's-1', status: 'active', ended_at: null, lifecycle: 'idle' } },
      [claim]
    );
    expect(result.reclaimed).toBe(0);
    expect(releases).toHaveLength(0);
    expect(midTurnMock).not.toHaveBeenCalled();
  });

  it('an idle session past the window loses its claim once provably not mid-turn (round-1 P1)', async () => {
    midTurnMock.mockResolvedValue(false);
    const { releases, result } = await runSweep(
      { sessionRow: { id: 's-1', status: 'active', ended_at: null, lifecycle: 'idle' } },
      [oldClaim]
    );
    expect(result.reclaimed).toBe(1);
    expect(releases[0]).toMatchObject({ reclaim: true });
    expect(midTurnMock).toHaveBeenCalledWith('s-1', USER);
  });

  it('an idle session past the window KEEPS its claim while mid-turn — never steal from a live turn', async () => {
    midTurnMock.mockResolvedValue(true);
    const { releases, result } = await runSweep(
      { sessionRow: { id: 's-1', status: 'active', ended_at: null, lifecycle: 'idle' } },
      [oldClaim]
    );
    expect(result.reclaimed).toBe(0);
    expect(releases).toHaveLength(0);
  });

  it('an unverifiable session keeps its claim — lookup errors fail closed', async () => {
    const { releases, result } = await runSweep({ sessionLookupError: true }, [oldClaim]);
    expect(result.reclaimed).toBe(0);
    expect(releases).toHaveLength(0);
  });

  it('a missing session row keeps its claim — absence is not proof of death', async () => {
    const { releases, result } = await runSweep({ sessionRow: null }, [oldClaim]);
    expect(result.reclaimed).toBe(0);
    expect(releases).toHaveLength(0);
  });
});

/**
 * PR #724 review (Lumen). The boundary release checked the session's epoch,
 * then released by token. The release now hands the same epoch to
 * release_graph_claim, which re-checks it under the row lock.
 */
describe('releaseGraphClaimsForSession fences each release on the boundary epoch', () => {
  function boundaryClient(turnEpoch: string | null) {
    const rpcCalls: Array<Record<string, unknown>> = [];
    const client = {
      from(table: string) {
        const chain: Record<string, unknown> = {
          select: () => chain,
          eq: () => chain,
          lte: () =>
            Promise.resolve({
              data: table === 'tasks' ? [{ id: 't-1', user_id: USER, claim_token: 'tok-1' }] : [],
              error: null,
            }),
          maybeSingle: () => Promise.resolve({ data: { turn_epoch: turnEpoch }, error: null }),
        };
        return chain;
      },
      rpc: (_fn: string, args: Record<string, unknown>) => {
        rpcCalls.push(args);
        return Promise.resolve({ data: { success: true }, error: null });
      },
    };
    return { client, rpcCalls };
  }

  it('passes the epoch it checked to the release', async () => {
    const { client, rpcCalls } = boundaryClient('epoch-1');
    const released = await releaseGraphClaimsForSession(
      client as never,
      's-1',
      'cli-turn-stopped',
      new Date().toISOString(),
      'epoch-1'
    );
    expect(released).toBe(1);
    expect(rpcCalls[0]).toMatchObject({
      p_session_id: 's-1',
      p_fence_turn_epoch: true,
      p_expected_turn_epoch: 'epoch-1',
    });
  });

  it('an unfenced (legacy) boundary stays unfenced', async () => {
    const { client, rpcCalls } = boundaryClient(null);
    await releaseGraphClaimsForSession(client as never, 's-1', 'legacy-stop');
    expect(rpcCalls[0]).toMatchObject({ p_fence_turn_epoch: false, p_expected_turn_epoch: null });
  });
});

describe('GraphExecutorService startGroup', () => {
  it('refuses to resurrect a terminal group (r3)', async () => {
    const ctx = makeComposer();
    const repos = ctx.composer.repositories.taskGroups as unknown as {
      findById: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };
    repos.findById.mockResolvedValue({ ...baseGroup, status: 'cancelled' });
    const service = new GraphExecutorService(ctx.composer);
    const result = await service.startGroup(USER, 'g-1');
    expect(result).toMatchObject({ success: false, reason: 'group-terminal' });
    expect(repos.update).not.toHaveBeenCalled();
  });
});

describe('GraphExecutorService dispatch', () => {
  beforeEach(() => {
    sendMock.mockClear();
  });

  it('sweep dedupe skips a recently-dispatched standing node', async () => {
    const { composer } = makeComposer({
      taskStamps: { 't-1': new Date(Date.now() - 60_000).toISOString() },
    });
    const service = new GraphExecutorService(composer);
    const result = await service.dispatchEvaluation(
      USER,
      baseGroup,
      { ...emptyEval, readyWork: [{ id: 't-1', title: 'node' }] },
      { dedupe: true }
    );
    expect(result.skipped).toEqual(['t-1']);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('sweep dedupe re-triggers once the redispatch interval has passed', async () => {
    const { composer } = makeComposer({
      taskStamps: { 't-1': new Date(Date.now() - 45 * 60_000).toISOString() },
    });
    const service = new GraphExecutorService(composer);
    const result = await service.dispatchEvaluation(
      USER,
      baseGroup,
      { ...emptyEval, readyWork: [{ id: 't-1', title: 'node' }] },
      { dedupe: true }
    );
    expect(result.triggered).toEqual(['t-1']);
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('a freshly-opened gate is always dispatched, even under sweep dedupe', async () => {
    const { composer } = makeComposer({
      taskStamps: { 'gate-1': new Date(Date.now() - 1000).toISOString() },
    });
    const service = new GraphExecutorService(composer);
    const result = await service.dispatchEvaluation(
      USER,
      baseGroup,
      {
        ...emptyEval,
        openedGates: [{ id: 'gate-1', title: 'gate', attempt: 1, assigneeIdentityId: 'ident-1' }],
        openGates: [{ id: 'gate-1', title: 'gate', attempt: 1, assigneeIdentityId: 'ident-1' }],
      },
      { dedupe: true }
    );
    expect(result.triggered).toEqual(['gate-1']);
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('a complete evaluation finalizes the group instead of dispatching', async () => {
    const ctx = makeComposer();
    const service = new GraphExecutorService(ctx.composer);
    await service.dispatchEvaluation(
      USER,
      baseGroup,
      {
        ...emptyEval,
        groupComplete: true,
        counts: { total: 2, completed: 2, failed: 0, skipped: 0 },
      },
      { dedupe: false }
    );
    expect(ctx.groupUpdates[0]).toMatchObject({
      status: 'completed',
      execution_phase: 'completed',
    });
    // Owner notified of completion; nothing dispatched as work.
    expect(sendMock).toHaveBeenCalledTimes(1);
    const sent = sendMock.mock.calls[0][0] as Record<string, unknown>;
    expect(String(sent.content)).toContain('complete');
  });

  it('a NEW failed source on an already-notified destination re-surfaces (round-1 P2)', async () => {
    const ctx = makeComposer();
    const service = new GraphExecutorService(ctx.composer);
    const oneSource = {
      id: 'd1',
      title: 'downstream',
      sources: [{ id: 's1', title: 'a', state: 'failed' }],
    };

    await service.dispatchEvaluation(
      USER,
      baseGroup,
      { ...emptyEval, dependencyFailures: [oneSource] },
      { dedupe: true }
    );
    const failureCount = () =>
      ctx.activities.filter((a) => a.subtype === 'graph_dependency_failure').length;
    expect(failureCount()).toBe(1);
    const stampedKey = (ctx.groupUpdates.at(-1)?.metadata as Record<string, unknown>)
      .graphDepFailuresNotified as string;

    // Same failure set on a stamped group → suppressed.
    const stampedGroup = {
      ...baseGroup,
      metadata: { graphDepFailuresNotified: stampedKey },
    } as TaskGroup;
    await service.dispatchEvaluation(
      USER,
      stampedGroup,
      { ...emptyEval, dependencyFailures: [oneSource] },
      { dedupe: true }
    );
    expect(failureCount()).toBe(1);

    // A SECOND source failing on the SAME destination is fresh information.
    const twoSources = {
      ...oneSource,
      sources: [...oneSource.sources, { id: 's2', title: 'b', state: 'skipped' }],
    };
    await service.dispatchEvaluation(
      USER,
      stampedGroup,
      { ...emptyEval, dependencyFailures: [twoSources] },
      { dedupe: true }
    );
    expect(failureCount()).toBe(2);
  });

  it('recovery clears the failure stamp, so an identical refail on a NEW attempt re-surfaces (r2 P2)', async () => {
    const ctx = makeComposer();
    const service = new GraphExecutorService(ctx.composer);
    const failureAttempt1 = {
      id: 'd1',
      title: 'downstream',
      sources: [{ id: 'g1', title: 'gate', state: 'failed', attempt: 1 }],
    };
    const failureCount = () =>
      ctx.activities.filter((a) => a.subtype === 'graph_dependency_failure').length;

    await service.dispatchEvaluation(
      USER,
      baseGroup,
      { ...emptyEval, dependencyFailures: [failureAttempt1] },
      { dedupe: true }
    );
    expect(failureCount()).toBe(1);
    const stampedKey = (ctx.groupUpdates.at(-1)?.metadata as Record<string, unknown>)
      .graphDepFailuresNotified as string;
    const stampedGroup = {
      ...baseGroup,
      metadata: { graphDepFailuresNotified: stampedKey },
    } as TaskGroup;

    // Retry recovers the gate: no failures → the stamp is CLEARED.
    await service.dispatchEvaluation(USER, stampedGroup, { ...emptyEval }, { dedupe: true });
    const clearedMeta = ctx.groupUpdates.at(-1)?.metadata as Record<string, unknown>;
    expect(clearedMeta.graphDepFailuresNotified).toBeUndefined();

    // Attempt 2 refails the same way: with attempt in the key this is a
    // DIFFERENT fact even against a stale stamp — it re-surfaces.
    const failureAttempt2 = {
      ...failureAttempt1,
      sources: [{ ...failureAttempt1.sources[0], attempt: 2 }],
    };
    await service.dispatchEvaluation(
      USER,
      stampedGroup,
      { ...emptyEval, dependencyFailures: [failureAttempt2] },
      { dedupe: true }
    );
    expect(failureCount()).toBe(2);
  });

  it('a human-assigned gate is surfaced as awaiting-human, never messaged as an agent', async () => {
    const ctx = makeComposer();
    const service = new GraphExecutorService(ctx.composer);
    const result = await service.dispatchEvaluation(
      USER,
      baseGroup,
      {
        ...emptyEval,
        openedGates: [{ id: 'gate-1', title: 'approval', attempt: 1, assigneeUserId: 'human-1' }],
      },
      { dedupe: false }
    );
    expect(result.triggered).toEqual([]);
    expect(sendMock).not.toHaveBeenCalled();
    expect(ctx.activities.some((a) => a.subtype === 'graph_awaiting_human')).toBe(true);
  });
});

// No-progress breaker (spec session-lifecycle-model §5). A fake breaker keeps
// these tests independent of the composer's one-size table chain.
function fakeBreaker(held: string[] = []) {
  return {
    readTaskStates: vi.fn(
      async (_userId: string, ids: string[]) =>
        new Map(ids.map((id) => [id, { fingerprint: `fp-${id}`, revision: '0' }]))
    ),
    admitMany: vi.fn(
      async (_userId: string, _source: string, items: Array<{ workId: string }>) =>
        new Map(
          items.map((i) => [
            i.workId,
            held.includes(i.workId)
              ? { allowed: false as const, trippedAt: '2026-10-02T10:10:00.000Z' }
              : { allowed: true as const, clearTrip: false },
          ])
        )
    ),
    resetGroup: vi.fn(async () => undefined),
  };
}

describe('GraphExecutorService no-progress breaker', () => {
  beforeEach(() => {
    sendMock.mockClear();
  });

  it('does not dispatch a node the breaker holds, even past the redispatch interval', async () => {
    const { composer } = makeComposer({
      taskStamps: { 't-1': new Date(Date.now() - 45 * 60_000).toISOString() },
    });
    const service = new GraphExecutorService(composer);
    const breaker = fakeBreaker(['t-1']);
    service.setWakeBreaker(breaker as never);
    const result = await service.dispatchEvaluation(
      USER,
      baseGroup,
      {
        ...emptyEval,
        readyWork: [
          { id: 't-1', title: 'stuck node' },
          { id: 't-2', title: 'moving node' },
        ],
      },
      { dedupe: true }
    );
    expect(result.skipped).toEqual(['t-1']);
    expect(result.triggered).toEqual(['t-2']);
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(breaker.admitMany).toHaveBeenCalledWith(USER, 'graph_dispatch', [
      { workId: 't-1', revision: '0', fingerprint: 'fp-t-1' },
      { workId: 't-2', revision: '0', fingerprint: 'fp-t-2' },
    ]);
  });

  it('tags a dispatch with the node state and the identity it reached', async () => {
    const { composer } = makeComposer();
    const service = new GraphExecutorService(composer);
    service.setWakeBreaker(fakeBreaker() as never);
    await service.dispatchEvaluation(
      USER,
      baseGroup,
      { ...emptyEval, readyWork: [{ id: 't-1', title: 'node', assigneeIdentityId: 'ident-9' }] },
      { dedupe: false }
    );
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0][2]).toEqual({
      wakeSource: {
        source: 'graph_dispatch',
        workKind: 'graph_node',
        workId: 't-1',
        revision: '0',
        fingerprint: 'fp-t-1',
        dispatchedAt: expect.any(String),
        taskGroupId: 'g-1',
        ownerSbId: 'ident-9',
      },
    });
  });

  it('starting execution gives every node a fresh count', async () => {
    const ctx = makeComposer();
    const repos = ctx.composer.repositories.taskGroups as unknown as {
      sweepTaskGraph: ReturnType<typeof vi.fn>;
    };
    repos.sweepTaskGraph.mockResolvedValue({ success: true, evaluation: emptyEval, claims: [] });
    const service = new GraphExecutorService(ctx.composer);
    const breaker = fakeBreaker();
    service.setWakeBreaker(breaker as never);
    await service.startGroup(USER, 'g-1');
    expect(breaker.resetGroup).toHaveBeenCalledWith(USER, 'graph_dispatch', 'g-1');
  });
});
