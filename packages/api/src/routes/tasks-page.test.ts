import { describe, expect, it } from 'vitest';
import {
  afterCursorFilter,
  decodeTasksCursor,
  encodeTasksCursor,
  parseTasksPage,
  TASKS_PAGE_MAX,
} from './tasks-page';

const ID = '11111111-2222-4333-8444-555555555555';
const AT = '2026-10-09T00:25:39.675785+00:00';
const cursorOf = (pair: unknown) => Buffer.from(JSON.stringify(pair), 'utf8').toString('base64url');

describe('a tasks cursor', () => {
  it('comes back as the exact pair it was made from, microseconds included', () => {
    const cursor = encodeTasksCursor({ createdAt: AT, id: ID });
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeTasksCursor(cursor)).toEqual({ createdAt: AT, id: ID });
  });

  it('accepts the timestamp shapes PostgREST prints', () => {
    for (const at of [
      '2026-10-09T00:25:39+00:00',
      '2026-10-09T00:25:39.1Z',
      '2026-10-09T00:25:39.000001-07:00',
    ]) {
      expect(decodeTasksCursor(cursorOf([at, ID])), at).toEqual({ createdAt: at, id: ID });
    }
  });

  it('refuses anything this route did not issue', () => {
    const refused: Array<[string, string]> = [
      ['not base64url', 'a+b/c='],
      ['not JSON', Buffer.from('nope').toString('base64url')],
      ['an object', cursorOf({ createdAt: AT, id: ID })],
      ['one value', cursorOf([AT])],
      ['three values', cursorOf([AT, ID, 'x'])],
      ['a number for the time', cursorOf([1, ID])],
      ['a date without a zone', cursorOf(['2026-10-09T00:25:39', ID])],
      ['seven fraction digits', cursorOf(['2026-10-09T00:25:39.1234567Z', ID])],
      ['a month that does not exist', cursorOf(['2026-13-01T00:00:00Z', ID])],
      ['February 30', cursorOf(['2026-02-30T00:00:00Z', ID])],
      ['hour 24', cursorOf(['2026-10-09T24:00:00Z', ID])],
      ['second 60', cursorOf(['2026-10-09T23:59:60Z', ID])],
      ['an offset past 15 hours', cursorOf(['2026-10-09T00:00:00+16:00', ID])],
      ['filter syntax in the time', cursorOf([`${AT}),id.gt.0`, ID])],
      ['filter syntax in the id', cursorOf([AT, `${ID}),user_id.neq.x`])],
      ['a short id', cursorOf([AT, '11111111'])],
      ['too long', 'A'.repeat(161)],
    ];
    for (const [why, value] of refused) {
      expect(decodeTasksCursor(value), why).toBeNull();
    }
  });

  it('filters to rows strictly after it, newest first, with the id breaking a tie', () => {
    expect(afterCursorFilter({ createdAt: AT, id: ID })).toBe(
      `created_at.lt."${AT}",and(created_at.eq."${AT}",id.lt.${ID})`
    );
  });
});

describe('reading limit and before', () => {
  it('leaves a request with neither unpaged', () => {
    expect(parseTasksPage({})).toEqual({ ok: true, page: { paged: false } });
  });

  it('pages with either one, at the cap when limit is absent', () => {
    expect(parseTasksPage({ limit: '25' })).toEqual({
      ok: true,
      page: { paged: true, limit: 25, before: null },
    });
    expect(parseTasksPage({ before: encodeTasksCursor({ createdAt: AT, id: ID }) })).toEqual({
      ok: true,
      page: { paged: true, limit: TASKS_PAGE_MAX, before: { createdAt: AT, id: ID } },
    });
  });

  it('takes limit from 1 to the cap', () => {
    for (const limit of ['1', '999', String(TASKS_PAGE_MAX)]) {
      expect(parseTasksPage({ limit }), limit).toMatchObject({ ok: true });
    }
  });

  it('refuses a limit that is not a whole number in range, or given twice', () => {
    for (const limit of ['0', '-1', '1001', '10000', '1.5', '01', ' 5', 'ten', '', ['5', '6']]) {
      expect(parseTasksPage({ limit }), JSON.stringify(limit)).toEqual({
        ok: false,
        error: `limit must be a whole number from 1 to ${TASKS_PAGE_MAX}`,
      });
    }
  });

  it('refuses a before it cannot read, rather than serving the first page', () => {
    for (const before of ['', 'garbage', ['a', 'b'], { c: AT }]) {
      expect(parseTasksPage({ before }), JSON.stringify(before)).toEqual({
        ok: false,
        error: 'before must be a nextBefore value from this route',
      });
    }
  });
});
