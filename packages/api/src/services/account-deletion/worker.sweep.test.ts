/**
 * The deletion worker's sweep order over FakePostgrest: every pending
 * request is reached, however many share a timestamp (Lumen, #783 r2:
 * a cursor on requested_at alone never visited the 21st of 21 same-time
 * requests). Every id here is synthetic.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakePostgrest } from '../../test/fake-postgrest';
import { accountGate } from './gate';
import { processDeletions, SWEEP_SIZE, type DeletionDeps } from './worker';

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
let seeded: string[] = [];

afterEach(() => {
  for (const userId of seeded) accountGate.forget(userId);
  seeded = [];
});

/** Requests held at `closed`, one per timestamp given. */
function requests(times: string[]): { db: FakePostgrest; deps: DeletionDeps } {
  const db = new FakePostgrest();
  // requestDeletionOfRecreatedAccounts reads `.not('auth_uid', 'is', null)`,
  // which the fake spells as neq.
  const from = db.from.bind(db);
  db.from = ((table: string) => {
    const query = from(table);
    return Object.assign(query, {
      not: (column: string, op: string, value: unknown) => {
        expect([op, value]).toEqual(['is', null]);
        return query.neq(column, null);
      },
    });
  }) as typeof db.from;
  times.forEach((requestedAt, i) => {
    seeded.push(id(i));
    db.seed('account_deletion_requests', {
      user_id: id(i),
      requested_at: requestedAt,
      completed_at: null,
      step: 'closed',
      auth_uid: null,
      inventory: null,
      outcomes: {},
    });
  });
  const deps: DeletionDeps = {
    db: db as never,
    deleteAuthUser: vi.fn(),
    stopTurns: vi.fn(),
    serverInstance: () => undefined,
    roots: {} as never,
    uploadsRoot: null,
    drainTimeoutMs: 0,
    now: () => Date.parse('2026-10-07T12:01:00.000Z'),
    sweep: { after: null },
  };
  return { db, deps };
}

const visited = (db: FakePostgrest) =>
  db
    .rows('account_deletion_requests')
    .filter((row) => Object.keys(row.outcomes as object).length > 0)
    .map((row) => row.user_id);

const SAME = '2026-10-07T12:00:00.000Z';

describe('the deletion sweep', () => {
  it('reaches all 21 of 21 requests that share one timestamp in two sweeps (Lumen, #783 r2)', async () => {
    const { db, deps } = requests(Array(21).fill(SAME));
    await processDeletions(deps);
    expect(visited(db)).toHaveLength(SWEEP_SIZE);
    // A full sweep stops on the last request it took, by time and id.
    expect(deps.sweep?.after).toEqual({ requestedAt: SAME, userId: id(19) });
    await processDeletions(deps);
    expect(visited(db)).toHaveLength(21);
    // A short sweep starts the next one at the oldest again.
    expect(deps.sweep?.after).toBeNull();
  });

  it('reaches every request within ceil(N / 20) + 1 sweeps when ties straddle each boundary', async () => {
    // 45 requests, seven to an instant, so each sweep of twenty stops in the
    // middle of one: request 20 shares its instant with request 21, and 40
    // with 41.
    const instants = ['10:00', '10:01', '10:02', '10:03', '10:04', '10:05', '10:06'].map(
      (t) => `2026-10-07T${t}:00.000Z`
    );
    const times = Array.from({ length: 45 }, (_, i) => instants[Math.floor(i / 7)]);
    const { db, deps } = requests(times);
    const bound = Math.ceil(times.length / SWEEP_SIZE) + 1;
    for (let sweep = 0; sweep < bound; sweep++) await processDeletions(deps);
    expect(new Set(visited(db))).toEqual(new Set(seeded));
  });

  it('starts at the oldest with no cursor, as a server that keeps none does', async () => {
    const { db, deps } = requests(Array(21).fill(SAME));
    delete deps.sweep;
    await processDeletions(deps);
    await processDeletions(deps);
    // Without a cursor each sweep takes the same oldest twenty: the cursor is what reaches the rest.
    expect(visited(db)).toHaveLength(SWEEP_SIZE);
  });
});
