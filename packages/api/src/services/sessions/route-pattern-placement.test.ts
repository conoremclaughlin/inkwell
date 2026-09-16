/**
 * Does a route pattern actually DETERMINE the destination?
 *
 * This probe exists because of a wrong finding. On 2026-09-16 I reported the
 * route-pattern tier as dead for 14 days, from a zero in
 * `studio_lease_events.reason`. Lumen took the trace apart: since v18 S3 the
 * spawn path stamps `recipientSessionId` before admission, so admission
 * answers at `recipient-session` and the lease event records the ADMISSION
 * phase's tier, never the phase that chose the studio. The tier had not gone
 * quiet — its label had moved. Confirmed against the plan-phase population
 * (`sessions.metadata->'routing_decision'->>'tier'`): 90 route-pattern plans
 * inside the window I had measured as zero.
 *
 * Two controls passed while I was wrong. Both asked "does this channel emit",
 * and the channel kept emitting under a different value in the same column. A
 * coverage control established on the old side of a version boundary does not
 * transfer across it.
 *
 * So the question "does the pattern place the work" cannot be answered from
 * either channel alone — it needs the two phases run in order, with the
 * pattern as the only thing that varies. That is this file.
 *
 * `route-patterns.test.ts` does NOT answer it: that suite re-implements
 * `matchRoutePattern`/`routePatternSpecificity` inside the test file, so it
 * stays green if production's resolver is deleted. It tests the algorithm,
 * never the wiring.
 *
 * WHAT RUNS. The first draft of this file composed the two phases by hand —
 * it called `getOrCreateSession(planOnly)`, stamped `planned.id` itself, called
 * `getOrCreateSession` again, and called the private cwd resolver directly.
 * Lumen's review: that is service composition, not handler coverage. The
 * orchestration under test was supplied by the test, so deleting server.ts's
 * winner stamp, dropping `metadata.recipientSessionId` forwarding in
 * handleMessage, or handing the runner a different directory all left the test
 * path unchanged. This version runs the REAL trigger handler instead —
 * extracted from `server.ts` by AST, the technique Lumen established in
 * `routing/inbound-agent-handler.probe.test.ts` (PR #638), because `server.ts`
 * ends in an unconditional `startServer(...)` and importing it to reach one
 * arrow would boot a server on every suite run.
 *
 * The production code executing is: the trigger handler, SessionService's
 * `getOrCreateSession` (both phases), `decideDelivery`, and `handleMessage`
 * through to the runner call. Everything outside that — auth context, inkmail
 * logging, thread descriptors, media snapshotting, response routing, the
 * retry scheduler, and the runner itself — is injected and inert. No worktree
 * is provisioned and no process is spawned.
 *
 * STILL NOT COVERED, deliberately: thread assignment and routing-hold stamping.
 * The payload carries no `threadId`, so `assignThreadParticipant` /
 * `stampRoutingHold` / `clearRoutingHold` are never reached. They decide which
 * session a thread is stamped to, not which studio the work lands in, and each
 * has its own suite. Naming it here so the gap is a choice on the record rather
 * than an unexamined edge of the probe.
 *
 * Shape (Lumen's spec, thread pcp:spec:trigger-studio-routing, 2026-09-16):
 *   - the full handler path, both phases, provisioning/runner boundaries
 *     stubbed — no real worktree, no executor;
 *   - unbound participant: no recipient/alias/history/default-session reuse;
 *   - one unique matching free studio B, distinct reachable fallback C;
 *   - non-attached, write-intent thread, so admission acquires for real;
 *   - the winner stamp is PRESERVED — the positive case must not depend on
 *     acquiring under a `route-pattern` reason, because it never does;
 *   - NEGATIVE CONTROL: remove B's pattern and require the outcome to change
 *     to C, so a pass cannot mean "some other rung would have chosen B too".
 *
 * Tested head: cb810cb0 (origin/main, 2026-09-16); mechanism unchanged since
 * 9893af9f, the head Lumen and I both read.
 */

import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { SessionService, RoutingRefusedError } from './session-service';
import { decideDelivery } from './trigger-delivery.js';
import { resetActiveRuns } from './active-runs.js';
import { resetPendingFinalizations } from './finalize-turn.js';
import { makeFakeSupabase, type Row } from './fake-supabase.js';
import type { Session, InjectedContext } from './types';

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('./claude-runner.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  buildIdentityPrompt: vi.fn(() => 'identity-prompt'),
}));

const USER = 'user-1';
const SLUG = 'wren';
const SB_ID = 'sb-wren-uuid';

