/**
 * Studio lease unit tests.
 *
 * The fake supabase client below models the PostgREST semantics the lease
 * service actually uses — filtered UPDATE ... WHERE as CAS, jsonb `->>` path
 * filters — so the acquire ladder (vacant / same-thread adopt / stale
 * fence-then-rescue reclaim / fresh refuse) is exercised against real
 * conditional-write behavior, not hand-stubbed return values. An afterSelect
 * hook lets tests interleave a concurrent write between the service's read
 * and its CAS, which is exactly the race the heartbeat guard exists for.
 *
 * captureWorktreeState is tested against a real temp git repo: the rescue
 * stash is the safety mechanism reclaim depends on, so it has to be proven
 * against git itself, not a mock.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdtemp, rm, writeFile, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import {
  StudioLeaseService,
  captureWorktreeState,
  rescueSucceeded,
  isLeaseStale,
  LEASE_STALE_MS,
  type StudioLease,
} from './studio-lease.service';
import { registerActiveRun, resetActiveRuns } from './sessions/active-runs';

const execFileAsync = promisify(execFile);

// ── Fake supabase ──

type Row = Record<string, unknown>;

interface FakeHooks {
  /** Fires after each select executes on the named table. */
  afterSelect?: (table: string, count: number) => void;
}

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
    private table: string,
    private rows: Row[],
    private mode: 'select' | 'update' | 'insert',
    private payload?: Row,
    private hooks?: FakeHooks,
    private counters?: Record<string, number>
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
    const copies = matched.map((r) => ({ ...r }));
    if (this.mode === 'select' && this.hooks?.afterSelect && this.counters) {
      this.counters[this.table] = (this.counters[this.table] ?? 0) + 1;
      this.hooks.afterSelect(this.table, this.counters[this.table]);
    }
    return copies;
  }

  maybeSingle(): Promise<{ data: Row | null; error: null }> {
    const rows = this.exec();
    return Promise.resolve({ data: rows[0] ?? null, error: null });
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

function makeFakeSupabase(tables: Record<string, Row[]>, hooks?: FakeHooks) {
  const counters: Record<string, number> = {};
  return {
    from(table: string) {
      const rows = tables[table] ?? (tables[table] = []);
      return {
        select: () => new FakeQuery(table, rows, 'select', undefined, hooks, counters),
        update: (payload: Row) => new FakeQuery(table, rows, 'update', payload, hooks, counters),
        insert: (payload: Row) => new FakeQuery(table, rows, 'insert', payload, hooks, counters),
      };
    },
  } as never;
}

function freshLease(overrides: Partial<StudioLease> = {}): StudioLease {
  const now = new Date().toISOString();
  return {
    sessionId: 'session-a',
    threadKey: 'pr:100',
    agentId: 'wren',
    acquiredAt: now,
    heartbeatAt: now,
    ...overrides,
  };
}

function staleLease(overrides: Partial<StudioLease> = {}): StudioLease {
  const stale = new Date(Date.now() - LEASE_STALE_MS - 60_000).toISOString();
  return freshLease({ acquiredAt: stale, heartbeatAt: stale, ...overrides });
}

function baseTables(): Record<string, Row[]> {
  return {
    studios: [{ id: 'studio-1', user_id: 'user-1', lease: null, worktree_path: null }],
    studio_lease_events: [],
    inbox_threads: [],
    agent_identities: [],
  };
}

describe('isLeaseStale', () => {
  it('is fresh within the threshold and stale beyond it', () => {
    expect(isLeaseStale(freshLease())).toBe(false);
    expect(isLeaseStale(staleLease())).toBe(true);
  });

  it('treats an unparseable heartbeat as stale', () => {
    expect(isLeaseStale(freshLease({ heartbeatAt: 'garbage', acquiredAt: 'garbage' }))).toBe(true);
  });
});

describe('rescueSucceeded', () => {
  it('fails on capture error or dirty-without-stash', () => {
    expect(rescueSucceeded({ error: 'boom' })).toBe(false);
    expect(rescueSucceeded({ dirty: true })).toBe(false);
    expect(rescueSucceeded({ dirty: true, rescueStashSha: 'abc' })).toBe(true);
    expect(rescueSucceeded({ dirty: false })).toBe(true);
  });
});

describe('StudioLeaseService.acquire', () => {
  let tables: Record<string, Row[]>;
  let service: StudioLeaseService;

  beforeEach(() => {
    resetActiveRuns();
    tables = baseTables();
    service = new StudioLeaseService(makeFakeSupabase(tables));
  });

  afterEach(() => resetActiveRuns());

  const req = {
    studioId: 'studio-1',
    sessionId: 'session-b',
    threadKey: 'pr:200',
    agentId: 'wren',
    userId: 'user-1',
    reason: 'route-pattern',
  };

  it('acquires a vacant studio and logs the event', async () => {
    const result = await service.acquire(req);
    expect(result.acquired).toBe(true);
    expect((tables.studios[0].lease as StudioLease).sessionId).toBe('session-b');
    expect((tables.studios[0].lease as StudioLease).reason).toBe('route-pattern');
    expect(tables.studio_lease_events).toHaveLength(1);
    expect(tables.studio_lease_events[0].event).toBe('acquired');
  });

  it('never mutates another user’s studio — even with the right studio UUID', async () => {
    const result = await service.acquire({ ...req, userId: 'user-2' });
    expect(result.acquired).toBe(false);
    // user-1's studio untouched, no event written against it.
    expect(tables.studios[0].lease).toBeNull();
    expect(tables.studio_lease_events).toHaveLength(0);
  });

  it('adopts a lease held by the same thread — leases follow the thread', async () => {
    tables.studios[0].lease = freshLease({ sessionId: 'session-old', threadKey: 'pr:200' });
    const result = await service.acquire(req);
    expect(result.acquired).toBe(true);
    expect((tables.studios[0].lease as StudioLease).sessionId).toBe('session-b');
    // Adoption is not a new grab — no second 'acquired' event.
    expect(tables.studio_lease_events).toHaveLength(0);
  });

  it('refuses a studio freshly leased by another thread', async () => {
    const holder = freshLease({ threadKey: 'pr:999' });
    tables.studios[0].lease = holder;
    const result = await service.acquire(req);
    expect(result.acquired).toBe(false);
    if (!result.acquired) {
      expect(result.holder?.threadKey).toBe('pr:999');
    }
    // Holder untouched.
    expect((tables.studios[0].lease as StudioLease).sessionId).toBe('session-a');
  });

  it('reclaims a stale foreign lease and logs it loudly', async () => {
    tables.studios[0].lease = staleLease({ threadKey: 'pr:999' });
    const result = await service.acquire(req);
    expect(result.acquired).toBe(true);
    if (result.acquired) {
      expect(result.reclaimedFrom?.threadKey).toBe('pr:999');
    }
    expect((tables.studios[0].lease as StudioLease).threadKey).toBe('pr:200');
    expect(tables.studio_lease_events.map((e) => e.event)).toContain('reclaimed');
  });

  it('a renewal landing between the stale read and the claim defeats the reclaim', async () => {
    tables.studios[0].lease = staleLease({ threadKey: 'pr:999' });
    let interleaved = false;
    const hookedService = new StudioLeaseService(
      makeFakeSupabase(tables, {
        afterSelect: (table, count) => {
          // After acquire()'s first read of the holder, the holder's lifecycle
          // hook renews: heartbeatAt changes, sessionId/acquiredAt do not.
          if (table === 'studios' && count === 1 && !interleaved) {
            interleaved = true;
            const lease = tables.studios[0].lease as StudioLease;
            tables.studios[0].lease = { ...lease, heartbeatAt: new Date().toISOString() };
          }
        },
      })
    );

    const result = await hookedService.acquire(req);
    expect(result.acquired).toBe(false);
    // The renewed holder keeps the studio — the claim's heartbeatAt guard
    // mismatched, and no reclaim event was written.
    expect((tables.studios[0].lease as StudioLease).sessionId).toBe('session-a');
    expect(tables.studio_lease_events.map((e) => e.event)).not.toContain('reclaimed');
  });

  it('quarantines instead of handing out a studio whose rescue failed', async () => {
    const nonRepoDir = await mkdtemp(path.join(tmpdir(), 'lease-nonrepo-'));
    try {
      // Stale holder over a worktree that is not a git repo — capture errors.
      tables.studios[0].lease = staleLease({ threadKey: 'pr:999' });
      tables.studios[0].worktree_path = nonRepoDir;

      const result = await service.acquire(req);
      expect(result.acquired).toBe(false);
      // The claim was rolled back — studio is vacant, not ours.
      expect(tables.studios[0].lease).toBeNull();
      const conflict = tables.studio_lease_events.find((e) => e.event === 'conflict');
      expect(conflict?.reason).toBe('reclaim-aborted-rescue-failed');
    } finally {
      await rm(nonRepoDir, { recursive: true, force: true });
    }
  });

  it('renews instead of reclaiming when the stale holder has a live in-process run', async () => {
    const holder = staleLease({ threadKey: 'pr:999', sessionId: 'session-running' });
    tables.studios[0].lease = holder;
    registerActiveRun({
      sessionId: 'session-running',
      userId: 'user-1',
      agentId: 'lumen',
      backend: 'claude-code',
      startedAt: Date.now(),
    });

    const result = await service.acquire(req);
    expect(result.acquired).toBe(false);
    const lease = tables.studios[0].lease as StudioLease;
    expect(lease.sessionId).toBe('session-running');
    // Heartbeat was renewed on the holder's behalf.
    expect(isLeaseStale(lease)).toBe(false);
  });
});

describe('StudioLeaseService release paths', () => {
  let tables: Record<string, Row[]>;
  let service: StudioLeaseService;

  beforeEach(() => {
    resetActiveRuns();
    tables = {
      studios: [
        {
          id: 'studio-1',
          user_id: 'user-1',
          lease: freshLease({ sessionId: 'session-a', threadKey: 'pr:100' }),
          worktree_path: null,
        },
        {
          id: 'studio-2',
          user_id: 'user-1',
          lease: freshLease({ sessionId: 'session-b', threadKey: 'pr:100' }),
          worktree_path: null,
        },
      ],
      studio_lease_events: [],
      inbox_threads: [],
      agent_identities: [],
    };
    service = new StudioLeaseService(makeFakeSupabase(tables));
  });

  afterEach(() => resetActiveRuns());

  it('releaseBySession clears exactly that session lease and records held duration', async () => {
    const ok = await service.releaseBySession('session-a', {
      userId: 'user-1',
      reason: 'session-end',
    });
    expect(ok).toBe(true);
    expect(tables.studios[0].lease).toBeNull();
    expect(tables.studios[1].lease).not.toBeNull();
    const event = tables.studio_lease_events[0];
    expect(event.event).toBe('released');
    expect(event.reason).toBe('session-end');
    expect((event.detail as { heldMs: number }).heldMs).toBeGreaterThanOrEqual(0);
  });

  it('releaseBySession scoped to the wrong user is a no-op', async () => {
    expect(await service.releaseBySession('session-a', { userId: 'user-2' })).toBe(false);
    expect(tables.studios[0].lease).not.toBeNull();
  });

  it('releaseUnlessRunning defers while the session has a live in-process run', async () => {
    registerActiveRun({
      sessionId: 'session-a',
      userId: 'user-1',
      agentId: 'wren',
      backend: 'claude-code',
      startedAt: Date.now(),
    });
    expect(await service.releaseUnlessRunning('session-a', { userId: 'user-1' })).toBe(false);
    expect(tables.studios[0].lease).not.toBeNull();

    resetActiveRuns();
    expect(await service.releaseUnlessRunning('session-a', { userId: 'user-1' })).toBe(true);
    expect(tables.studios[0].lease).toBeNull();
  });

  it('releaseByThread clears every studio the thread holds', async () => {
    const released = await service.releaseByThread('user-1', 'pr:100');
    expect(released).toBe(2);
    expect(tables.studios[0].lease).toBeNull();
    expect(tables.studios[1].lease).toBeNull();
  });

  it('releaseByStudio clears whatever the studio holds, user-scoped', async () => {
    expect(await service.releaseByStudio('studio-2', { userId: 'user-2' })).toBe(false);
    expect(
      await service.releaseByStudio('studio-2', { userId: 'user-1', reason: 'studio-closed' })
    ).toBe(true);
    expect(tables.studios[1].lease).toBeNull();
  });

  it('renewBySession bumps heartbeatAt without logging an event', async () => {
    const before = (tables.studios[0].lease as StudioLease).heartbeatAt;
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await service.renewBySession('session-a', 'user-1')).toBe(true);
    const after = (tables.studios[0].lease as StudioLease).heartbeatAt;
    expect(Date.parse(after)).toBeGreaterThan(Date.parse(before));
    expect(tables.studio_lease_events).toHaveLength(0);
  });
});

