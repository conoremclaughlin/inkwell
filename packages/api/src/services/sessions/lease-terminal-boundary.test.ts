/**
 * SessionService × lease boundary tests (PR #492 review, Lumen).
 *
 * The earlier unit tests exercised the lease service in isolation; these
 * cover the two boundaries the review flagged as fail-open:
 *
 *  1. Routing: a session must NEVER be returned bound to a studio whose
 *     lease was not acquired — on refusal with no overflow available, the
 *     binding is cleared so the runner cannot enter the occupied worktree.
 *  2. Terminal: endSession defers release while the session's in-process run
 *     is live; the run boundary (releaseLeaseIfSessionTerminal) releases once
 *     the turn has actually stopped.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SessionService, RoutingRefusedError } from './session-service';
import type { Session } from './types';
import { tmpdir } from 'os';
import { registerActiveRun, resetActiveRuns } from './active-runs';
import { LEASE_STALE_MS, type StudioLease } from '../studio-lease.service';

// ── Minimal fake supabase (same PostgREST semantics as the lease unit tests) ──

import { makeFakeSupabase, type Row } from './fake-supabase.js';

// ── Minimal session repository ──

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-1',
    userId: 'user-1',
    agentId: 'wren',
    studioId: 'studio-1',
    backendSessionId: null,
    type: 'primary',
    lifecycle: 'idle',
    status: 'active',
    contextTokens: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    messageCount: 0,
    tokenCount: 0,
    backend: 'claude-code',
    model: null,
    lastCompactionAt: null,
    compactionCount: 0,
    endedAt: null,
    metadata: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    // The spread was MISSING until PR #563 round 6 — every override in this
    // file silently no-opped, and the tests passed only because callers
    // happened to pass values equal to the defaults.
    ...overrides,
  } as unknown as Session;
}

function makeMockRepository(session: Session) {
  const store = { session };
  return {
    store,
    repo: {
      findById: vi.fn(async (id: string) => (id === store.session.id ? store.session : null)),
      update: vi.fn(async (id: string, updates: Record<string, unknown>) => {
        store.session = { ...store.session, ...updates } as Session;
        return store.session;
      }),
      create: vi.fn(async () => store.session),
      findByUserAndAgent: vi.fn(async () => null),
    } as never,
  };
}

function makeService(repo: never, tables: Record<string, Row[]>) {
  return new SessionService(
    repo,
    { buildContext: vi.fn() } as never,
    { run: vi.fn() } as never,
    { logMessage: vi.fn(), logActivity: vi.fn() } as never,
    { defaultWorkingDirectory: '/test', mcpConfigPath: '', compactionThreshold: 150000 },
    undefined,
    makeFakeSupabase(tables)
  );
}

const staleIso = () => new Date(Date.now() - LEASE_STALE_MS - 60_000).toISOString();

describe('fail-closed routing at the lease boundary', () => {
  beforeEach(() => resetActiveRuns());
  afterEach(() => resetActiveRuns());

  it('HOLDS when the studio is held by another thread and overflow is unavailable (6b r2)', async () => {
    const session = makeSession({ studioId: 'studio-1' });
    const { store, repo } = makeMockRepository(session);
    const foreignHolder: StudioLease = {
      sessionId: 'session-foreign',
      threadKey: 'pr:999',
      agentId: 'lumen',
      acquiredAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
    };
    const tables: Record<string, Row[]> = {
      // Parent studio row lacks a real repo — overflow worktree creation
      // fails, so the only safe outcome is a cleared binding.
      studios: [
        {
          id: 'studio-1',
          user_id: 'user-1',
          lease: foreignHolder as unknown as Row,
          // A REAL directory: this test is about an occupancy conflict, not
          // a dead studio (a missing worktree would retire the row instead —
          // see the round-8 missing-cwd tests). Overflow still fails because
          // repo_root does not exist, which is what this test needs.
          worktree_path: tmpdir(),
          repo_root: '/nonexistent/repo',
          slug: 'wren-main',
          status: 'active',
          branch: 'main',
          base_branch: 'main',
          ephemeral: false,
          metadata: {},
        },
      ],
      sessions: [{ id: 'session-1', user_id: 'user-1', studio_id: 'studio-1' }],
      studio_lease_events: [],
      inbox_threads: [],
      agent_identities: [],
    };
    const service = makeService(repo, tables);

    // recipientSessionId path — a bypass tier (occupancy unchecked).
    //
    // 6b r2 (Lumen #517 blocker 6): clearing the binding sent the runner to
    // defaultWorkingDirectory — routinely the SAME occupied root. The only
    // safe outcome is a HOLD: throw occupied, no execution anywhere.
    await expect(
      service.getOrCreateSession('user-1', 'wren', {
        threadKey: 'pr:200',
        recipientSessionId: 'session-1',
      })
    ).rejects.toMatchObject({
      code: 'ROUTING_REFUSED',
      detail: { reason: 'occupied' },
    });

    // The foreign holder was not clobbered.
    expect((tables.studios[0].lease as unknown as StudioLease).sessionId).toBe('session-foreign');
    // The contradiction is on the record.
    expect(tables.studio_lease_events.map((e) => e.event)).toContain('conflict');
    void store;
    void RoutingRefusedError;
  });

  it('keeps the binding when the lease is acquired normally', async () => {
    const session = makeSession({ studioId: 'studio-1' });
    const { repo } = makeMockRepository(session);
    const tables: Record<string, Row[]> = {
      studios: [
        {
          id: 'studio-1',
          user_id: 'user-1',
          lease: null,
          worktree_path: null,
          status: 'active',
        },
      ],
      sessions: [{ id: 'session-1', user_id: 'user-1', studio_id: 'studio-1' }],
      studio_lease_events: [],
      inbox_threads: [],
      agent_identities: [],
    };
    const service = makeService(repo, tables);

    const result = await service.getOrCreateSession('user-1', 'wren', {
      threadKey: 'pr:200',
      recipientSessionId: 'session-1',
    });

    expect(result.studioId).toBe('studio-1');
    expect((tables.studios[0].lease as unknown as StudioLease).sessionId).toBe('session-1');
  });
});

describe('terminal-boundary release', () => {
  beforeEach(() => resetActiveRuns());
  afterEach(() => resetActiveRuns());

  function leasedTables(sessionId: string): Record<string, Row[]> {
    return {
      studios: [
        {
          id: 'studio-1',
          user_id: 'user-1',
          lease: {
            sessionId,
            threadKey: 'pr:200',
            agentId: 'wren',
            acquiredAt: staleIso(),
            heartbeatAt: new Date().toISOString(),
          } as unknown as Row,
          worktree_path: null,
        },
      ],
      studio_lease_events: [],
      inbox_threads: [],
      channel_routes: [],
      agent_identities: [],
      // The holder session is terminal in the DB — endSession stamped it.
      sessions: [{ id: sessionId, user_id: 'user-1', ended_at: new Date().toISOString() }],
    };
  }

  it('round 6 (PR #563): the run-boundary release refuses a stale owner epoch', async () => {
    const session = makeSession({ turnEpoch: 'owner-epoch' } as never);
    const { store, repo } = makeMockRepository(session);
    const tables = leasedTables('session-1');
    const service = makeService(repo, tables);
    const svc = service as unknown as {
      releaseLeaseIfSessionTerminal(id: string, epoch?: string): Promise<void>;
    };

    // Same shape as the deferred-release test above: end mid-run so the
    // release defers, then bring the session to its terminal boundary.
    registerActiveRun({
      sessionId: 'session-1',
      userId: 'user-1',
      agentId: 'wren',
      backend: 'claude-code',
      startedAt: Date.now(),
    });
    await service.endSession('session-1', 'ended mid-turn');
    expect(tables.studios[0].lease).not.toBeNull();
    resetActiveRuns();
    store.session = { ...store.session, endedAt: new Date() } as Session;

    // A boundary that stopped being ours: the same read that establishes
    // terminality establishes ownership, and a mismatch refuses the release.
    await svc.releaseLeaseIfSessionTerminal('session-1', 'stale-epoch');
    expect(tables.studios[0].lease).not.toBeNull();

    // The current owner's boundary releases.
    await svc.releaseLeaseIfSessionTerminal('session-1', 'owner-epoch');
    expect(tables.studios[0].lease).toBeNull();
  });

  it('round 7 (PR #563): refuses a lease renewed after the calling turn began', async () => {
    const session = makeSession({ turnEpoch: 'owner-epoch' } as never);
    const { store, repo } = makeMockRepository(session);
    const tables = leasedTables('session-1'); // heartbeatAt = NOW
    const service = makeService(repo, tables);
    const svc = service as unknown as {
      releaseLeaseIfSessionTerminal(id: string, epoch?: string, since?: number): Promise<void>;
    };

    registerActiveRun({
      sessionId: 'session-1',
      userId: 'user-1',
      agentId: 'wren',
      backend: 'claude-code',
      startedAt: Date.now(),
    });
    await service.endSession('session-1', 'ended mid-turn');
    resetActiveRuns();
    store.session = { ...store.session, endedAt: new Date() } as Session;

    // The queued NEXT turn renewed the lease (heartbeat is fresh) after this
    // turn began a minute ago: the boundary is not ours to release.
    await svc.releaseLeaseIfSessionTerminal('session-1', 'owner-epoch', Date.now() - 60_000);
    expect(tables.studios[0].lease).not.toBeNull();

    // No renewal since the turn began: the boundary releases.
    await svc.releaseLeaseIfSessionTerminal('session-1', 'owner-epoch', Date.now() + 1_000);
    expect(tables.studios[0].lease).toBeNull();
  });

  it('endSession releases immediately when no run is live', async () => {
    const session = makeSession();
    const { repo } = makeMockRepository(session);
    const tables = leasedTables('session-1');
    const service = makeService(repo, tables);

    await service.endSession('session-1', 'done');
    expect(tables.studios[0].lease).toBeNull();
  });

  it('endSession defers while a run is live; the run boundary releases after', async () => {
    const session = makeSession();
    const { store, repo } = makeMockRepository(session);
    const tables = leasedTables('session-1');
    const service = makeService(repo, tables);

    registerActiveRun({
      sessionId: 'session-1',
      userId: 'user-1',
      agentId: 'wren',
      backend: 'claude-code',
      startedAt: Date.now(),
    });

    await service.endSession('session-1', 'ended mid-turn');
    // Deferred: the process is still cd'd into the worktree.
    expect(tables.studios[0].lease).not.toBeNull();

    // The turn finishes: active run cleared, boundary check runs.
    resetActiveRuns();
    store.session = { ...store.session, endedAt: new Date() } as Session;
    await (
      service as unknown as { releaseLeaseIfSessionTerminal(id: string): Promise<void> }
    ).releaseLeaseIfSessionTerminal('session-1');

    expect(tables.studios[0].lease).toBeNull();
  });

  it('the run boundary leaves a non-terminal session leased', async () => {
    const session = makeSession();
    const { repo } = makeMockRepository(session);
    const tables = leasedTables('session-1');
    const service = makeService(repo, tables);

    await (
      service as unknown as { releaseLeaseIfSessionTerminal(id: string): Promise<void> }
    ).releaseLeaseIfSessionTerminal('session-1');

    expect(tables.studios[0].lease).not.toBeNull();
  });
});
