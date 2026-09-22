/**
 * A verdict reached before the text was bounded is the one that decides.
 *
 * `RunnerResult.error` is an excerpt. Session-service used to classify it, and
 * that meant a text budget chosen for a log field decided a category — measured
 * on PR #662: `Error: fetch failed` above a long enough stack lands in the
 * elided middle of a 2000-character excerpt and comes out `unknown`
 * /non-retryable (Lumen, second review). A runner that saw the whole output
 * classifies it there and carries the verdict on the result.
 *
 * These pin the CONSUMER, not the field. Every test below asserts something
 * session-service does differently because of the carried value — what it
 * writes to the session row, what it records on the activity stream — with a
 * control alongside it running the same text without the carried value. A test
 * that only asserted `result.classification` exists would pass against a field
 * nothing reads.
 *
 * The harness is the one from `refused-resume-owner-state.test.ts`, which pins
 * the behaviour this rides on: an `owner_conflict` verdict means the backend
 * refused before accepting, so no outcome is recorded on the target session.
 * That is the loudest consequence a classification has, which is why it is the
 * one measured here.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SessionService } from './session-service.js';
import { makeFakeSupabase, type Row } from './fake-supabase.js';
import { resetActiveRuns } from './active-runs.js';
import { resetPendingFinalizations } from './finalize-turn.js';
import type { Session, ISessionRepository, IContextBuilder, IRunner } from './types.js';
import type { IActivityStream } from './session-service.js';
import { describeExitResult, classifyError, type ErrorClassification } from '@inklabs/shared';

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('./claude-runner.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, buildIdentityPrompt: vi.fn(() => 'mocked-identity-prompt') };
});

vi.mock('../graph-executor.service', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, releaseGraphClaimsForSession: vi.fn(async () => 0) };
});

const OWNER_THREAD = '01900000-0000-7000-8000-00000000beef';

/**
 * Enough stack to push the error line out of a 2000-character excerpt's head
 * and off the end of its tail — the shape that made a budget decide a
 * category. Synthetic paths under a reserved TLD.
 */
const STACK_FRAMES = Array.from(
  { length: 40 },
  (_, i) =>
    `    at step${i} (/tmp/example.test/node_modules/example-backend/dist/runtime/transport/request-handler.js:100:20)`
);

/**
 * What a bounded excerpt of a Codex refusal looks like once the refusal itself
 * is in the elided middle: startup noise at the head, a closing line at the
 * tail, and nothing a rule matches. Shaped like the real thing; the thread
 * handle is synthetic.
 *
 * The control below asserts this is genuinely unclassifiable, so nothing here
 * can be satisfied by the text happening to carry the answer.
 */
const EXCERPT_WITHOUT_ITS_CAUSE = [
  'Codex exited with code 1: 2026-09-21T07:51:45.685237Z INFO codex_core: starting',
  '(Use node --trace-warnings to show where the warning was created)',
  '…',
  'exitCode=1 signal=none stdoutBytes=0 stderrBytes=3527',
].join('\n');

/** The same failure with its refusal intact — the fallback path's input. */
const FULL_REFUSAL = [
  'Codex exited with code 1: failed to initialize thread persistence: thread-store conflict: thread ' +
    `${OWNER_THREAD} already has an active writer`,
  `Error: thread/resume: thread/resume failed: thread ${OWNER_THREAD} already has an active writer`,
].join('\n');

/** What a producer that could still see the whole output concluded. */
const REFUSAL_VERDICT: ErrorClassification = {
  category: 'owner_conflict',
  summary: 'thread-store conflict: thread already has an active writer',
  retryable: false,
};

function makeOwnerSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-owner',
    userId: 'user-456',
    sbSlug: 'lumen',
    studioId: null,
    backendSessionId: OWNER_THREAD,
    type: 'primary',
    lifecycle: 'running',
    status: 'active',
    cliAttached: true,
    contextTokens: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    messageCount: 7,
    tokenCount: 0,
    backend: 'codex-cli',
    model: null,
    lastCompactionAt: null,
    compactionCount: 0,
    endedAt: null,
    metadata: {},
    turnEpoch: 'owner-epoch',
    startedAt: new Date(),
    lastActivityAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as unknown as Session;
}

