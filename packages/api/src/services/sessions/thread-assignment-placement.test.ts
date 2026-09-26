/**
 * Does the project-safe candidate SURVIVE thread assignment?
 *
 * `route-pattern-placement.test.ts` proves a route pattern places threadless
 * work; it excludes `threadId` on purpose. With a threadId the trigger handler
 * runs the real participant assignment, and an existing live stamp wins with
 * `explicitAnchor: false` — that replaces `deliverySession`, and the spawn
 * anchors on the winner. On a project-pinned thread the stamp from the
 * 2026-09-24 mis-route points at a session in the WRONG repo, so routing's
 * correct answer was discarded one boundary later (Lumen, #681 round 2).
 *
 * Same technique as the placement probe: the REAL handler lifted out of
 * `server.ts` by AST, the real `assignThreadParticipant` over a fake client
 * whose rows both the repository and the routing queries read, `handleMessage`
 * replaced by a dry plan-only admission. No runner, no worktree, no database.
 */

import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SessionService, RoutingRefusedError } from './session-service';
import { assignThreadParticipant } from './thread-assignment';
import { decideDelivery } from './trigger-delivery.js';
import { resetActiveRuns } from './active-runs.js';
import { resetPendingFinalizations } from './finalize-turn.js';
import { makeFakeSupabase, type Row } from './fake-supabase.js';
import type { Session } from './types';

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const USER = 'user-1';
const SLUG = 'wren';
const SB_ID = 'sb-wren-uuid';
const THREAD_ID = 'thread-1';
const THREAD_KEY = 'inktrade:pr:1';
const REPO_PROJECT = '/repos/inktrade';
const REPO_OTHER = '/repos/inkwell';

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