describe('StudioLeaseService.sweepExpiredLeases', () => {
  afterEach(() => resetActiveRuns());

  it('expires stale leases, renews live in-process holders, leaves fresh alone', async () => {
    resetActiveRuns();
    const tables: Record<string, Row[]> = {
      studios: [
        {
          id: 's-fresh',
          user_id: 'u',
          lease: freshLease({ sessionId: 'sess-1' }),
          worktree_path: null,
        },
        {
          id: 's-stale',
          user_id: 'u',
          lease: staleLease({ sessionId: 'sess-2' }),
          worktree_path: null,
        },
        {
          id: 's-running',
          user_id: 'u',
          lease: staleLease({ sessionId: 'sess-3' }),
          worktree_path: null,
        },
        { id: 's-vacant', user_id: 'u', lease: null, worktree_path: null },
      ],
      studio_lease_events: [],
      inbox_threads: [],
      agent_identities: [],
    };
    registerActiveRun({
      sessionId: 'sess-3',
      userId: 'u',
      agentId: 'wren',
      backend: 'claude-code',
      startedAt: Date.now(),
    });

    const service = new StudioLeaseService(makeFakeSupabase(tables));
    const stats = await service.sweepExpiredLeases();

    expect(stats).toEqual({ expired: 1, renewed: 1, quarantined: 0 });
    expect(tables.studios[0].lease).not.toBeNull(); // fresh untouched
    expect(tables.studios[1].lease).toBeNull(); // stale expired
    expect(tables.studios[2].lease).not.toBeNull(); // running renewed
    expect(isLeaseStale(tables.studios[2].lease as StudioLease)).toBe(false);
    expect(tables.studio_lease_events.map((e) => e.event)).toEqual(['expired']);
  });

  it('keeps the sweeper marker (quarantine) when the expiry rescue fails', async () => {
    resetActiveRuns();
    const nonRepoDir = await mkdtemp(path.join(tmpdir(), 'lease-sweep-nonrepo-'));
    try {
      const tables: Record<string, Row[]> = {
        studios: [
          {
            id: 's-bad',
            user_id: 'u',
            lease: staleLease({ sessionId: 'sess-x' }),
            worktree_path: nonRepoDir,
          },
        ],
        studio_lease_events: [],
        inbox_threads: [],
        agent_identities: [],
      };
      const service = new StudioLeaseService(makeFakeSupabase(tables));
      const stats = await service.sweepExpiredLeases();

      expect(stats).toEqual({ expired: 0, renewed: 0, quarantined: 1 });
      const marker = tables.studios[0].lease as StudioLease;
      expect(marker.sessionId).toBe('lease-sweep:sess-x');
      expect(tables.studio_lease_events.map((e) => e.event)).toEqual(['conflict']);
    } finally {
      await rm(nonRepoDir, { recursive: true, force: true });
    }
  });
});

