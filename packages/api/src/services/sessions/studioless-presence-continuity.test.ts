/**
 * A project-pinned PRESENCE thread, for an SB with no studio in the project's
 * repo, keeps one session (task bd4657a0).
 *
 * Routing places that work studioless by design: the project-repo tier finds
 * no studio, the type is presence + reuse-only, and the create boundary
 * proceeds with no worktree. The #681 guard then refused every studioless
 * session on a pinned thread, so nothing the thread produced was admissible
 * on its next message. On inkling:thread:app-build every message to Lumen
 * created rows in the routeOnly pass, again in the wake pass, and again in
 * handleMessage; 20 rows in an hour, 6 that ran.
 *
 * Each message here is what send_to_inbox does: a routeOnly dispatch, then a
 * wake dispatch, both carrying the recipientSessionId inbox-handlers infers
 * from the participant stamp. The handler is the REAL one lifted out of
 * server.ts (as in thread-assignment-placement.test.ts), over the real
 * assignThreadParticipant and the real SessionService, and handleMessage is
 * the real one too: the runner records the cwd it was given and the
 * transcript it resumed. One table set backs the repository, routing and
 * assignment, so a row the service creates is a row every reader sees.
 */

import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as sessionServiceModule from './session-service';
import { SessionService, RoutingRefusedError } from './session-service';
import { assignThreadParticipant } from './thread-assignment';
import { decideDelivery } from './trigger-delivery.js';
import { resetActiveRuns } from './active-runs.js';
import { resetPendingFinalizations } from './finalize-turn.js';
import { makeFakeSupabase, type Row } from './fake-supabase.js';
import type { IContextBuilder, IRunner, Session } from './types';
import type { IActivityStream } from './session-service';

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('./claude-runner.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, buildIdentityPrompt: vi.fn(() => 'identity-prompt') };
});

vi.mock('../graph-executor.service', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, releaseGraphClaimsForSession: vi.fn(async () => 0) };
});

// The pre-spawn studio checklist runs against the default directory for a
// studioless session; it would run `ink init` there.
vi.mock('../studio-complete.js', () => ({
  ensureStudioComplete: vi.fn(async () => ({ ok: true, complete: true, missing: [] })),
}));

const USER = 'user-1';
const SLUG = 'lumen';
const SB_ID = 'sb-lumen-uuid';
const WS = 'ws-probe';
const THREAD_ID = 'thread-1';
const THREAD_KEY = 'inkling:thread:app-build';
const PROJECT = 'inkling';
// None of these exist on disk, so realpath leaves them as written.
const REPO_PROJECT = '/repos/inkling';
const REPO_OTHER = '/repos/inkwell';
const DEFAULT_DIR = '/ink-server-default';

