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
  QUARANTINE_THREAD_KEY,
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
  // Nested JSON paths as PostgREST parses them: base->child->>leaf.
  const parts = col.split('->');
  let cur: unknown = row;
  for (let part of parts) {
    if (part.startsWith('>')) part = part.slice(1);
    if (!cur || typeof cur !== 'object') return null;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur ?? null;
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
    studios: [
      { id: 'studio-1', user_id: 'user-1', status: 'active', lease: null, worktree_path: null },
    ],
    studio_lease_events: [],
    inbox_threads: [],
    agent_identities: [],
    sessions: [],
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

  it('never leases a cleaned studio — even a vacant one (round 7)', async () => {
    // A successful close leaves status='cleaned', lease=NULL. Continuity or
    // an explicit UUID must not send a runner back to the deleted path.
    tables.studios[0].status = 'cleaned';
    const result = await service.acquire(req);
    expect(result.acquired).toBe(false);
    expect(tables.studios[0].lease).toBeNull();
  });

  it('never leases an ACTIVE, VACANT studio whose worktree is gone (round 8)', async () => {
    // The vacant fast path used to CAS before any validation — a live-looking
    // row with a deleted cwd was handed straight to the runner.
    // `removeWorktree: false` closes produce exactly this state.
    tables.studios[0].lease = null;
    tables.studios[0].status = 'active';
    tables.studios[0].worktree_path = path.join(tmpdir(), 'vacant-missing-worktree-xyz');

    const result = await service.acquire(req);
    expect(result.acquired).toBe(false);
    // Retired, not left circulating as an acquirable vacancy.
    expect(tables.studios[0].status).toBe('cleaned');
    expect(tables.studios[0].lease).toBeNull();
    const event = tables.studio_lease_events.find((e) => e.event === 'released');
    expect(event?.reason).toBe('worktree-absent-retired');
    // And a second attempt still refuses (now on the status guard).
    expect((await service.acquire(req)).acquired).toBe(false);
  });

  it('re-validates after a lost vacant CAS — never adopts into a vanished cwd (round 9)', async () => {
    // A reads vacant + present. Between that read and its CAS, B installs a
    // TERMINAL same-thread lease and the worktree disappears. A loses the
    // vacant CAS; the reread must go back through validation rather than
    // straight to adoption, which would grant a missing cwd.
    tables.studios[0].lease = null;
    tables.studios[0].worktree_path = tmpdir(); // present at the first read
    tables.sessions.push({
      id: 'session-old',
      user_id: 'user-1',
      ended_at: new Date().toISOString(),
      status: 'completed',
    });

    let raced = false;
    const hooked = new StudioLeaseService(
      makeFakeSupabase(tables, {
        afterSelect: (table, count) => {
          if (table === 'studios' && count === 1 && !raced) {
            raced = true;
            tables.studios[0].lease = freshLease({
              sessionId: 'session-old',
              threadKey: 'pr:200',
            });
            tables.studios[0].worktree_path = path.join(tmpdir(), 'vanished-mid-race-xyz');
          }
        },
      })
    );

    const result = await hooked.acquire(req);
    expect(raced).toBe(true);
    expect(result.acquired).toBe(false);
    // The reread was validated: the dead studio was retired, not adopted.
    expect(tables.studios[0].status).toBe('cleaned');
    expect(tables.studios[0].lease).toBeNull();
  });

  it('re-validates after a lost ADOPTION CAS — never accepts its own lease unchecked (round 10)', async () => {
    // A validates an old same-thread holder over a present cwd. B then
    // acquires FOR THE REQUESTING SESSION while the worktree disappears. A
    // loses the adoption CAS and its reread shows its own sessionId holding
    // the lease — which must NOT be accepted, because the studio underneath
    // it has changed.
    tables.studios[0].lease = freshLease({ sessionId: 'session-old', threadKey: 'pr:200' });
    tables.studios[0].worktree_path = tmpdir(); // present at the first read
    tables.sessions.push({
      id: 'session-old',
      user_id: 'user-1',
      ended_at: new Date().toISOString(),
      status: 'completed',
    });

    let raced = false;
    const hooked = new StudioLeaseService(
      makeFakeSupabase(tables, {
        afterSelect: (table, count) => {
          if (table === 'studios' && count === 1 && !raced) {
            raced = true;
            // B wins the studio for our own session, and the cwd vanishes.
            tables.studios[0].lease = freshLease({
              sessionId: req.sessionId,
              threadKey: 'pr:200',
            });
            tables.studios[0].worktree_path = path.join(tmpdir(), 'vanished-mid-adopt-xyz');
          }
        },
      })
    );

    const result = await hooked.acquire(req);
    expect(raced).toBe(true);
    expect(result.acquired).toBe(false);
    // The retry pass validated the new snapshot and retired the dead studio.
    expect(tables.studios[0].status).toBe('cleaned');
    expect(tables.studios[0].lease).toBeNull();
  });

  it('still grants when the lost adoption CAS resolves to a healthy own-session lease (round 10)', async () => {
    // Same lost-CAS shape, but nothing is wrong with the studio: the retry
    // pass must validate and then grant, not refuse.
    tables.studios[0].lease = freshLease({ sessionId: 'session-old', threadKey: 'pr:200' });
    tables.studios[0].worktree_path = tmpdir();
    tables.sessions.push({
      id: 'session-old',
      user_id: 'user-1',
      ended_at: new Date().toISOString(),
      status: 'completed',
    });

    let raced = false;
    const hooked = new StudioLeaseService(
      makeFakeSupabase(tables, {
        afterSelect: (table, count) => {
          if (table === 'studios' && count === 1 && !raced) {
            raced = true;
            tables.studios[0].lease = freshLease({
              sessionId: req.sessionId,
              threadKey: 'pr:200',
            });
          }
        },
      })
    );

    const result = await hooked.acquire(req);
    expect(raced).toBe(true);
    expect(result.acquired).toBe(true);
    expect((tables.studios[0].lease as StudioLease).sessionId).toBe(req.sessionId);
    expect(tables.studios[0].status).toBe('active');
  });

  it('never steals a FRESH teardown claim when the worktree is missing (round 9)', async () => {
    // close_studio's normal window: the worktree is legitimately gone
    // between `git worktree remove` and the owner's finalizeTeardown. The
    // claim's sessionId is a random token, not a session, so a liveness
    // probe calls it dead — stealing it would make the real close's
    // finalize CAS lose and report a false failure.
    const claim: StudioLease = {
      sessionId: '44444444-4444-4444-4444-444444444444',
      threadKey: QUARANTINE_THREAD_KEY,
      heldThreadKey: 'pr:5',
      agentId: 'wren',
      acquiredAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      quarantined: true,
      claimKind: 'teardown',
    };
    tables.studios[0].lease = claim;
    tables.studios[0].worktree_path = path.join(tmpdir(), 'mid-close-worktree-xyz');

    const result = await service.acquire(req);
    expect(result.acquired).toBe(false);
    // The owner's claim is intact...
    expect((tables.studios[0].lease as StudioLease).sessionId).toBe(claim.sessionId);
    expect(tables.studios[0].status).toBe('active');
    // ...so its finalization still wins.
    expect(await service.finalizeTeardown('studio-1', 'user-1', claim)).toBe(true);
    expect(tables.studios[0].status).toBe('cleaned');
  });

  it('never adopts a SAME-THREAD lease when the worktree is gone (round 8)', async () => {
    // Terminal same-thread holder would normally be adopted outright,
    // bypassing claimAndRescue's missing-cwd check.
    tables.studios[0].lease = freshLease({ sessionId: 'session-old', threadKey: 'pr:200' });
    tables.studios[0].worktree_path = path.join(tmpdir(), 'adopt-missing-worktree-xyz');
    tables.sessions.push({
      id: 'session-old',
      user_id: 'user-1',
      ended_at: new Date().toISOString(),
      status: 'completed',
    });

    const result = await service.acquire(req);
    expect(result.acquired).toBe(false);
    expect(tables.studios[0].status).toBe('cleaned');
    expect(tables.studios[0].lease).toBeNull();
  });

  it('does not disturb a LIVE holder when the worktree is gone (round 8)', async () => {
    tables.studios[0].lease = freshLease({ sessionId: 'session-live', threadKey: 'pr:200' });
    tables.studios[0].worktree_path = path.join(tmpdir(), 'live-missing-worktree-xyz');
    registerActiveRun({
      sessionId: 'session-live',
      userId: 'user-1',
      agentId: 'wren',
      backend: 'claude-code',
      startedAt: Date.now(),
    });

    const result = await service.acquire(req);
    expect(result.acquired).toBe(false);
    // Nothing on disk left to protect, but the live holder's lease and the
    // row's status are left for its own boundary/the sweep to resolve.
    expect((tables.studios[0].lease as StudioLease).sessionId).toBe('session-live');
    expect(tables.studios[0].status).toBe('active');
  });

  it('retires a stale holder whose worktree is GONE instead of acquiring it (round 7)', async () => {
    tables.studios[0].lease = staleLease({ threadKey: 'pr:999', sessionId: 'session-dead' });
    tables.studios[0].worktree_path = path.join(tmpdir(), 'definitely-missing-worktree-xyz');

    const result = await service.acquire(req);
    // Never handed to the requester (nonexistent cwd), never left as an
    // acquirable vacancy: retired to cleaned in one claim-guarded CAS.
    expect(result.acquired).toBe(false);
    expect(tables.studios[0].lease).toBeNull();
    expect(tables.studios[0].status).toBe('cleaned');
    const event = tables.studio_lease_events.find((e) => e.event === 'released');
    expect(event?.reason).toBe('worktree-absent-retired');
  });

  it('never mutates another user’s studio — even with the right studio UUID', async () => {
    const result = await service.acquire({ ...req, userId: 'user-2' });
    expect(result.acquired).toBe(false);
    // user-1's studio untouched, no event written against it.
    expect(tables.studios[0].lease).toBeNull();
    expect(tables.studio_lease_events).toHaveLength(0);
  });

  it('adopts a lease from a provably TERMINAL same-thread holder', async () => {
    tables.studios[0].lease = freshLease({ sessionId: 'session-old', threadKey: 'pr:200' });
    tables.sessions.push({
      id: 'session-old',
      user_id: 'user-1',
      ended_at: new Date().toISOString(),
      status: 'completed',
    });
    const result = await service.acquire(req);
    expect(result.acquired).toBe(true);
    expect((tables.studios[0].lease as StudioLease).sessionId).toBe('session-b');
    // Adoption is not a new grab — no second 'acquired' event.
    expect(tables.studio_lease_events).toHaveLength(0);
  });

  it('refuses adoption from a TERMINAL holder whose process is still running (round 4)', async () => {
    // end_session stamps terminal state from INSIDE the active turn — the
    // DB row is terminal but the process has not left the worktree.
    tables.studios[0].lease = freshLease({ sessionId: 'session-old', threadKey: 'pr:200' });
    tables.sessions.push({
      id: 'session-old',
      user_id: 'user-1',
      ended_at: new Date().toISOString(),
      status: 'completed',
    });
    registerActiveRun({
      sessionId: 'session-old',
      userId: 'user-1',
      agentId: 'wren',
      backend: 'claude-code',
      startedAt: Date.now(),
    });

    const result = await service.acquire(req);
    expect(result.acquired).toBe(false);
    expect((tables.studios[0].lease as StudioLease).sessionId).toBe('session-old');
  });

  it('refuses adoption from a TERMINAL holder with an open CLI turn (round 4)', async () => {
    tables.studios[0].lease = freshLease({ sessionId: 'session-old', threadKey: 'pr:200' });
    tables.sessions.push({
      id: 'session-old',
      user_id: 'user-1',
      ended_at: new Date().toISOString(),
      status: 'completed',
      cli_attached: true,
      cli_turn_at: new Date().toISOString(), // on-prompt fired, no on-stop yet
    });

    const result = await service.acquire(req);
    expect(result.acquired).toBe(false);
    expect((tables.studios[0].lease as StudioLease).sessionId).toBe('session-old');
  });

  it('treats the hook-owned turn signal as liveness for no-plugin CLIs (round 4)', async () => {
    // cli_poll_at never set (no channel plugin) — an OPEN cli_turn_at alone
    // keeps the session live mid-turn, with no wall-time expiry: it is a
    // start marker, and a legitimate turn may run arbitrarily long (round 5).
    tables.studios[0].lease = staleLease({ sessionId: 'session-noplugin', threadKey: 'pr:999' });
    tables.sessions.push({
      id: 'session-noplugin',
      user_id: 'user-1',
      cli_attached: true,
      cli_poll_at: null,
      // Opened 45 minutes ago — well past LEASE_STALE_MS, still one turn.
      cli_turn_at: new Date(Date.now() - 45 * 60 * 1000).toISOString(),
    });

    const mid = await service.acquire(req);
    expect(mid.acquired).toBe(false);
    expect((tables.studios[0].lease as StudioLease).sessionId).toBe('session-noplugin');

    // The attach/detach boundary (or the real on-stop) cleared the marker —
    // process proof the turn's process is gone. Reclaim may proceed.
    tables.sessions[0].cli_turn_at = null;
    tables.studios[0].lease = staleLease({ sessionId: 'session-noplugin', threadKey: 'pr:999' });
    const after = await service.acquire(req);
    expect(after.acquired).toBe(true);
  });

  it('the turn signal survives end_session clearing cli_attached (round 5)', async () => {
    // end_session clears cli_attached from inside the live turn; the open
    // turn marker must keep the holder live regardless.
    tables.studios[0].lease = staleLease({ sessionId: 'session-ending', threadKey: 'pr:999' });
    tables.sessions.push({
      id: 'session-ending',
      user_id: 'user-1',
      cli_attached: false, // cleared by end_session mid-turn
      cli_poll_at: null,
      cli_turn_at: new Date().toISOString(),
      ended_at: new Date().toISOString(),
    });

    const result = await service.acquire(req);
    expect(result.acquired).toBe(false);
    expect((tables.studios[0].lease as StudioLease).sessionId).toBe('session-ending');
  });

  it('a failed liveness read fails CLOSED — never authorizes a reclaim (round 5)', async () => {
    tables.studios[0].lease = staleLease({ threadKey: 'pr:999', sessionId: 'session-x' });
    const erroringSupabase = {
      from(table: string) {
        if (table === 'sessions') {
          return {
            select: () => ({
              eq() {
                return this;
              },
              maybeSingle: () =>
                Promise.resolve({ data: null, error: { message: 'connection reset' } }),
            }),
          };
        }
        return (makeFakeSupabase(tables) as { from: (t: string) => unknown }).from(table);
      },
    } as never;
    const failingService = new StudioLeaseService(erroringSupabase);

    const result = await failingService.acquire({
      studioId: 'studio-1',
      sessionId: 'session-b',
      threadKey: 'pr:200',
      agentId: 'wren',
      userId: 'user-1',
    });
    expect(result.acquired).toBe(false);
    // The stale holder was treated as live: renewed (or untouched), never
    // claimed or stashed.
    expect((tables.studios[0].lease as StudioLease).sessionId).toBe('session-x');
    expect(tables.studio_lease_events.map((e) => e.event)).not.toContain('reclaimed');
  });

  it('refuses adoption from a fresh non-terminal holder — the admission gap (round 3)', async () => {
    // The holder session exists, is NOT terminal, and is NOT in the run
    // registry — exactly the window between acquire and registerActiveRun.
    // "Not live right now" must not mean "adoptable": presume fresh = live.
    tables.studios[0].lease = freshLease({ sessionId: 'session-old', threadKey: 'pr:200' });
    tables.sessions.push({
      id: 'session-old',
      user_id: 'user-1',
      ended_at: null,
      status: 'active',
    });

    const result = await service.acquire(req);
    expect(result.acquired).toBe(false);
    expect((tables.studios[0].lease as StudioLease).sessionId).toBe('session-old');
  });

  it('adopts from a stale non-terminal holder only when its process is not live', async () => {
    tables.studios[0].lease = staleLease({ sessionId: 'session-old', threadKey: 'pr:200' });
    tables.sessions.push({
      id: 'session-old',
      user_id: 'user-1',
      ended_at: null,
      status: 'active',
    });
    const result = await service.acquire(req);
    expect(result.acquired).toBe(true);
    expect((tables.studios[0].lease as StudioLease).sessionId).toBe('session-b');
  });

  it('renews instead of adopting a stale same-thread holder with a live CLI', async () => {
    tables.studios[0].lease = staleLease({ sessionId: 'session-cli', threadKey: 'pr:200' });
    tables.sessions.push({
      id: 'session-cli',
      user_id: 'user-1',
      ended_at: null,
      status: 'active',
      cli_attached: true,
      cli_poll_at: new Date().toISOString(),
    });
    const result = await service.acquire(req);
    expect(result.acquired).toBe(false);
    const lease = tables.studios[0].lease as StudioLease;
    expect(lease.sessionId).toBe('session-cli');
    expect(isLeaseStale(lease)).toBe(false); // renewed on the holder's behalf
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

  it('a failed rescue produces a DURABLE quarantine — not a vacancy', async () => {
    const nonRepoDir = await mkdtemp(path.join(tmpdir(), 'lease-nonrepo-'));
    try {
      // Stale holder over a worktree that is not a git repo — capture errors.
      const holder = staleLease({ threadKey: 'pr:999', sessionId: 'session-dead' });
      tables.studios[0].lease = holder;
      tables.studios[0].worktree_path = nonRepoDir;

      const result = await service.acquire(req);
      expect(result.acquired).toBe(false);

      // Quarantine: non-vacant, non-adoptable, unique claim token as its
      // sessionId, original holder UUID kept for audit.
      const lease = tables.studios[0].lease as StudioLease;
      expect(lease.quarantined).toBe(true);
      expect(lease.threadKey).toBe(QUARANTINE_THREAD_KEY);
      expect(lease.heldThreadKey).toBe('pr:999');
      expect(lease.holderSessionId).toBe('session-dead');
      expect(lease.sessionId).toMatch(/^[0-9a-f-]{36}$/);
      const conflict = tables.studio_lease_events.find((e) => e.event === 'conflict');
      expect(conflict?.reason).toBe('rescue-failed-quarantined');

      // Regression (round 2): a second acquire must NOT enter the unrescued
      // tree — the fresh quarantine refuses it and stays in place.
      const second = await service.acquire({ ...req, sessionId: 'session-c' });
      expect(second.acquired).toBe(false);
      expect((tables.studios[0].lease as StudioLease).quarantined).toBe(true);

      // Nor can the original thread "adopt" it back via heldThreadKey.
      const adoptAttempt = await service.acquire({
        ...req,
        sessionId: 'session-d',
        threadKey: 'pr:999',
      });
      expect(adoptAttempt.acquired).toBe(false);
      expect((tables.studios[0].lease as StudioLease).quarantined).toBe(true);
    } finally {
      await rm(nonRepoDir, { recursive: true, force: true });
    }
  });

  it('a stale quarantine converts to an acquisition only through a verified rescue', async () => {
    const staleQuarantineHeartbeat = new Date(Date.now() - LEASE_STALE_MS - 60_000).toISOString();
    tables.studios[0].lease = {
      sessionId: 'session-dead',
      threadKey: QUARANTINE_THREAD_KEY,
      heldThreadKey: 'pr:999',
      agentId: 'lumen',
      acquiredAt: staleQuarantineHeartbeat,
      heartbeatAt: staleQuarantineHeartbeat,
      quarantined: true,
    } satisfies StudioLease;
    // No worktree path → nothing to rescue → the claim stands.
    const result = await service.acquire(req);
    expect(result.acquired).toBe(true);
    expect((tables.studios[0].lease as StudioLease).threadKey).toBe('pr:200');
    expect((tables.studios[0].lease as StudioLease).quarantined).toBeFalsy();
  });

  it('refuses same-thread adoption while the holder session is live (server run)', async () => {
    tables.studios[0].lease = freshLease({ sessionId: 'session-live', threadKey: 'pr:200' });
    registerActiveRun({
      sessionId: 'session-live',
      userId: 'user-1',
      agentId: 'wren',
      backend: 'claude-code',
      startedAt: Date.now(),
    });

    const result = await service.acquire(req);
    expect(result.acquired).toBe(false);
    // The live holder keeps the lease — two sessions of one thread must not
    // both run in the worktree.
    expect((tables.studios[0].lease as StudioLease).sessionId).toBe('session-live');
  });

  it('refuses same-thread adoption while the holder has a freshly-attached CLI', async () => {
    tables.studios[0].lease = freshLease({ sessionId: 'session-cli', threadKey: 'pr:200' });
    tables.sessions.push({
      id: 'session-cli',
      user_id: 'user-1',
      cli_attached: true,
      updated_at: new Date().toISOString(),
    });

    const result = await service.acquire(req);
    expect(result.acquired).toBe(false);
    expect((tables.studios[0].lease as StudioLease).sessionId).toBe('session-cli');
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

  it('never stale-claims a foreign holder with a freshly-polling CLI (round 3)', async () => {
    // The lifecycle hook updated the row but its async lease renewal has not
    // landed yet: the lease looks stale while the CLI is demonstrably live.
    tables.studios[0].lease = staleLease({ threadKey: 'pr:999', sessionId: 'session-cli-live' });
    tables.sessions.push({
      id: 'session-cli-live',
      user_id: 'user-1',
      cli_attached: true,
      cli_poll_at: new Date().toISOString(),
    });

    const result = await service.acquire(req);
    expect(result.acquired).toBe(false);
    const lease = tables.studios[0].lease as StudioLease;
    expect(lease.sessionId).toBe('session-cli-live');
    expect(isLeaseStale(lease)).toBe(false); // renewed on the holder's behalf
    expect(tables.studio_lease_events.map((e) => e.event)).not.toContain('reclaimed');
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
          status: 'active',
          lease: freshLease({ sessionId: 'session-a', threadKey: 'pr:100' }),
          worktree_path: null,
        },
        {
          id: 'studio-2',
          user_id: 'user-1',
          status: 'active',
          lease: freshLease({ sessionId: 'session-b', threadKey: 'pr:100' }),
          worktree_path: null,
        },
      ],
      studio_lease_events: [],
      inbox_threads: [],
      agent_identities: [],
      // Holder sessions are terminal (ended) — the common release scenario.
      // Fresh NON-terminal holders defer instead; see the admission-gap test.
      sessions: [
        { id: 'session-a', user_id: 'user-1', ended_at: new Date().toISOString() },
        { id: 'session-b', user_id: 'user-1', ended_at: new Date().toISOString() },
      ],
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

  it('releaseUnlessRunning defers for a freshly-polling CLI session (round 2)', async () => {
    // The registry cannot see interactive CLI turns; cli_poll_at can — and
    // only the CLI itself stamps it.
    Object.assign(tables.sessions[0], {
      cli_attached: true,
      cli_poll_at: new Date().toISOString(),
    });
    expect(await service.releaseUnlessRunning('session-a', { userId: 'user-1' })).toBe(false);
    expect(tables.studios[0].lease).not.toBeNull();

    // A stale poll is a dead CLI — release proceeds (holder is terminal).
    tables.sessions[0].cli_poll_at = new Date(Date.now() - 11 * 60 * 1000).toISOString();
    expect(await service.releaseUnlessRunning('session-a', { userId: 'user-1' })).toBe(true);
    expect(tables.studios[0].lease).toBeNull();
  });

  it('releaseUnlessRunning defers for an open no-plugin CLI turn (round 4)', async () => {
    Object.assign(tables.sessions[0], {
      // cli_attached already cleared by end_session — the open turn marker
      // alone must defer (round 5: signals are not gated on the flag).
      cli_attached: false,
      cli_poll_at: null,
      cli_turn_at: new Date().toISOString(), // on-prompt fired, no on-stop yet
    });
    expect(await service.releaseUnlessRunning('session-a', { userId: 'user-1' })).toBe(false);
    expect(tables.studios[0].lease).not.toBeNull();

    // The real on-stop cleared the turn signal — release proceeds.
    tables.sessions[0].cli_turn_at = null;
    expect(await service.releaseUnlessRunning('session-a', { userId: 'user-1' })).toBe(true);
    expect(tables.studios[0].lease).toBeNull();
  });

  it('a stale attached flag cannot look alive via terminal-write timestamps (round 3)', async () => {
    // cli_attached is true but there is no poll and no open turn — a dead
    // orphan flag. A terminal API updating the row (bumping updated_at) must
    // not defer.
    Object.assign(tables.sessions[0], {
      cli_attached: true,
      cli_poll_at: null,
      cli_turn_at: null,
      updated_at: new Date().toISOString(), // freshly touched by endSession
    });
    expect(await service.releaseUnlessRunning('session-a', { userId: 'user-1' })).toBe(true);
    expect(tables.studios[0].lease).toBeNull();
  });

  it('close-release paths presume a fresh non-terminal holder live — admission gap (round 4)', async () => {
    // The holder just won its lease in getOrCreateSession and has not yet
    // reached registerActiveRun: no registry entry, no CLI signals, session
    // row not terminal. Releasing now would clear the lease under it.
    tables.sessions[0].ended_at = null;

    const byThread = await service.releaseByThread('user-1', 'pr:100', {
      reason: 'thread-closed',
    });
    // session-a (fresh, non-terminal) deferred; session-b (terminal) released.
    expect(byThread).toEqual({ released: 1, deferred: 1 });
    const marked = tables.studios[0].lease as StudioLease;
    expect(marked.sessionId).toBe('session-a');
    expect(marked.pendingRelease?.reason).toBe('thread-closed');

    // releaseByStudio applies the same rule.
    tables.studios[0].lease = freshLease({ sessionId: 'session-a', threadKey: 'pr:100' });
    expect(
      await service.releaseByStudio('studio-1', { userId: 'user-1', reason: 'studio-closed' })
    ).toBe('deferred');
  });

  it('releaseByThread clears every studio the thread holds', async () => {
    const result = await service.releaseByThread('user-1', 'pr:100');
    expect(result).toEqual({ released: 2, deferred: 0 });
    expect(tables.studios[0].lease).toBeNull();
    expect(tables.studios[1].lease).toBeNull();
  });

  it('releaseByThread DEFERS a live holder via pendingRelease; the boundary completes it (round 3)', async () => {
    registerActiveRun({
      sessionId: 'session-a',
      userId: 'user-1',
      agentId: 'wren',
      backend: 'claude-code',
      startedAt: Date.now(),
    });

    const result = await service.releaseByThread('user-1', 'pr:100', { reason: 'thread-closed' });
    expect(result).toEqual({ released: 1, deferred: 1 });
    // The live holder keeps its lease — marked, not cleared.
    const marked = tables.studios[0].lease as StudioLease;
    expect(marked.sessionId).toBe('session-a');
    expect(marked.pendingRelease?.reason).toBe('thread-closed');
    expect(tables.studios[1].lease).toBeNull();

    // The turn finishes; the boundary completes the deferred release even
    // though the session itself is not terminal.
    resetActiveRuns();
    const released = await service.releaseAtBoundary('session-a', {
      userId: 'user-1',
      sessionTerminal: false,
      reason: 'run-terminal',
    });
    expect(released).toBe(true);
    expect(tables.studios[0].lease).toBeNull();
    const event = tables.studio_lease_events.find(
      (e) => e.event === 'released' && e.session_id === 'session-a'
    );
    expect(event?.reason).toBe('thread-closed');
  });

  it('releaseAtBoundary is a no-op for a non-terminal session with no pendingRelease', async () => {
    expect(
      await service.releaseAtBoundary('session-a', {
        userId: 'user-1',
        sessionTerminal: false,
        reason: 'run-terminal',
      })
    ).toBe(false);
    expect(tables.studios[0].lease).not.toBeNull();
  });

  it('releaseByStudio clears a non-live holder, defers a live one, user-scoped', async () => {
    expect(await service.releaseByStudio('studio-2', { userId: 'user-2' })).toBe('none');
    expect(
      await service.releaseByStudio('studio-2', { userId: 'user-1', reason: 'studio-closed' })
    ).toBe('released');
    expect(tables.studios[1].lease).toBeNull();

    registerActiveRun({
      sessionId: 'session-a',
      userId: 'user-1',
      agentId: 'wren',
      backend: 'claude-code',
      startedAt: Date.now(),
    });
    expect(
      await service.releaseByStudio('studio-1', { userId: 'user-1', reason: 'studio-closed' })
    ).toBe('deferred');
    expect((tables.studios[0].lease as StudioLease).pendingRelease?.reason).toBe('studio-closed');
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
      sessions: [],
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

    expect(stats).toEqual({ expired: 1, renewed: 1, quarantined: 0, released: 0 });
    expect(tables.studios[0].lease).not.toBeNull(); // fresh untouched
    expect(tables.studios[1].lease).toBeNull(); // stale expired
    expect(tables.studios[2].lease).not.toBeNull(); // running renewed
    expect(isLeaseStale(tables.studios[2].lease as StudioLease)).toBe(false);
    expect(tables.studio_lease_events.map((e) => e.event)).toEqual(['expired']);
  });

  it('a failed expiry rescue leaves a durable quarantine and blocks acquirers', async () => {
    resetActiveRuns();
    const nonRepoDir = await mkdtemp(path.join(tmpdir(), 'lease-sweep-nonrepo-'));
    try {
      const tables: Record<string, Row[]> = {
        studios: [
          {
            id: 's-bad',
            user_id: 'u',
            lease: staleLease({ sessionId: 'sess-x', threadKey: 'pr:7' }),
            worktree_path: nonRepoDir,
          },
        ],
        studio_lease_events: [],
        inbox_threads: [],
        agent_identities: [],
        sessions: [],
      };
      const service = new StudioLeaseService(makeFakeSupabase(tables));
      const stats = await service.sweepExpiredLeases();

      expect(stats).toEqual({ expired: 0, renewed: 0, quarantined: 1, released: 0 });
      const marker = tables.studios[0].lease as StudioLease;
      expect(marker.quarantined).toBe(true);
      expect(marker.threadKey).toBe(QUARANTINE_THREAD_KEY);
      expect(marker.heldThreadKey).toBe('pr:7');
      // Original holder UUID preserved for audit; claim carries its own token.
      expect(marker.holderSessionId).toBe('sess-x');
      expect(marker.sessionId).toMatch(/^[0-9a-f-]{36}$/);
      expect(tables.studio_lease_events.map((e) => e.event)).toEqual(['conflict']);

      // Regression (round 2): the quarantined studio refuses acquisition —
      // including a same-thread acquire against the held thread.
      const acq = await service.acquire({
        studioId: 's-bad',
        sessionId: 'sess-new',
        threadKey: 'pr:7',
        agentId: 'wren',
        userId: 'u',
      });
      expect(acq.acquired).toBe(false);
      expect((tables.studios[0].lease as StudioLease).quarantined).toBe(true);
    } finally {
      await rm(nonRepoDir, { recursive: true, force: true });
    }
  });
});

describe('sweep worktree-absent reconciliation (round 6)', () => {
  afterEach(() => resetActiveRuns());

  function staleClaim(kind: 'recovery' | 'teardown'): StudioLease {
    const staleIso = new Date(Date.now() - LEASE_STALE_MS - 60_000).toISOString();
    return {
      sessionId: '22222222-2222-2222-2222-222222222222',
      threadKey: QUARANTINE_THREAD_KEY,
      heldThreadKey: 'pr:33',
      holderSessionId: 'sess-orig',
      agentId: 'wren',
      acquiredAt: staleIso,
      heartbeatAt: staleIso,
      quarantined: true,
      claimKind: kind,
    };
  }

  it('finalizes an interrupted TEARDOWN over an absent worktree: cleaned + released', async () => {
    resetActiveRuns();
    const tables: Record<string, Row[]> = {
      studios: [
        {
          id: 's-t',
          user_id: 'u',
          status: 'active',
          lease: staleClaim('teardown') as unknown as Row,
          worktree_path: path.join(tmpdir(), 'gone-worktree-xyz'),
        },
      ],
      studio_lease_events: [],
      inbox_threads: [],
      agent_identities: [],
      sessions: [],
    };
    const service = new StudioLeaseService(makeFakeSupabase(tables));
    const stats = await service.sweepExpiredLeases();

    expect(stats.released).toBe(1);
    expect(stats.quarantined).toBe(0);
    expect(tables.studios[0].lease).toBeNull();
    expect(tables.studios[0].status).toBe('cleaned');
    const event = tables.studio_lease_events.find((e) => e.event === 'released');
    expect(event?.reason).toBe('teardown-finalized-worktree-absent');
  });

  it('retires (not vacates) a stale RECOVERY quarantine over an absent worktree', async () => {
    resetActiveRuns();
    const tables: Record<string, Row[]> = {
      studios: [
        {
          id: 's-r',
          user_id: 'u',
          status: 'active',
          lease: staleClaim('recovery') as unknown as Row,
          worktree_path: path.join(tmpdir(), 'gone-worktree-abc'),
        },
      ],
      studio_lease_events: [],
      inbox_threads: [],
      agent_identities: [],
      sessions: [],
    };
    const service = new StudioLeaseService(makeFakeSupabase(tables));
    const stats = await service.sweepExpiredLeases();

    // Round 7: a missing cwd must never become an acquirable vacancy — the
    // studio is retired to cleaned (non-routable) in one claim-guarded CAS.
    expect(stats.released).toBe(1);
    expect(stats.quarantined).toBe(0);
    expect(tables.studios[0].lease).toBeNull();
    expect(tables.studios[0].status).toBe('cleaned');
    const event = tables.studio_lease_events.find((e) => e.event === 'released');
    expect(event?.reason).toBe('worktree-absent-retired');
  });
});

describe('sweep pendingRelease backstop', () => {
  afterEach(() => resetActiveRuns());

  it('completes a deferred release once the holder is provably done', async () => {
    resetActiveRuns();
    const lease: StudioLease = {
      ...freshLease({ sessionId: 'sess-p', threadKey: 'pr:11' }),
      pendingRelease: { reason: 'thread-closed', requestedAt: new Date().toISOString() },
    };
    const tables: Record<string, Row[]> = {
      studios: [{ id: 's-p', user_id: 'u', lease: lease as unknown as Row, worktree_path: null }],
      studio_lease_events: [],
      inbox_threads: [],
      agent_identities: [],
      sessions: [{ id: 'sess-p', user_id: 'u', ended_at: new Date().toISOString() }],
    };
    const service = new StudioLeaseService(makeFakeSupabase(tables));
    const stats = await service.sweepExpiredLeases();
    expect(stats.released).toBe(1);
    expect(tables.studios[0].lease).toBeNull();
  });

  /**
   * The pr:498/pr:499 shape — an idle CLI, attached and polling, NOT
   * mid-turn, never terminal, holding a stale lease that asked to release.
   * Round six DELETED the proof-based narrow release: six review rounds
   * showed client-pushed testimony cannot safely AUTHORIZE a release (every
   * scheme leaked at an ownership or visibility boundary). Completion now
   * waits for a REAL boundary — the holder's stop event, session end, or
   * presence loss — so the sweep defers and renews here. Delayed, never
   * premature: that trade is the design.
   */
  it('defers an idle-but-attached holder and renews — completion waits for a real boundary', async () => {
    resetActiveRuns();
    const lease: StudioLease = {
      ...freshLease({ sessionId: 'sess-idle', threadKey: 'pr:499' }),
      heartbeatAt: new Date(Date.now() - LEASE_STALE_MS - 60_000).toISOString(),
      pendingRelease: {
        reason: 'thread-closed',
        requestedAt: new Date(Date.now() - 46 * 60 * 1000).toISOString(),
      },
    };
    const tables: Record<string, Row[]> = {
      studios: [
        { id: 's-idle', user_id: 'u', lease: lease as unknown as Row, worktree_path: null },
      ],
      studio_lease_events: [],
      inbox_threads: [],
      agent_identities: [],
      sessions: [
        {
          id: 'sess-idle',
          user_id: 'u',
          ended_at: null,
          status: 'active',
          cli_attached: true,
          cli_poll_at: new Date().toISOString(), // terminal open, polling now
          cli_turn_at: null,
        },
      ],
    };
    const service = new StudioLeaseService(makeFakeSupabase(tables));
    const stats = await service.sweepExpiredLeases();

    expect(stats.released).toBe(0);
    expect(stats.renewed).toBe(1);
    expect(tables.studios[0].lease).not.toBeNull();
  });

  it("completes the deferred release once the holder's presence lapses", async () => {
    resetActiveRuns();
    const lease: StudioLease = {
      ...freshLease({ sessionId: 'sess-gone', threadKey: 'pr:499' }),
      heartbeatAt: new Date(Date.now() - LEASE_STALE_MS - 60_000).toISOString(),
      pendingRelease: { reason: 'thread-closed', requestedAt: new Date().toISOString() },
    };
    const tables: Record<string, Row[]> = {
      studios: [
        { id: 's-gone', user_id: 'u', lease: lease as unknown as Row, worktree_path: null },
      ],
      studio_lease_events: [],
      inbox_threads: [],
      agent_identities: [],
      sessions: [
        {
          id: 'sess-gone',
          user_id: 'u',
          ended_at: null,
          status: 'active',
          cli_attached: true,
          // The terminal closed 20 minutes ago: polls stopped, no open turn.
          cli_poll_at: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
          cli_turn_at: null,
        },
      ],
    };
    const service = new StudioLeaseService(makeFakeSupabase(tables));
    const stats = await service.sweepExpiredLeases();

    expect(stats.released).toBe(1);
    expect(tables.studios[0].lease).toBeNull();
  });

  it('still defers a pendingRelease while the holder is MID-TURN (cli_turn_at open)', async () => {
    resetActiveRuns();
    const lease: StudioLease = {
      ...freshLease({ sessionId: 'sess-turn', threadKey: 'pr:12' }),
      heartbeatAt: new Date(Date.now() - LEASE_STALE_MS - 60_000).toISOString(),
      pendingRelease: { reason: 'thread-closed', requestedAt: new Date().toISOString() },
    };
    const tables: Record<string, Row[]> = {
      studios: [
        { id: 's-turn', user_id: 'u', lease: lease as unknown as Row, worktree_path: null },
      ],
      studio_lease_events: [],
      inbox_threads: [],
      agent_identities: [],
      sessions: [
        {
          id: 'sess-turn',
          user_id: 'u',
          ended_at: null,
          cli_attached: true,
          cli_poll_at: new Date().toISOString(),
          // close_thread was called from INSIDE this turn — the process is
          // still cd'd into the worktree. Release must wait for the boundary.
          cli_turn_at: new Date().toISOString(),
        },
      ],
    };
    const service = new StudioLeaseService(makeFakeSupabase(tables));
    const stats = await service.sweepExpiredLeases();

    expect(stats.released).toBe(0);
    expect(tables.studios[0].lease).not.toBeNull();
  });

  it('leaves a pendingRelease lease alone while the holder is still live', async () => {
    resetActiveRuns();
    registerActiveRun({
      sessionId: 'sess-p',
      userId: 'u',
      agentId: 'wren',
      backend: 'claude-code',
      startedAt: Date.now(),
    });
    const lease: StudioLease = {
      ...freshLease({ sessionId: 'sess-p', threadKey: 'pr:11' }),
      pendingRelease: { reason: 'thread-closed', requestedAt: new Date().toISOString() },
    };
    const tables: Record<string, Row[]> = {
      studios: [{ id: 's-p', user_id: 'u', lease: lease as unknown as Row, worktree_path: null }],
      studio_lease_events: [],
      inbox_threads: [],
      agent_identities: [],
      sessions: [],
    };
    const service = new StudioLeaseService(makeFakeSupabase(tables));
    const stats = await service.sweepExpiredLeases();
    expect(stats.released).toBe(0);
    expect(tables.studios[0].lease).not.toBeNull();
  });
});

describe('touchStudioLeaseForSession — the prompt fence (rounds five–six)', () => {
  afterEach(() => resetActiveRuns());

  it('reports HELD only after a successful exact-CAS heartbeat touch', async () => {
    const lease = freshLease({ sessionId: 'sess-t', threadKey: 'pr:90' });
    const before = lease.heartbeatAt;
    const tables: Record<string, Row[]> = {
      studios: [{ id: 's-t', user_id: 'u', lease: lease as unknown as Row, worktree_path: null }],
      studio_lease_events: [],
      inbox_threads: [],
      agent_identities: [],
      sessions: [],
    };
    const service = new StudioLeaseService(makeFakeSupabase(tables));
    await expect(service.touchStudioLeaseForSession('s-t', 'sess-t', 'u')).resolves.toBe(true);
    const after = (tables.studios[0].lease as unknown as StudioLease).heartbeatAt;
    expect(after >= before).toBe(true); // the touch IS the fence: heartbeat bumped via CAS
  });

  it('reports NOT HELD for a released or foreign lease — a plain read is never enough', async () => {
    const foreign = freshLease({ sessionId: 'sess-other', threadKey: 'pr:91' });
    const tables: Record<string, Row[]> = {
      studios: [
        { id: 's-gone', user_id: 'u', lease: null, worktree_path: null },
        { id: 's-f', user_id: 'u', lease: foreign as unknown as Row, worktree_path: null },
      ],
      studio_lease_events: [],
      inbox_threads: [],
      agent_identities: [],
      sessions: [],
    };
    const service = new StudioLeaseService(makeFakeSupabase(tables));
    await expect(service.touchStudioLeaseForSession('s-gone', 'sess-t', 'u')).resolves.toBe(false);
    await expect(service.touchStudioLeaseForSession('s-f', 'sess-t', 'u')).resolves.toBe(false);
  });

  /**
   * Round six (Lumen): the heartbeat guard alone cannot see a pendingRelease
   * marked between the touch's read and its CAS — marking leaves heartbeatAt
   * unchanged, so the stale touch would match and overwrite the whole lease
   * JSON with its pre-marker snapshot: close_thread returned success, but
   * the request vanished. The pendingRelease-state guard makes that first
   * CAS fail; the re-read carries the marker into the rewrite instead.
   */
  it('a pendingRelease marked after the touch read is preserved, never erased', async () => {
    const lease = freshLease({ sessionId: 'sess-t', threadKey: 'pr:92' });
    const tables: Record<string, Row[]> = {
      studios: [{ id: 's-t', user_id: 'u', lease: lease as unknown as Row, worktree_path: null }],
      studio_lease_events: [],
      inbox_threads: [],
      agent_identities: [],
      sessions: [],
    };
    const marker = { reason: 'thread-closed', requestedAt: new Date().toISOString() };
    const service = new StudioLeaseService(
      makeFakeSupabase(tables, {
        afterSelect: (table, count) => {
          // Interleave: close_thread stamps pendingRelease AFTER the touch's
          // first read returns its snapshot (heartbeat unchanged).
          if (table === 'studios' && count === 1) {
            const row = tables.studios[0];
            row.lease = {
              ...(row.lease as unknown as StudioLease),
              pendingRelease: marker,
            } as unknown as Row;
          }
        },
      })
    );

    const held = await service.touchStudioLeaseForSession('s-t', 'sess-t', 'u');
    const after = tables.studios[0].lease as unknown as StudioLease;

    // The request survives — this is the P1. The touch itself still reports
    // held via its re-read (the holder may finish its turn; the marker only
    // defers the release to the boundary).
    expect(after.pendingRelease).toEqual(marker);
    expect(held).toBe(true);
  });
});

/**
 * Regression: session 4896f302 was observed holding two studios at once —
 * one per thread it had opened. Nothing enforces one-studio-per-session
 * (jsonb carries no unique constraint), and every release path used
 * `.limit(1).maybeSingle()`, so it acted on ONE row in unspecified order and
 * stranded the other: leased, no live holder, no pendingRelease, invisible to
 * the sweep. These prove the whole set is handled.
 */
describe('a session holding multiple studios (leak)', () => {
  afterEach(() => resetActiveRuns());

  function twoHeld(leaseOverrides: Partial<StudioLease> = {}): Record<string, Row[]> {
    const mk = (threadKey: string) =>
      ({
        ...freshLease({ sessionId: 'sess-multi', threadKey }),
        ...leaseOverrides,
      }) as unknown as Row;
    return {
      studios: [
        { id: 's-one', user_id: 'u', status: 'active', lease: mk('pr:504'), worktree_path: null },
        {
          id: 's-two',
          user_id: 'u',
          status: 'active',
          lease: mk('pcp:issue:x'),
          worktree_path: null,
        },
      ],
      studio_lease_events: [],
      inbox_threads: [],
      agent_identities: [],
      sessions: [{ id: 'sess-multi', user_id: 'u', ended_at: new Date().toISOString() }],
    };
  }

  it('releaseBySession clears EVERY studio the session holds, not an arbitrary one', async () => {
    resetActiveRuns();
    const tables = twoHeld();
    const service = new StudioLeaseService(makeFakeSupabase(tables));

    expect(await service.releaseBySession('sess-multi', { userId: 'u' })).toBe(true);
    expect(tables.studios[0].lease).toBeNull();
    expect(tables.studios[1].lease).toBeNull();
  });

  it('releaseAtBoundary completes a pendingRelease on every held studio', async () => {
    resetActiveRuns();
    const tables = twoHeld({
      pendingRelease: { reason: 'thread-closed', requestedAt: new Date().toISOString() },
    });
    const service = new StudioLeaseService(makeFakeSupabase(tables));

    expect(
      await service.releaseAtBoundary('sess-multi', {
        userId: 'u',
        sessionTerminal: false,
        reason: 'cli-turn-stopped',
      })
    ).toBe(true);
    expect(tables.studios[0].lease).toBeNull();
    expect(tables.studios[1].lease).toBeNull();
  });

  it('renewBySession heartbeats every held studio, so neither goes stale unwatched', async () => {
    resetActiveRuns();
    const stale = new Date(Date.now() - LEASE_STALE_MS - 60_000).toISOString();
    const tables = twoHeld({ heartbeatAt: stale });
    const service = new StudioLeaseService(makeFakeSupabase(tables));

    expect(await service.renewBySession('sess-multi', 'u')).toBe(true);
    for (const row of tables.studios) {
      expect(isLeaseStale(row.lease as unknown as StudioLease)).toBe(false);
    }
  });
});

describe('claimForTeardown ownership (round 3)', () => {
  function claimTables(lease: StudioLease | null): Record<string, Row[]> {
    return {
      studios: [{ id: 's-1', user_id: 'u', lease: lease as unknown as Row, worktree_path: null }],
      studio_lease_events: [],
      inbox_threads: [],
      agent_identities: [],
      sessions: [],
    };
  }

  it('claims a vacant studio with a unique token', async () => {
    const tables = claimTables(null);
    const service = new StudioLeaseService(makeFakeSupabase(tables));
    const claim = await service.claimForTeardown('s-1', 'u', { reason: 'teardown' });
    expect(claim?.claimKind).toBe('teardown');
    expect(claim?.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await service.verifyClaim('s-1', 'u', claim!)).toBe(true);
  });

  it('REFUSES to steal a fresh claim — its owner is mid-rescue/removal', async () => {
    const tables = claimTables(null);
    const service = new StudioLeaseService(makeFakeSupabase(tables));
    const first = await service.claimForTeardown('s-1', 'u', { reason: 'teardown-a' });
    expect(first).not.toBeNull();

    const second = await service.claimForTeardown('s-1', 'u', { reason: 'teardown-b' });
    expect(second).toBeNull();
    // First worker's token still owns the studio.
    expect(await service.verifyClaim('s-1', 'u', first!)).toBe(true);
  });

  it('finalizeTeardown fails when the claim changed underneath — never a phantom success (round 7)', async () => {
    const tables = claimTables(null);
    const service = new StudioLeaseService(makeFakeSupabase(tables));
    const claim = await service.claimForTeardown('s-1', 'u', { reason: 'teardown' });
    expect(claim).not.toBeNull();

    // Another worker replaced the claim (aged-out steal) between our
    // observation and finalization.
    const other: StudioLease = {
      ...claim!,
      sessionId: '33333333-3333-3333-3333-333333333333',
    };
    tables.studios[0].lease = other as unknown as Row;

    expect(await service.finalizeTeardown('s-1', 'u', claim!)).toBe(false);
    expect(tables.studios[0].status).not.toBe('cleaned');
    expect((tables.studios[0].lease as StudioLease).sessionId).toBe(other.sessionId);

    // The claim that actually holds the studio finalizes atomically.
    expect(await service.finalizeTeardown('s-1', 'u', other)).toBe(true);
    expect(tables.studios[0].status).toBe('cleaned');
    expect(tables.studios[0].lease).toBeNull();
  });

  it('re-claims only a STALE quarantine, and token revalidation detects takeover', async () => {
    const staleIso = new Date(Date.now() - LEASE_STALE_MS - 60_000).toISOString();
    const staleQuarantine: StudioLease = {
      sessionId: '11111111-1111-1111-1111-111111111111',
      threadKey: QUARANTINE_THREAD_KEY,
      heldThreadKey: 'pr:5',
      agentId: 'wren',
      acquiredAt: staleIso,
      heartbeatAt: staleIso,
      quarantined: true,
      claimKind: 'recovery',
    };
    const tables = claimTables(staleQuarantine);
    const service = new StudioLeaseService(makeFakeSupabase(tables));

    const claim = await service.claimForTeardown('s-1', 'u', { reason: 'teardown-retry' });
    expect(claim).not.toBeNull();
    // The old quarantine's identity no longer verifies.
    expect(await service.verifyClaim('s-1', 'u', staleQuarantine)).toBe(false);
    expect(await service.verifyClaim('s-1', 'u', claim!)).toBe(true);
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
