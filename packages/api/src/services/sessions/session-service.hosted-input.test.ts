/**
 * Ordinary hosted input uses SessionService's existing queue, not a hosted
 * input registry/poller. Only routing and external effects are fixtures:
 * handleMessage -> runTurn -> HostedInkSessionRunner -> createHostedInkExecutor
 * -> composeInkSession/runHeadlessSession are real.
 *
 * Run from an owned temporary source snapshot/cwd/HOME, never this checkout's
 * production environment. No database, server, credentials or provider process.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createSessionToolHost, type CodingTool } from '@inklabs/shared/node-host';
import { OBS_PROJECTION_TYPES, SessionLog, ToolPolicyState } from '@inklabs/shared/runtime';
import type { BackendHost, BackendRunRequest, BackendRunResult } from '@inklabs/shared/providers';
import { SessionService, type IActivityStream } from './session-service.js';
import { createHostedInkExecutor, type HostedInkEffects } from './hosted-ink-executor.js';
import { HostedInkSessionRunner, type ProviderTurnRequest } from './hosted-ink-session.js';
import { getActiveRun, isGenerationAdmitted, resetActiveRuns } from './active-runs.js';
import type {
  IContextBuilder,
  InjectedContext,
  IRunner,
  ISessionRepository,
  Session,
  SessionRequest,
  SessionResult,
} from './types.js';

// Prevent transitive imports from loading the checkout's .env files or clients.
vi.mock('../../config/env', () => ({ env: { NODE_ENV: 'test' } }));
vi.mock('../../data/supabase/client', () => {
  const forbidden = () => {
    throw new Error('No database in the hosted-input fixture');
  };
  return { createSupabaseClient: forbidden, getSupabaseClient: forbidden };
});
vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
// Studio completion otherwise reads identity/config files and can launch ink init.
vi.mock('../studio-complete.js', () => ({ ensureStudioComplete: vi.fn(async () => {}) }));
vi.mock('./launched-processes.js', () => ({
  launchHoldFor: vi.fn(() => undefined),
  reserveLaunch: vi.fn(async () => undefined),
}));

const SB_ID = '00000000-0000-4000-8000-000000000701';
const USER_ID = 'hosted-input-fixture-owner';
const SB = 'echo';
const FIRST = 'First ordinary input: read fixture.txt';
const LATER = 'Later ordinary input: continue after the first answer';
const WAKE = 'Agent wake: review the two ordinary inputs';
const OTHER = 'Independent session input';
const FIRST_REPLY = 'First answer: harmless hosted file';
const LATER_REPLY = 'Later ordinary answer';
const WAKE_REPLY = 'Agent wake answer';
const OTHER_REPLY = 'Independent session answer';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

const tool = (name: string, args: Record<string, unknown>) =>
  `\n\`\`\`ink-tool\n${JSON.stringify({ tool: name, args })}\n\`\`\``;
const final = (text: string) => `${text}${tool('signal_status', { status: 'completed' })}`;
const providerResult = (text: string): BackendRunResult => ({
  success: true,
  childExited: true,
  responseText: text,
  stdout: text,
  stderr: '',
  exitCode: 0,
  durationMs: 1,
  command: 'fixture only; no process',
});

function session(id: string): Session {
  return {
    id,
    userId: USER_ID,
    sbSlug: SB,
    sbId: SB_ID,
    backendSessionId: id,
    type: 'primary',
    lifecycle: 'idle',
    status: 'active',
    backend: 'ink',
    model: null,
    contextTokens: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    messageCount: 0,
    tokenCount: 0,
    lastCompactionAt: null,
    compactionCount: 0,
    endedAt: null,
    metadata: {},
    startedAt: new Date('2026-10-08T12:00:00Z'),
    lastActivityAt: new Date('2026-10-08T12:00:00Z'),
  };
}

function context(provider: 'claude' | 'codex'): InjectedContext {
  return {
    agent: {
      sbSlug: SB,
      name: 'Echo',
      role: 'assistant',
      backend: 'ink',
      provider,
      values: [],
      capabilities: [],
      relationships: {},
    },
    user: { id: USER_ID, timezone: 'America/Los_Angeles', contacts: {}, preferences: {} },
    temporal: {
      currentTime: '5:00 AM',
      currentDate: '2026-10-08',
      dayOfWeek: 'Thursday',
      timezone: 'America/Los_Angeles',
      greeting: 'Good morning',
    },
    recentMemories: [],
    activeProjects: [],
  };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  resetActiveRuns();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function fixture(provider: 'claude' | 'codex') {
  resetActiveRuns();
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ink-hosted-input-')));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'fixture.txt'), 'harmless hosted file');
  // Only explicitly named, inert settings; never inspect inherited credentials.
  vi.stubEnv('JWT_SECRET', '');
  vi.stubEnv('INK_EXECUTION_TIER', 'full');
  vi.stubEnv('INK_EXECUTION_TIER_SBS', '');
  vi.stubEnv('INK_EXECUTION_TIER_CLIENTS', '');
  const network = vi.fn(async () => {
    throw new Error('Network forbidden in hosted-input fixture');
  });
  vi.stubGlobal('fetch', network);

  const firstProvider = gate();
  const firstLog = gate();
  const firstReply = gate();
  const laterProvider = gate();
  const logBlocked = vi.fn();
  const timeline: string[] = [];
  const events = new Map<string, Record<string, unknown>[]>([
    ['a', []],
    ['b', []],
  ]);
  const projections = new Map<string, Record<string, unknown>[]>([
    ['a', []],
    ['b', []],
  ]);
  const histories: Array<{ sessionId: string; entries: Record<string, unknown>[] }> = [];
  const active = new Map<string, number>();
  const peak = new Map<string, number>();
  const epochs: Array<{ sessionId: string; epoch: string }> = [];
  const closed: string[] = [];
  const rows = new Map([
    ['a', session('a')],
    ['b', session('b')],
  ]);
  const row = (id: string) => {
    const found = rows.get(id);
    if (!found) throw new Error(`Unknown fixture session ${id}`);
    return found;
  };
  const update = vi.fn(async (id: string, changes: Partial<Session>) => {
    const updated = { ...row(id), ...changes };
    rows.set(id, updated);
    return updated;
  });
  const repository = {
    findById: vi.fn(async (id: string) => row(id)),
    update,
    updateIfTurnEpoch: vi.fn(async (id: string, epoch: string, changes: Partial<Session>) => {
      if (row(id).turnEpoch !== epoch) return null;
      timeline.push(`finalize:${id}:${changes.messageCount}`);
      return update(id, changes);
    }),
    updateTokenUsage: vi.fn(async () => {}),
  } as unknown as ISessionRepository;
  const injected = context(provider);
  const contextBuilder: IContextBuilder = {
    buildContext: vi.fn(async () => injected),
    buildMinimalContext: vi.fn(async () => ({
      agent: injected.agent,
      temporal: injected.temporal,
    })),
    getAgentBackend: vi.fn(async () => ({ backend: 'ink', provider })),
  };
  const activity: IActivityStream = {
    logMessage: vi.fn(async () => ({ id: 'fixture-message' })),
    logActivity: vi.fn(async () => ({ id: 'fixture-activity' })),
  };
  const fallback: IRunner = {
    uploadMedia: 'refuse',
    run: vi.fn(async () => {
      throw new Error('Subprocess fallback forbidden');
    }),
  };

  const scripts = new Map([
    [
      'a',
      [
        tool('read', { path: 'fixture.txt' }),
        final(FIRST_REPLY),
        final(LATER_REPLY),
        final(WAKE_REPLY),
      ],
    ],
    ['b', [final(OTHER_REPLY)]],
  ]);
  const starts = new Map<string, number>();
  const start = vi.fn((request: ProviderTurnRequest) => {
    const id = request.inkSessionId;
    const count = (starts.get(id) ?? 0) + 1;
    starts.set(id, count);
    const text = scripts.get(id)?.shift();
    if (text === undefined) throw new Error(`Unscripted provider call for ${id}`);
    expect(isGenerationAdmitted(id, row(id).turnEpoch!)).toBe(true);
    const running = (active.get(id) ?? 0) + 1;
    active.set(id, running);
    peak.set(id, Math.max(peak.get(id) ?? 0, running));
    timeline.push(`start:${id}:${count}`);
    const result = (async () => {
      try {
        if (id === 'a' && count === 1) await firstProvider.promise;
        if (id === 'a' && count === 3) await laterProvider.promise;
        const emit = request.onEvent as BackendRunRequest['onEvent'];
        emit?.({ kind: 'text-delta', text });
        emit?.({ kind: 'text', text });
        return providerResult(text);
      } finally {
        active.set(id, (active.get(id) ?? 1) - 1);
        timeline.push(`exit:${id}:${count}`);
      }
    })();
    return {
      result,
      abort: vi.fn(() => {
        firstProvider.release();
        laterProvider.release();
      }),
    };
  });

  // The real coding-tool host reads ONLY our named file; no provider SDK/auth loader.
  const read: CodingTool = {
    name: 'read',
    description: 'Read the single harmless fixture',
    parameters: {},
    execute: vi.fn(async (_id, args) => {
      expect(args.path).toBe('fixture.txt');
      return {
        content: [{ type: 'text', text: await readFile(join(root, 'fixture.txt'), 'utf8') }],
      };
    }),
  };
  const mcp = vi.fn(async (name: string) => {
    switch (name) {
      case 'bootstrap':
        return {
          identityFiles: { soul: 'Echo fixture' },
          user: { timezone: 'America/Los_Angeles' },
        };
      case 'recall':
        return { success: true, memories: [] };
      case 'log_activity':
      case 'update_session_state':
        return { success: true };
      default:
        throw new Error(`Unscripted Inkwell effect: ${name}`);
    }
  });
  let nextId = 0;
  const prepare = vi.fn(async (input: { sessionId: string }): Promise<HostedInkEffects> => {
    const toolHost = createSessionToolHost({
      cwd: root,
      home: root,
      tempDir: root,
      imageRoots: [root],
      credentials: {},
      coding: { load: async () => new Map([['read', read]]), readDocument: async () => null },
    });
    const policy = new ToolPolicyState('backend');
    policy.allowTool('read');
    return {
      toolHost,
      policy,
      activeSkills: [],
      mintId: () => `fixture-${++nextId}`,
      approve: async () => false,
      approveClone: async () => false,
      cloneLog: () => {
        throw new Error('Clones not part of this fixture');
      },
      flushPolicy: async () => {},
      close: async () => {
        await toolHost.close();
        closed.push(input.sessionId);
        timeline.push(`close:${input.sessionId}`);
      },
      presentation: {
        ui: { printLine: vi.fn(), printEvent: vi.fn(), startWaiting: () => vi.fn() },
        render: vi.fn(),
        progress: vi.fn(),
        toolStarted: vi.fn(),
        modelReported: vi.fn(),
        toolResult: vi.fn(),
        compacted: vi.fn(),
        notice: vi.fn(),
      },
    };
  });
  const runner = new HostedInkSessionRunner({
    execute: createHostedInkExecutor(prepare),
    forTurn: ({ sessionId, turnEpoch, config }) => {
      expect(getActiveRun(sessionId)).toMatchObject({ turnEpoch, backend: 'ink' });
      expect(isGenerationAdmitted(sessionId, turnEpoch)).toBe(true);
      epochs.push({ sessionId, epoch: turnEpoch });
      const entries = events.get(sessionId)!;
      // A fresh log per turn: the actual composition must replay/seed its EIDs.
      const log = new SessionLog({
        path: join(root, `${sessionId}.jsonl`),
        sink: {
          write: async (line) => {
            const entry = JSON.parse(line) as Record<string, unknown>;
            if (sessionId === 'a' && entry.type === 'assistant' && entry.content === FIRST_REPLY) {
              logBlocked();
              await firstLog.promise;
            }
            entries.push(entry);
            if (entry.type === 'assistant') timeline.push(`log:${sessionId}:${entry.content}`);
          },
        },
        onProjection: (entry) => projections.get(sessionId)!.push(entry),
      });
      return {
        inkwell: { callTool: mcp },
        startProviderTurn: start,
        isHostedRefusal: () => false,
        deadlineAt: Date.now() + 30_000,
        sessionLog: {
          path: log.path,
          seed: (id) => log.seed(id),
          append: (entry) => log.append(entry),
          flush: () => log.flush(),
          read: async () => {
            const snapshot = [...entries];
            histories.push({ sessionId, entries: snapshot });
            return snapshot;
          },
        },
        providerContext: {
          workingDirectory: root,
          inkSessionId: sessionId,
          studioId: config.studioId,
          host: {} as BackendHost,
        },
      };
    },
  });
  const service = new SessionService(
    repository,
    contextBuilder,
    fallback,
    activity,
    {
      defaultWorkingDirectory: root,
      mcpConfigPath: join(root, 'unused.mcp.json'),
      compactionEnabled: false,
      hostedInk: { runner, sbIds: new Set([SB_ID]) },
    },
    fallback,
    undefined,
    fallback,
    fallback,
    fallback
  );
  // Only the DB routing seam is replaced, including its normal dequeue re-resolution.
  const routing = vi
    .spyOn(service, 'getOrCreateSession')
    .mockImplementation(async (_user, _sb, options) => row(options?.recipientSessionId ?? 'a'));
  const internals = service as unknown as {
    pendingQueues: Map<string, Array<{ request: SessionRequest; turnEpochCandidate: string }>>;
    processingLocks: Set<string>;
  };
  const queue = () => internals.pendingQueues.get(`${SB}:a`) ?? [];
  const replies = vi.fn(async (reply: { sessionId?: string; text: string | null }) => {
    expect(
      events.get(reply.sessionId!)!.some((e) => e.type === 'assistant' && e.content === reply.text)
    ).toBe(true);
    timeline.push(`reply:${reply.sessionId}:${reply.text}`);
    if (reply.text === FIRST_REPLY) await firstReply.promise;
  });
  const ordinary = (content: string, id = 'a'): SessionRequest => ({
    userId: USER_ID,
    sbSlug: SB,
    channel: 'telegram',
    conversationId: `fixture-chat-${id}`,
    sender: { id: 'fixture-person', name: 'Fixture person' },
    content,
    metadata: { recipientSessionId: id },
    onTurnReply: replies,
  });
  const wake: SessionRequest = {
    ...ordinary(WAKE),
    channel: 'agent',
    conversationId: 'trigger:echo:pr:701',
    sender: { id: 'fixture-sibling', name: 'Fixture sibling' },
    metadata: {
      recipientSessionId: 'a',
      triggerType: 'agent',
      threadKey: 'pr:701',
      triggerThreadMessageId: 'fixture-wake-message',
      wakeCoalescible: true,
    },
    onTurnReply: undefined,
    turnHooks: { start: vi.fn(async () => {}), end: vi.fn(async () => {}) },
  };
  return {
    service,
    ordinary,
    wake,
    queue,
    internals,
    routing,
    repository,
    rows,
    activity,
    fallback,
    firstProvider,
    firstLog,
    firstReply,
    laterProvider,
    logBlocked,
    timeline,
    events,
    projections,
    histories,
    active,
    peak,
    epochs,
    closed,
    start,
    starts,
    read,
    mcp,
    prepare,
    replies,
    network,
  };
}

describe('SessionService ordinary inputs through the real hosted Ink composition', () => {
  it.each(['claude', 'codex'] as const)(
    'queues ordinary input and a wake through %s; serializes commit/reply/replay without blocking another session',
    async (provider) => {
      const h = await fixture(provider);
      const pending: Promise<SessionResult>[] = [];
      try {
        pending.push(h.service.handleMessage(h.ordinary(FIRST)));
        await vi.waitFor(() => expect(h.starts.get('a')).toBe(1));
        const firstEpoch = getActiveRun('a')!.turnEpoch;

        pending.push(h.service.handleMessage(h.ordinary(LATER)));
        await vi.waitFor(() => expect(h.queue()).toHaveLength(1));
        pending.push(h.service.handleMessage(h.wake));
        await vi.waitFor(() => expect(h.queue()).toHaveLength(2));
        const queuedEpochs = h.queue().map((entry) => entry.turnEpochCandidate);
        expect(h.queue().map((entry) => entry.request.content)).toEqual([LATER, WAKE]);
        expect(h.internals.processingLocks).toEqual(new Set([`${SB}:a`]));
        expect(h.prepare).toHaveBeenCalledTimes(1);
        expect(h.wake.turnHooks!.start).not.toHaveBeenCalled();
        expect(getActiveRun('a')!.turnEpoch).toBe(firstEpoch);

        // Same SB, different session: a's existing processing lock is not global.
        const other = h.service.handleMessage(h.ordinary(OTHER, 'b'));
        pending.push(other);
        expect(await other).toMatchObject({
          success: true,
          admitted: true,
          sessionId: 'b',
          finalTextResponse: OTHER_REPLY,
        });
        expect(h.active.get('a')).toBe(1);
        expect(h.queue()).toHaveLength(2);
        expect(h.starts.get('a')).toBe(1);
        expect(getActiveRun('b')).toBeUndefined();

        h.firstProvider.release();
        await vi.waitFor(() => expect(h.logBlocked).toHaveBeenCalledOnce());
        expect(h.read.execute).toHaveBeenCalledOnce();
        expect(h.starts.get('a')).toBe(2); // real read dispatch and provider continuation
        expect(h.active.get('a')).toBe(0);
        expect(h.queue()).toHaveLength(2);
        expect(
          h.events.get('a')!.some((e) => e.type === 'assistant' && e.content === FIRST_REPLY)
        ).toBe(false);
        expect(h.replies.mock.calls.map(([reply]) => reply.text)).toEqual([OTHER_REPLY]);

        h.firstLog.release();
        await vi.waitFor(() =>
          expect(h.replies.mock.calls.map(([reply]) => reply.text)).toEqual([
            OTHER_REPLY,
            FIRST_REPLY,
          ])
        );
        expect(h.queue()).toHaveLength(2); // committed log alone does not bypass the awaited reply
        expect(h.starts.get('a')).toBe(2);
        h.firstReply.release();
        await vi.waitFor(() => expect(h.starts.get('a')).toBe(3));
        expect(h.queue().map((entry) => entry.request.content)).toEqual([WAKE]);
        expect(h.rows.get('a')!.messageCount).toBe(1);
        expect(h.closed.filter((id) => id === 'a')).toHaveLength(1);
        expect(h.wake.turnHooks!.start).not.toHaveBeenCalled();
        h.laterProvider.release();

        const [first, later, wake] = await Promise.all(pending.slice(0, 3));
        expect(
          [first, later, wake].map((result) => ({
            success: result.success,
            admitted: result.admitted,
            sessionId: result.sessionId,
            finalTextResponse: result.finalTextResponse,
          }))
        ).toEqual([
          { success: true, admitted: true, sessionId: 'a', finalTextResponse: FIRST_REPLY },
          { success: true, admitted: true, sessionId: 'a', finalTextResponse: LATER_REPLY },
          { success: true, admitted: true, sessionId: 'a', finalTextResponse: WAKE_REPLY },
        ]);
        expect(h.peak).toEqual(
          new Map([
            ['a', 1],
            ['b', 1],
          ])
        );
        expect(h.start).toHaveBeenCalledTimes(5);
        expect(h.prepare).toHaveBeenCalledTimes(4);
        expect(h.closed.filter((id) => id === 'a')).toHaveLength(3);
        expect(h.wake.turnHooks!.start).toHaveBeenCalledOnce();
        expect(h.wake.turnHooks!.end).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ success: true, finalTextResponse: WAKE_REPLY })
        );
        expect(
          h.epochs.filter((entry) => entry.sessionId === 'a').map((entry) => entry.epoch)
        ).toEqual([firstEpoch, ...queuedEpochs]);
        expect(new Set([firstEpoch, ...queuedEpochs]).size).toBe(3);
        // Both queued inputs resolve on arrival and dequeue with their original candidate.
        for (const epoch of queuedEpochs) {
          expect(
            h.routing.mock.calls.filter(([, , options]) => options?.turnEpochCandidate === epoch)
          ).toHaveLength(2);
        }

        const requests = h.start.mock.calls
          .map(([request]) => request)
          .filter((request) => request.inkSessionId === 'a');
        expect(requests[1].prompt).toContain('harmless hosted file');
        expect(requests[2].prompt).toContain(LATER);
        expect(requests[3].prompt).toContain(WAKE);
        if (provider === 'claude') {
          // Native continuity is recovered from the log, not a second transcript:
          // later turns resume the logged seed with a delta, not duplicate history.
          expect(requests[0].backendSessionSeedId).toEqual(expect.any(String));
          for (const request of requests.slice(1)) {
            expect(request.backendSessionId).toBe(requests[0].backendSessionSeedId);
            expect(request.backendSessionSeedId).toBeUndefined();
          }
          expect(requests[2].prompt).not.toContain(FIRST);
        } else {
          // Stateless providers receive the ledger actually hydrated by composition.
          for (const text of [FIRST, FIRST_REPLY]) expect(requests[2].prompt).toContain(text);
          for (const text of [FIRST_REPLY, LATER, LATER_REPLY])
            expect(requests[3].prompt).toContain(text);
        }
        for (const request of requests) expect(request.prompt).not.toContain(OTHER);
        expect(
          h.start.mock.calls.find(([request]) => request.inkSessionId === 'b')![0].prompt
        ).not.toContain(FIRST);
        const assistantTexts = (entries: Record<string, unknown>[]) =>
          entries.filter((e) => e.type === 'assistant').map((e) => e.content);
        expect(
          h.histories
            .filter((read) => read.sessionId === 'a')
            .map((read) => assistantTexts(read.entries))
        ).toEqual([[], [FIRST_REPLY], [FIRST_REPLY, LATER_REPLY]]);
        expect(assistantTexts(h.events.get('a')!)).toEqual([FIRST_REPLY, LATER_REPLY, WAKE_REPLY]);
        expect(assistantTexts(h.events.get('b')!)).toEqual([OTHER_REPLY]);
        for (const [id, entries] of h.events) {
          expect(h.projections.get(id)).toEqual(
            entries.filter((entry) => OBS_PROJECTION_TYPES.has(String(entry.type)))
          );
          expect(entries.map((entry) => entry.eid)).toEqual(entries.map((_, index) => index + 1));
        }
        const before = (earlier: string, later: string) => {
          expect(h.timeline).toContain(earlier);
          expect(h.timeline.indexOf(earlier)).toBeLessThan(h.timeline.indexOf(later));
        };
        before(`log:a:${FIRST_REPLY}`, `reply:a:${FIRST_REPLY}`);
        before(`reply:a:${FIRST_REPLY}`, 'finalize:a:1');
        before('finalize:a:1', 'start:a:3');
        before(`log:a:${LATER_REPLY}`, `reply:a:${LATER_REPLY}`);
        before(`reply:a:${LATER_REPLY}`, 'finalize:a:2');
        before('finalize:a:2', 'start:a:4');
        expect(h.rows.get('a')!.messageCount).toBe(3);
        expect(
          vi
            .mocked(h.activity.logMessage)
            .mock.calls.filter(([message]) => message.direction === 'in')
            .map(([message]) => message.content)
        ).toEqual([FIRST, LATER, WAKE, OTHER]);
        expect(h.mcp.mock.calls.filter(([name]) => name === 'bootstrap')).toHaveLength(4);
        expect(h.start.mock.calls.every(([request]) => request.backend === provider)).toBe(true);
        expect(h.internals.pendingQueues.size).toBe(0);
        expect(h.internals.processingLocks.size).toBe(0);
        expect(getActiveRun('a')).toBeUndefined();
        expect(h.fallback.run).not.toHaveBeenCalled();
        expect(h.network).not.toHaveBeenCalled();
      } finally {
        h.firstProvider.release();
        h.firstLog.release();
        h.firstReply.release();
        h.laterProvider.release();
        await Promise.allSettled(pending);
      }
    }
  );
});
