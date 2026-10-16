import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  retainedInboxStore,
  type RetainedInboxDelivery,
  type RetainedInboxSource,
} from './retained-inbox-store';

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const scope = { ownerId: id(1), recipientId: id(2), sessionId: id(3) };
const sources: RetainedInboxSource[] = [
  { kind: 'thread', messageId: id(4) },
  { kind: 'thread', messageId: id(5) },
  { kind: 'inbox', messageId: id(6) },
];
const launch = { launchId: id(7), turnEpoch: id(8), native: null };
const stamp = '2026-01-01T00:00:00.000Z';
type Row = Record<string, unknown>;
type Reply = { data: unknown; error: { message: string } | null };
type Filter = { op: 'eq' | 'is' | 'neq' | 'gt'; key: string; value: unknown };

/** Inert query model; this does not prove PostgreSQL constraints or isolation. */
function harness() {
  const rows = new Map<string, Row>();
  const calls: Query[] = [];
  let fault: ((query: Query, reply: Reply) => Reply) | undefined;
  class Query implements PromiseLike<Reply> {
    operation = 'read';
    changes: Row = {};
    inserted: Row[] = [];
    filters: Filter[] = [];
    limitCount = Infinity;
    constructor(readonly table: string) {
      calls.push(this);
    }
    insert(values: Row[]) {
      this.operation = 'insert';
      this.inserted = values;
      return this;
    }
    update(values: Row) {
      this.operation = 'update';
      this.changes = values;
      return this;
    }
    select(_columns: string) {
      return this;
    }
    eq(key: string, value: unknown) {
      this.filters.push({ op: 'eq', key, value });
      return this;
    }
    is(key: string, value: unknown) {
      this.filters.push({ op: 'is', key, value });
      return this;
    }
    neq(key: string, value: unknown) {
      this.filters.push({ op: 'neq', key, value });
      return this;
    }
    gt(key: string, value: unknown) {
      this.filters.push({ op: 'gt', key, value });
      return this;
    }
    order(key: string, options: { ascending: boolean }) {
      expect([key, options]).toEqual(['id', { ascending: true }]);
      return this;
    }
    limit(value: number) {
      this.limitCount = value;
      return this;
    }
    async maybeSingle(): Promise<Reply> {
      const reply = this.execute();
      const data = Array.isArray(reply.data) ? (reply.data[0] ?? null) : reply.data;
      return { ...reply, data };
    }
    then<TResult1 = Reply, TResult2 = never>(
      fulfilled?: ((value: Reply) => TResult1 | PromiseLike<TResult1>) | null,
      rejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
    ): Promise<TResult1 | TResult2> {
      return Promise.resolve()
        .then(() => this.execute())
        .then(fulfilled, rejected);
    }
    execute(): Reply {
      expect(this.table).toBe('sb_inbox_deliveries');
      let selected: Row[];
      if (this.operation === 'insert') {
        // Model whole-batch uniqueness before any insert; the real guarantee
        // belongs to the database and requires separate integration coverage.
        const sameSource = (a: Row, b: Row) =>
          a.recipient_id === b.recipient_id &&
          ((a.thread_message_id !== null && a.thread_message_id === b.thread_message_id) ||
            (a.inbox_message_id !== null && a.inbox_message_id === b.inbox_message_id));
        if (this.inserted.some((a) => [...rows.values()].some((b) => sameSource(a, b))))
          return { data: null, error: { message: 'duplicate' } };
        selected = this.inserted.map((row) => ({
          ...row,
          state: 'pending',
          revision: 0,
          launch_id: null,
          turn_epoch: null,
          native_session_id: null,
          native_input_id: null,
          created_at: stamp,
          changed_at: stamp,
          settled_at: null,
        }));
        for (const row of selected) rows.set(String(row.id), row);
      } else {
        selected = [...rows.values()]
          .filter((row) =>
            this.filters.every(({ op, key, value }) =>
              op === 'neq'
                ? row[key] !== value
                : op === 'gt'
                  ? String(row[key]) > String(value)
                  : row[key] === value
            )
          )
          .sort((a, b) => String(a.id).localeCompare(String(b.id)))
          .slice(0, this.limitCount);
        if (this.operation === 'update')
          for (const row of selected) Object.assign(row, this.changes);
      }
      const reply = { data: structuredClone(selected), error: null };
      return fault ? fault(this, reply) : reply;
    }
  }
  const client = { from: (table: string) => new Query(table) } as unknown as SupabaseClient;
  return {
    store: retainedInboxStore(client),
    rows,
    calls,
    setFault: (value: typeof fault) => {
      fault = value;
    },
  };
}

