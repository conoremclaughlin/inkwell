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
 * Shape (Lumen's spec, thread pcp:spec:trigger-studio-routing, 2026-09-16):
 *   - both phases in production's order, provisioning/runner boundaries
 *     stubbed — no real worktree, no executor;
 *   - unbound participant: no recipient/alias/history/default-session reuse;
 *   - one unique matching free studio B, distinct reachable fallback C;
 *   - non-attached, write-intent thread, so admission acquires for real;
 *   - the winner stamp is PRESERVED — the positive case must not depend on
 *     acquiring under a `route-pattern` reason, because it never does;
 *   - NEGATIVE CONTROL: remove B's pattern and require the outcome to change
 *     to C, so a pass cannot mean "some other rung would have chosen B too".
 *
 * COVERAGE BOUNDARY — READ THIS BEFORE TRUSTING A GREEN RUN.
 * This exercises SERVICE COMPOSITION, not the delivery handler. `deliver()`
 * below makes both `getOrCreateSession` calls itself, writes the admission
 * stamp itself, and reaches `resolveWorkingDirectory` past the public
 * surface. It does NOT enter `packages/api/src/server.ts`, does not call
 * `handleMessage`, and never observes a runner invocation. So it pins what
 * this author believes that handler does. If the real handler reorders the
 * phases, drops the stamp, or passes different arguments, every case here
 * stays green (Lumen, review of PR #648).
 *
 * That gap is structural, not laziness: `packages/api/src/server.ts` has ZERO
 * exports and ends in an unconditional module-scope `startServer(...)`, so
 * importing it to reach the sequence boots a real server (the PR #635
 * incident). Closing it needs that sequence extracted into a side-effect-free
 * module — task 0b25d2b7, a production change with its own review.
 *
 * Tested head: cb810cb0 (origin/main, 2026-09-16); mechanism unchanged since
 * 9893af9f, the head Lumen and I both read.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { SessionService } from './session-service';
import { makeFakeSupabase, type Row } from './fake-supabase.js';
import type { Session } from './types';

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const USER = 'user-1';
const SLUG = 'wren';
const SB_ID = 'sb-wren-uuid';

/** Matches B's pattern, matches nothing else. Never registered as a key type,
 *  so it resolves through UNKNOWN_TYPE_DEFAULT — write intent, reuse-only. */
const THREAD_KEY = 'pcp:probe:route-pattern-decides';
const B_PATTERN = 'pcp:probe:*';

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
    }) as unknown as Session;

  let n = 0;
  return {
    findById: vi.fn(async (id: string) => {
      const row = sessions.find((r) => r.id === id);
      return row ? toSession(row) : null;
    }),
    findByUserAndAgent: vi.fn(async () => null),
    findByAlias: vi.fn(async () => null),
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
      row.updated_at = new Date().toISOString();
      return toSession(row);
    }),
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

/**
 * @param bPatterns B's declared patterns. `[]` is the negative control: the
 *   ONLY thing that varies between the base cases.
 * @param dPatterns when non-empty, a SECOND pattern-carrying studio D, so
 *   `matches` has more than one entry and the specificity sort is load-bearing.
 *   With one match, `matches[0]` and `matches[matches.length - 1]` are the same
 *   row and a broken sort survives — measured, not assumed (mutation M3).
 */
async function makeWorld(bPatterns: string[], dPatterns: string[] = []) {
  // C is the repoRoot-main studio: resolveMainStudio matches on
  // repo_root === worktree_path === REPO_ROOT, so it is reachable at tier 4
  // the moment the pattern tier declines. B lives in the same repo (so it is
  // inside the pattern query's repo scope) on its own worktree.
  const REPO_ROOT = await realDir('probe-root-c');
  const DIR_B = await realDir('probe-studio-b');
  const DIR_D = await realDir('probe-studio-d');

  const tables: Record<string, Row[]> = {
    agent_identities: [{ id: SB_ID, user_id: USER, agent_id: SLUG, default_session_id: null }],
    studios: [
      studioRow({
        id: 'studio-B',
        slug: 'wren-b',
        worktree_path: DIR_B,
        repo_root: REPO_ROOT,
        route_patterns: bPatterns,
      }),
      studioRow({
        id: 'studio-C',
        slug: 'wren-main',
        worktree_path: REPO_ROOT,
        repo_root: REPO_ROOT,
      }),
      ...(dPatterns.length
        ? [
            studioRow({
              id: 'studio-D',
              slug: 'wren-d',
              worktree_path: DIR_D,
              repo_root: REPO_ROOT,
              route_patterns: dPatterns,
            }),
          ]
        : []),
    ],
    sessions: [],
    inbox_threads: [],
    studio_lease_events: [],
  };

  const repository = makeRepository(tables);
  const service = new SessionService(
    repository as never,
    { buildContext: vi.fn() } as never,
    { run: vi.fn() } as never,
    { logMessage: vi.fn(), logActivity: vi.fn() } as never,
    // Deliberately NEITHER studio: a working directory that falls back to the
    // default is then distinguishable from one that resolved to B or C.
    { defaultWorkingDirectory: await realDir('probe-default'), mcpConfigPath: '' },
    undefined,
    makeFakeSupabase(tables)
  );

  /**
   * The two resolutions one delivery performs, in production's order.
   *
   * Line cites are `packages/api/src/server.ts` (2103 lines), NOT
   * `packages/api/src/mcp/server.ts` — both exist and only the first carries
   * this sequence.
   *
   * PHASE 1 — PLAN (server.ts:1259-1280): `planOnly`, carrying the ORIGINAL
   * payload's recipientSessionId, which for an unbound participant is absent.
   * No lease is taken.
   *
   * PHASE 2 — ADMISSION (server.ts:1456-1465 → session-service.ts:1242):
   * the spawn path stamps `recipientSessionId = deliverySession.id` and
   * re-resolves. This is the stamp that renames the tier, and it stays.
   */
  async function deliver() {
    const planned = await service.getOrCreateSession(USER, SLUG, {
      threadKey: THREAD_KEY,
      repoRoot: REPO_ROOT,
      planOnly: true,
    });
    const admitted = await service.getOrCreateSession(USER, SLUG, {
      threadKey: THREAD_KEY,
      repoRoot: REPO_ROOT,
      recipientSessionId: planned.id,
    });
    // NOT a runner invocation. This reaches past the public surface to the
    // resolver a runner WOULD consult; nothing is spawned and no executor
    // runs. Read every `runnerDir` assertion below as "the cwd a runner would
    // be handed", never as "the runner started there" (Lumen, PR #648).
    const runnerDir = await (
      service as unknown as {
        resolveWorkingDirectory: (u: string, s: string, id?: string) => Promise<string>;
      }
    ).resolveWorkingDirectory(USER, SLUG, admitted.studioId);
    return { planned, admitted, runnerDir };
  }

  const leaseHolder = (studioId: string) =>
    (tables.studios.find((s) => s.id === studioId)?.lease as Row | null) ?? null;
  const planTier = (s: Session) =>
    (s.metadata as { routing_decision?: { tier?: string } })?.routing_decision?.tier;

  return { deliver, tables, leaseHolder, planTier, REPO_ROOT, DIR_B, DIR_D };
}

