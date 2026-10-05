import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { freezeJournalEntry, journalReplayEvent, type JournalEntry } from '@inklabs/shared/runtime';
import { readSessionJournalPage, type JournalReadScope } from './session-journal-reader';

const scope: JournalReadScope = {
  sessionId: '00000000-0000-4000-8000-000000000001',
  journalId: '00000000-0000-4000-8000-000000000002',
};
const tenure = '00000000-0000-4000-8000-000000000003';
const other = '00000000-0000-4000-8000-000000000009';
function entry(eid: number, text = 'hello'): JournalEntry {
  return {
    ...scope,
    writerTenureId: tenure,
    hostInstanceId: 'fixture-host',
    version: 1,
    eid,
    ts: '2026-10-05T02:00:00.000Z',
    type: 'assistant',
    target: null,
    body: { text },
  };
}
function header(committed_eid: number) {
  return {
    id: scope.journalId,
    session_id: scope.sessionId,
    kind: 'db_v1',
    hold_reason: null,
    committed_eid,
  };
}
function meta(entries: JournalEntry[]) {
  return entries.map((e) => ({
    eid: e.eid,
    entry_bytes: freezeJournalEntry(e, 256 * 1024).bytes + 16,
  }));
}
function rows(entries: JournalEntry[]) {
  return entries.map((e) => ({ eid: e.eid, entry: e }));
}
type Result = { data: unknown; error: unknown };
type Query = { table: string; columns?: string; ops: unknown[][] };
function fixture(responses: Array<unknown | (() => Promise<Result>)>) {
  const queries: Query[] = [];
  const client = {
    from: (table: string) => {
      const q: Query = { table, ops: [] };
      queries.push(q);
      const builder = {
        select(columns: string) {
          q.columns = columns;
          return builder;
        },
        eq(...args: unknown[]) {
          q.ops.push(['eq', ...args]);
          return builder;
        },
        gt(...args: unknown[]) {
          q.ops.push(['gt', ...args]);
          return builder;
        },
        lte(...args: unknown[]) {
          q.ops.push(['lte', ...args]);
          return builder;
        },
        order(...args: unknown[]) {
          q.ops.push(['order', ...args]);
          return builder;
        },
        limit(...args: unknown[]) {
          q.ops.push(['limit', ...args]);
          return builder;
        },
        maybeSingle() {
          q.ops.push(['maybeSingle']);
          return builder;
        },
        then(resolve: (result: Result) => unknown, reject: (error: unknown) => unknown) {
          const response = responses.shift();
          return Promise.resolve()
            .then(() =>
              typeof response === 'function' ? response() : { data: response, error: null }
            )
            .then(resolve, reject);
        },
      };
      return builder;
    },
  } as unknown as SupabaseClient;
  const authorize = vi.fn(async (_scope: Readonly<JournalReadScope>) => true);
  const options = {
    scope: { ...scope },
    cursor: { journalId: scope.journalId, afterEid: 0 },
    authorize,
  };
  return { client, queries, options, authorize, responses };
}