function makeStatefulRepo(initial: Session) {
  const state = { row: initial };
  const merge = (updates: Record<string, unknown>) => {
    state.row = { ...state.row, ...updates } as Session;
    return state.row;
  };
  const repo = {
    findById: vi.fn(async () => state.row),
    findByUserAndAgent: vi.fn(async () => state.row),
    findByUser: vi.fn(async () => [state.row]),
    create: vi.fn(async () => state.row),
    update: vi.fn(async (_id: string, updates: Record<string, unknown>) => merge(updates)),
    updateIfTurnEpoch: vi.fn(
      async (_id: string, epoch: string, updates: Record<string, unknown>) => {
        if ((state.row as { turnEpoch?: string }).turnEpoch !== epoch) return null;
        return merge(updates);
      }
    ),
    updateTokenUsage: vi.fn(async () => undefined),
    markCompacted: vi.fn(async () => undefined),
    tryAcquireCompactionLock: vi.fn(async () => true),
    releaseCompactionLock: vi.fn(async () => undefined),
  };
  return { state, repo: repo as unknown as ISessionRepository };
}

const contextBuilder = {
  buildContext: vi.fn(async () => ({
    agent: {
      sbSlug: 'lumen',
      name: 'Lumen',
      role: 'assistant',
      values: [],
      capabilities: [],
      relationships: {},
    },
    user: { id: 'user-456', timezone: 'UTC', contacts: {}, preferences: {} },
    temporal: {
      currentTime: '00:51',
      currentDate: '2026-09-21',
      dayOfWeek: 'Monday',
      timezone: 'UTC',
      greeting: 'Good evening',
    },
    recentMemories: [],
    activeProjects: [],
  })),
  buildMinimalContext: vi.fn(async () => ({})),
  getAgentBackend: vi.fn(async () => ({ backend: 'codex', provider: null })),
} as unknown as IContextBuilder;

const logActivity = vi.fn(async () => ({ id: 'activity-1' }));
const activityStream = {
  logMessage: vi.fn(async () => ({ id: 'msg-1' })),
  logActivity,
  tagActivityTaskGroup: vi.fn(async () => undefined),
} as unknown as IActivityStream;

/** One turn against a session whose runner fails with `error`, optionally carrying a verdict. */
async function runTurn(error: string, classification?: ErrorClassification) {
  const { state, repo } = makeStatefulRepo(makeOwnerSession());
  const tables: Record<string, Row[]> = {
    sessions: [{ id: 'session-owner', user_id: 'user-456', studio_id: null }],
    studios: [],
    agent_identities: [],
    inbox_threads: [],
    studio_lease_events: [],
    tasks: [],
  };
  const failingRunner: IRunner = {
    run: vi.fn(async () => ({
      success: false,
      backendSessionId: OWNER_THREAD,
      responses: [],
      error,
      ...(classification ? { classification } : {}),
    })),
  };
  const service = new SessionService(
    repo,
    contextBuilder,
    { run: vi.fn() } as unknown as IRunner,
    activityStream,
    {
      defaultWorkingDirectory: '/test',
      mcpConfigPath: '/test/.mcp.json',
      compactionThreshold: 150000,
    },
    failingRunner,
    makeFakeSupabase(tables) as never
  );

  const result = await service.handleMessage({
    userId: 'user-456',
    sbSlug: 'lumen',
    channel: 'agent',
    conversationId: 'trigger:lumen:pr:662',
    sender: { id: 'wren', name: 'Wren' },
    content: 'Review request',
    metadata: {},
  } as never);

  return { result, row: state.row };
}

