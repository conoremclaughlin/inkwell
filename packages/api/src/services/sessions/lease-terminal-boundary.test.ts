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
import { SessionService } from './session-service';
import type { Session } from './types';
import { tmpdir } from 'os';
import { registerActiveRun, resetActiveRuns } from './active-runs';
import { LEASE_STALE_MS, type StudioLease } from '../studio-lease.service';

// ── Minimal fake supabase (same PostgREST semantics as the lease unit tests) ──

type Row = Record<string, unknown>;

function getCol(row: Row, col: string): unknown {
  if (col.includes('->>')) {
    const [base, key] = col.split('->>');
    const obj = row[base];
    if (!obj || typeof obj !== 'object') return null;
    return (obj as Row)[key] ?? null;
  }
  return row[col] ?? null;
}

class FakeQuery {
  private filters: Array<(r: Row) => boolean> = [];
  private limitN?: number;

  constructor(
    private rows: Row[],
    private mode: 'select' | 'update' | 'insert',
    private payload?: Row
  ) {}

  eq(col: string, val: unknown) {
    this.filters.push((r) => getCol(r, col) === val);
    return this;
  }
  is(col: string, val: unknown) {
    if (val === null) this.filters.push((r) => getCol(r, col) == null);
    return this;
  }
  not(col: string, op: string, val: unknown) {
    if (op === 'is' && val === null) this.filters.push((r) => getCol(r, col) != null);
    else if (op === 'eq') this.filters.push((r) => getCol(r, col) !== val);
    return this;
  }
  in(col: string, vals: unknown[]) {
    this.filters.push((r) => vals.includes(getCol(r, col)));
    return this;
  }
  limit(n: number) {
    this.limitN = n;
    return this;
  }
  select(_cols?: string) {
    return this;
  }
  order() {
    return this;
  }

  private exec(): Row[] {
    if (this.mode === 'insert') {
      this.rows.push({ ...this.payload });
      return [{ ...this.payload }];
    }
    let matched = this.rows.filter((r) => this.filters.every((f) => f(r)));
    if (this.mode === 'update') {
      for (const r of matched) Object.assign(r, this.payload);
    }
    if (this.limitN !== undefined) matched = matched.slice(0, this.limitN);
    return matched.map((r) => ({ ...r }));
  }

  maybeSingle(): Promise<{ data: Row | null; error: null }> {
    return Promise.resolve({ data: this.exec()[0] ?? null, error: null });
  }
  single(): Promise<{ data: Row | null; error: { code: string; message: string } | null }> {
    const rows = this.exec();
    return Promise.resolve(
      rows[0]
        ? { data: rows[0], error: null }
        : { data: null, error: { code: 'PGRST116', message: 'no rows' } }
    );
  }
  then<T>(resolve: (v: { data: Row[]; error: null }) => T): Promise<T> {
    return Promise.resolve({ data: this.exec(), error: null }).then(resolve);
  }
}

function makeFakeSupabase(tables: Record<string, Row[]>) {
  return {
    from(table: string) {
      const rows = tables[table] ?? (tables[table] = []);
      return {
        select: () => new FakeQuery(rows, 'select'),
        update: (payload: Row) => new FakeQuery(rows, 'update', payload),
        insert: (payload: Row) => new FakeQuery(rows, 'insert', payload),
      };
    },
  } as never;
}

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

  it('clears the studio binding when the studio is held by another thread and overflow is unavailable', async () => {
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
    const result = await service.getOrCreateSession('user-1', 'wren', {
      threadKey: 'pr:200',
      recipientSessionId: 'session-1',
    });

    // Never bound to the occupied studio.
    expect(result.studioId).toBeFalsy();
    expect(store.session.studioId).toBeFalsy();
    // The foreign holder was not clobbered.
    expect((tables.studios[0].lease as unknown as StudioLease).sessionId).toBe('session-foreign');
    // The contradiction is on the record.
    expect(tables.studio_lease_events.map((e) => e.event)).toContain('conflict');
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