describe('D1 bounded participant replay (mock queries, no live endpoint)', () => {
  it('reads a contiguous pinned prefix, with scoped ascending keyset queries and immutable output', async () => {
    const es = [entry(1), entry(2)];
    const f = fixture([header(3), meta(es), rows(es)]);
    const page = await readSessionJournalPage(f.client, { ...f.options, maxEntries: 2 });
    expect(page.entries).toEqual(es);
    expect(page.cursor).toEqual({ journalId: scope.journalId, afterEid: 2 });
    expect(page).toMatchObject({ throughEid: 3, committedEid: 3, more: true });
    expect(f.queries).toEqual([
      {
        table: 'session_journals',
        columns: 'id,session_id,kind,committed_eid,hold_reason',
        ops: [
          ['eq', 'id', scope.journalId],
          ['eq', 'session_id', scope.sessionId],
          ['maybeSingle'],
        ],
      },
      {
        table: 'session_journal_entries',
        columns: 'eid,entry_bytes',
        ops: [
          ['eq', 'journal_id', scope.journalId],
          ['gt', 'eid', 0],
          ['lte', 'eid', 3],
          ['order', 'eid', { ascending: true }],
          ['limit', 2],
        ],
      },
      {
        table: 'session_journal_entries',
        columns: 'eid,entry',
        ops: [
          ['eq', 'journal_id', scope.journalId],
          ['gt', 'eid', 0],
          ['lte', 'eid', 2],
          ['order', 'eid', { ascending: true }],
          ['limit', 2],
        ],
      },
    ]);
    expect(f.authorize).toHaveBeenCalledTimes(3);
    for (const [checked] of f.authorize.mock.calls) {
      expect(checked).toEqual(scope);
      expect(Object.isFrozen(checked)).toBe(true);
    }
    expect(Object.isFrozen(page)).toBe(true);
    expect(Object.isFrozen(page.entries)).toBe(true);
    expect(Object.isFrozen(page.entries[0].body)).toBe(true);
    es[0].body.text = 'changed';
    expect(page.entries[0].body.text).toBe('hello');
  });

  it('loads only the byte-fitting prefix, not every candidate body', async () => {
    const es = [entry(1, 'x'.repeat(700)), entry(2, 'x'.repeat(700)), entry(3)];
    const f = fixture([header(3), meta(es), rows([es[0]])]);
    const page = await readSessionJournalPage(f.client, { ...f.options, maxPageBytes: 2048 });
    expect(page.entries).toEqual([es[0]]);
    expect(page.cursor.afterEid).toBe(1);
    expect(page.more).toBe(true);
    expect(f.queries[2].ops).toContainEqual(['lte', 'eid', 1]);
    expect(f.queries[2].ops).toContainEqual(['limit', 1]);
    expect(new TextEncoder().encode(JSON.stringify(page)).byteLength).toBeLessThanOrEqual(2048);
  });

  it('caps metadata at128 and does not multiply the maximum entry size by128', async () => {
    const es = Array.from({ length: 128 }, (_, i) => entry(i + 1));
    const f = fixture([header(9000), meta(es), rows(es)]);
    const page = await readSessionJournalPage(f.client, f.options);
    expect(page.entries).toHaveLength(128);
    expect(page.cursor.afterEid).toBe(128);
    expect(f.queries[1].ops).toContainEqual(['limit', 128]);
  });

  it.each([0, 2])(
    'returns an empty completed prefix at%s without a payload query',
    async (head) => {
      const f = fixture([header(head + 10)]);
      const page = await readSessionJournalPage(f.client, {
        ...f.options,
        cursor: { journalId: scope.journalId, afterEid: head },
        throughEid: head,
      });
      expect(page.entries).toEqual([]);
      expect(page.more).toBe(false);
      expect(page.throughEid).toBe(head);
      expect(page.committedEid).toBe(head + 10);
      expect(f.queries).toHaveLength(1);
      expect(f.authorize).toHaveBeenCalledTimes(2);
    }
  );

  it('preserves a stored hold while allowing the authorized historical read', async () => {
    const e = entry(1);
    const f = fixture([{ ...header(1), hold_reason: 'store_capacity' }, meta([e]), rows([e])]);
    const page = await readSessionJournalPage(f.client, f.options);
    expect(page.holdReason).toBe('store_capacity');
    expect(page.entries).toEqual([e]);
  });

  it('budgets expanded SQL jsonb text without treating it as oversized compact JSON', async () => {
    const e = entry(1);
    const f = fixture([header(1), [{ eid: 1, entry_bytes: 512 * 1024 }], rows([e])]);
    expect((await readSessionJournalPage(f.client, f.options)).entries).toEqual([e]);
  });

  it.each([undefined, '', 'free text', 'x'.repeat(101)])(
    'refuses malformed hold metadata',
    async (hold_reason) => {
      const f = fixture([{ ...header(1), hold_reason }]);
      await expect(readSessionJournalPage(f.client, f.options)).rejects.toMatchObject({
        code: 'invalid_page',
      });
      expect(f.queries).toHaveLength(1);
    }
  );

  it('reads a byte-bounded page whose independently valid entries exceed the per-entry node cap in aggregate', async () => {
    const es = Array.from({ length: 128 }, (_, i) => ({
      ...entry(i + 1),
      body: { values: Array(900).fill(0) },
    }));
    const f = fixture([header(128), meta(es), rows(es)]);
    const page = await readSessionJournalPage(f.client, f.options);
    expect(page.entries).toHaveLength(128);
    expect(page.cursor.afterEid).toBe(128);
    expect(new TextEncoder().encode(JSON.stringify(page)).byteLength).toBeLessThan(1024 * 1024);
  });

  it('does not count transport/page wrappers against the entry depth cap', async () => {
    let nested: { [key: string]: import('@inklabs/shared/runtime').JournalJson } = {
      leaf: 'fixture',
    };
    for (let depth = 0; depth < 61; depth++) nested = { child: nested };
    const e = { ...entry(1), body: nested };
    expect(() => freezeJournalEntry(e, 256 * 1024)).not.toThrow();
    const f = fixture([header(1), meta([e]), rows([e])]);
    expect((await readSessionJournalPage(f.client, f.options)).entries).toEqual([e]);
  });

  it('keeps a prior snapshot ceiling when the head grows between pages', async () => {
    const es = [entry(3), entry(4)];
    const f = fixture([header(9), meta(es), rows(es)]);
    const page = await readSessionJournalPage(f.client, {
      ...f.options,
      cursor: { journalId: scope.journalId, afterEid: 2 },
      throughEid: 4,
    });
    expect(page).toMatchObject({ throughEid: 4, committedEid: 9, more: false });
    expect(f.queries[1].ops).toContainEqual(['lte', 'eid', 4]);
  });

  it('keeps hidden control entries in the scanned cursor and preserves replay context references', async () => {
    const first = {
      ...entry(1),
      type: 'provider_spawn_observation',
      target: { tenureId: tenure, epoch: 'epoch-1', commandUuid: other, invocationId: 'inv-1' },
      body: { kind: 'unknown', reasonCode: 'lost_binding' },
    };
    const second = {
      ...entry(2),
      type: 'context_op',
      body: { refs: [1], op: 'evict', contentId: 'ctx-7' },
    };
    const f = fixture([header(2), meta([first, second]), rows([first, second])]);
    const page = await readSessionJournalPage(f.client, f.options);
    expect(page.cursor.afterEid).toBe(2);
    expect(journalReplayEvent(page.entries[1])).toEqual({
      ...second.body,
      type: second.type,
      ts: second.ts,
      eid: 2,
    });
  });

  it.each([
    { scope: { ...scope, sessionId: 'bad' } },
    { scope: { ...scope, extra: true } },
    { cursor: { journalId: other, afterEid: 0 } },
    { cursor: { journalId: scope.journalId, afterEid: -1 } },
    { cursor: { journalId: scope.journalId, afterEid: 0, extra: true } },
    { cursor: { journalId: scope.journalId, afterEid: Number.MAX_SAFE_INTEGER + 1 } },
    { throughEid: -1 },
    { throughEid: 0.5 },
    { maxEntries: 0 },
    { maxEntries: 129 },
    { maxPageBytes: 100 },
    { maxPageBytes: 1024 * 1024 + 1 },
  ])('refuses malformed requests before authorization or I/O', async (changes) => {
    const f = fixture([]);
    await expect(
      readSessionJournalPage(f.client, { ...f.options, ...changes })
    ).rejects.toMatchObject({ code: 'invalid_request' });
    expect(f.queries).toHaveLength(0);
    expect(f.authorize).not.toHaveBeenCalled();
  });

  it.each([false, undefined, { allowed: true }])(
    'requires explicit current authorization, never a truthy object',
    async (allowed) => {
      const f = fixture([]);
      f.authorize.mockResolvedValueOnce(allowed as boolean);
      await expect(readSessionJournalPage(f.client, f.options)).rejects.toMatchObject({
        code: 'forbidden',
      });
      expect(f.queries).toHaveLength(0);
    }
  );

  it.each([2, 3])('discards the page if authorization is revoked at check%s', async (check) => {
    const es = [entry(1)];
    const f = fixture([header(1), meta(es), rows(es)]);
    f.authorize.mockImplementation(async () => f.authorize.mock.calls.length !== check);
    await expect(readSessionJournalPage(f.client, f.options)).rejects.toMatchObject({
      code: 'forbidden',
    });
    expect(f.queries).toHaveLength(check === 2 ? 2 : 3);
  });

  it('does not expose an authorization exception', async () => {
    const f = fixture([]);
    f.authorize.mockRejectedValueOnce(new Error('private-auth-detail'));
    await expect(readSessionJournalPage(f.client, f.options)).rejects.toThrow(
      'Session journal read: forbidden'
    );
  });

  it('freezes caller scope, cursor and limits before the authorization await', async () => {
    const f = fixture([header(0)]);
    f.authorize.mockImplementationOnce(async () => {
      f.options.scope.sessionId = other;
      f.options.cursor.afterEid = 999;
      return true;
    });
    const page = await readSessionJournalPage(f.client, f.options);
    expect(page.cursor.afterEid).toBe(0);
    expect(f.queries[0].ops).toContainEqual(['eq', 'session_id', scope.sessionId]);
  });

  it('does not create a journal when none exists', async () => {
    const f = fixture([null]);
    await expect(readSessionJournalPage(f.client, f.options)).rejects.toMatchObject({
      code: 'unavailable',
    });
    expect(f.queries).toHaveLength(1);
  });

  it.each([{ afterEid: 3 }, { throughEid: 3 }])(
    'does not reset a cursor/ceiling ahead of the store',
    async (change) => {
      const f = fixture([header(2)]);
      await expect(
        readSessionJournalPage(f.client, {
          ...f.options,
          cursor: { journalId: scope.journalId, afterEid: change.afterEid ?? 0 },
          throughEid: change.throughEid,
        })
      ).rejects.toMatchObject({ code: 'cursor_ahead' });
      expect(f.queries).toHaveLength(1);
    }
  );

  it.each([
    { ...header(1), id: other },
    { ...header(1), session_id: other },
    { ...header(1), kind: 'file' },
    { ...header(1), committed_eid: '1' },
    { ...header(1), committed_eid: Number.MAX_SAFE_INTEGER + 1 },
  ])('refuses an invalid/miscorrelated header', async (bad) => {
    const f = fixture([bad]);
    await expect(readSessionJournalPage(f.client, f.options)).rejects.toMatchObject({
      code: 'invalid_page',
    });
    expect(f.queries).toHaveLength(1);
  });

  it.each(
    [
      [],
      [{ eid: 2, entry_bytes: 500 }],
      [{ eid: 1, entry_bytes: -1 }],
      [{ eid: 1, entry_bytes: 512 * 1024 + 1 }],
      [{ eid: 1, entry_bytes: '500' }],
      [
        { eid: 1, entry_bytes: 500 },
        { eid: 1, entry_bytes: 500 },
      ],
    ].map((bad) => ({ bad }))
  )('refuses gaps, duplicates and malformed size metadata before bodies', async ({ bad }) => {
    const f = fixture([header(1), bad]);
    await expect(readSessionJournalPage(f.client, f.options)).rejects.toMatchObject({
      code: 'invalid_page',
    });
    expect(f.queries).toHaveLength(2);
  });

  it('refuses a too-small page rather than silently skipping the first large entry', async () => {
    const f = fixture([header(1), [{ eid: 1, entry_bytes: 3000 }]]);
    await expect(
      readSessionJournalPage(f.client, { ...f.options, maxPageBytes: 2048 })
    ).rejects.toMatchObject({ code: 'page_too_small' });
    expect(f.queries).toHaveLength(2);
  });

  it.each(
    [
      [],
      rows([entry(2)]),
      [{ eid: 1, entry: { ...entry(1), sessionId: other } }],
      [{ eid: 1, entry: { ...entry(1), journalId: other } }],
      [{ eid: 1, entry: { ...entry(1), body: { text: 'x'.repeat(1000) } } }],
      [{ eid: 1, entry: { ...entry(1), extra: 'bad' } }],
    ].map((bad) => ({ bad }))
  )('returns no partial cursor or page for corrupt/missing bodies', async ({ bad }) => {
    const f = fixture([header(1), meta([entry(1)]), bad]);
    await expect(readSessionJournalPage(f.client, f.options)).rejects.toMatchObject({
      code: 'invalid_page',
    });
  });

  it('refuses even a one-byte metadata undercount', async () => {
    const e = entry(1);
    const bytes = freezeJournalEntry(e, 256 * 1024).bytes;
    const f = fixture([header(1), [{ eid: 1, entry_bytes: bytes - 1 }], rows([e])]);
    await expect(readSessionJournalPage(f.client, f.options)).rejects.toMatchObject({
      code: 'invalid_page',
    });
  });

  it.each([
    'element-getter',
    'row-getter',
    'inner-getter',
    'hole',
    'array-extra',
    'row-extra',
    'array-prototype',
    'row-prototype',
  ])('rejects non-data body transport shape %s without invoking accessors', async (kind) => {
    const e = entry(1);
    const bad = rows([e]);
    const getter = vi.fn(() => e);
    if (kind === 'element-getter')
      Object.defineProperty(bad, '0', { get: getter, enumerable: true });
    if (kind === 'row-getter')
      Object.defineProperty(bad[0], 'entry', { get: getter, enumerable: true });
    if (kind === 'inner-getter')
      Object.defineProperty(e.body, 'text', { get: getter, enumerable: true });
    if (kind === 'hole') delete bad[0];
    if (kind === 'array-extra') Object.defineProperty(bad, 'extra', { value: true });
    if (kind === 'row-extra') Object.defineProperty(bad[0], Symbol('extra'), { value: true });
    if (kind === 'array-prototype') Object.setPrototypeOf(bad, Object.create(Array.prototype));
    if (kind === 'row-prototype') Object.setPrototypeOf(bad[0], { marker: true });
    const f = fixture([header(1), meta([entry(1)]), bad]);
    await expect(readSessionJournalPage(f.client, f.options)).rejects.toMatchObject({
      code: 'invalid_page',
    });
    expect(getter).not.toHaveBeenCalled();
  });

  it.each([0, 1, 2])('does not retry or expose errors from query%s', async (index) => {
    const replies: unknown[] = [header(1), meta([entry(1)]), rows([entry(1)])];
    replies[index] = async () => ({ data: null, error: { message: 'private-database-detail' } });
    const f = fixture(replies);
    await expect(readSessionJournalPage(f.client, f.options)).rejects.toThrow(
      'Session journal read: transport_failed'
    );
    expect(f.queries).toHaveLength(index + 1);
  });
});