/** Matches B's pattern, matches nothing else. Never registered as a key type,
 *  so it resolves through UNKNOWN_TYPE_DEFAULT — write intent, reuse-only. */
const THREAD_KEY = 'pcp:probe:route-pattern-decides';
const B_PATTERN = 'pcp:probe:*';

/* ------------------------------------------------------------------------ *
 * The production handler, lifted out of server.ts without importing it.
 * ------------------------------------------------------------------------ */

/** The arrow passed to `agentGateway.setDefaultHandler(...)` — the whole
 *  trigger path from payload to runner. Anonymous, so it is located by its
 *  call site rather than by name.
 *
 *  The file is `packages/api/src/server.ts`, NOT `packages/api/src/mcp/server.ts`
 *  — both exist and only the first carries this sequence. Locating by call site
 *  also means there are no line numbers here to go stale: if the registration
 *  moves or is renamed, extraction throws instead of silently testing nothing. */
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
  if (!arrow) {
    throw new Error(
      'agentGateway.setDefaultHandler(<arrow>) not found in server.ts — this probe needs re-pointing'
    );
  }
  return arrow;
}

const compiledHandler = ts.transpileModule(`const handler = ${extractTriggerHandler()};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

/** Every free name the handler closes over. Production values for the routing
 *  path; inert doubles for the boundaries. A name missing here is a
 *  ReferenceError at call time, not a silent skip. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const makeTriggerHandler = (deps: Record<string, unknown>): any =>
  new Function(
    'deps',
    `const {
       logger, dataComposer, sessionService, getUserFromContext, logInkmail,
       loadThreadDescriptor, formatThreadDescriptorLines, assignThreadParticipant,
       stampRoutingHold, clearRoutingHold, storedTriggerMedia, decideDelivery,
       RoutingRefusedError, routeResponses, triggerRetryScheduler
     } = deps;
     ${compiledHandler}
     return handler;`
  )(deps);

/* ------------------------------------------------------------------------ */

const dirs: string[] = [];
async function realDir(prefix: string): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), `${prefix}-`));
  dirs.push(d);
  return d;
}
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

/**
 * Repository backed by the SAME rows the fake Supabase serves. Production's
 * repository and its routing queries read one database; a repository with a
 * private store would let phase 2's `recipient-session` rung find a session
 * that `resolveStudioId`'s tier-1 query could not see, which is a divergence
 * the test would have invented.
 */
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
    /**
     * The thread-continuity rung, and it has to be here. Omitting it is not a
     * smaller fixture, it is a DIFFERENT cascade: `getOrCreateSession` gates
     * this rung on `'findByThreadKey' in this.repository`, so a repository
     * without it skips straight to creating a session. The first mutation run
     * of this file had that hole — deleting server.ts's winner stamp appeared
     * to kill all five cases because admission minted a SECOND session, an
     * outcome production cannot produce. Mirrors session-repository.ts:375,
     * including the studio scope (the rung searches inside the studio routing
     * just chose) and the lifecycle exclusion. Insertion order stands in for
     * `started_at DESC`.
     */
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
              !['completed', 'failed'].includes((r.lifecycle as string) ?? '') &&
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
        backend: payload.backend ?? 'claude-code',
        lifecycle: 'idle',
        status: 'active',
        message_count: 0,
        backend_session_id: null,
        updated_at: new Date().toISOString(),
      };
      sessions.push(row);
      return toSession(row);
    }),
    update: vi.fn(async (id: string, patch: Record<string, unknown>) => {
      const row = sessions.find((r) => r.id === id);
      if (!row) throw new Error(`no session ${id}`);
      if ('studioId' in patch) row.studio_id = patch.studioId ?? null;
      if ('endedAt' in patch) row.ended_at = patch.endedAt ?? null;
      if ('backendSessionId' in patch) row.backend_session_id = patch.backendSessionId ?? null;
      if ('metadata' in patch)
        row.metadata = { ...(row.metadata ?? {}), ...(patch.metadata ?? {}) };
      row.updated_at = new Date().toISOString();
      return toSession(row);
    }),
    updateTokenUsage: vi.fn(async () => undefined),
    markCompacted: vi.fn(async () => undefined),
    tryAcquireCompactionLock: vi.fn(async () => true),
    releaseCompactionLock: vi.fn(async () => undefined),
  };
}

function studioRow(over: Partial<Row> & { id: string; worktree_path: string }): Row {
  return {
    user_id: USER,
    agent_id: SLUG,
    sb_id: SB_ID,
    status: 'active',
    branch: 'main',
    base_branch: 'main',
    ephemeral: false,
    lease: null,
    route_patterns: [],
    ...over,
  };
}

const injectedContext = (): InjectedContext =>
  ({
    agent: {
      sbSlug: SLUG,
      name: 'Wren',
      role: 'assistant',
      values: [],
      capabilities: [],
      relationships: {},
    },
    user: { id: USER, email: 'wren@example.com', timezone: 'UTC', contacts: {}, preferences: {} },
    temporal: {
      currentTime: '12:00',
      currentDate: '2026-09-16',
      dayOfWeek: 'Wednesday',
      timezone: 'UTC',
      greeting: 'Hello',
    },
    recentMemories: [],
    activeProjects: [],
  }) as unknown as InjectedContext;

/**
 * @param bPatterns B's declared patterns. `[]` is the negative control: the
 *   ONLY thing that varies between the base cases.
 * @param dPatterns when non-empty, a SECOND pattern-carrying studio D, so
 *   `matches` has more than one entry and the specificity sort is load-bearing.
 *   With one match, `matches[0]` and `matches[matches.length - 1]` are the same
 *   row and a broken sort survives — measured, not assumed (mutation M3).
 * @param dFirst emit D ahead of B in the studio query's result order. The sort
 *   is stable, so with the winner already first a no-op sort still answers
 *   correctly and a mutation that flattens the comparator survives — measured:
 *   `.sort(() => 0)` passed all five cases until this parameter existed. Row
 *   order is not ours to choose in production (no ORDER BY on that query), so
 *   specificity has to decide in BOTH orders.
 */
async function makeWorld(bPatterns: string[], dPatterns: string[] = [], dFirst = false) {
  // C is the repoRoot-main studio: resolveMainStudio matches on
  // repo_root === worktree_path === REPO_ROOT, so it is reachable at tier 4
  // the moment the pattern tier declines. B lives in the same repo (so it is
  // inside the pattern query's repo scope) on its own worktree.
  const REPO_ROOT = await realDir('probe-root-c');
  const DIR_B = await realDir('probe-studio-b');
  const DIR_D = await realDir('probe-studio-d');

  const studioB = studioRow({
    id: 'studio-B',
    slug: 'wren-b',
    worktree_path: DIR_B,
    repo_root: REPO_ROOT,
    route_patterns: bPatterns,
  });
  const studioC = studioRow({
    id: 'studio-C',
    slug: 'wren-main',
    worktree_path: REPO_ROOT,
    repo_root: REPO_ROOT,
  });
  const studioD = dPatterns.length
    ? [
        studioRow({
          id: 'studio-D',
          slug: 'wren-d',
          worktree_path: DIR_D,
          repo_root: REPO_ROOT,
          route_patterns: dPatterns,
        }),
      ]
    : [];

  const tables: Record<string, Row[]> = {
    agent_identities: [
      { id: SB_ID, user_id: USER, agent_id: SLUG, workspace_id: null, default_session_id: null },
    ],
    studios: dFirst ? [...studioD, studioB, studioC] : [studioB, studioC, ...studioD],
    sessions: [],
    inbox_threads: [],
    studio_lease_events: [],
  };

  const supabase = makeFakeSupabase(tables);
  const repository = makeRepository(tables);
  const runner = { run: vi.fn(async () => ({ success: true, responses: [], usage: {} })) };
  const service = new SessionService(
    repository as never,
    {
      buildContext: vi.fn(async () => injectedContext()),
      buildMinimalContext: vi.fn(async () => injectedContext()),
      getAgentBackend: vi.fn(async () => ({ backend: 'claude', provider: null })),
    } as never,
    runner as never,
    {
      logMessage: vi.fn(async () => ({ id: 'm1' })),
      logActivity: vi.fn(async () => ({ id: 'a1' })),
    } as never,
    // Deliberately NEITHER studio: a working directory that falls back to the
    // default is then distinguishable from one that resolved to B or C.
    { defaultWorkingDirectory: await realDir('probe-default'), mcpConfigPath: '' },
    undefined,
    supabase
  );

  /**
   * Lease state sampled the instant each routing resolution returns. The PLAN
   * resolution must leave every studio free — plan decides, admission
   * provisions — and that is a claim about a moment, not about the row you
   * find at the end. Reading it off the final state would be satisfied by a
   * plan that acquired and an admission that reused.
   */
  const leaseSnapshots: Array<{ planOnly: boolean; held: string[] }> = [];
  const realResolve = service.getOrCreateSession.bind(service);
  vi.spyOn(service, 'getOrCreateSession').mockImplementation(async (...args) => {
    const result = await realResolve(...args);
    leaseSnapshots.push({
      planOnly: (args[2] as { planOnly?: boolean } | undefined)?.planOnly === true,
      held: tables.studios.filter((s) => s.lease).map((s) => s.id as string),
    });
    return result;
  });

  /**
   * The boundaries this probe declares out of scope. Kept addressable so a
   * test can assert they were never reached — a throwing sentinel would not
   * work here, because the handler's own try/catch around the plan block
   * swallows a non-refusal throw and falls through to spawn, which is a
   * different path reported as a pass.
   */
  const outOfScope = {
    assignThreadParticipant: vi.fn(async () => ({ stampPersisted: true, rerouted: false })),
    stampRoutingHold: vi.fn(async () => undefined),
    clearRoutingHold: vi.fn(async () => undefined),
  };

  const handler = makeTriggerHandler({
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    dataComposer: { getClient: () => supabase },
    sessionService: service,
    getUserFromContext: () => ({ userId: USER }),
    logInkmail: vi.fn(async () => undefined),
    loadThreadDescriptor: vi.fn(async () => null),
    formatThreadDescriptorLines: vi.fn(() => [] as string[]),
    ...outOfScope,
    storedTriggerMedia: vi.fn(async () => []),
    // Production, not a double: the inline-vs-spawn decision is on the path.
    decideDelivery,
    RoutingRefusedError,
    routeResponses: vi.fn(async () => undefined),
    triggerRetryScheduler: { cancelFor: vi.fn() },
  });

  /** One delivery, through the handler production registers on the gateway. */
  async function trigger() {
    await handler({
      toSlug: SLUG,
      fromSlug: 'lumen',
      triggerType: 'message',
      priority: 'normal',
      summary: 'probe',
      threadKey: THREAD_KEY,
      // No threadId: assignment and hold stamping are out of scope (see header).
      metadata: { repoRoot: REPO_ROOT },
    });
  }

  const leaseHolder = (studioId: string) =>
    (tables.studios.find((s) => s.id === studioId)?.lease as Row | null) ?? null;
  const session = () => {
    expect(tables.sessions).toHaveLength(1);
    return tables.sessions[0];
  };
  const planTier = (row: Row) =>
    (row.metadata as { routing_decision?: { tier?: string } })?.routing_decision?.tier;
  /** The directory the runner was actually handed — not the resolver's return. */
  const runnerCwd = () => {
    expect(runner.run).toHaveBeenCalledTimes(1);
    return (runner.run.mock.calls[0] as unknown[])[1] as { config: { workingDirectory: string } };
  };

  return {
    trigger,
    tables,
    leaseHolder,
    leaseSnapshots,
    session,
    planTier,
    runnerCwd,
    outOfScope,
    REPO_ROOT,
    DIR_B,
    DIR_D,
  };
}

describe('a route pattern determines where the work lands', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetActiveRuns();
    resetPendingFinalizations();
  });

  it('places an unbound participant in the matching studio, and the runner starts there', async () => {
    const {
      trigger,
      leaseHolder,
      leaseSnapshots,
      session,
      planTier,
      runnerCwd,
      outOfScope,
      DIR_B,
    } = await makeWorld([B_PATTERN]);

    await trigger();
    const routed = session();

    // 1. The PLAN chose B, and recorded that it was the pattern that chose it.
    expect(planTier(routed)).toBe('route-pattern');
    expect(routed.studio_id).toBe('studio-B');

    // 2. Plan decided and provisioned nothing; admission is what acquired.
    //    Sampled when each resolution returned, not read off the end state.
    expect(leaseSnapshots[0]).toEqual({ planOnly: true, held: [] });
    expect(leaseSnapshots[1]).toEqual({ planOnly: false, held: ['studio-B'] });

    // 3. The lease is held on B, by the session the plan created — which is
    //    the same session admission resolved to, because the handler stamped
    //    it as the anchor. One session exists at all (session() asserts it).
    expect(leaseHolder('studio-B')).toMatchObject({ sessionId: routed.id });
    expect(leaseHolder('studio-C')).toBeNull();

    // 4. The runner was started in B's worktree — the whole point of routing,
    //    and the only assertion that covers the handler→runner option wiring.
    expect(runnerCwd().config.workingDirectory).toBe(DIR_B);

    // 5. The scope boundary, checked rather than asserted in prose. The three
    //    out-of-scope boundaries are genuinely unreached — not reached and
    //    quietly failed. The runner assertion above is this claim's control:
    //    it proves an injected double being CALLED is observable here, so a
    //    zero call count means absence, not a broken instrument.
    expect(outOfScope.assignThreadParticipant).not.toHaveBeenCalled();
    expect(outOfScope.stampRoutingHold).not.toHaveBeenCalled();
    expect(outOfScope.clearRoutingHold).not.toHaveBeenCalled();
  });

  it('the lease event names the admission rung, so reasons are not a placement census', async () => {
    // The observability defect stated as a test rather than a complaint: it is
    // what made my 14-day "outage" readable as real.
    //
    // This characterizes the legacy `reason` column. It is NOT a requirement
    // that better receipts break it — adding phase-separated fields
    // (planTier/sessionReuseRung/admissionTier) to the event detail would
    // leave every assertion here passing, which is the intended relationship:
    // the property asserted is that `reason` answers "which rung admitted",
    // and a delivery placed by the pattern tier still records
    // `recipient-session` because the handler's anchor stamp is what admission
    // answers at. Anyone reading placement out of this column reads the stamp.
    const { trigger, tables, session, planTier } = await makeWorld([B_PATTERN]);

    await trigger();

    // Same delivery, two channels, two different answers about the same studio.
    expect(planTier(session())).toBe('route-pattern');
    const acquired = tables.studio_lease_events.filter((e) => e.event === 'acquired');
    expect(acquired).toHaveLength(1);
    expect(acquired[0]).toMatchObject({ studio_id: 'studio-B', reason: 'recipient-session' });
  });

  it('NEGATIVE CONTROL: without the pattern the same delivery lands in C', async () => {
    // Without this, every assertion above is satisfiable by "B was the only
    // studio a lower rung could have picked anyway".
    const { trigger, leaseHolder, session, planTier, runnerCwd, REPO_ROOT } = await makeWorld([]);

    await trigger();
    const routed = session();

    expect(planTier(routed)).toBe('repo-root-main');
    expect(routed.studio_id).toBe('studio-C');
    expect(leaseHolder('studio-C')).toMatchObject({ sessionId: routed.id });
    expect(leaseHolder('studio-B')).toBeNull();
    expect(runnerCwd().config.workingDirectory).toBe(REPO_ROOT);
  });

  // B claims the exact key (specificity 3); D claims the prefix (2).
  //
  // Two rows, both orders, because each hides a different broken comparator.
  // With only ONE match, `matches[0]` and `matches[matches.length - 1]` are
  // the same row and a last-instead-of-first mutation passed (M3). With two
  // matches but the winner already first, the sort's stability answers
  // correctly on its own and a flattened comparator passed (M8). Production
  // issues that query with no ORDER BY, so neither order is the real one.
  it.each([
    ['winner first in the studio query', false],
    ['winner second in the studio query', true],
  ])('the MORE SPECIFIC pattern wins when two studios both match — %s', async (_label, dFirst) => {
    const { trigger, leaseHolder, session, planTier, runnerCwd, DIR_B } = await makeWorld(
      [THREAD_KEY],
      [B_PATTERN],
      dFirst
    );

    await trigger();

    expect(planTier(session())).toBe('route-pattern');
    expect(session().studio_id).toBe('studio-B');
    expect(leaseHolder('studio-D')).toBeNull();
    expect(runnerCwd().config.workingDirectory).toBe(DIR_B);
  });

  it('an equal-specificity tie routes NOWHERE near either claimant', async () => {
    // session-service.ts:3273-3278 — `matches[0].specificity > matches[1]`
    // is false for a tie, so the tier falls through rather than guessing.
    //
    // This is why appending a pattern is an unsound reassignment primitive:
    // `recordStudioProvenance` only ever appends and nothing removes a key
    // from its old studio, so "move this thread to a new studio" leaves two
    // studios claiming the same key at equal specificity — and the result is
    // not "the new one wins", it is "the pattern tier stops working for that
    // key". A reassignment API that appends would silently disable the very
    // routing it was asked to change.
    const { trigger, leaseHolder, session, planTier, runnerCwd, REPO_ROOT } = await makeWorld(
      [B_PATTERN],
      [B_PATTERN]
    );

    await trigger();

    expect(planTier(session())).toBe('repo-root-main');
    expect(session().studio_id).toBe('studio-C');
    expect(leaseHolder('studio-B')).toBeNull();
    expect(leaseHolder('studio-D')).toBeNull();
    expect(runnerCwd().config.workingDirectory).toBe(REPO_ROOT);
  });
});
