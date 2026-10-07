import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_SLOTS,
  freeSlots,
  GLOBAL_SLOTS,
  insertWithSlots,
  PENDING_SLOTS,
  pickSlots,
  SLOT_ATTEMPTS,
  slotConflictOf,
  type Slots,
  type UsedSlots,
} from './slots.js';

const range = (n: number) => Array.from({ length: n }, (_, i) => i);
const none: UsedSlots = { account: [], pending: [], global: [] };

describe('freeSlots and pickSlots', () => {
  it('lists the free numbers in range, ascending', () => {
    expect(freeSlots([0, 2, 99], 4)).toEqual([1, 3]);
  });

  it('takes the lowest account and pending slots and a random free global one', () => {
    const used = { account: [0, 1], pending: [0], global: [0, 1, 2] };
    expect(pickSlots(used, () => 0)).toEqual({
      ok: true,
      slots: { account: 2, pending: 1, global: 3 },
    });
    expect(pickSlots(used, () => 0.999999)).toEqual({
      ok: true,
      slots: { account: 2, pending: 1, global: GLOBAL_SLOTS - 1 },
    });
    // A random source that returns exactly 1 still lands in range.
    expect(pickSlots(none, () => 1)).toMatchObject({
      ok: true,
      slots: { global: GLOBAL_SLOTS - 1 },
    });
  });

  it('names the kind that is full', () => {
    expect(pickSlots({ ...none, account: range(ACCOUNT_SLOTS) })).toEqual({
      ok: false,
      full: 'account',
    });
    expect(pickSlots({ ...none, pending: range(PENDING_SLOTS) })).toEqual({
      ok: false,
      full: 'pending',
    });
    expect(pickSlots({ ...none, global: range(GLOBAL_SLOTS) })).toEqual({
      ok: false,
      full: 'global',
    });
  });
});

describe('slotConflictOf', () => {
  it('names the slot index in a unique violation, and nothing else', () => {
    const dup = (index: string) => ({
      code: '23505',
      message: `duplicate key value violates unique constraint "${index}"`,
    });
    expect(slotConflictOf(dup('thread_uploads_account_slot_key'))).toBe('account');
    expect(slotConflictOf(dup('thread_uploads_pending_slot_key'))).toBe('pending');
    expect(
      slotConflictOf({ code: '23505', message: 'x', details: 'thread_uploads_global_slot_key' })
    ).toBe('global');
    expect(slotConflictOf(dup('thread_uploads_pkey'))).toBeNull();
    expect(
      slotConflictOf({ code: '23503', message: 'thread_uploads_account_slot_key' })
    ).toBeNull();
    expect(slotConflictOf(null)).toBeNull();
  });
});

describe('insertWithSlots', () => {
  it('rereads and retries after a slot conflict, then succeeds', async () => {
    const used: UsedSlots[] = [none, { ...none, account: [0] }];
    const tried: Slots[] = [];
    const result = await insertWithSlots(
      async () => used.shift() ?? none,
      async (slots) => {
        tried.push(slots);
        return tried.length === 1 ? { ok: false, conflict: 'account' } : { ok: true, row: 'row' };
      },
      () => 0
    );
    expect(result).toEqual({ ok: true, slots: { account: 1, pending: 0, global: 0 }, row: 'row' });
    expect(tried).toHaveLength(2);
  });

  it('answers full without inserting when a kind has no free slot', async () => {
    let inserts = 0;
    const result = await insertWithSlots(
      async () => ({ ...none, pending: range(PENDING_SLOTS) }),
      async () => {
        inserts++;
        return { ok: true, row: 1 };
      }
    );
    expect(result).toEqual({ ok: false, reason: 'full', full: 'pending' });
    expect(inserts).toBe(0);
  });

  it('gives up as contended after the last attempt', async () => {
    let inserts = 0;
    const result = await insertWithSlots(
      async () => none,
      async () => {
        inserts++;
        return { ok: false, conflict: 'global' };
      }
    );
    expect(result).toEqual({ ok: false, reason: 'contended' });
    expect(inserts).toBe(SLOT_ATTEMPTS);
  });
});
