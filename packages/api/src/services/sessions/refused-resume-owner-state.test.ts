/**
 * A run the backend refused is not a session that died.
 *
 * Measured on spec:live-agent-surfaces, 2026-09-21. Four inkmail deliveries
 * were routed to a live Codex session; inline delivery is structurally
 * unreachable for codex-cli, so each took the spawn branch and resumed the
 * OWNER's backend thread. Codex refused all four — `thread-store conflict:
 * thread <id> already has an active writer` — and each refusal came back
 * through `processMessage` as `result.success === false`, where
 * `postRunLifecycle = result.success ? 'idle' : 'failed'` wrote
 * `lifecycle='failed', cli_attached=false` onto the owner's row. The owner
 * went on working for another fifteen minutes after the database recorded it
 * dead.
 *
 * The refusal is the one outcome that says nothing about the target session's
 * own health: no turn began, so nothing was observed. These tests pin both
 * directions — the refusal writes no outcome, and an ordinary backend failure
 * still writes one.
 *
 * Deliberately NOT asserted here, because the fix does not claim it: a
 * writer-lock conflict is not evidence the owner is alive. Nothing below
 * refreshes a registration, extends a lease, or marks the session live. The
 * row is put back the way this turn found it, and no further claim is made
 * (Lumen, spec:live-agent-surfaces).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SessionService } from './session-service.js';
import { makeFakeSupabase, type Row } from './fake-supabase.js';
import { resetActiveRuns } from './active-runs.js';
import { resetPendingFinalizations } from './finalize-turn.js';
import type { Session, ISessionRepository, IContextBuilder, IRunner } from './types.js';
import type { IActivityStream } from './session-service.js';

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('./claude-runner.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, buildIdentityPrompt: vi.fn(() => 'mocked-identity-prompt') };
});

// Spied, not stubbed wholesale: the turn-boundary release is the one effect
// whose ownership gate (the row's turnEpoch) does NOT protect the owner here,
// because the refused run genuinely holds that epoch.
vi.mock('../graph-executor.service', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, releaseGraphClaimsForSession: vi.fn(async () => 0) };
});
const { releaseGraphClaimsForSession } = await import('../graph-executor.service');

/**
 * The 2026-09-21 refusal, ANSI escapes stripped and the thread handle swapped
 * for a synthetic one — the rule keys on the sentence, and the real UUID would
 * be a live session identifier in a tracked file for no test value. Everything
 * the matcher reads is verbatim.
 */
const CODEX_WRITER_CONFLICT = [
  'Codex exited with code 1: 2026-09-21T07:51:45.685237Z ERROR codex_core::session::session: failed to initialize thread persistence: thread-store conflict: thread 01900000-0000-7000-8000-00000000beef already has an active writer',
  'Error: thread/resume: thread/resume failed: thread 01900000-0000-7000-8000-00000000beef already has an active writer (code -32600)',
  '',
  'exitCode=1 signal=none stdoutBytes=0 stderrBytes=575',
].join('\n');

/** An ordinary backend crash — the control for every assertion below. */
const ORDINARY_CRASH = 'Claude Code exited with code 1: Killed: 9';

const OWNER_THREAD = '01900000-0000-7000-8000-00000000beef';

function makeOwnerSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-owner',
    userId: 'user-456',
    sbSlug: 'lumen',
    studioId: null,
    backendSessionId: OWNER_THREAD,
    type: 'primary',
    // The owner is mid-work: this is the state the refusal must not change.
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

/**
 * One row, mutated in place by field-level merge — the property under test is
 * which COLUMNS a refused run touches, and a merge that replaces the whole row
 * would answer a different question. `updateIfTurnEpoch` enforces the epoch CAS
 * the same way the repository does: a row carrying a different epoch matches
 * zero rows and returns null.
 */
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
  return { state, repo: repo as unknown as ISessionRepository, spies: repo };
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

const activityStream = {
  logMessage: vi.fn(async () => ({ id: 'msg-1' })),
  logActivity: vi.fn(async () => ({ id: 'activity-1' })),
  tagActivityTaskGroup: vi.fn(async () => undefined),
} as unknown as IActivityStream;