/** Repository over the same rows the fake client serves (see the placement probe). */
function makeRepository(tables: Record<string, Row[]>) {
  const sessions = tables.sessions ?? (tables.sessions = []);
  const toSession = (r: Row): Session =>
    ({
      id: r.id,
      userId: r.user_id,
      sbSlug: r.agent_id,
      sbId: r.sb_id,
      studioId: r.studio_id ?? undefined,
      threadKey: r.thread_key,
      endedAt: r.ended_at ?? null,
      metadata: r.metadata ?? {},
      backend: r.backend ?? 'claude-code',
      lifecycle: r.lifecycle ?? 'idle',
      status: r.status ?? 'active',
      messageCount: r.message_count ?? 0,
      contextTokens: 0,
      backendSessionId: r.backend_session_id ?? undefined,
    }) as unknown as Session;
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
        const match = [...sessions]
          .reverse()
          .find(
            (r) =>
              r.user_id === userId &&
              r.thread_key === threadKey &&
              (r.ended_at ?? null) === null &&
              (sbId ? r.sb_id === sbId : r.agent_id === sbSlug) &&
              (studioId ? r.studio_id === studioId : true) &&
              (contactId ? r.contact_id === contactId : true)
          );
        return match ? toSession(match) : null;
      }
    ),
    create: vi.fn(async (payload: Record<string, unknown>) => {
      const row: Row = {
        id: `session-${++n}`,
        user_id: payload.userId,
        agent_id: payload.sbSlug,
        sb_id: payload.sbId ?? null,
        studio_id: payload.studioId ?? null,
        thread_key: payload.threadKey ?? null,
        ended_at: null,
        metadata: payload.metadata ?? {},
        lifecycle: 'idle',
        status: 'active',
        message_count: 0,
        backend_session_id: null,
      };
      sessions.push(row);
      return toSession(row);
    }),
    update: vi.fn(async (id: string, patch: Record<string, unknown>) => {
      const row = sessions.find((r) => r.id === id);
      if (!row) throw new Error(`no session ${id}`);
      if ('studioId' in patch) row.studio_id = patch.studioId ?? null;
      if ('endedAt' in patch) row.ended_at = patch.endedAt ?? null;
      if ('metadata' in patch)
        row.metadata = { ...(row.metadata ?? {}), ...(patch.metadata ?? {}) };
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

/**
 * The incident's state: the thread is pinned to a project whose repo holds a
 * free studio for this agent, and the participant stamp points at a live
 * session bound to a studio in ANOTHER repo.
 */
function makeWorld() {
  const tables: Record<string, Row[]> = {
    agent_identities: [
      {
        id: SB_ID,
        user_id: USER,
        agent_id: SLUG,
        workspace_id: 'ws-probe',
        default_session_id: null,
      },
    ],
    inbox_threads: [
      {
        id: THREAD_ID,
        workspace_id: 'ws-probe',
        thread_key: THREAD_KEY,
        key_type: 'pr',
        key_project: 'inktrade',
        key_id: '1',
      },
    ],
    projects: [{ workspace_id: 'ws-probe', slug: 'inktrade', repo_root: REPO_PROJECT }],
    thread_key_types: [],
    studios: [studioRow('studio-wrong', REPO_OTHER), studioRow('studio-correct', REPO_PROJECT)],
    sessions: [
      {
        id: 'old-session',
        user_id: USER,
        agent_id: SLUG,
        sb_id: SB_ID,
        studio_id: 'studio-wrong',
        thread_key: THREAD_KEY,
        ended_at: null,
        lifecycle: 'idle',
        status: 'active',
        message_count: 3,
        backend_session_id: 'claude-old',
        metadata: {},
      },
    ],
    inbox_thread_participants: [{ thread_id: THREAD_ID, sb_id: SB_ID, session_id: 'old-session' }],
    studio_lease_events: [],
  };
  const supabase = makeFakeSupabase(tables);
  const repository = makeRepository(tables);
  const service = new SessionService(
    repository as never,
    {
      buildContext: vi.fn(),
      buildMinimalContext: vi.fn(),
      getAgentBackend: vi.fn(async () => ({ backend: 'claude', provider: null })),
    } as never,
    {} as never,
    {
      logMessage: vi.fn(async () => ({ id: 'm1' })),
      logActivity: vi.fn(async () => ({ id: 'a1' })),
    } as never,
    { defaultWorkingDirectory: REPO_OTHER, mcpConfigPath: '' },
    undefined,
    supabase
  );

  const assignment = vi.fn(assignThreadParticipant);
  // Dry admission: the same resolution handleMessage performs, plan-only.
  const handleMessage = vi.fn(
    async (request: { userId: string; sbSlug: string; metadata: Record<string, unknown> }) => {
      const admitted = await service.getOrCreateSession(request.userId, request.sbSlug, {
        threadKey: request.metadata.threadKey as string,
        recipientSessionId: request.metadata.recipientSessionId as string | undefined,
        recipientSessionExplicit: request.metadata.recipientSessionExplicit === true,
        sbId: SB_ID,
        planOnly: true,
      });
      return {
        success: true,
        admitted: true,
        sessionId: admitted.id,
        responses: [],
        admittedStudioId: admitted.studioId,
      };
    }
  );

  const handler = makeTriggerHandler({
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    dataComposer: { getClient: () => supabase },
    sessionService: {
      getOrCreateSession: service.getOrCreateSession.bind(service),
      getSession: service.getSession.bind(service),
      endSession: vi.fn(async () => undefined),
      sessionAllowedForThread: service.sessionAllowedForThread?.bind(service),
      handleMessage,
    },
    getUserFromContext: () => ({ userId: USER }),
    resolveThreadTriggerScope: vi.fn(async () => ({
      userId: USER,
      recipientSbId: SB_ID,
      threadWorkspaceId: 'ws-probe',
    })),
    logInkmail: vi.fn(async () => undefined),
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

  async function trigger(extra: Record<string, unknown> = {}) {
    return handler({
      toSlug: SLUG,
      toSbId: SB_ID,
      fromSlug: 'lumen',
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
  }

  const stamp = () => tables.inbox_thread_participants[0].session_id as string;
  const admitted = () =>
    handleMessage.mock.results[0]?.value as Promise<{ admittedStudioId: string }>;
  const requested = () =>
    (handleMessage.mock.calls[0]?.[0] as { metadata: Record<string, unknown> } | undefined)
      ?.metadata;

  return { tables, repository, assignment, handleMessage, trigger, stamp, admitted, requested };
}

describe('thread assignment cannot undo project-safe placement (Lumen, #681 round 2)', () => {
  beforeEach(() => {
    resetActiveRuns();
    resetPendingFinalizations();
  });

  it('repairs a wrong-repo participant stamp to the project-safe candidate before delivery', async () => {
    const w = makeWorld();
    const error = await w.trigger();
    expect(error).toBeNull();

    // Routing placed the candidate in the project repo.
    expect(w.repository.create).toHaveBeenCalledWith(
      expect.objectContaining({ studioId: 'studio-correct' })
    );
    const candidate = (await w.repository.create.mock.results[0].value) as Session;

    // The real assignment first let the live stamp win (no explicit anchor) …
    expect(w.assignment).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.objectContaining({ candidateSessionId: candidate.id, explicitAnchor: false })
    );
    // … and the handler repaired it: the stamp now names the candidate.
    expect(w.assignment).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.objectContaining({ candidateSessionId: candidate.id, explicitAnchor: true })
    );
    expect(w.stamp()).toBe(candidate.id);

    // Delivery anchored on the candidate, and admission lands in the project studio.
    expect(w.handleMessage).toHaveBeenCalledTimes(1);
    expect(w.requested()?.recipientSessionId).toBe(candidate.id);
    expect((await w.admitted()).admittedStudioId).toBe('studio-correct');
  });

  it('an inferred recipientSessionId hint in the wrong repo does not anchor the plan', async () => {
    // What inbox-handlers supplies from thread history / the participant
    // stamp: no explicitRecipientTarget. It is a hint, not an address.
    const w = makeWorld();
    const error = await w.trigger({ recipientSessionId: 'old-session' });
    expect(error).toBeNull();

    expect(w.repository.create).toHaveBeenCalledWith(
      expect.objectContaining({ studioId: 'studio-correct' })
    );
    const candidate = (await w.repository.create.mock.results[0].value) as Session;
    expect(w.stamp()).toBe(candidate.id);
    expect(w.requested()?.recipientSessionId).toBe(candidate.id);
    expect((await w.admitted()).admittedStudioId).toBe('studio-correct');
  });

  it('control: a caller-explicit recipientSessionId is honoured as before', async () => {
    const w = makeWorld();
    const error = await w.trigger({
      recipientSessionId: 'old-session',
      explicitRecipientTarget: true,
    });
    expect(error).toBeNull();

    expect(w.repository.create).not.toHaveBeenCalled();
    expect(w.assignment).toHaveBeenCalledTimes(1);
    expect(w.stamp()).toBe('old-session');
    expect(w.requested()?.recipientSessionId).toBe('old-session');
  });
});
