/**
 * Queued wakes run as one turn (spec trigger-pipe-in v7, slice 1).
 *
 * While a session's turn runs, every message for it queues. A wake only
 * points at a stored message, so a contiguous run of them can share the next
 * turn instead of each paying for its own `--resume`. These tests pin what
 * merges, what stays apart, and who owns the merged turn's replies.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SessionService } from './session-service.js';
import { StudioLeaseService } from '../studio-lease.service.js';
import type {
  Session,
  ISessionRepository,
  IContextBuilder,
  IClaudeRunner,
  InjectedContext,
  ClaudeRunnerResult,
  SessionRequest,
  SessionResult,
} from './types.js';
import type { IActivityStream } from './session-service.js';

vi.mock('../principals.js', () => ({
  workspaceOfSb: vi.fn(async () => 'ws-1'),
  personalWorkspaceOf: vi.fn(async () => 'ws-1'),
}));

// The inkling turn gate's owner proof, per stored message (see the inkling merge test).
const ownerProof = vi.hoisted(() => ({ of: new Map<string, 'yes' | 'no' | 'unreadable'>() }));
vi.mock('../inklings/inkling-turn-gate.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    isOwnersOwnMessage: vi.fn(
      async (_supabase: unknown, input: { threadMessageId?: string }) =>
        ownerProof.of.get(input.threadMessageId ?? '') ?? 'no'
    ),
  };
});
vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('./claude-runner.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, buildIdentityPrompt: vi.fn(() => 'mocked-identity-prompt') };
});

const session = (id: string): Session =>
  ({
    id,
    userId: 'user-456',
    sbSlug: 'myra',
    backendSessionId: `backend-${id}`,
    type: 'primary',
    status: 'active',
    contextTokens: 1000,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    messageCount: 1,
    tokenCount: 0,
    backend: 'claude-code',
    model: 'sonnet',
    lastCompactionAt: null,
    compactionCount: 0,
    endedAt: null,
    metadata: {},
    startedAt: new Date(),
    lastActivityAt: new Date(),
  }) as unknown as Session;

const context = (): InjectedContext => ({
  agent: {
    sbSlug: 'myra',
    name: 'Myra',
    role: 'assistant',
    values: [],
    capabilities: [],
    relationships: {},
  },
  user: { id: 'user-456', timezone: 'UTC', contacts: {}, preferences: {} },
  temporal: {
    currentTime: '10:00 AM',
    currentDate: '2026-10-06',
    dayOfWeek: 'Tuesday',
    timezone: 'UTC',
    greeting: 'Good morning',
  },
  recentMemories: [],
  activeProjects: [],
});

const runnerResult = (overrides: Partial<ClaudeRunnerResult> = {}): ClaudeRunnerResult => ({
  success: true,
  backendSessionId: 'backend-session-a',
  responses: [],
  usage: { contextTokens: 5000, inputTokens: 1000, outputTokens: 500 },
  finalTextResponse: 'done',
  ...overrides,
});

/** A message that is not a wake: a person on a channel. */
const channelMessage = (content: string, recipientSessionId = 'session-a'): SessionRequest => ({
  userId: 'user-456',
  sbSlug: 'myra',
  channel: 'telegram',
  conversationId: 'chat-123',
  sender: { id: '123456789', name: 'Conor' },
  content,
  metadata: { recipientSessionId },
});

/** A wake as the trigger handler builds it, pointing at stored message `source`. */
const wake = (
  source: string,
  metadata: Record<string, unknown> = {},
  sender = 'lumen'
): SessionRequest => ({
  userId: 'user-456',
  sbSlug: 'myra',
  channel: 'agent',
  conversationId: `trigger:myra:pr:${source}`,
  sender: { id: sender, name: sender },
  content: `wake for ${source}`,
  metadata: {
    triggerType: 'agent',
    threadKey: `pr:${source}`,
    triggerThreadMessageId: source,
    wakeCoalescible: true,
    recipientSessionId: 'session-a',
    ...metadata,
  },
});

