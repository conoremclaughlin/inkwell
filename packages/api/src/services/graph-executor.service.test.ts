/**
 * GraphExecutorService — unit tests (mocked composer).
 *
 * The DB owns the transitions (integration-tested in
 * ../data/task-graph-executor.integration.test.ts); what these tests pin is
 * the app half's POSTURE:
 *   - reclaim fires only for provably-ended sessions and fails closed on
 *     every uncertainty (live, unverifiable, missing)
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
  type GraphEvaluation,
  type GraphClaimRef,
} from './graph-executor.service';
import { handleSendToInbox } from '../mcp/tools/inbox-handlers';

vi.mock('../mcp/tools/inbox-handlers', () => ({
  handleSendToInbox: vi.fn().mockResolvedValue({ content: [] }),
}));
vi.mock('../auth/resolve-identity', () => ({
  resolveAgentSlug: vi.fn().mockResolvedValue('wren'),
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
  sessionRow?: { id: string; status: string | null; ended_at: string | null } | null;
  sessionLookupError?: boolean;
  taskStamps?: Record<string, string>;
}

function makeComposer(cfg: ComposerConfig = {}) {
  const releases: Array<Record<string, unknown>> = [];
  const groupUpdates: Array<Record<string, unknown>> = [];
  const activities: Array<Record<string, unknown>> = [];

  const client = {
    from(table: string) {
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
  });

  it('reclaims a claim whose holder session has ended', async () => {
    const { releases, result } = await runSweep(
      { sessionRow: { id: 's-1', status: 'active', ended_at: new Date().toISOString() } },
      [claim]
    );
    expect(result.reclaimed).toBe(1);
    expect(releases[0]).toMatchObject({ taskId: 't-1', claimToken: 'tok-1', reclaim: true });
  });

  it('a live session keeps its claim — quiet is not abandoned', async () => {
    const { releases, result } = await runSweep(
      { sessionRow: { id: 's-1', status: 'active', ended_at: null } },
      [claim]
    );
    expect(result.reclaimed).toBe(0);
    expect(releases).toHaveLength(0);
  });

  it('an unverifiable session keeps its claim — lookup errors fail closed', async () => {
    const { releases, result } = await runSweep({ sessionLookupError: true }, [claim]);
    expect(result.reclaimed).toBe(0);
    expect(releases).toHaveLength(0);
  });

  it('a missing session row keeps its claim — absence is not proof of death', async () => {
    const { releases, result } = await runSweep({ sessionRow: null }, [claim]);
    expect(result.reclaimed).toBe(0);
    expect(releases).toHaveLength(0);
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
