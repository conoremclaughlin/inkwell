/**
 * The idle-compaction wiring in SessionService: an ink run that ends large
 * arms a compaction turn for just before its prompt cache expires, the turn
 * goes to that same session, and the compaction turn itself never arms
 * another (idle-compaction-scheduler.ts covers the timing rules).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionService, type IActivityStream } from './session-service.js';
import { resetActiveRuns } from './active-runs.js';
import { resetLaunchHolds } from './launched-processes.js';
import { DEFAULT_IDLE_COMPACTION_CONFIG } from './idle-compaction-scheduler.js';
import { logger } from '../../utils/logger.js';
import type {
  ClaudeRunnerResult,
  IClaudeRunner,
  IContextBuilder,
  InjectedContext,
  ISessionRepository,
  Session,
} from './types.js';

vi.mock('../principals.js', () => ({
  workspaceOfSb: vi.fn(async () => 'ws-1'),
  personalWorkspaceOf: vi.fn(async () => 'ws-1'),
}));

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('./claude-runner.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, buildIdentityPrompt: vi.fn(() => 'mocked-identity-prompt') };
});

const HOUR_MS = 60 * 60 * 1000;

const inkSession = (overrides: Partial<Session> = {}): Session =>
  ({
    id: 'session-ink',
    userId: 'user-456',
    sbSlug: 'myra',
    backendSessionId: 'claude-native-1',
    type: 'primary',
    status: 'active',
    lifecycle: 'idle',
    contextTokens: 1000,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    messageCount: 0,
    tokenCount: 0,
    backend: 'ink',
    model: null,
    lastCompactionAt: null,
    compactionCount: 0,
    endedAt: null,
    metadata: {},
    startedAt: new Date(),
    lastActivityAt: new Date(),
    ...overrides,
  }) as Session;

const context = (): InjectedContext =>
  ({
    agent: {
      sbSlug: 'myra',
      name: 'Myra',
      role: 'assistant',
      values: [],
      capabilities: [],
      relationships: {},
      backend: 'ink',
    },
    user: {
      id: 'user-456',
      timezone: 'America/Los_Angeles',
      contacts: {},
      preferences: {},
    },
    temporal: {
      currentTime: '10:00 AM',
      currentDate: '2026-10-11',
      dayOfWeek: 'Sunday',
      timezone: 'America/Los_Angeles',
      greeting: 'Good evening',
    },
    recentMemories: [],
    activeProjects: [],
  }) as unknown as InjectedContext;

const inkResult = (
  usage: Partial<NonNullable<ClaudeRunnerResult['usage']>>
): ClaudeRunnerResult => ({
  success: true,
  backendSessionId: 'claude-native-1',
  responses: [],
  usage: { contextTokens: 72_000, inputTokens: 1000, outputTokens: 500, ...usage },
  finalTextResponse: 'ok',
});

describe('SessionService idle compaction', () => {
  let session: Session;
  let repository: ISessionRepository;
  let inkRunner: IClaudeRunner;
  let service: SessionService;

  const message = (content = 'Hello, Myra!') => ({
    userId: 'user-456',
    sbSlug: 'myra',
    channel: 'telegram' as const,
    conversationId: 'chat-123',
    sender: { id: '123456789', name: 'TestUser' },
    content,
    metadata: {},
  });

  beforeEach(() => {
    // The logger mock outlives a test; one test's log must not satisfy the next.
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-12T06:00:00.000Z'));
    resetActiveRuns();
    resetLaunchHolds();
    session = inkSession();
    repository = {
      findByUserAndAgent: vi.fn(async () => session),
      findById: vi.fn(async (id: string) => (id === session.id ? session : null)),
      findByUser: vi.fn(async () => [session]),
      create: vi.fn(async () => session),
      update: vi.fn(async (_id: string, updates: Partial<Session>) => {
        session = { ...session, ...updates };
        return session;
      }),
      reopenEnded: vi.fn(async () => ({ kind: 'reopened', session })),
      updateTokenUsage: vi.fn(async () => undefined),
      markCompacted: vi.fn(async () => undefined),
      tryAcquireCompactionLock: vi.fn(async () => true),
      releaseCompactionLock: vi.fn(async () => undefined),
    } as unknown as ISessionRepository;
    const contextBuilder = {
      buildContext: vi.fn(async () => context()),
      buildMinimalContext: vi.fn(async () => ({
        temporal: context().temporal,
        agent: context().agent,
      })),
      getAgentBackend: vi.fn(async () => ({ backend: 'ink', provider: null })),
    } as unknown as IContextBuilder;
    const claudeRunner: IClaudeRunner = {
      uploadMedia: 'grant',
      run: vi.fn(async () => inkResult({})),
    };
    inkRunner = {
      uploadMedia: 'grant',
      // The run's last provider request starts as it is called (fake clock).
      run: vi.fn(async () =>
        inkResult({
          providerContextTokens: 292_000,
          cacheTtlSeconds: 3600,
          lastRequestStartedAt: new Date().toISOString(),
        })
      ),
    };
    const activityStream = {
      logMessage: vi.fn(async () => ({ id: 'msg-1' })),
      logActivity: vi.fn(async () => ({ id: 'activity-1' })),
      tagActivityTaskGroup: vi.fn(async () => undefined),
    } as unknown as IActivityStream;
    service = new SessionService(
      repository,
      contextBuilder,
      claudeRunner,
      activityStream,
      {
        defaultWorkingDirectory: '/test',
        mcpConfigPath: '/test/.mcp.json',
        idleCompaction: DEFAULT_IDLE_COMPACTION_CONFIG,
      },
      undefined,
      undefined,
      undefined,
      inkRunner
    );
  });

  afterEach(() => {
    service.stopIdleCompaction();
    vi.useRealTimers();
  });

  const runPrompts = () =>
    (inkRunner.run as ReturnType<typeof vi.fn>).mock.calls.map((call) => String(call[0]));

  it('sends the session a compaction turn five minutes before its one-hour cache expires', async () => {
    await service.handleMessage(message());
    expect(runPrompts()).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(55 * 60 * 1000 - 1);
    expect(runPrompts()).toHaveLength(1);

    // The compaction turn leaves the context small, as compact_context does.
    (inkRunner.run as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      inkResult({ providerContextTokens: 86_000, cacheTtlSeconds: 3600 })
    );
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(runPrompts()).toHaveLength(2));
    expect(runPrompts()[1]).toContain('[IDLE COMPACTION]');
    expect(runPrompts()[1]).toContain('about 292k tokens');
    expect(runPrompts()[1]).toContain('compact_context');
    // Resumed on the same native session, so it reads the cache warm.
    const options = (inkRunner.run as ReturnType<typeof vi.fn>).mock.calls[1][1];
    expect(options.backendSessionId).toBe('claude-native-1');
  });

  it('a compaction turn that leaves the context large does not arm another', async () => {
    await service.handleMessage(message());
    await vi.advanceTimersByTimeAsync(55 * 60 * 1000);
    await vi.waitFor(() => expect(runPrompts()).toHaveLength(2));

    // A positive signal that the compaction turn finished and declined to arm:
    // fake timers do not flush the turn's real I/O, so "no third run yet"
    // alone would pass before a re-armed turn had time to land.
    await vi.waitFor(() =>
      expect(logger.info).toHaveBeenCalledWith('[IdleCompaction] idle compaction not armed', {
        sessionId: 'session-ink',
        reason: 'this run was an idle compaction',
      })
    );
    await vi.advanceTimersByTimeAsync(3 * HOUR_MS);
    expect(runPrompts()).toHaveLength(2);
  });

  it('addresses the turn to the session it was armed for, by id', async () => {
    const handle = vi.spyOn(service, 'handleMessage');
    await service.handleMessage(message());
    await vi.advanceTimersByTimeAsync(55 * 60 * 1000);
    await vi.waitFor(() => expect(handle).toHaveBeenCalledTimes(2));
    const idle = handle.mock.calls[1][0];
    expect(idle.idleCompaction).toBe(true);
    expect(idle.metadata).toMatchObject({
      recipientSessionId: 'session-ink',
      recipientSessionExplicit: true,
    });
  });

  it('a later turn moves the compaction out to its own expiry', async () => {
    await service.handleMessage(message());
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    await service.handleMessage(message('Still there?'));
    expect(runPrompts()).toHaveLength(2);

    // 55 minutes after the FIRST turn: nothing, because the second reset it.
    await vi.advanceTimersByTimeAsync(25 * 60 * 1000);
    expect(runPrompts()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    await vi.waitFor(() => expect(runPrompts()).toHaveLength(3));
    expect(runPrompts()[2]).toContain('[IDLE COMPACTION]');
  });

  it('does not arm when the provider context is under the floor', async () => {
    (inkRunner.run as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      inkResult({ providerContextTokens: 117_319, cacheTtlSeconds: 3600 })
    );
    await service.handleMessage(message());
    await vi.advanceTimersByTimeAsync(2 * HOUR_MS);
    expect(runPrompts()).toHaveLength(1);
  });
});
