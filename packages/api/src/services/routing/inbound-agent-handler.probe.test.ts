/**
 * Does the RUNNING SERVER route to the right SB?
 *
 * The cascade's own unit tests prove the module is correct. They cannot prove
 * the server calls it, or calls it with the arguments it needs — and a module
 * that production reaches with the wrong arguments is a green suite over a live
 * misroute. This runs the actual message handler from `server.ts`.
 *
 * The handler is extracted from the source by AST rather than imported, because
 * `server.ts` ends in an unconditional `startServer(...)`: importing it to reach
 * one arrow function would boot a real server on every suite run. Everything
 * below the handler is injected, so the only production code executing is the
 * handler itself, the cascade, and the reply resolver.
 *
 * Instrument and the three scenarios are Lumen's, from the PR #638 review;
 * kept here so the cases that found the bug stay run on every commit.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('./resolve-mention', () => ({ resolveAgentFromMention: vi.fn() }));
vi.mock('./resolve-route', () => ({ resolveRouteSlug: vi.fn() }));
// Reached only by the admission cases below, through SessionService.
vi.mock('../principals', () => ({
  workspaceOfSb: vi.fn(async () => 'ws-1'),
  personalWorkspaceOf: vi.fn(async () => 'ws-1'),
}));

import { resolveInboundAgent } from './resolve-inbound-agent';
import { resolveAgentFromMention } from './resolve-mention';
import { resolveRouteSlug } from './resolve-route';
import { SessionService } from '../sessions/session-service';
import { makeFakeSupabase, type Row } from '../sessions/fake-supabase';
import { resetActiveRuns } from '../sessions/active-runs';
import { resetPendingFinalizations } from '../sessions/finalize-turn';
import type { Session } from '../sessions/types';

const DEFAULT_SLUG = 'myra';
const CHAT = '-100000000001';
const OTHER_CHAT = '-100000000002';

/** Pull the real `messageHandler` arrow out of server.ts without importing it. */
function extractMessageHandler(): string {
  const source = readFileSync(new URL('../../server.ts', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('server.ts', source, ts.ScriptTarget.Latest, true);
  let arrow = '';
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'messageHandler') {
      arrow = node.initializer!.getText(ast);
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  if (!arrow) {
    throw new Error('messageHandler not found in server.ts — this probe needs re-pointing');
  }
  return arrow;
}

const compiled = ts.transpileModule(`const handler = ${extractMessageHandler()};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

// `channelGateway` is injected as undefined: it ends the handler after
// session routing, before the channel-forwarding steps this probe does not model.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const makeHandler = (deps: Record<string, unknown>): any =>
  new Function(
    'deps',
    `const { sbSlug, dataComposer, logger, resolveInboundAgent, sessionService, channelGateway } = deps;
     ${compiled}
     return handler;`
  )(deps);

interface ActivityRow {
  [column: string]: unknown;
}

function attributedRow(overrides: ActivityRow = {}): ActivityRow {
  return {
    user_id: 'user-1',
    type: 'message_out',
    platform: 'telegram',
    platform_message_id: '4242',
    platform_chat_id: CHAT,
    agent_id: 'wren',
    sb_id: 'sb-wren',
    session_id: 'session-wren',
    payload: { authorship: 'session' },
    created_at: '2026-09-15T10:00:00Z',
    ...overrides,
  };
}

const OPEN_SESSION = { id: 'session-wren', user_id: 'user-1', ended_at: null };

function clientFor(rows: ActivityRow[], sessions: ActivityRow[] = [OPEN_SESSION]) {
  const tables: Record<string, ActivityRow[]> = { activity_stream: rows, sessions };
  return {
    from(table: string) {
      const predicates: Array<(row: ActivityRow) => boolean> = [];
      const matched = () => (tables[table] ?? []).filter((row) => predicates.every((p) => p(row)));
      const builder = {
        select: () => builder,
        eq(column: string, value: unknown) {
          predicates.push((row) => row[column] === value);
          return builder;
        },
        in(column: string, values: unknown[]) {
          predicates.push((row) => values.includes(row[column]));
          return builder;
        },
        order: () => builder,
        limit(n: number) {
          return Promise.resolve({ data: matched().slice(0, n), error: null });
        },
        maybeSingle() {
          if (table !== 'sessions') throw new Error(`unexpected maybeSingle() on ${table}`);
          return Promise.resolve({ data: matched()[0] ?? null, error: null });
        },
        single() {
          if (table !== 'agent_identities') throw new Error(`unexpected single() on ${table}`);
          return Promise.resolve({ data: { session_scope: 'global' }, error: null });
        },
      };
      return builder;
    },
  };
}

/** Run the real handler and capture the SessionRequest it would have dispatched. */
async function route(options: {
  rows?: ActivityRow[];
  sessions?: ActivityRow[];
  mention?: { sbSlug: string; sbId: string } | null;
  channelRoute?: { sbSlug: string; sbId: string } | null;
  chatType?: string;
}) {
  vi.mocked(resolveAgentFromMention).mockResolvedValue(options.mention ?? null);
  vi.mocked(resolveRouteSlug).mockResolvedValue(
    options.channelRoute
      ? {
          ...options.channelRoute,
          routeId: 'route-1',
          studioHint: null,
          activeSessionId: null,
        }
      : null
  );

  // Stop the handler the moment it has decided, before any live session work.
  const stop = new Error('captured request');
  let captured: { sbSlug: string; metadata: Record<string, unknown> } | undefined;

  const handler = makeHandler({
    sbSlug: DEFAULT_SLUG,
    dataComposer: { getClient: () => clientFor(options.rows ?? [], options.sessions) },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    resolveInboundAgent,
    sessionService: {
      handleMessage: async (request: typeof captured) => {
        captured = request;
        throw stop;
      },
    },
    channelGateway: undefined,
  });

  await expect(
    handler('telegram', CHAT, { id: 'sender-1', name: 'Sender' }, 'a reply', {
      userId: 'user-1',
      replyToMessageId: '4242',
      chatType: options.chatType ?? 'direct',
    })
  ).rejects.toBe(stop);

  return captured!;
}

describe('the production message handler', () => {
  it('does not answer a reply with an author from an unrelated chat', async () => {
    const result = await route({ rows: [attributedRow({ platform_chat_id: OTHER_CHAT })] });

    expect(result.sbSlug).toBe(DEFAULT_SLUG);
    expect(result.metadata.replyRouting).toEqual({
      resolved: false,
      reason: 'no_matching_message',
    });
  });

  it('keeps a mention of the default SB ahead of the reply author', async () => {
    const result = await route({
      rows: [attributedRow()],
      mention: { sbSlug: DEFAULT_SLUG, sbId: 'sb-myra' },
      chatType: 'group',
    });

    expect(result.sbSlug).toBe(DEFAULT_SLUG);
  });

  it('keeps a reply authored by the default SB ahead of a channel route', async () => {
    const result = await route({
      rows: [attributedRow({ agent_id: DEFAULT_SLUG, sb_id: 'sb-myra' })],
      channelRoute: { sbSlug: 'wren', sbId: 'sb-wren' },
    });

    expect(result.sbSlug).toBe(DEFAULT_SLUG);
    expect(result.metadata.replyRouting).toEqual({ resolved: true, session: 'authoring' });
  });

  it('still routes a reply to its author when nothing else matches', async () => {
    const result = await route({ rows: [attributedRow()] });

    expect(result.sbSlug).toBe('wren');
    expect(result.metadata.replyRouting).toEqual({ resolved: true, session: 'authoring' });
  });

  it('hands session routing the session that wrote the message', async () => {
    // The cascade can resolve the session and the handler can still drop it on
    // the way to handleMessage. Only this probe sees the request as dispatched.
    const result = await route({ rows: [attributedRow()] });

    expect(result.metadata.replyToSessionId).toBe('session-wren');
  });

  it('dispatches no anchor when the authoring session has ended', async () => {
    const result = await route({
      rows: [attributedRow()],
      sessions: [{ ...OPEN_SESSION, ended_at: '2026-09-20T12:00:00Z' }],
    });

    expect(result.sbSlug).toBe('wren');
    expect(result.metadata).not.toHaveProperty('replyToSessionId');
    expect(result.metadata.replyRouting).toEqual({ resolved: true, session: 'session_ended' });
  });

  it('says so when an anchored reply lands in a different session', async () => {
    // Admission can decline the anchor (another contact or identity, ended,
    // a live terminal, an occupied studio). Either way the delivery succeeds,
    // so without this line nothing records that the reply missed.
    const warn = vi.fn();
    const handler = makeHandler({
      sbSlug: DEFAULT_SLUG,
      dataComposer: { getClient: () => clientFor([attributedRow()]) },
      logger: { info() {}, warn, error() {}, debug() {} },
      resolveInboundAgent,
      sessionService: {
        handleMessage: async () => ({
          success: true,
          sessionId: 'session-elsewhere',
          responses: [],
        }),
      },
      channelGateway: undefined,
    });

    await handler('telegram', CHAT, { id: 'sender-1', name: 'Sender' }, 'a reply', {
      userId: 'user-1',
      replyToMessageId: '4242',
      chatType: 'direct',
    });

    expect(warn).toHaveBeenCalledWith(
      '[Route] Reply was anchored to its authoring session but landed elsewhere',
      expect.objectContaining({
        authoringSessionId: 'session-wren',
        routedSessionId: 'session-elsewhere',
      })
    );
  });

  it('stays quiet when the anchored reply lands where it was aimed', async () => {
    const warn = vi.fn();
    const handler = makeHandler({
      sbSlug: DEFAULT_SLUG,
      dataComposer: { getClient: () => clientFor([attributedRow()]) },
      logger: { info() {}, warn, error() {}, debug() {} },
      resolveInboundAgent,
      sessionService: {
        handleMessage: async () => ({ success: true, sessionId: 'session-wren', responses: [] }),
      },
      channelGateway: undefined,
    });

    await handler('telegram', CHAT, { id: 'sender-1', name: 'Sender' }, 'a reply', {
      userId: 'user-1',
      replyToMessageId: '4242',
      chatType: 'direct',
    });

    expect(warn).not.toHaveBeenCalled();
  });
});

/**
 * Does the anchored reply get ADMITTED safely? The cases above stop at the
 * request the handler dispatches. These carry it on through the real
 * SessionService over the fake database and the real lease service, with
 * only the runner mocked, because each hazard lives past the dispatch.
 *
 * The three hazards are Lumen's, from the PR #682 review, where all three were
 * red at dd807fea and green at the base: a reply resuming an older session
 * beside its live terminal, entering a studio another session holds the lease
 * on, and binding a new session to a studio that closed after the reply
 * lookup. The first case is the control. Without it the other three would
 * pass just as well if the anchor never reached session routing at all.
 */
describe('reply admission, through session routing', () => {
  // Real directories, so the lease service's worktree check passes and the
  // occupied case exercises the lease that is held, not a retired studio.
  const worktrees = mkdtempSync(path.join(tmpdir(), 'reply-admission-'));
  afterAll(() => rmSync(worktrees, { recursive: true, force: true }));
  afterEach(() => {
    resetActiveRuns();
    resetPendingFinalizations();
  });

  function makeSession(id: string, overrides: Partial<Session> = {}): Session {
    return {
      id,
      userId: 'user-1',
      sbSlug: 'wren',
      sbId: 'sb-wren',
      backendSessionId: `backend-${id}`,
      type: 'primary',
      status: 'active',
      lifecycle: 'idle',
      contextTokens: 100,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheWriteTokens: 0,
      messageCount: 0,
      tokenCount: 0,
      backend: 'claude-code',
      model: null,
      lastCompactionAt: null,
      compactionCount: 0,
      endedAt: null,
      metadata: {},
      startedAt: new Date(),
      lastActivityAt: new Date(),
      ...overrides,
    };
  }

  function rig(
    opts: {
      /** A CLI polling the authoring session right now. */
      attached?: boolean;
      /** Another session holds the authoring studio's lease. */
      occupied?: boolean;
      /** The authoring session and its studio close after the reply lookup. */
      endBeforeAdmission?: boolean;
      /** The authoring session is bound to its studio without a thread. */
      threadless?: boolean;
    } = {}
  ) {
    const now = new Date().toISOString();
    // The authoring session is OLDER than the home session, so general reuse
    // would never pick it: landing there can only be the anchor's doing.
    const older = makeSession('older', {
      studioId: 'studio-old',
      threadKey: opts.threadless ? undefined : 'pr:900001',
      cliAttached: opts.attached === true,
    });
    const newer = makeSession('newer', { studioId: 'studio-home' });
    const rows = [older, newer];

    const tables: Record<string, Row[]> = {
      agent_identities: [
        {
          id: 'sb-wren',
          user_id: 'user-1',
          agent_id: 'wren',
          workspace_id: 'ws-1',
          session_scope: 'global',
          metadata: {},
        },
      ],
      activity_stream: [attributedRow({ session_id: 'older', created_at: now })],
      sessions: rows.map((s) => ({
        id: s.id,
        user_id: 'user-1',
        sb_id: 'sb-wren',
        agent_id: 'wren',
        studio_id: s.studioId,
        thread_key: s.threadKey ?? null,
        ended_at: null,
        cli_attached: s.cliAttached === true,
        cli_poll_at: s.cliAttached ? now : null,
        updated_at: now,
      })),
      studios: ['studio-old', 'studio-home'].map((id) => ({
        id,
        user_id: 'user-1',
        agent_id: 'wren',
        sb_id: 'sb-wren',
        status: 'active',
        route_patterns: [],
        ephemeral: false,
        worktree_path: mkdtempSync(path.join(worktrees, `${id}-`)),
        lease:
          opts.occupied && id === 'studio-old'
            ? {
                sessionId: 'another-writer',
                threadKey: 'pr:900002',
                threadKeys: ['pr:900002'],
                sbSlug: 'wren',
                sbId: 'sb-wren',
                acquiredAt: now,
                heartbeatAt: now,
              }
            : null,
      })),
      inbox_threads: [
        { id: 'thread-1', workspace_id: 'ws-1', thread_key: 'pr:900001', key_type: 'pr' },
      ],
      thread_key_types: [
        {
          id: 'tkt-pr',
          workspace_id: null,
          type: 'pr',
          write_intent: 'write',
          studio_policy: 'provision',
          description: null,
          created_at: now,
          updated_at: now,
        },
      ],
      studio_lease_events: [],
    };
    const db = makeFakeSupabase(tables);

    const repo = {
      findById: vi.fn(async (id: string) => rows.find((s) => s.id === id) ?? null),
      // Newest open session first, the way general reuse orders them.
      findByUserAndAgent: vi.fn(
        async (_userId: string, _slug: string, o: { studioId?: string } = {}) =>
          [...rows]
            .reverse()
            .find((s) => !s.endedAt && (!o.studioId || s.studioId === o.studioId)) ?? null
      ),
      create: vi.fn(async (data: Partial<Session>) => {
        const created = makeSession('created', data);
        rows.push(created);
        return created;
      }),
      update: vi.fn(async (id: string, update: Partial<Session>) =>
        Object.assign(rows.find((s) => s.id === id)!, update)
      ),
      updateIfTurnEpoch: vi.fn(async (id: string, epoch: string, update: Partial<Session>) => {
        const row = rows.find((s) => s.id === id)!;
        return row.turnEpoch === epoch ? Object.assign(row, update) : null;
      }),
      updateTokenUsage: vi.fn(async () => {}),
    };
    const contextBuilder = {
      getAgentBackend: vi.fn(async () => ({ backend: 'claude-code' })),
      buildContext: vi.fn(async () => ({
        agent: { sbSlug: 'wren', name: 'Wren', role: 'developer', values: [], capabilities: [] },
        user: { id: 'user-1', timezone: 'America/Los_Angeles', contacts: {}, preferences: {} },
        temporal: {
          currentTime: '10 AM',
          currentDate: '2026-09-25',
          dayOfWeek: 'Friday',
          timezone: 'America/Los_Angeles',
          greeting: 'Hello',
        },
        recentMemories: [],
        activeProjects: [],
      })),
    };
    const runner = {
      run: vi.fn(async (_text: unknown, { backendSessionId }: { backendSessionId: string }) => ({
        success: true,
        backendSessionId,
        responses: [],
        usage: { contextTokens: 100, inputTokens: 1, outputTokens: 1 },
      })),
    };
    const activity = {
      logMessage: vi.fn(async () => ({ id: 'activity-1' })),
      logActivity: vi.fn(async () => ({ id: 'activity-1' })),
    };
    const service = new SessionService(
      repo as never,
      contextBuilder as never,
      runner as never,
      activity as never,
      { defaultWorkingDirectory: worktrees, mcpConfigPath: path.join(worktrees, 'unread.json') },
      runner as never,
      db as never,
      runner as never,
      runner as never,
      runner as never
    );
    // No case below may provision a worktree, and a divert would try to.
    const ensureOverflowStudio = vi.fn(async () => null);
    (service as unknown as { overflowService: unknown }).overflowService = {
      ensureOverflowStudio,
      findOverflowStudio: vi.fn(async () => null),
    };

    const placed: Session[] = [];
    const processMessage = (
      service as unknown as { processMessage: (...a: unknown[]) => Promise<unknown> }
    ).processMessage.bind(service);
    vi.spyOn(
      service as unknown as { processMessage: (...a: unknown[]) => Promise<unknown> },
      'processMessage'
    ).mockImplementation(async (request, session, epoch) => {
      placed.push({ ...(session as Session) });
      return processMessage(request, session, epoch);
    });

    vi.mocked(resolveAgentFromMention).mockResolvedValue(null);
    vi.mocked(resolveRouteSlug).mockResolvedValue(null);
    const handler = makeHandler({
      sbSlug: DEFAULT_SLUG,
      dataComposer: { getClient: () => db },
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      resolveInboundAgent,
      channelGateway: undefined,
      sessionService: {
        handleMessage: (request: unknown) => {
          if (opts.endBeforeAdmission) {
            // After the reply lookup read the session as open, before routing.
            older.endedAt = new Date();
            tables.sessions[0].ended_at = older.endedAt.toISOString();
            tables.studios[0].status = 'closed';
          }
          return service.handleMessage(request as never);
        },
      },
    });

    return {
      older,
      tables,
      repo,
      runner,
      service,
      placed,
      ensureOverflowStudio,
      send: () =>
        handler('telegram', CHAT, { id: 'sender-1', name: 'Sender' }, 'continue the work', {
          userId: 'user-1',
          replyToMessageId: '4242',
          chatType: 'direct',
        }),
    };
  }

  const resumedBackends = (r: ReturnType<typeof rig>) =>
    r.runner.run.mock.calls.map(([, o]) => (o as { backendSessionId: string }).backendSessionId);

  it('resumes the session that wrote the message, under its thread lease', async () => {
    const r = rig();
    await r.send();

    expect(r.placed.map((s) => s.id)).toEqual(['older']);
    expect(resumedBackends(r)).toEqual(['backend-older']);
    // Its thread's contract applied: the write lease is taken, as a message
    // on pr:900001 would take it.
    expect(r.tables.studios[0].lease).toMatchObject({
      sessionId: 'older',
      threadKey: 'pr:900001',
    });
  });

  it('does not resume an older session headless beside its live terminal', async () => {
    const r = rig({ attached: true });
    await r.send();

    expect(resumedBackends(r)).not.toContain('backend-older');
    expect(r.older.cliAttached).toBe(true);
    // Routed as an unanchored reply would be: the newest session.
    expect(r.placed.map((s) => s.id)).toEqual(['newer']);
  });

  it('does not enter a studio whose write lease another session holds', async () => {
    const r = rig({ occupied: true });
    await r.send();

    expect(r.placed.map((s) => s.studioId)).not.toContain('studio-old');
    expect(r.placed.map((s) => s.id)).toEqual(['newer']);
    // Declined, not diverted: the holder keeps its lease, the studio stays
    // active (so this was the held-lease path, not a retired worktree), the
    // authoring session keeps its binding, and nothing was provisioned.
    expect(r.tables.studios[0].lease).toMatchObject({ sessionId: 'another-writer' });
    expect(r.tables.studios[0].status).toBe('active');
    expect(r.older.studioId).toBe('studio-old');
    expect(r.ensureOverflowStudio).not.toHaveBeenCalled();
  });

  it('does not enter an occupied studio through a session bound to it without a thread', async () => {
    // Lumen, PR #682 r2: the lease step ran only for a session with a thread,
    // so the same occupied studio was open to a threadless session in it.
    const r = rig({ occupied: true, threadless: true });
    await r.send();

    expect(r.placed.map((s) => s.studioId)).not.toContain('studio-old');
    expect(r.placed.map((s) => s.id)).toEqual(['newer']);
    expect(r.tables.studios[0].lease).toMatchObject({ sessionId: 'another-writer' });
    expect(r.tables.studios[0].status).toBe('active');
  });

  it('does not bind anything to a studio that closed after the reply lookup', async () => {
    const r = rig({ endBeforeAdmission: true });
    await r.send();

    expect(r.placed.map((s) => s.studioId)).not.toContain('studio-old');
    expect(r.repo.create.mock.calls.some(([data]) => data.studioId === 'studio-old')).toBe(false);
    expect(r.placed.map((s) => s.id)).toEqual(['newer']);
  });

  it('a reply declined at dequeue waits for the turn already running in its fallback session', async () => {
    // Lumen, PR #682 r2. The reply queues behind its authoring session's turn,
    // which then ends that session. At dequeue its anchor is declined and it
    // resolves to the newer session, which has a turn of its own running.
    const r = rig();
    const gates = new Map<string, () => void>();
    const running = new Map<string, number>();
    const peak = new Map<string, number>();
    const entered: string[] = [];
    vi.spyOn(
      r.service as unknown as { processMessage: (...a: unknown[]) => Promise<unknown> },
      'processMessage'
    ).mockImplementation(async (request, session) => {
      const { id } = session as Session;
      const turn = `${id}:${(request as { content: string }).content}`;
      entered.push(turn);
      running.set(id, (running.get(id) ?? 0) + 1);
      peak.set(id, Math.max(peak.get(id) ?? 0, running.get(id)!));
      await new Promise<void>((resolve) => gates.set(turn, resolve));
      running.set(id, running.get(id)! - 1);
      return { success: true, sessionId: id, responses: [] };
    });
    const turnIn = (sessionId: string) =>
      r.service.handleMessage({
        userId: 'user-1',
        sbSlug: 'wren',
        channel: 'telegram',
        conversationId: CHAT,
        sender: { id: 'sender-1', name: 'Sender' },
        content: 'existing turn',
        metadata: { recipientSessionId: sessionId },
      } as never);
    const pendingQueues = (r.service as unknown as { pendingQueues: Map<string, unknown[]> })
      .pendingQueues;

    const olderTurn = turnIn('older');
    await vi.waitFor(() => expect(gates.has('older:existing turn')).toBe(true));
    const newerTurn = turnIn('newer');
    await vi.waitFor(() => expect(gates.has('newer:existing turn')).toBe(true));
    const reply = r.send();
    await vi.waitFor(() => expect(pendingQueues.get('wren:older')).toHaveLength(1));

    r.older.endedAt = new Date();
    r.tables.sessions[0].ended_at = r.older.endedAt.toISOString();
    r.tables.studios[0].status = 'closed';
    gates.get('older:existing turn')!();
    // Either the reply runs now, beside the newer session's turn, or it has
    // moved to that session's queue.
    await vi.waitFor(() =>
      expect(
        gates.has('newer:continue the work') || pendingQueues.get('wren:newer')?.length === 1
      ).toBe(true)
    );
    expect(peak.get('newer')).toBe(1);
    await olderTurn;

    gates.get('newer:existing turn')!();
    await vi.waitFor(() => expect(gates.has('newer:continue the work')).toBe(true));
    gates.get('newer:continue the work')!();
    await Promise.all([newerTurn, reply]);

    expect(peak.get('newer')).toBe(1);
    expect(entered).toEqual([
      'older:existing turn',
      'newer:existing turn',
      'newer:continue the work',
    ]);
  });
});