function extractTriggerHandler(): string {
  const source = readFileSync(new URL('../../server.ts', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('server.ts', source, ts.ScriptTarget.Latest, true);
  let arrow = '';
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(ast) === 'agentGateway.setDefaultHandler' &&
      node.arguments.length === 1
    ) {
      arrow = node.arguments[0].getText(ast);
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  if (!arrow) throw new Error('agentGateway.setDefaultHandler(<arrow>) not found in server.ts');
  return arrow;
}

const compiledHandler = ts.transpileModule(`const handler = ${extractTriggerHandler()};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const makeTriggerHandler = (deps: Record<string, unknown>): any =>
  new Function(
    'deps',
    `const {
       logger, dataComposer, sessionService, getUserFromContext, logInkmail,
       loadThreadDescriptor, formatThreadDescriptorLines, assignThreadParticipant,
       stampRoutingHold, clearRoutingHold, storedTriggerMedia, decideDelivery,
       RoutingRefusedError, routeResponses, triggerRetryScheduler, resolveThreadTriggerScope
     } = deps;
     ${compiledHandler}
     return handler;`
  )(deps);

/** A session row as the DB holds it. */
function sessionRow(id: string, overrides: Row = {}): Row {
  return {
    id,
    user_id: USER,
    agent_id: SLUG,
    sb_id: SB_ID,
    studio_id: null,
    working_dir: null,
    thread_key: THREAD_KEY,
    contact_id: null,
    ended_at: null,
    lifecycle: 'idle',
    status: 'active',
    message_count: 0,
    backend_session_id: null,
    turn_epoch: null,
    backend: 'claude-code',
    metadata: {},
    ...overrides,
  };
}

/** What the fixed create boundary records on a row it places studioless. */
const recordedPlacement = (repoRoot = REPO_PROJECT): Row => ({
  routing_decision: {
    tier: 'project-repo-created',
    studioId: null,
    threadKey: THREAD_KEY,
    placement: { kind: 'studioless-presence', project: PROJECT, repoRoot },
  },
});

/**
 * A repository over the shared `sessions` rows, with the real one's
 * semantics where routing depends on them: findByThreadKey is the newest
 * started live row (crashed as the fallback), owner-scoped, by identity.
 */
function makeRepository(tables: Record<string, Row[]>) {
  const sessions = tables.sessions;
  const toSession = (r: Row): Session =>
    ({
      id: r.id,
      userId: r.user_id,
      sbSlug: r.agent_id,
      sbId: r.sb_id ?? undefined,
      studioId: r.studio_id ?? undefined,
      workingDir: r.working_dir ?? undefined,
      contactId: r.contact_id ?? undefined,
      threadKey: r.thread_key ?? undefined,
      endedAt: r.ended_at ? new Date(r.ended_at as string) : null,
      metadata: r.metadata ?? {},
      backend: r.backend ?? 'claude-code',
      model: null,
      type: 'primary',
      lifecycle: r.lifecycle ?? 'idle',
      status: r.status ?? 'active',
      messageCount: r.message_count ?? 0,
      tokenCount: 0,
      contextTokens: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheWriteTokens: 0,
      compactionCount: 0,
      lastCompactionAt: null,
      backendSessionId: r.backend_session_id ?? null,
      turnEpoch: r.turn_epoch ?? null,
      startedAt: new Date(),
      lastActivityAt: new Date(),
    }) as unknown as Session;
  const apply = (row: Row, patch: Record<string, unknown>) => {
    if ('studioId' in patch) row.studio_id = patch.studioId ?? null;
    if ('endedAt' in patch) row.ended_at = patch.endedAt ? String(patch.endedAt) : null;
    if ('backendSessionId' in patch) row.backend_session_id = patch.backendSessionId ?? null;
    if ('lifecycle' in patch) row.lifecycle = patch.lifecycle;
    if ('status' in patch) row.status = patch.status;
    if ('messageCount' in patch) row.message_count = patch.messageCount;
    if ('turnEpoch' in patch) row.turn_epoch = patch.turnEpoch ?? null;
    if ('metadata' in patch) {
      row.metadata = { ...((row.metadata as Row) ?? {}), ...((patch.metadata as Row) ?? {}) };
    }
  };
  let n = 0;
  return {
    findById: vi.fn(async (id: string) => {
      const row = sessions.find((r) => r.id === id);
      return row ? toSession(row) : null;
    }),
    findByUserAndAgent: vi.fn(async () => null),
    findByUser: vi.fn(async () => []),
    findByAlias: vi.fn(async () => null),
    findByThreadKey: vi.fn(
      async (
        userId: string,
        sbSlug: string,
        threadKey: string,
        studioId?: string,
        contactId?: string,
        sbId?: string | null
      ) => {
        const candidates = [...sessions]
          .reverse()
          .filter(
            (r) =>
              r.user_id === userId &&
              r.thread_key === threadKey &&
              (r.ended_at ?? null) === null &&
              (sbId ? r.sb_id === sbId : r.agent_id === sbSlug) &&
              (studioId ? r.studio_id === studioId : true) &&
              (contactId ? r.contact_id === contactId : (r.contact_id ?? null) === null)
          );
        const live = candidates.find(
          (r) => r.lifecycle !== 'completed' && r.lifecycle !== 'failed'
        );
        const match = live ?? candidates.find((r) => r.lifecycle === 'failed');
        return match ? toSession(match) : null;
      }
    ),
    create: vi.fn(async (payload: Record<string, unknown>) => {
      const row = sessionRow(`created-${++n}`, {
        sb_id: payload.sbId ?? null,
        studio_id: payload.studioId ?? null,
        thread_key: payload.threadKey ?? null,
        contact_id: payload.contactId ?? null,
        backend: payload.backend ?? 'claude-code',
        metadata: payload.metadata ?? {},
      });
      sessions.push(row);
      return toSession(row);
    }),
    update: vi.fn(async (id: string, patch: Record<string, unknown>) => {
      const row = sessions.find((r) => r.id === id);
      if (!row) throw new Error(`Session not found: ${id}`);
      apply(row, patch);
      return toSession(row);
    }),
    updateIfTurnEpoch: vi.fn(async (id: string, epoch: string, patch: Record<string, unknown>) => {
      const row = sessions.find((r) => r.id === id);
      if (!row) throw new Error(`Session not found: ${id}`);
      if (row.turn_epoch !== epoch) return null;
      apply(row, patch);
      return toSession(row);
    }),
    updateTokenUsage: vi.fn(async () => undefined),
    markCompacted: vi.fn(async () => undefined),
    tryAcquireCompactionLock: vi.fn(async () => true),
    releaseCompactionLock: vi.fn(async () => undefined),
  };
}

function studioRow(id: string, repoRoot: string): Row {
  return {
    id,
    user_id: USER,
    agent_id: SLUG,
    sb_id: SB_ID,
    status: 'active',
    branch: 'main',
    base_branch: 'main',
    ephemeral: false,
    lease: null,
    route_patterns: [],
    repo_root: repoRoot,
    worktree_path: `${repoRoot}--${id}`,
  };
}

function typeRow(type: string, writeIntent: string, studioPolicy: string): Row {
  return {
    id: `tkt-${type}`,
    workspace_id: null,
    type,
    write_intent: writeIntent,
    studio_policy: studioPolicy,
    description: null,
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-01T00:00:00Z',
  };
}

const contextBuilder = {
  buildContext: vi.fn(async () => ({
    agent: { sbSlug: SLUG, name: 'Lumen', role: 'assistant', values: [], capabilities: [] },
    user: { id: USER, timezone: 'UTC', contacts: {}, preferences: {} },
    temporal: {
      currentTime: '02:30',
      currentDate: '2026-10-02',
      dayOfWeek: 'Friday',
      timezone: 'UTC',
      greeting: 'Good night',
    },
    recentMemories: [],
    activeProjects: [],
  })),
  buildMinimalContext: vi.fn(async () => ({})),
  getAgentBackend: vi.fn(async () => ({ backend: 'claude', provider: null })),
} as unknown as IContextBuilder;

const activityStream = {
  logMessage: vi.fn(async () => ({ id: 'msg-1' })),
  logActivity: vi.fn(async () => ({ id: 'activity-1' })),
  tagActivityTaskGroup: vi.fn(async () => undefined),
} as unknown as IActivityStream;

interface WorldOptions {
  /** inbox_threads.key_type; the registry below maps it. Default `thread`. */
  keyType?: string;
  /** projects.repo_root; null = the project names no repo. */
  projectRepo?: string | null;
  studios?: Row[];
  sessions?: Row[];
  /** The participant stamp's session, if any. */
  stamp?: string | null;
  /** Every studios read fails (the lookup-failure control). */
  studiosUnreadable?: boolean;
  /**
   * Only the root-checkout (main studio) read fails: the read that filters
   * on worktree_path. The non-ephemeral studio lookup before it succeeds.
   */
  mainStudioUnreadable?: boolean;
}

/** A query whose maybeSingle fails once it has filtered on worktree_path. */
function failingOnWorktreePath<T extends object>(query: T): T {
  let poisoned = false;
  const proxy: T = new Proxy(query, {
    get(target, prop) {
      if (prop === 'eq') {
        return (col: string, val: unknown) => {
          if (col === 'worktree_path') poisoned = true;
          (target as { eq: (c: string, v: unknown) => unknown }).eq(col, val);
          return proxy;
        };
      }
      if (prop === 'maybeSingle' && poisoned) {
        return async () => ({ data: null, error: { message: 'main studio unreadable' } });
      }
      const value = (target as Record<string | symbol, unknown>)[prop];
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        const result = (value as (...a: unknown[]) => unknown).apply(target, args);
        return result === target ? proxy : result;
      };
    },
  });
  return proxy;
}

function makeWorld(opts: WorldOptions = {}) {
  const tables: Record<string, Row[]> = {
    agent_identities: [
      {
        id: SB_ID,
        user_id: USER,
        agent_id: SLUG,
        workspace_id: WS,
        default_session_id: null,
      },
    ],
    inbox_threads: [
      {
        id: THREAD_ID,
        workspace_id: WS,
        thread_key: THREAD_KEY,
        key_type: opts.keyType ?? 'thread',
        key_project: PROJECT,
        key_id: 'app-build',
      },
    ],
    projects: [
      {
        workspace_id: WS,
        slug: PROJECT,
        repo_root: opts.projectRepo === undefined ? REPO_PROJECT : opts.projectRepo,
      },
    ],
    // The production templates for the types these tests use.
    thread_key_types: [
      typeRow('thread', 'presence', 'reuse-only'),
      typeRow('deploy', 'write', 'reuse-only'),
      typeRow('pr', 'write', 'provision'),
    ],
    // The SB's only studio is in another repo, as Lumen's was.
    studios: opts.studios ?? [studioRow('studio-other', REPO_OTHER)],
    sessions: opts.sessions ?? [],
    inbox_thread_participants: [
      { thread_id: THREAD_ID, sb_id: SB_ID, session_id: opts.stamp ?? null },
    ],
    studio_lease_events: [],
    tasks: [],
  };
  const fake = makeFakeSupabase(tables);
  const supabase = opts.mainStudioUnreadable
    ? {
        ...fake,
        from(table: string) {
          const real = fake.from(table);
          if (table !== 'studios') return real;
          return { ...real, select: () => failingOnWorktreePath(real.select()) };
        },
      }
    : opts.studiosUnreadable
      ? {
          ...fake,
          from(table: string) {
            if (table !== 'studios') return fake.from(table);
            const failing = {
              select: () => failing,
              eq: () => failing,
              in: () => failing,
              is: () => failing,
              not: () => failing,
              order: () => failing,
              limit: () => failing,
              maybeSingle: async () => ({ data: null, error: { message: 'studios unreadable' } }),
              single: async () => ({ data: null, error: { message: 'studios unreadable' } }),
              then: (resolve: (v: unknown) => unknown) =>
                Promise.resolve({ data: null, error: { message: 'studios unreadable' } }).then(
                  resolve
                ),
            };
            return failing;
          },
        }
      : fake;
  const repository = makeRepository(tables);

  /** The cwd each spawn was given, and the transcript it resumed. */
  const runs: Array<{ cwd: string; resumed: string | null; returned: string }> = [];
  let transcripts = 0;
  const runner: IRunner = {
    run: vi.fn(async (_message, options) => {
      const returned = options.backendSessionId ?? `transcript-${++transcripts}`;
      runs.push({
        cwd: options.config.workingDirectory,
        resumed: options.backendSessionId ?? null,
        returned,
      });
      return {
        success: true,
        backendSessionId: returned,
        responses: [],
        usage: { contextTokens: 10, inputTokens: 5, outputTokens: 5 },
        finalTextResponse: 'ok',
        toolCalls: [],
      };
    }),
  };

  const service = new SessionService(
    repository as never,
    contextBuilder,
    runner,
    activityStream,
    { defaultWorkingDirectory: DEFAULT_DIR, mcpConfigPath: '' },
    runner,
    supabase as never
  );

  const assignment = vi.fn(assignThreadParticipant);
  const handleMessage = vi.fn(service.handleMessage.bind(service));
  const logInkmail = vi.fn(async () => undefined);
  const handler = makeTriggerHandler({
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    dataComposer: { getClient: () => supabase },
    sessionService: {
      getOrCreateSession: service.getOrCreateSession.bind(service),
      getSession: service.getSession.bind(service),
      endSession: service.endSession.bind(service),
      sessionAllowedForThread: service.sessionAllowedForThread.bind(service),
      handleMessage,
    },
    getUserFromContext: () => ({ userId: USER }),
    resolveThreadTriggerScope: vi.fn(async () => ({
      userId: USER,
      recipientSbId: SB_ID,
      threadWorkspaceId: WS,
    })),
    logInkmail,
    loadThreadDescriptor: vi.fn(async () => null),
    formatThreadDescriptorLines: vi.fn(() => [] as string[]),
    assignThreadParticipant: assignment,
    stampRoutingHold: vi.fn(async () => undefined),
    clearRoutingHold: vi.fn(async () => undefined),
    storedTriggerMedia: vi.fn(async () => []),
    decideDelivery,
    RoutingRefusedError,
    routeResponses: vi.fn(async () => undefined),
    triggerRetryScheduler: { cancelFor: vi.fn() },
  });

  const stamp = () => tables.inbox_thread_participants[0].session_id as string | null;

  const dispatch = (extra: Record<string, unknown>) =>
    handler({
      toSlug: SLUG,
      toSbId: SB_ID,
      fromSlug: 'wren',
      triggerType: 'message',
      priority: 'normal',
      summary: 'probe',
      threadId: THREAD_ID,
      threadKey: THREAD_KEY,
      ...extra,
    }).then(
      () => null,
      (e: unknown) => e
    );

  /**
   * One send_to_inbox: the anchor inbox-handlers infers (here, the stamp),
   * then the synchronous routeOnly assignment, then the wake.
   */
  async function send(): Promise<{ routeOnly: unknown; wake: unknown }> {
    const inferred = stamp() ?? undefined;
    const routeOnly = await dispatch({ routeOnly: true, recipientSessionId: inferred });
    const wake = await dispatch({ recipientSessionId: inferred });
    return { routeOnly, wake };
  }

  const liveRows = () => tables.sessions.filter((r) => (r.ended_at ?? null) === null);
  const ranIn = (i: number) =>
    (handleMessage.mock.results[i]?.value as Promise<{ sessionId: string }> | undefined)?.then(
      (r) => r.sessionId
    );

  return {
    tables,
    service,
    repository,
    runner,
    runs,
    handleMessage,
    assignment,
    send,
    dispatch,
    stamp,
    liveRows,
    ranIn,
  };
}

describe('a pinned presence thread with no studio in the project repo keeps one session (task bd4657a0)', () => {
  beforeEach(() => {
    resetActiveRuns();
    resetPendingFinalizations();
  });

  it('first message makes one row; the second resumes it: same id, stamp and transcript, no new rows', async () => {
    const w = makeWorld();

    const first = await w.send();
    expect(first).toEqual({ routeOnly: null, wake: null });
    expect(w.tables.sessions).toHaveLength(1);
    const session = w.tables.sessions[0];
    expect(session.studio_id).toBeNull();
    expect(w.stamp()).toBe(session.id);
    expect(await w.ranIn(0)).toBe(session.id);
    // Repo-neutral presence: the runner was given the default directory,
    // not the project's repo.
    expect(w.runs[0].cwd).toBe(DEFAULT_DIR);
    expect(session.backend_session_id).toBe(w.runs[0].returned);
    // The placement is recorded on the row, server-side.
    expect((session.metadata as Row).routing_decision).toMatchObject({
      placement: { kind: 'studioless-presence', project: PROJECT, repoRoot: REPO_PROJECT },
    });

    const second = await w.send();
    expect(second).toEqual({ routeOnly: null, wake: null });
    expect(w.tables.sessions).toHaveLength(1);
    expect(w.stamp()).toBe(session.id);
    expect(await w.ranIn(1)).toBe(session.id);
    expect(w.runs[1]).toEqual({
      cwd: DEFAULT_DIR,
      resumed: w.runs[0].returned,
      returned: w.runs[0].returned,
    });
  });

  it('a Claude-style hook report of the default directory does not break continuity', async () => {
    // Claude hooks send workingDir on every lifecycle event, and a spawned
    // studioless session runs in the default directory.
    const w = makeWorld();
    await w.send();
    const session = w.tables.sessions[0];
    session.working_dir = DEFAULT_DIR;

    await w.send();
    expect(w.tables.sessions).toHaveLength(1);
    expect(await w.ranIn(1)).toBe(session.id);
    expect(w.runs[1].resumed).toBe(w.runs[0].returned);
  });

  it('from the incident state: one new row, the stamp repaired to it, then continuity', async () => {
    // A row from before the fix: it ran, studioless, but routing recorded no
    // placement on it and it reports no working_dir. Unverifiable, so it is
    // not resumed; its successor is, from then on.
    const legacy = sessionRow('legacy-real', {
      backend_session_id: 'legacy-transcript',
      message_count: 3,
      metadata: { routing_decision: { tier: 'project-repo-created', studioId: null } },
    });
    const w = makeWorld({ sessions: [legacy], stamp: 'legacy-real' });

    await w.send();
    expect(w.tables.sessions).toHaveLength(2);
    const successor = w.tables.sessions[1];
    expect(w.stamp()).toBe(successor.id);
    expect(await w.ranIn(0)).toBe(successor.id);

    await w.send();
    expect(w.tables.sessions).toHaveLength(2);
    expect(w.stamp()).toBe(successor.id);
    expect(await w.ranIn(1)).toBe(successor.id);
    expect(w.runs[1].resumed).toBe(w.runs[0].returned);
  });

  it('working_dir evidence: matching resumes, null without a record and wrong-repo do not', async () => {
    // Matching: a pre-fix row that reported running inside the project repo.
    const matching = makeWorld({
      sessions: [
        sessionRow('ran-in-project', {
          working_dir: `${REPO_PROJECT}/app`,
          backend_session_id: 'project-transcript',
        }),
      ],
      stamp: 'ran-in-project',
    });
    await matching.send();
    expect(matching.tables.sessions).toHaveLength(1);
    expect(await matching.ranIn(0)).toBe('ran-in-project');
    expect(matching.runs[0].resumed).toBe('project-transcript');

    // Wrong repo: the row even carries the placement record, but it reports
    // running in another repo (a terminal resumed it there).
    const wrong = makeWorld({
      sessions: [
        sessionRow('ran-elsewhere', {
          working_dir: `${REPO_OTHER}/packages/api`,
          backend_session_id: 'elsewhere-transcript',
          metadata: recordedPlacement(),
        }),
      ],
      stamp: 'ran-elsewhere',
    });
    await wrong.send();
    expect(wrong.tables.sessions).toHaveLength(2);
    expect(await wrong.ranIn(0)).not.toBe('ran-elsewhere');
    expect(wrong.runs[0].resumed).toBeNull();

    // A string prefix is not containment: /repos/inkling-old is not inside
    // /repos/inkling.
    const prefix = makeWorld({
      sessions: [
        sessionRow('sibling-dir', {
          working_dir: `${REPO_PROJECT}-old`,
          backend_session_id: 'sibling-transcript',
        }),
      ],
      stamp: 'sibling-dir',
    });
    await prefix.send();
    expect(await prefix.ranIn(0)).not.toBe('sibling-dir');

    // Null working_dir, no record: covered by the incident case above.
  });

  it('the inferred anchor is admitted by the same decision when the newest row is an empty one', async () => {
    // Production's state: the newest rows on the thread are the empty ones
    // the bug left, so the thread-key rung cannot find the real session.
    // Only the anchor (the stamp, as inbox-handlers infers it) can, and it
    // must survive to handleMessage, where admission re-resolves.
    const w = makeWorld({
      sessions: [
        sessionRow('evidenced', {
          backend_session_id: 'evidenced-transcript',
          metadata: recordedPlacement(),
        }),
        sessionRow('empty-newer'),
      ],
      stamp: 'evidenced',
    });
    await w.send();
    expect(w.tables.sessions).toHaveLength(2);
    expect(await w.ranIn(0)).toBe('evidenced');
    expect(w.runs[0].resumed).toBe('evidenced-transcript');
  });

  it("the stamp's winner is judged by the plan's decision, not refused for having no studio", async () => {
    // Thread history names an older unverifiable row, so the anchor drops;
    // the newest row is empty, so the plan creates a candidate. The stamp
    // names the evidenced session, and it keeps the thread: the fresh
    // candidate is archived and the turn runs in the stamped session.
    const w = makeWorld({
      sessions: [
        sessionRow('legacy', { backend_session_id: 'legacy-transcript' }),
        sessionRow('evidenced', {
          backend_session_id: 'evidenced-transcript',
          metadata: recordedPlacement(),
        }),
        sessionRow('empty-newer'),
      ],
      stamp: 'evidenced',
    });
    const wake = await w.dispatch({ recipientSessionId: 'legacy' });
    expect(wake).toBeNull();
    expect(w.stamp()).toBe('evidenced');
    expect(await w.ranIn(0)).toBe('evidenced');
    expect(w.runs[0].resumed).toBe('evidenced-transcript');
    // The plan's candidate was fresh and lost, so it was archived.
    expect(w.liveRows().map((r) => r.id)).toEqual(['legacy', 'evidenced', 'empty-newer']);
  });

  it('a record for a different repo root is not evidence for this one', async () => {
    const w = makeWorld({
      sessions: [
        sessionRow('old-root', {
          backend_session_id: 'old-root-transcript',
          metadata: recordedPlacement('/repos/inkling-before-move'),
        }),
      ],
      stamp: 'old-root',
    });
    await w.send();
    expect(await w.ranIn(0)).not.toBe('old-root');
  });
});

describe('working_dir evidence must be absolute, and adoption keeps it (Lumen, #721 r1)', () => {
  beforeEach(() => {
    resetActiveRuns();
    resetPendingFinalizations();
  });

  it.each(['.', 'app'])('a relative working_dir %s is not project evidence', async (workingDir) => {
    // Containment resolved a relative path against the root being tested,
    // so it was "inside" every root.
    const w = makeWorld({
      sessions: [
        sessionRow('relative', {
          working_dir: workingDir,
          backend_session_id: 'relative-transcript',
        }),
      ],
      stamp: 'relative',
    });
    expect(await w.send()).toEqual({ routeOnly: null, wake: null });
    expect(await w.ranIn(0)).not.toBe('relative');
    expect(w.runs[0].resumed).toBeNull();
  });

  it('a relative working_dir is refused even beside a placement record', async () => {
    const w = makeWorld({
      sessions: [
        sessionRow('relative-recorded', {
          working_dir: 'app',
          backend_session_id: 'relative-recorded-transcript',
          metadata: recordedPlacement(),
        }),
      ],
      stamp: 'relative-recorded',
    });
    await w.send();
    expect(await w.ranIn(0)).not.toBe('relative-recorded');
  });

  it('a row admitted on its working_dir keeps the thread after its hook reports the default directory', async () => {
    const legacy = sessionRow('legacy-project', {
      working_dir: `${REPO_PROJECT}/app`,
      backend_session_id: 'legacy-project-transcript',
    });
    const w = makeWorld({ sessions: [legacy], stamp: 'legacy-project' });

    expect(await w.send()).toEqual({ routeOnly: null, wake: null });
    expect(await w.ranIn(0)).toBe('legacy-project');
    expect(w.runs[0]).toMatchObject({ cwd: DEFAULT_DIR, resumed: 'legacy-project-transcript' });
    // The spawn recorded the placement it ran the row under.
    expect((legacy.metadata as Row).routing_decision).toMatchObject({
      placement: { kind: 'studioless-presence', project: PROJECT, repoRoot: REPO_PROJECT },
    });

    // What its hook writes once it has run here.
    legacy.working_dir = w.runs[0].cwd;
    expect(await w.send()).toEqual({ routeOnly: null, wake: null });
    expect(await w.ranIn(1)).toBe('legacy-project');
    expect(w.runs[1].resumed).toBe('legacy-project-transcript');
    expect(w.tables.sessions).toHaveLength(1);
  });

  it('a spawn resolution with no anchor records the placement at the thread-key rung', async () => {
    // The trigger path always anchors a spawn on the delivered session, so
    // this is the rung a non-trigger caller reaches.
    const legacy = sessionRow('legacy-project', {
      working_dir: `${REPO_PROJECT}/app`,
      backend_session_id: 'legacy-project-transcript',
    });
    const w = makeWorld({ sessions: [legacy] });
    const session = await w.service.getOrCreateSession(USER, SLUG, {
      threadKey: THREAD_KEY,
      sbId: SB_ID,
    });
    expect(session.id).toBe('legacy-project');
    expect((legacy.metadata as Row).routing_decision).toMatchObject({
      placement: { kind: 'studioless-presence', project: PROJECT, repoRoot: REPO_PROJECT },
    });
  });

  it('control: a plan alone records nothing', async () => {
    const legacy = sessionRow('legacy-project', {
      working_dir: `${REPO_PROJECT}/app`,
      backend_session_id: 'legacy-project-transcript',
    });
    const w = makeWorld({ sessions: [legacy], stamp: 'legacy-project' });
    expect(await w.dispatch({ routeOnly: true, recipientSessionId: 'legacy-project' })).toBeNull();
    expect(w.stamp()).toBe('legacy-project');
    expect((legacy.metadata as Row).routing_decision).toBeUndefined();
  });

  it('control: an explicit address runs a row but does not make it continuity', async () => {
    // Addressed by the caller, the predicate never runs, so nothing was
    // verified and nothing is recorded. The next inferred message refuses it.
    const addressed = sessionRow('addressed', {
      working_dir: DEFAULT_DIR,
      backend_session_id: 'addressed-transcript',
    });
    const w = makeWorld({ sessions: [addressed], stamp: null });
    expect(
      await w.dispatch({ recipientSessionId: 'addressed', explicitRecipientTarget: true })
    ).toBeNull();
    expect(await w.ranIn(0)).toBe('addressed');
    expect((addressed.metadata as Row).routing_decision).toBeUndefined();

    await w.send();
    expect(await w.ranIn(1)).not.toBe('addressed');
  });
});

describe('studioless continuity needs routing to place the thread studioless (controls)', () => {
  beforeEach(() => {
    resetActiveRuns();
    resetPendingFinalizations();
  });

  /** A studioless row that WOULD be admitted under studioless presence. */
  const evidenced = () =>
    sessionRow('evidenced', {
      backend_session_id: 'evidenced-transcript',
      metadata: recordedPlacement(),
    });

  it('control: under studioless presence the evidenced row is resumed', async () => {
    const w = makeWorld({ sessions: [evidenced()], stamp: 'evidenced' });
    await w.send();
    expect(w.tables.sessions).toHaveLength(1);
    expect(await w.ranIn(0)).toBe('evidenced');
  });

  it('writer: a write-intent reuse-only thread holds and resumes nothing', async () => {
    const w = makeWorld({ keyType: 'deploy', sessions: [evidenced()], stamp: 'evidenced' });
    const { routeOnly, wake } = await w.send();
    expect(routeOnly).toBeInstanceOf(RoutingRefusedError);
    expect(wake).toBeInstanceOf(RoutingRefusedError);
    expect(w.handleMessage).not.toHaveBeenCalled();
    expect(w.runner.run).not.toHaveBeenCalled();
  });

  it('refusal: a project with no repo holds and resumes nothing', async () => {
    const w = makeWorld({ projectRepo: null, sessions: [evidenced()], stamp: 'evidenced' });
    const { routeOnly, wake } = await w.send();
    expect(routeOnly).toMatchObject({ detail: { reason: 'project-without-repo' } });
    expect(wake).toMatchObject({ detail: { reason: 'project-without-repo' } });
    expect(w.runner.run).not.toHaveBeenCalled();
  });

  it('lookup failure: an unreadable studios table holds and resumes nothing', async () => {
    const w = makeWorld({ studiosUnreadable: true, sessions: [evidenced()], stamp: 'evidenced' });
    const { routeOnly, wake } = await w.send();
    expect(routeOnly).toBeInstanceOf(RoutingRefusedError);
    expect(wake).toBeInstanceOf(RoutingRefusedError);
    expect(w.runner.run).not.toHaveBeenCalled();
  });

  it('lookup failure: a failed main-studio read is not "no studio" and resumes nothing', async () => {
    // The non-ephemeral lookup finds nothing, and the root-checkout read
    // fails. Reading that failure as "none" deferred a create, which for a
    // presence thread is the studioless placement itself.
    const w = makeWorld({
      mainStudioUnreadable: true,
      sessions: [evidenced()],
      stamp: 'evidenced',
    });
    const { routeOnly, wake } = await w.send();
    expect(routeOnly).toBeInstanceOf(RoutingRefusedError);
    expect(wake).toBeInstanceOf(RoutingRefusedError);
    expect(w.runner.run).not.toHaveBeenCalled();
  });

  it('a studio in the project repo: routing places there, and the studioless row is not resumed', async () => {
    const w = makeWorld({
      studios: [studioRow('studio-other', REPO_OTHER), studioRow('studio-project', REPO_PROJECT)],
      sessions: [evidenced()],
      stamp: 'evidenced',
    });
    await w.send();
    const ran = await w.ranIn(0);
    expect(ran).not.toBe('evidenced');
    expect(w.tables.sessions.find((r) => r.id === ran)?.studio_id).toBe('studio-project');
    expect(w.runs[0].resumed).toBeNull();
  });

  it('a wrong-repo studio session on the thread is not resumed under studioless presence', async () => {
    const w = makeWorld({
      sessions: [
        sessionRow('wrong-studio', {
          studio_id: 'studio-other',
          backend_session_id: 'wrong-studio-transcript',
        }),
      ],
      stamp: 'wrong-studio',
    });
    await w.send();
    const ran = await w.ranIn(0);
    expect(ran).not.toBe('wrong-studio');
    expect(w.tables.sessions.find((r) => r.id === ran)?.studio_id).toBeNull();
    expect(w.stamp()).toBe(ran);
  });
});

describe('the repair tests the stamp it meets against the same decision', () => {
  beforeEach(() => {
    resetActiveRuns();
    resetPendingFinalizations();
  });

  /**
   * The stamp names a pre-fix row (no record, no working_dir), so the plan
   * creates a candidate and the repair runs. While it runs, an independent
   * dispatch moves the stamp to `concurrent`.
   */
  function racingWorld(concurrent: Row) {
    const legacy = sessionRow('legacy', { backend_session_id: 'legacy-transcript' });
    const w = makeWorld({ sessions: [legacy], stamp: 'legacy' });
    let injected = false;
    w.assignment.mockImplementation(async (client, params) => {
      if (params.supersedeSessionId && !injected) {
        injected = true;
        w.tables.sessions.push(concurrent);
        w.tables.inbox_thread_participants[0].session_id = concurrent.id;
      }
      return assignThreadParticipant(client, params);
    });
    return { w, wasInjected: () => injected };
  }

  it('a concurrent stamp on an evidenced studioless session is kept and delivered to', async () => {
    const { w, wasInjected } = racingWorld(
      sessionRow('concurrent', {
        backend_session_id: 'concurrent-transcript',
        metadata: recordedPlacement(),
      })
    );
    const wake = await w.dispatch({ recipientSessionId: 'legacy' });
    expect(wake).toBeNull();
    expect(wasInjected()).toBe(true);
    // The repair was a CAS on the rejected winner: the newer stamp survives,
    // and delivery follows it.
    expect(w.stamp()).toBe('concurrent');
    expect(await w.ranIn(0)).toBe('concurrent');
    expect(w.runs[0].resumed).toBe('concurrent-transcript');
  });

  it('control: a concurrent stamp on a wrong-repo studioless session fails visibly', async () => {
    const { w, wasInjected } = racingWorld(
      sessionRow('concurrent-elsewhere', {
        working_dir: REPO_OTHER,
        backend_session_id: 'elsewhere-transcript',
        metadata: recordedPlacement(),
      })
    );
    const routeOnly = await w.dispatch({ routeOnly: true, recipientSessionId: 'legacy' });
    expect(wasInjected()).toBe(true);
    expect(w.stamp()).toBe('concurrent-elsewhere');
    expect(String((routeOnly as Error).message)).toMatch(/outside the thread project repo/);
    expect(w.handleMessage).not.toHaveBeenCalled();
  });
});

describe('studiolessPresenceOf reads only an affirmative decision', () => {
  // Through the module namespace, so this file still loads against a source
  // that lacks the export and every other test reports on its own.
  const studiolessPresenceOf: typeof sessionServiceModule.studiolessPresenceOf = (...args) =>
    sessionServiceModule.studiolessPresenceOf(...args);
  const project = { slug: PROJECT, repoRoot: REPO_PROJECT };
  const deferred = {
    studioId: undefined,
    tier: 'project-repo-created' as const,
    occupancyChecked: false,
    deferredCreate: { repoRoot: REPO_PROJECT, sbId: SB_ID, source: 'project' as const },
  };

  it('is the placement for a deferred project create on a presence, reuse-only thread', () => {
    expect(studiolessPresenceOf(deferred, project, 'presence', 'reuse-only')).toEqual({
      project: PROJECT,
      repoRoot: REPO_PROJECT,
    });
  });

  it('is none for a refusal, a placed studio, the caller repo, a writer, provisioning, or no repo', () => {
    const refused = {
      studioId: undefined,
      tier: 'refused' as const,
      occupancyChecked: false,
      refusal: { reason: 'no-route' as const, threadKey: THREAD_KEY, triedCallerRepo: false },
    };
    expect(studiolessPresenceOf(refused, project, 'presence', 'reuse-only')).toBeNull();
    expect(
      studiolessPresenceOf(
        { ...deferred, studioId: 'studio-project' },
        project,
        'presence',
        'reuse-only'
      )
    ).toBeNull();
    expect(
      studiolessPresenceOf(
        { ...deferred, deferredCreate: { ...deferred.deferredCreate, source: 'caller' } },
        project,
        'presence',
        'reuse-only'
      )
    ).toBeNull();
    expect(studiolessPresenceOf(deferred, project, 'write', 'reuse-only')).toBeNull();
    expect(studiolessPresenceOf(deferred, project, 'presence', 'provision')).toBeNull();
    expect(
      studiolessPresenceOf(deferred, { slug: PROJECT, repoRoot: null }, 'presence', 'reuse-only')
    ).toBeNull();
    expect(
      studiolessPresenceOf(
        deferred,
        { slug: PROJECT, repoRoot: '/repos/elsewhere' },
        'presence',
        'reuse-only'
      )
    ).toBeNull();
    expect(studiolessPresenceOf(deferred, null, 'presence', 'reuse-only')).toBeNull();
  });
});