/** A service wired to a codex-cli session whose runner always fails with `error`. */
function makeServiceFailingWith(
  error: string,
  initial: Session,
  opts: { gate?: Promise<void> } = {}
) {
  const { state, repo, spies } = makeStatefulRepo(initial);
  const tables: Record<string, Row[]> = {
    sessions: [{ id: initial.id, user_id: 'user-456', studio_id: null }],
    studios: [],
    agent_identities: [],
    inbox_threads: [],
    studio_lease_events: [],
    tasks: [],
  };
  const codexRunner: IRunner = {
    run: vi.fn(async () => {
      // Held open so later messages queue behind this turn rather than
      // serialising into separate lock acquisitions.
      if (opts.gate) await opts.gate;
      return { success: false, backendSessionId: OWNER_THREAD, responses: [], error };
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
    codexRunner,
    makeFakeSupabase(tables) as never
  );
  const send = () =>
    service.handleMessage({
      userId: 'user-456',
      sbSlug: 'lumen',
      channel: 'agent',
      conversationId: 'trigger:lumen:spec:live-agent-surfaces',
      sender: { id: 'wren', name: 'Wren' },
      content: 'Review request',
      // No threadKey: studio routing would need a studio fixture with a route
      // pattern and a real worktree, and none of that is on the path under
      // test. The turn-boundary control below proves the release is reachable.
      metadata: {},
    } as never);

  return { service, send, state, spies, codexRunner };
}

/** Drives one turn against a codex-cli session whose runner fails with `error`. */
async function runTurnFailingWith(error: string, initial: Session) {
  const { send, state, spies } = makeServiceFailingWith(error, initial);
  const result = await send();
  return { result, row: state.row, spies };
}

describe('a refused resume must not record an outcome on the target session', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetActiveRuns();
    resetPendingFinalizations();
  });
  afterEach(() => {
    resetActiveRuns();
    resetPendingFinalizations();
  });

  it('does not mark the live owner failed', async () => {
    const { row } = await runTurnFailingWith(CODEX_WRITER_CONFLICT, makeOwnerSession());
    expect(row.lifecycle).not.toBe('failed');
  });

  it('does not clear the owner cliAttached flag', async () => {
    const { row } = await runTurnFailingWith(CODEX_WRITER_CONFLICT, makeOwnerSession());
    expect(row.cliAttached).toBe(true);
  });

  it('does not count a message the backend never accepted', async () => {
    const { row } = await runTurnFailingWith(CODEX_WRITER_CONFLICT, makeOwnerSession());
    expect(row.messageCount).toBe(7);
  });

  /**
   * The takeover write stamps `running` before the runner spawns, so omitting
   * `lifecycle` on a refusal would leave OUR `running` standing on a session
   * we learned nothing about — which thread-spines reads as live for the next
   * thirty minutes. Restoring the pre-turn value is the only outcome that
   * claims nothing in either direction, and an idle owner is where the two
   * differ.
   */
  it('restores the pre-turn lifecycle rather than leaving the takeover running', async () => {
    const { row } = await runTurnFailingWith(
      CODEX_WRITER_CONFLICT,
      makeOwnerSession({ lifecycle: 'idle' })
    );
    expect(row.lifecycle).toBe('idle');
  });

  it('reports the turn as failed to the caller — the delivery did not happen', async () => {
    const { result } = await runTurnFailingWith(CODEX_WRITER_CONFLICT, makeOwnerSession());
    expect(result.success).toBe(false);
  });

  it('classifies the refusal on the activity entry', async () => {
    await runTurnFailingWith(CODEX_WRITER_CONFLICT, makeOwnerSession());
    const categories = vi
      .mocked(activityStream.logActivity)
      .mock.calls.map(
        (c) => (c[0].payload as { errorCategory?: string } | undefined)?.errorCategory
      )
      .filter(Boolean);
    expect(categories).toContain('owner_conflict');
  });

  /**
   * The turn-boundary effects exist because, for a server-spawned session,
   * "the run IS the turn" — so they release the claims that turn held. A
   * refused run was never a turn, and its epoch gate does not save the owner:
   * the takeover write means the refused run genuinely holds the row's epoch,
   * so `releaseGraphClaimsForSession`'s own ownership check passes and the
   * LIVE owner's claims go back to the pool.
   */
  it('does not run the turn-boundary claim release', async () => {
    await runTurnFailingWith(CODEX_WRITER_CONFLICT, makeOwnerSession());
    // Fire-and-forget inside an async IIFE — let it settle before asserting.
    await new Promise((r) => setTimeout(r, 20));
    expect(releaseGraphClaimsForSession).not.toHaveBeenCalled();
  });

  /**
   * A consequence of giving the refusal a name, and the reason it is worth
   * pinning: `flushQueueOnNonRetryableError` acts only on a classification
   * that is both non-retryable and NOT `unknown`, so this text used to fall
   * through it. Now it flushes: everything still queued for the session fails
   * with a named reason and no spawn, instead of taking its own turn at
   * resuming a thread we have just been told is held. That is the point —
   * each of those attempts is one more of the event this change exists to
   * stop.
   */
  it('flushes the rest of the queue instead of re-resuming a held thread', async () => {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const { send, codexRunner } = makeServiceFailingWith(
      CODEX_WRITER_CONFLICT,
      makeOwnerSession(),
      { gate }
    );

    const first = send();
    // Both queue behind the held first turn; the flush needs something left
    // in the queue after the turn that failed.
    const queued = [send(), send()];
    open();

    await expect(first).resolves.toMatchObject({ success: false });
    const flushed = await Promise.all(queued);
    for (const r of flushed) {
      expect(r.success).toBe(false);
      // handleMessage turns the flush rejection back into a result, so the
      // sender is told why rather than getting a bare failure.
      expect(r.error).toContain('Queue flushed: owner_conflict');
    }
    // One spawn, not three: the queued messages never reached the runner.
    expect(vi.mocked(codexRunner.run)).toHaveBeenCalledTimes(1);
  });

  /**
   * Controls. Without these the fix reads as "stop recording failures", which
   * would be a worse bug than the one it replaces: a session whose backend
   * genuinely crashed has to end up `failed`, detached, and counted.
   */
  describe('an ordinary backend failure still records its outcome', () => {
    it('marks the session failed', async () => {
      const { row } = await runTurnFailingWith(ORDINARY_CRASH, makeOwnerSession());
      expect(row.lifecycle).toBe('failed');
    });

    it('clears cliAttached', async () => {
      const { row } = await runTurnFailingWith(ORDINARY_CRASH, makeOwnerSession());
      expect(row.cliAttached).toBe(false);
    });

    it('counts the message', async () => {
      const { row } = await runTurnFailingWith(ORDINARY_CRASH, makeOwnerSession());
      expect(row.messageCount).toBe(8);
    });

    // The coverage control for the boundary assertion above: without this, a
    // release that never fires on ANY path would read as the fix working.
    it('still runs the turn-boundary claim release', async () => {
      await runTurnFailingWith(ORDINARY_CRASH, makeOwnerSession());
      await new Promise((r) => setTimeout(r, 20));
      expect(releaseGraphClaimsForSession).toHaveBeenCalledWith(
        expect.anything(),
        'session-owner',
        'run-completed',
        expect.any(String),
        expect.any(String)
      );
    });
  });
});