// ── captureWorktreeState against a real git repo ──

describe('captureWorktreeState (real git)', () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await mkdtemp(path.join(tmpdir(), 'lease-rescue-'));
    const git = (...args: string[]) => execFileAsync('git', args, { cwd: repoDir });
    await git('init', '-b', 'main');
    await git('config', 'user.email', 'test@test.local');
    await git('config', 'user.name', 'Lease Test');
    await writeFile(path.join(repoDir, 'file.txt'), 'committed\n');
    await git('add', '.');
    await git('commit', '-m', 'initial');
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  it('records branch, commit, and clean state without stashing', async () => {
    const state = await captureWorktreeState(repoDir, { rescue: true, rescueLabel: 'pr:1' });
    expect(state.branch).toBe('main');
    expect(state.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(state.dirty).toBe(false);
    expect(state.rescueStashSha).toBeUndefined();
    expect(rescueSucceeded(state)).toBe(true);
  });

  it('rescue-stashes a dirty tree and records the stash commit SHA', async () => {
    await writeFile(path.join(repoDir, 'file.txt'), 'uncommitted change\n');
    await writeFile(path.join(repoDir, 'untracked.txt'), 'new work\n');

    const state = await captureWorktreeState(repoDir, { rescue: true, rescueLabel: 'pr:1' });
    expect(state.dirty).toBe(true);
    expect(state.rescueStashSha).toMatch(/^[0-9a-f]{40}$/);
    expect(rescueSucceeded(state)).toBe(true);

    // The tree is clean afterwards — the next occupant starts fresh.
    const { stdout: status } = await execFileAsync('git', ['status', '--porcelain'], {
      cwd: repoDir,
    });
    expect(status.trim()).toBe('');

    // The stashed work is recoverable from the recorded SHA even if the
    // stash entry itself is later dropped.
    const { stdout: stashShow } = await execFileAsync(
      'git',
      ['show', `${state.rescueStashSha}:file.txt`],
      { cwd: repoDir }
    );
    expect(stashShow).toBe('uncommitted change\n');
  });

  it('reports dirty without stashing when rescue is off (plain final-state capture)', async () => {
    await writeFile(path.join(repoDir, 'file.txt'), 'uncommitted change\n');
    const state = await captureWorktreeState(repoDir);
    expect(state.dirty).toBe(true);
    expect(state.rescueStashSha).toBeUndefined();
    // Work left in place.
    const content = await readFile(path.join(repoDir, 'file.txt'), 'utf8');
    expect(content).toBe('uncommitted change\n');
  });

  it('records an error instead of throwing for a non-repo path', async () => {
    const state = await captureWorktreeState(path.join(tmpdir(), 'does-not-exist-xyz'));
    expect(state.error).toBeTruthy();
    expect(rescueSucceeded(state)).toBe(false);
  });
});