/**
 * Two turns on one lock: the first fails, the second is queued behind it.
 *
 * The flush decision reads a category and either discards the queue or lets it
 * run, so `runs` is the whole assertion — 1 means the queued turn was thrown
 * away, 2 means it was dispatched. The first run parks on a gate so the second
 * call reaches the queue rather than the lock, which is the only way to get a
 * message waiting at the moment the flush decision is made.
 *
 * Harness from Lumen's r3 countertest.
 */
async function runQueuedTurn(error: string, classification?: ErrorClassification) {
  const { state, repo } = makeStatefulRepo(makeOwnerSession());
  const tables: Record<string, Row[]> = {
    sessions: [{ id: 'session-owner', user_id: 'user-456', studio_id: null }],
    studios: [],
    agent_identities: [],
    inbox_threads: [],
    studio_lease_events: [],
    tasks: [],
  };

  let started!: () => void;
  let release!: () => void;
  const startGate = new Promise<void>((resolve) => {
    started = resolve;
  });
  const finishGate = new Promise<void>((resolve) => {
    release = resolve;
  });

  let runs = 0;
  const failingRunner: IRunner = {
    run: vi.fn(async () => {
      runs++;
      // The queued turn, if it is ever dispatched, succeeds — so a flush is
      // the only thing that can keep `runs` at 1.
      if (runs > 1) return { success: true, responses: [], backendSessionId: OWNER_THREAD };
      started();
      await finishGate;
      return {
        success: false,
        backendSessionId: OWNER_THREAD,
        responses: [],
        error,
        ...(classification ? { classification } : {}),
      };
    }),
  };

  const service = new SessionService(
    repo,
    contextBuilder,
    { run: vi.fn() } as unknown as IRunner,
    activityStream,
    {
      defaultWorkingDirectory: '/test',
      mcpConfigPath: '/test/.mcp.json',
      compactionThreshold: 150000,
    },
    failingRunner,
    makeFakeSupabase(tables) as never
  );

  const request = {
    userId: 'user-456',
    sbSlug: 'lumen',
    channel: 'agent',
    conversationId: 'trigger:lumen:pr:662',
    sender: { id: 'wren', name: 'Wren' },
    content: 'Review request',
    metadata: {},
  } as never;

  const first = service.handleMessage(request);
  await startGate;
  const second = service.handleMessage(request);
  await vi.waitFor(() => {
    const queues = (service as unknown as { pendingQueues: Map<string, unknown[]> }).pendingQueues;
    expect(queues.get('lumen:session-owner')).toHaveLength(1);
  });
  release();

  // Both resolve: a flushed queue entry is rejected into handleMessage's own
  // catch, which is why that call awaits its queue promise rather than
  // returning it. So a flush shows up as `success: false`, not as a throw.
  const [result, queued] = await Promise.all([first, second]);
  return { result, queued, runs, row: state.row };
}

/** The category session-service recorded for the turn, as the activity stream saw it. */
function recordedCategory(): string | undefined {
  const turnEntry = logActivity.mock.calls
    .map((c) => c[0] as unknown as { payload?: { errorCategory?: string } })
    .reverse()
    .find((entry) => entry?.payload?.errorCategory !== undefined);
  return turnEntry?.payload?.errorCategory;
}