describe('a route pattern determines where the work lands', () => {
  beforeEach(() => vi.clearAllMocks());

  it('places an unbound participant in the matching studio, and the lease follows', async () => {
    const { deliver, leaseHolder, planTier, DIR_B } = await makeWorld([B_PATTERN]);

    const { planned, admitted, runnerDir } = await deliver();

    // 1. The PLAN chose B, and recorded that it was the pattern that chose it.
    expect(planned.studioId).toBe('studio-B');
    expect(planTier(planned)).toBe('route-pattern');

    // 2. The session created by the plan is the one admission uses.
    expect(admitted.id).toBe(planned.id);
    expect(admitted.studioId).toBe('studio-B');

    // 3. The lease is held on B, by that session. Plan takes no lease, so
    //    this can only have come from admission.
    expect(leaseHolder('studio-B')).toMatchObject({ sessionId: planned.id });
    expect(leaseHolder('studio-C')).toBeNull();

    // 4. The runner would start in B's worktree — the whole point of routing.
    expect(runnerDir).toBe(DIR_B);
  });

  it('records the ADMISSION phase on the lease, not the tier that chose the studio', async () => {
    // This is the observability defect stated as a test rather than a
    // complaint, and it is what made my 14-day "outage" readable as real.
    // It asserts CURRENT behaviour: if a future change adds phase-separated
    // receipts (planTier/sessionReuseRung/admissionTier), this test should
    // fail and be rewritten to assert the new, better contract.
    const { deliver, tables } = await makeWorld([B_PATTERN]);

    await deliver();

    const acquired = tables.studio_lease_events.filter((e) => e.event === 'acquired');
    expect(acquired).toHaveLength(1);
    expect(acquired[0]).toMatchObject({ studio_id: 'studio-B', reason: 'recipient-session' });
    // The tier that actually selected B appears NOWHERE in this channel.
    expect(tables.studio_lease_events.some((e) => e.reason === 'route-pattern')).toBe(false);
  });

  it('NEGATIVE CONTROL: without the pattern the same delivery lands in C', async () => {
    // Without this, every assertion above is satisfiable by "B was the only
    // studio a lower rung could have picked anyway".
    const { deliver, leaseHolder, planTier, REPO_ROOT } = await makeWorld([]);

    const { planned, admitted, runnerDir } = await deliver();

    expect(planned.studioId).toBe('studio-C');
    expect(planTier(planned)).toBe('repo-root-main');
    expect(admitted.studioId).toBe('studio-C');
    expect(leaseHolder('studio-C')).toMatchObject({ sessionId: planned.id });
    expect(leaseHolder('studio-B')).toBeNull();
    expect(runnerDir).toBe(REPO_ROOT);
  });

  it('the MORE SPECIFIC pattern wins when two studios both match', async () => {
    // B claims the exact key (specificity 3); D claims the prefix (2).
    // With only one match in `matches`, the sort is unobservable — a mutation
    // taking the last element instead of the first passed the three tests
    // above. This is the case that makes the ordering load-bearing.
    const { deliver, leaseHolder, planTier, DIR_B } = await makeWorld([THREAD_KEY], [B_PATTERN]);

    const { planned, runnerDir } = await deliver();

    expect(planned.studioId).toBe('studio-B');
    expect(planTier(planned)).toBe('route-pattern');
    expect(leaseHolder('studio-D')).toBeNull();
    expect(runnerDir).toBe(DIR_B);
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
    const { deliver, leaseHolder, planTier, REPO_ROOT } = await makeWorld([B_PATTERN], [B_PATTERN]);

    const { planned, runnerDir } = await deliver();

    expect(planTier(planned)).toBe('repo-root-main');
    expect(planned.studioId).toBe('studio-C');
    expect(leaseHolder('studio-B')).toBeNull();
    expect(leaseHolder('studio-D')).toBeNull();
    expect(runnerDir).toBe(REPO_ROOT);
  });
});