describe('queued wakes run as one turn (spec trigger-pipe-in v7, slice 1)', () => {
  let service: SessionService;
  let runner: IClaudeRunner;
  let prompts: string[];
  let releaseFirst: () => void;
  let candidates: Map<string, string>;
  let resolveCalls: Array<{ content: string; candidate: string }>;
  let failResolutionOf: Set<string>;
  let movesAtDequeue: Set<string>;

  const internals = () =>
    service as unknown as {
      pendingQueues: Map<string, unknown[]>;
      processingLocks: Set<string>;
    };
  const queued = () => internals().pendingQueues.get('myra:session-a')?.length ?? 0;

  beforeEach(() => {
    vi.clearAllMocks();
    prompts = [];
    candidates = new Map();
    resolveCalls = [];
    failResolutionOf = new Set();
    movesAtDequeue = new Set();

    const repository = {
      findByUserAndAgent: vi.fn().mockResolvedValue(null),
      findById: vi.fn(async (id: string) => session(id)),
      findByUser: vi.fn().mockResolvedValue([]),
      create: vi.fn(async (data: Partial<Session>) => ({ ...session('created'), ...data })),
      update: vi.fn(async (id: string, updates: Partial<Session>) => ({
        ...session(id),
        ...updates,
      })),
      reopenEnded: vi.fn(),
      updateTokenUsage: vi.fn().mockResolvedValue(undefined),
      markCompacted: vi.fn().mockResolvedValue(undefined),
      tryAcquireCompactionLock: vi.fn().mockResolvedValue(true),
      releaseCompactionLock: vi.fn().mockResolvedValue(undefined),
    } as unknown as ISessionRepository;
    const contextBuilder = {
      buildContext: vi.fn().mockResolvedValue(context()),
      buildMinimalContext: vi.fn().mockResolvedValue({
        temporal: context().temporal,
        agent: context().agent,
      }),
      getAgentBackend: vi.fn().mockResolvedValue({ backend: 'claude', provider: null }),
    } as unknown as IContextBuilder;
    let parked: Promise<void> | undefined = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    runner = {
      run: vi.fn(async (message: string) => {
        prompts.push(message);
        // The first turn holds the session while the others queue behind it.
        if (parked) {
          const wait = parked;
          parked = undefined;
          await wait;
        }
        return runnerResult({
          responses: [
            { channel: 'telegram', conversationId: 'chat-123', content: `reply to a turn` },
          ],
        });
      }),
    } as unknown as IClaudeRunner;
    const activity = {
      logMessage: vi.fn().mockResolvedValue({ id: 'msg-123' }),
      logActivity: vi.fn().mockResolvedValue({ id: 'activity-123' }),
      tagActivityTaskGroup: vi.fn().mockResolvedValue(undefined),
    } as unknown as IActivityStream;

    service = new SessionService(repository, contextBuilder, runner, activity, {
      defaultWorkingDirectory: '/test',
      mcpConfigPath: '/test/.mcp.json',
      compactionThreshold: 150000,
    });

    // Every message names its session. A message named in `movesAtDequeue`
    // resolves to session-a on arrival and to session-b when dequeued; one in
    // `failResolutionOf` fails at dequeue. Each resolution's epoch candidate is
    // recorded against the message.
    const arrived = new Set<string>();
    vi.spyOn(service, 'getOrCreateSession').mockImplementation(
      async (_userId, _sbSlug, options) => {
        const candidate = options?.turnEpochCandidate ?? '';
        const content = [...candidates.entries()].find(([, c]) => c === candidate)?.[0];
        resolveCalls.push({ content: content ?? '?', candidate });
        // A message resolves once on arrival and again when the queue reaches it.
        const atDequeue = arrived.has(candidate);
        arrived.add(candidate);
        if (atDequeue && content && failResolutionOf.has(content)) {
          // Non-retryable on purpose: the queue-wide flush acts on exactly
          // this kind of error, so a member-local rejection is what keeps the
          // message queued behind it alive.
          throw new Error(`resolution failed for ${content}: 401 unauthorized`);
        }
        if (atDequeue && content && movesAtDequeue.has(content)) return session('session-b');
        return session(options?.recipientSessionId ?? 'session-a');
      }
    );
  });

  /**
   * Send a request, remembering the epoch candidate handleMessage mints for
   * it. The pending result comes back wrapped: an async function returning a
   * promise would adopt it, and so wait for the turn itself.
   */
  async function send(request: SessionRequest): Promise<{ result: Promise<SessionResult> }> {
    const spy = vi.mocked(service.getOrCreateSession);
    const before = spy.mock.calls.length;
    const result = service.handleMessage(request);
    await vi.waitFor(() => expect(spy.mock.calls.length).toBeGreaterThan(before));
    const options = spy.mock.calls[before][2] as { turnEpochCandidate?: string } | undefined;
    if (options?.turnEpochCandidate) candidates.set(request.content, options.turnEpochCandidate);
    return { result };
  }

  /** Hold the session with a first turn, queue `requests` behind it, then release it. */
  async function behindABusyTurn(requests: SessionRequest[]) {
    const { result: first } = await send(channelMessage('turn-a'));
    await vi.waitFor(() => expect(runner.run).toHaveBeenCalledTimes(1));
    const waits: Array<Promise<SessionResult>> = [];
    for (const request of requests) {
      const before = queued();
      waits.push((await send(request)).result);
      await vi.waitFor(() => expect(queued()).toBe(before + 1));
    }
    releaseFirst();
    const settled = await Promise.allSettled([first, ...waits]);
    return settled.slice(1);
  }

  const turnsAfterTheFirst = () => prompts.slice(1);
  const value = (s: PromiseSettledResult<SessionResult>) =>
    (s as PromiseFulfilledResult<SessionResult>).value;

  it('runs three queued wakes as one turn: the lead gets the replies, the others are told who carried them', async () => {
    const [one, two, three] = await behindABusyTurn([
      wake('m1'),
      wake('m2'),
      wake('m3', {}, 'myra'),
    ]);

    expect(turnsAfterTheFirst()).toHaveLength(1);
    const merged = turnsAfterTheFirst()[0];
    expect(merged).toMatch(/3 messages arrived for you while your previous turn ran/);
    for (const source of ['m1', 'm2', 'm3']) expect(merged).toContain(`wake for ${source}`);
    expect(merged.indexOf('wake for m1')).toBeLessThan(merged.indexOf('wake for m2'));
    expect(merged.indexOf('wake for m2')).toBeLessThan(merged.indexOf('wake for m3'));
    expect(merged).toContain('From: lumen, myra');

    expect(value(one)).toMatchObject({ success: true, admitted: true, finalTextResponse: 'done' });
    expect(value(one).responses).toHaveLength(1);
    expect(value(one).wake).toBeUndefined();
    for (const follower of [two, three]) {
      expect(value(follower)).toMatchObject({
        success: true,
        admitted: true,
        responses: [],
        wake: { coalescedInto: 'm1' },
      });
      expect(value(follower).finalTextResponse).toBeUndefined();
    }
    expect(internals().processingLocks.size).toBe(0);
  });

  it("wraps a merged turn in its lead's turn hooks alone (Lumen, #769)", async () => {
    const order: string[] = [];
    const hooks = (name: string) => ({
      start: async () => void order.push(`start ${name}`),
      end: async (result: SessionResult) =>
        void order.push(`end ${name}${result.wake ? ' (carried)' : ''}`),
    });
    await behindABusyTurn([
      { ...wake('m1'), turnHooks: hooks('m1') },
      { ...wake('m2'), turnHooks: hooks('m2') },
    ]);
    expect(turnsAfterTheFirst()).toHaveLength(1);
    expect(order).toEqual(['start m1', 'end m1']);
  });

  it('keeps a channel message between wakes in its place', async () => {
    await behindABusyTurn([
      wake('m1'),
      wake('m2'),
      channelMessage('message-b'),
      wake('m4'),
      wake('m5'),
    ]);
    const turns = turnsAfterTheFirst();
    expect(turns).toHaveLength(3);
    expect(turns[0]).toMatch(/2 messages arrived/);
    expect(turns[0]).toContain('wake for m1');
    expect(turns[0]).toContain('wake for m2');
    expect(turns[1]).toContain('message-b');
    expect(turns[1]).not.toContain('wake for');
    expect(turns[2]).toMatch(/2 messages arrived/);
    expect(turns[2]).toContain('wake for m4');
    expect(turns[2]).toContain('wake for m5');
  });

  it('runs a lone wake as it always did', async () => {
    await behindABusyTurn([wake('m1'), channelMessage('message-b'), wake('m3')]);
    const turns = turnsAfterTheFirst();
    expect(turns).toHaveLength(3);
    expect(turns[0]).toContain('wake for m1');
    expect(turns[0]).not.toMatch(/messages arrived/);
    expect(turns[1]).toContain('message-b');
    expect(turns[2]).toContain('wake for m3');
  });

  it('never merges an unflagged agent trigger, or a wake with media, a task group or a container', async () => {
    await behindABusyTurn([
      wake('m1', { wakeCoalescible: undefined }),
      wake('m2', { media: [{ type: 'image', path: '/tmp/x.png' }] }),
      wake('m3', { taskGroupId: 'group-1' }),
      wake('m4', { sandboxContainerName: 'box-1' }),
    ]);
    const turns = turnsAfterTheFirst();
    expect(turns).toHaveLength(4);
    for (const turn of turns) expect(turn).not.toMatch(/messages arrived/);
  });

  it('hands a member that now resolves elsewhere to that session alone, and merges the rest', async () => {
    movesAtDequeue.add('wake for m2');
    const [, moved] = await behindABusyTurn([wake('m1'), wake('m2'), wake('m3')]);
    await vi.waitFor(() => expect(runner.run).toHaveBeenCalledTimes(3));
    const turns = turnsAfterTheFirst();
    const merged = turns.find((t) => /2 messages arrived/.test(t))!;
    expect(merged).toContain('wake for m1');
    expect(merged).toContain('wake for m3');
    expect(merged).not.toContain('wake for m2');
    expect(
      turns.find((t) => t.includes('wake for m2') && !/messages arrived/.test(t))
    ).toBeTruthy();
    expect(value(moved)).toMatchObject({ sessionId: 'session-b' });
    expect(value(moved).wake).toBeUndefined();
  });

  it('rejects a member whose resolution fails alone, without flushing what is queued behind it', async () => {
    failResolutionOf.add('wake for m2');
    const [one, two, three, behind] = await behindABusyTurn([
      wake('m1'),
      wake('m2'),
      wake('m3'),
      channelMessage('message-d'),
    ]);
    // handleMessage turns a queued rejection into the same structured failure
    // as a direct one, so the caller sees this member's own error.
    expect(value(two)).toMatchObject({ success: false });
    expect(value(two).error).toContain('resolution failed for wake for m2');
    expect(value(one)).toMatchObject({ success: true });
    expect(value(three)).toMatchObject({ wake: { coalescedInto: 'm1' } });
    expect(value(behind)).toMatchObject({ success: true });
    const turns = turnsAfterTheFirst();
    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatch(/2 messages arrived/);
    expect(turns[1]).toContain('message-d');
  });

  it('runs wakes whose identity cannot be read one by one', async () => {
    for (const identity of [{ kind: 'unknown', transient: true }]) {
      const processed: string[] = [];
      const classify = vi
        .spyOn(
          service as unknown as { classifyTurnIdentity: () => Promise<unknown> },
          'classifyTurnIdentity'
        )
        .mockResolvedValue(identity);
      const process = vi
        .spyOn(
          service as unknown as { processMessage: (r: SessionRequest) => Promise<SessionResult> },
          'processMessage'
        )
        .mockImplementation(async (request: SessionRequest) => {
          processed.push(request.content);
          if (request.content === 'turn-a') await new Promise<void>((r) => (releaseFirst = r));
          return {
            success: true,
            sessionId: 'session-a',
            backendSessionId: 'backend-session-a',
            responses: [],
            sessionStatus: 'active',
            compactionTriggered: false,
          } as unknown as SessionResult;
        });
      const first = service.handleMessage(channelMessage('turn-a'));
      await vi.waitFor(() => expect(processed).toEqual(['turn-a']));
      const waits = [];
      for (const request of [wake('m1'), wake('m2'), wake('m3')]) {
        const before = queued();
        waits.push(service.handleMessage(request));
        await vi.waitFor(() => expect(queued()).toBe(before + 1));
      }
      releaseFirst();
      await Promise.all([first, ...waits]);
      expect(processed, identity.kind).toEqual([
        'turn-a',
        'wake for m1',
        'wake for m2',
        'wake for m3',
      ]);
      classify.mockRestore();
      process.mockRestore();
    }
  });

  // 3.5 (Oct 7 audit): an inkling's queued wakes merge as an ordinary SB's do,
  // but its gate reads each wake's own source. Only its owner's own messages
  // share a turn; every other wake runs alone and meets the gate there.
  // One conversation: owner wakes share a turn only within it (Lumen, #780 P1).
  const C1 = { threadKey: 'chat:c1' };
  const C2 = { threadKey: 'chat:c2' };

  function inklingTurns() {
    const turns: Array<{ content: string; sources: unknown; trigger?: unknown }> = [];
    // A client to prove sources with; the proof itself is ownerProof's, and
    // the lease carries no epochs, as with no lease service.
    (service as unknown as { supabase: unknown }).supabase = {};
    vi.spyOn(
      service as unknown as { leaseTurnEpochs: () => Promise<Set<string>> },
      'leaseTurnEpochs'
    ).mockResolvedValue(new Set());
    vi.spyOn(
      service as unknown as { classifyTurnIdentity: () => Promise<unknown> },
      'classifyTurnIdentity'
    ).mockResolvedValue({ kind: 'inkling', id: 'inkling-1', userId: 'user-456' });
    vi.spyOn(
      service as unknown as { processMessage: (r: SessionRequest) => Promise<SessionResult> },
      'processMessage'
    ).mockImplementation(async (request: SessionRequest) => {
      turns.push({
        content: request.content,
        sources: request.metadata?.coalescedSources,
        trigger: request.metadata?.triggerThreadMessageId,
      });
      if (request.content === 'turn-a') await new Promise<void>((r) => (releaseFirst = r));
      return {
        success: true,
        sessionId: 'session-a',
        backendSessionId: 'backend-session-a',
        responses: [],
        sessionStatus: 'active',
        compactionTriggered: false,
      } as unknown as SessionResult;
    });
    return turns;
  }

  async function queueBehindATurn(requests: SessionRequest[]) {
    const first = service.handleMessage(channelMessage('turn-a'));
    // turn-a is running, and holds the lock the wakes queue behind.
    await vi.waitFor(() => expect(internals().processingLocks.has('myra:session-a')).toBe(true));
    const waits = [];
    for (const request of requests) {
      const before = queued();
      waits.push(service.handleMessage(request));
      await vi.waitFor(() => expect(queued()).toBe(before + 1));
    }
    releaseFirst();
    await Promise.all([first, ...waits]);
  }

  it("merges an inkling's owner wakes, and runs an SB's wake queued among them alone (Myra a8f943a7)", async () => {
    ownerProof.of = new Map([
      ['o1', 'yes'],
      ['s1', 'no'],
      ['o2', 'yes'],
    ]);
    const turns = inklingTurns();
    await queueBehindATurn([
      wake('o1', C1, 'conor'),
      wake('s1', C1, 'lumen'),
      wake('o2', C1, 'conor'),
    ]);

    expect(turns).toHaveLength(3);
    // The owner's two share one turn, led by the first; the SB's never joins it.
    expect(turns[1].content).toContain('wake for o1');
    expect(turns[1].content).toContain('wake for o2');
    expect(turns[1].content).not.toContain('wake for s1');
    expect(turns[1].sources).toHaveLength(2);
    // The SB's runs alone afterwards, where the gate refuses it.
    expect(turns[2]).toMatchObject({ content: 'wake for s1', sources: undefined });
  });

  it("leads the merged turn with an owner's wake, so the turn's own gate reads an owner's message", async () => {
    ownerProof.of = new Map([
      ['s1', 'no'],
      ['o1', 'yes'],
      ['o2', 'yes'],
    ]);
    const turns = inklingTurns();
    await queueBehindATurn([
      wake('s1', C1, 'lumen'),
      wake('o1', C1, 'conor'),
      wake('o2', C1, 'conor'),
    ]);

    expect(turns[1].trigger).toBe('o1');
    expect(turns[1].content).not.toContain('wake for s1');
    expect(turns[2]).toMatchObject({ content: 'wake for s1', trigger: 's1' });
  });

  it("keeps an inkling wake whose source can't be read out of the merge", async () => {
    ownerProof.of = new Map([
      ['o1', 'yes'],
      ['u1', 'unreadable'],
      ['o2', 'yes'],
    ]);
    const turns = inklingTurns();
    await queueBehindATurn([
      wake('o1', C1, 'conor'),
      wake('u1', C1, 'conor'),
      wake('o2', C1, 'conor'),
    ]);

    expect(turns[1].content).not.toContain('wake for u1');
    expect(turns[1].sources).toHaveLength(2);
    expect(turns[2]).toMatchObject({ content: 'wake for u1', sources: undefined });
  });

  it('runs an inkling’s wakes one by one when no client can prove their sources', async () => {
    ownerProof.of = new Map([
      ['o1', 'yes'],
      ['o2', 'yes'],
    ]);
    const turns = inklingTurns();
    (service as unknown as { supabase: unknown }).supabase = null;
    await queueBehindATurn([wake('o1', C1, 'conor'), wake('o2', C1, 'conor')]);

    expect(turns.map((t) => t.content)).toEqual(['turn-a', 'wake for o1', 'wake for o2']);
  });

  it('never merges owner wakes from two conversations: a turn has one reply destination', async () => {
    ownerProof.of = new Map([
      ['o1', 'yes'],
      ['o2', 'yes'],
    ]);
    const turns = inklingTurns();
    await queueBehindATurn([wake('o1', C1, 'conor'), wake('o2', C2, 'conor')]);

    expect(turns.map((t) => t.content)).toEqual(['turn-a', 'wake for o1', 'wake for o2']);
  });

  it("merges the lead conversation's owner wakes, and runs another conversation's alone", async () => {
    ownerProof.of = new Map([
      ['o1', 'yes'],
      ['o2', 'yes'],
      ['o3', 'yes'],
    ]);
    const turns = inklingTurns();
    await queueBehindATurn([
      wake('o1', C1, 'conor'),
      wake('o2', C2, 'conor'),
      wake('o3', C1, 'conor'),
    ]);

    expect(turns).toHaveLength(3);
    expect(turns[1].content).toContain('wake for o1');
    expect(turns[1].content).toContain('wake for o3');
    expect(turns[1].content).not.toContain('wake for o2');
    expect(turns[2]).toMatchObject({ content: 'wake for o2', trigger: 'o2' });
  });

  it('runs them one by one when fewer than two are the owner’s', async () => {
    ownerProof.of = new Map([
      ['o1', 'yes'],
      ['s1', 'no'],
      ['s2', 'no'],
    ]);
    const turns = inklingTurns();
    await queueBehindATurn([
      wake('o1', C1, 'conor'),
      wake('s1', C1, 'lumen'),
      wake('s2', C1, 'lumen'),
    ]);

    expect(turns.map((t) => t.content)).toEqual([
      'turn-a',
      'wake for o1',
      'wake for s1',
      'wake for s2',
    ]);
  });

  /** Record the epoch candidate each turn runs under, running it for real. */
  function recordEpochs() {
    const epochs: Array<string | undefined> = [];
    const target = service as unknown as {
      processMessage: (...args: unknown[]) => Promise<SessionResult>;
    };
    const original = target.processMessage.bind(service);
    vi.spyOn(target, 'processMessage').mockImplementation(async (...args: unknown[]) => {
      epochs.push(args[2] as string | undefined);
      return original(...args);
    });
    return epochs;
  }
  const stampedLease = (epochs: () => string[]) =>
    vi
      .spyOn(
        service as unknown as { leaseTurnEpochs: () => Promise<Set<string>> },
        'leaseTurnEpochs'
      )
      .mockImplementation(async () => new Set(epochs()));

  it('runs the merged turn under the epoch its members left on the lease', async () => {
    const epochs = recordEpochs();
    // A presence thread's routing stamps nothing, so the lease can carry the
    // middle member's candidate rather than the last one's.
    stampedLease(() => [candidates.get('wake for m2')!]);
    await behindABusyTurn([wake('m1'), wake('m2'), wake('m3')]);
    expect(epochs).toHaveLength(2);
    expect(epochs[1]).toBe(candidates.get('wake for m2'));
  });

  it('runs it under the lead’s epoch when the lease carries none of theirs', async () => {
    const epochs = recordEpochs();
    stampedLease(() => ['an-earlier-turn']);
    await behindABusyTurn([wake('m1'), wake('m2'), wake('m3')]);
    expect(epochs).toHaveLength(2);
    expect(epochs[1]).toBe(candidates.get('wake for m1'));
  });

  it('gives every member the merged turn’s failure, and routes no reply', async () => {
    vi.mocked(runner.run).mockImplementation(async (message: string) => {
      prompts.push(message);
      if (message.includes('turn-a')) {
        await new Promise<void>((r) => (releaseFirst = r));
        return runnerResult();
      }
      return runnerResult({ success: false, error: 'backend exited 1', responses: [] });
    });
    const results = await behindABusyTurn([wake('m1'), wake('m2'), wake('m3')]);
    expect(turnsAfterTheFirst()).toHaveLength(1);
    for (const result of results) {
      expect(value(result).success).toBe(false);
      expect(value(result).responses).toEqual([]);
    }
    expect(value(results[1]).wake).toEqual({ coalescedInto: 'm1' });
  });

  it('carries at most ten wakes in a turn', async () => {
    await behindABusyTurn(Array.from({ length: 12 }, (_, i) => wake(`m${i + 1}`)));
    const turns = turnsAfterTheFirst();
    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatch(/10 messages arrived/);
    expect(turns[1]).toMatch(/2 messages arrived/);
    expect(turns[1]).toContain('wake for m11');
    expect(turns[1]).toContain('wake for m12');
  });

  // Lumen's review of 1e2920d7: PostgREST reports a failed read as a resolved
  // { data: null, error }, not a throw. Read as "no stamps", that merged the
  // wakes under the lead's epoch even when the lease carried a later
  // member's, and the boundary would then refuse the release. Both kinds of
  // failure must leave the merge in doubt, and so run the wakes one by one.
  it.each(['returned', 'thrown'])(
    'runs the wakes one by one when the lease read fails (%s error)',
    async (failureMode) => {
      const query: Record<string, unknown> = {};
      query.select = () => query;
      query.eq = () => query;
      query.then = (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) => {
        const error = { code: '57014', message: 'synthetic lease lookup timeout' };
        return failureMode === 'returned'
          ? Promise.resolve({ data: null, error }).then(resolve, reject)
          : Promise.reject(error).then(resolve, reject);
      };
      const leases = new StudioLeaseService({ from: () => query } as never);
      vi.spyOn(
        service as unknown as { getLeaseService: () => StudioLeaseService },
        'getLeaseService'
      ).mockReturnValue(leases);
      await behindABusyTurn([wake('m1'), wake('m2'), wake('m3')]);
      expect(turnsAfterTheFirst()).toHaveLength(3);
      expect(turnsAfterTheFirst().every((turn) => !turn.includes('messages arrived'))).toBe(true);
    }
  );
});