describe('session-service acts on the carried verdict, not on the excerpt', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetActiveRuns();
    resetPendingFinalizations();
  });
  afterEach(() => {
    resetActiveRuns();
    resetPendingFinalizations();
  });

  /**
   * The control. Without it every assertion below could be satisfied by the
   * excerpt still carrying its cause, and the carried value would be proving
   * nothing.
   */
  it('cannot classify this excerpt from its own text', async () => {
    await runTurn(EXCERPT_WITHOUT_ITS_CAUSE);

    expect(recordedCategory()).toBe('unknown');
  });

  it('records the carried category for a turn whose text no longer supports it', async () => {
    await runTurn(EXCERPT_WITHOUT_ITS_CAUSE, REFUSAL_VERDICT);

    expect(recordedCategory()).toBe('owner_conflict');
  });

  /**
   * The consequence that matters. A refusal is the one failure that says
   * nothing about the target session's own state, so it must not be written
   * onto a live owner's row — and whether this turn was a refusal is decided
   * entirely by the classification. Read off the excerpt, the owner is marked
   * dead while it is still working.
   */
  it('leaves a live owner alone when the carried verdict says the run was refused', async () => {
    const { row } = await runTurn(EXCERPT_WITHOUT_ITS_CAUSE, REFUSAL_VERDICT);

    expect(row.lifecycle).not.toBe('failed');
    expect(row.cliAttached).toBe(true);
    expect(row.messageCount).toBe(7);
  });

  it('marks the same turn failed when no verdict is carried', async () => {
    const { row } = await runTurn(EXCERPT_WITHOUT_ITS_CAUSE);

    expect(row.lifecycle).toBe('failed');
  });

  /**
   * The fallback, which is most of the fleet: no runner but ink populates the
   * field, so a failure arriving without one must classify exactly as it did
   * before. Same assertion as above, same code path, verdict derived from the
   * text instead of carried.
   */
  it('still classifies the text when a runner carries nothing', async () => {
    const { row } = await runTurn(FULL_REFUSAL);

    expect(recordedCategory()).toBe('owner_conflict');
    expect(row.lifecycle).not.toBe('failed');
  });

  /**
   * Bounded claim: a carried verdict is preferred, never invented. A
   * successful turn carries no classification onto the session result, so
   * nothing downstream can read a category for a turn that did not fail.
   */
  it('passes the verdict it acted on to its own caller', async () => {
    const { result } = await runTurn(EXCERPT_WITHOUT_ITS_CAUSE, REFUSAL_VERDICT);

    expect(result.classification).toMatchObject({ category: 'owner_conflict' });
  });

  /**
   * The queue flush, both directions (Lumen, r3).
   *
   * `flushQueueOnNonRetryableError` re-derived its own category from
   * `result.error`, so the excerpt decided whether queued work was discarded.
   * Both of these build their text through the real `describeExitResult`, and
   * both assert the excerpt genuinely disagrees with the verdict first — so
   * neither can be satisfied by the text happening to contain the answer.
   *
   * `runs` is the consequence: 1 means the queued turn was thrown away, 2
   * means it ran. Getting that wrong in one direction discards a user's
   * queued message, and in the other burns budget on a queue that cannot
   * succeed.
   */
  it('flushes the queue on a carried verdict its own excerpt cannot support', async () => {
    const raw = [
      'startup one',
      'startup two',
      'startup three',
      'Error: quota exceeded',
      ...STACK_FRAMES,
    ].join('\n');
    const failure = describeExitResult({ command: 'ink chat', exitCode: 1, stderr: raw });

    expect(failure.classification.category).toBe('quota');
    expect(classifyError({ errorText: failure.text }).category).toBe('unknown');

    const { result, queued, runs } = await runQueuedTurn(failure.text, failure.classification);

    expect(result.classification?.category).toBe('quota');
    expect(runs).toBe(1);
    expect(queued.success).toBe(false);
  });

  it('does not flush the queue on a retryable verdict whose excerpt reads worse', async () => {
    // The control, and the direction that costs a user real work: the excerpt
    // classifies `quota` (non-retryable, flush) while the verdict says
    // `capacity` (retryable, keep). A guard that flushed on everything would
    // pass the test above and fail this one.
    const raw = [
      'startup one',
      'startup two',
      'startup three',
      'Error: 503 service unavailable',
      ...STACK_FRAMES,
      'additional diagnostic: quota',
    ].join('\n');
    const failure = describeExitResult({ command: 'ink chat', exitCode: 1, stderr: raw });

    expect(failure.classification.category).toBe('capacity');
    expect(classifyError({ errorText: failure.text }).category).toBe('quota');

    const { queued, runs } = await runQueuedTurn(failure.text, failure.classification);

    expect(runs).toBe(2);
    expect(queued.success).toBe(true);
  });
});