async function bound(h: ReturnType<typeof harness>) {
  const [pending] = await h.store.retain(scope, sources.slice(0, 1));
  const result = await h.store.bind(pending, launch);
  expect(result.status).toBe('written');
  if (result.status !== 'written') throw new Error('fixture bind failed');
  return result.delivery;
}

describe('retained inbox delivery store (unwired)', () => {
  it('retains every coalesced source in one insert without content or a read pointer', async () => {
    const h = harness();
    const result = await h.store.retain(scope, sources);
    expect(result).toHaveLength(3);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].inserted.map((row) => [row.thread_message_id, row.inbox_message_id])).toEqual(
      [
        [id(4), null],
        [id(5), null],
        [null, id(6)],
      ]
    );
    expect(Object.keys(h.calls[0].inserted[0]).sort()).toEqual(
      [
        'id',
        'owner_id',
        'recipient_id',
        'session_id',
        'thread_message_id',
        'inbox_message_id',
      ].sort()
    );
    expect(Object.isFrozen(result)).toBe(true);
    expect(result.every(Object.isFrozen)).toBe(true);
  });

  it('rejects duplicate sources, empty batches, oversized batches and malformed scopes before I/O', async () => {
    const h = harness();
    for (const input of [
      [],
      [sources[0], sources[0]],
      Array.from({ length: 101 }, () => sources[0]),
    ])
      await expect(h.store.retain(scope, input)).rejects.toThrow();
    await expect(h.store.retain({ ...scope, recipientId: '' }, sources)).rejects.toThrow();
    expect(h.calls).toHaveLength(0);
  });

  it('does not upsert or replace an existing obligation on redispatch', async () => {
    const h = harness();
    const original = await h.store.retain(scope, sources.slice(0, 1));
    await expect(h.store.retain({ ...scope, sessionId: id(20) }, sources)).rejects.toThrow(
      'do not dispatch'
    );
    expect([...h.rows.values()]).toEqual(original);
  });

  it('keeps recipient fanout separate', async () => {
    const h = harness();
    await h.store.retain(scope, sources);
    await h.store.retain({ ...scope, recipientId: id(20) }, sources);
    expect(h.rows.size).toBe(6);
  });

  it('snapshots source and scope inputs before yielding to storage', async () => {
    const h = harness();
    const mutableScope = { ...scope };
    const mutableSources = sources.map((source) => ({ ...source }));
    const response = h.store.retain(mutableScope, mutableSources);
    mutableScope.sessionId = id(99);
    mutableSources[0].messageId = id(99);
    const rows = await response;
    expect(rows[0].session_id).toBe(scope.sessionId);
    expect(rows[0].thread_message_id).toBe(sources[0].messageId);
  });

  for (const failure of [
    'throw',
    'error',
    'partial',
    'duplicate',
    'wrong-source',
    'already-bound',
  ]) {
    it(`refuses admission on ${failure} retention acknowledgement`, async () => {
      const h = harness();
      h.setFault((_query, reply) => {
        if (failure === 'throw') throw new Error('synthetic private failure');
        if (failure === 'error')
          return { data: null, error: { message: 'synthetic private failure' } };
        const rows = reply.data as Row[];
        if (failure === 'partial') rows.pop();
        if (failure === 'duplicate') rows[1] = rows[0];
        if (failure === 'wrong-source') rows[0].thread_message_id = id(99);
        if (failure === 'already-bound')
          Object.assign(rows[0], { state: 'bound', launch_id: id(7), turn_epoch: id(8) });
        return reply;
      });
      await expect(h.store.retain(scope, sources)).rejects.toThrow(
        'Input retention was not confirmed; do not dispatch'
      );
      expect(h.rows.size).toBe(3); // ambiguous committed insert remains discoverable
    });
  }

  it('binds launch/epoch and optional native correlation before input dispatch', async () => {
    const h = harness();
    const [pending] = await h.store.retain(scope, sources.slice(0, 1));
    const outcome = await h.store.bind(pending, {
      ...launch,
      native: { sessionId: 'synthetic-native', inputId: id(19) },
    });
    expect(outcome).toMatchObject({
      status: 'written',
      delivery: {
        revision: 1,
        state: 'bound',
        launch_id: id(7),
        turn_epoch: id(8),
        native_session_id: 'synthetic-native',
        native_input_id: id(19),
      },
    });
    expect(await h.store.bind(pending, { ...launch, turnEpoch: id(20) })).toEqual({
      status: 'conflict',
    });
  });

  it('only one concurrent binder wins the modeled compare-and-set', async () => {
    const h = harness();
    const [pending] = await h.store.retain(scope, sources.slice(0, 1));
    const outcomes = await Promise.all([
      h.store.bind(pending, launch),
      h.store.bind(pending, { ...launch, launchId: id(20) }),
    ]);
    expect(outcomes.map((o) => o.status).sort()).toEqual(['conflict', 'written']);
  });

  it('recognizes equivalent PostgREST timestamp spelling on write acknowledgements', async () => {
    const h = harness();
    h.setFault((_query, reply) => {
      for (const row of reply.data as Row[]) {
        for (const key of ['created_at', 'changed_at', 'settled_at']) {
          if (typeof row[key] === 'string') row[key] = row[key].replace('Z', '+00:00');
        }
      }
      return reply;
    });
    const expected = await bound(h);
    expect(await h.store.settleAfterFinalization(expected)).toMatchObject({ status: 'written' });
  });

  it('fences state even if a stale writer has the same revision', async () => {
    const h = harness();
    const expected = await bound(h);
    h.rows.get(expected.id)!.state = 'held';
    expect(await h.store.settleAfterFinalization(expected)).toEqual({ status: 'conflict' });
    expect(h.rows.get(expected.id)!.state).toBe('held');
  });

  for (const field of [
    'id',
    'owner_id',
    'recipient_id',
    'session_id',
    'thread_message_id',
    'inbox_message_id',
    'revision',
    'launch_id',
    'turn_epoch',
    'native_session_id',
    'native_input_id',
  ] as const) {
    it(`fences ${field} during settlement`, async () => {
      const h = harness();
      const expected = await bound(h);
      const actual = h.rows.get(expected.id)!;
      actual[field] =
        field === 'revision' ? 99 : field === 'native_session_id' ? 'another-native' : id(99);
      expect(await h.store.settleAfterFinalization(expected)).toEqual({ status: 'conflict' });
      expect(actual.state).toBe('bound');
    });
  }

  it('holds uncertain delivery without settlement, reset, expiry or retry', async () => {
    const h = harness();
    const expected = await bound(h);
    const held = await h.store.hold(expected);
    expect(held.status).toBe('written');
    if (held.status !== 'written') throw new Error('fixture hold failed');
    const count = h.calls.length;
    expect(await h.store.settleAfterFinalization(held.delivery)).toEqual({ status: 'conflict' });
    expect(await h.store.bind(held.delivery, launch)).toEqual({ status: 'conflict' });
    expect(h.calls).toHaveLength(count);
    expect(await h.store.listUnsettled(scope)).toEqual([held.delivery]);
  });

  it('settles per source, only from bound, retaining deduplication after settlement', async () => {
    const h = harness();
    const expected = await bound(h);
    const settled = await h.store.settleAfterFinalization(expected);
    expect(settled).toMatchObject({
      status: 'written',
      delivery: { state: 'settled', revision: 2 },
    });
    expect(await h.store.listUnsettled(scope)).toEqual([]);
    await expect(h.store.retain(scope, sources.slice(0, 1))).rejects.toThrow('do not dispatch');
    expect(await h.store.settleAfterFinalization(expected)).toEqual({ status: 'conflict' });
  });

  it('does not settle pending input and refuses revision overflow', async () => {
    const h = harness();
    const [pending] = await h.store.retain(scope, sources.slice(0, 1));
    expect(await h.store.settleAfterFinalization(pending)).toEqual({ status: 'conflict' });
    expect(await h.store.bind({ ...pending, revision: 2_147_483_647 }, launch)).toEqual({
      status: 'conflict',
    });
    expect(h.calls).toHaveLength(1);
  });

  for (const failure of ['throw', 'error', 'wrong-row', 'wrong-revision', 'missing']) {
    it(`does not call an uncertain ${failure} update acknowledged`, async () => {
      const h = harness();
      const expected = await bound(h);
      h.setFault((_q, reply) => {
        if (failure === 'throw') throw new Error('private-synthetic');
        if (failure === 'error') return { data: null, error: { message: 'private-synthetic' } };
        const rows = reply.data as Row[];
        if (failure === 'wrong-row') rows[0].session_id = id(99);
        if (failure === 'wrong-revision') rows[0].revision = 10;
        if (failure === 'missing') return { data: undefined, error: null };
        return reply;
      });
      expect(await h.store.settleAfterFinalization(expected)).toEqual({ status: 'unknown' });
    });
  }

  it('discovers pending/bound/held rows by exact scope and stable keyset, never reader state', async () => {
    const h = harness();
    const own = await h.store.retain(scope, sources);
    await h.store.retain({ ...scope, recipientId: id(20) }, sources);
    await h.store.retain({ ...scope, ownerId: id(20), recipientId: id(21) }, sources);
    await h.store.retain({ ...scope, sessionId: id(20), recipientId: id(22) }, sources);
    const sorted = [...own].sort((a, b) => a.id.localeCompare(b.id));
    expect(await h.store.listUnsettled(scope, undefined, 2)).toEqual(sorted.slice(0, 2));
    expect(await h.store.listUnsettled(scope, sorted[1].id, 2)).toEqual(sorted.slice(2));
    const filters = h.calls.at(-1)!.filters;
    expect(filters).toContainEqual({ op: 'eq', key: 'owner_id', value: scope.ownerId });
    expect(filters).toContainEqual({ op: 'eq', key: 'recipient_id', value: scope.recipientId });
    expect(filters).toContainEqual({ op: 'eq', key: 'session_id', value: scope.sessionId });
    expect(filters).toContainEqual({ op: 'neq', key: 'state', value: 'settled' });
  });

  for (const failure of ['error', 'null', 'foreign', 'duplicate', 'settled']) {
    it(`does not convert ${failure} discovery to an empty successful page`, async () => {
      const h = harness();
      await h.store.retain(scope, sources);
      h.setFault((_q, reply) => {
        if (failure === 'error') return { data: null, error: { message: 'synthetic' } };
        if (failure === 'null') return { data: null, error: null };
        const rows = reply.data as Row[];
        if (failure === 'foreign') rows[0].owner_id = id(99);
        if (failure === 'duplicate') rows[1] = rows[0];
        if (failure === 'settled') rows[0].state = 'settled';
        return reply;
      });
      await expect(h.store.listUnsettled(scope)).rejects.toThrow('absence is not established');
    });
  }

  it('validates discovery bounds and nullable native binding before I/O', async () => {
    const h = harness();
    for (const limit of [0, -1, 101, 1.5])
      await expect(h.store.listUnsettled(scope, undefined, limit)).rejects.toThrow();
    await expect(h.store.listUnsettled(scope, 'not-a-uuid')).rejects.toThrow();
    expect(h.calls).toHaveLength(0);
    const [pending] = await h.store.retain(scope, sources.slice(0, 1));
    await expect(
      h.store.bind(pending, { ...launch, native: { sessionId: '', inputId: id(9) } })
    ).rejects.toThrow();
    const broken = { ...pending, inbox_message_id: id(99) } as RetainedInboxDelivery;
    await expect(h.store.bind(broken, launch)).rejects.toThrow();
    expect(h.calls).toHaveLength(1);
  });
});
