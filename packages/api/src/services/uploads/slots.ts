/**
 * Upload quotas as slots (upload design r4 §4).
 *
 * Each live upload row holds three numbered slots, each under a partial
 * unique index over live rows: one of 50 per account, one of 20 pending per
 * account (released once claimed), and one of 1024 overall. The row, and so
 * its slots, is inserted before a single byte is written, so staging is
 * inside the budget too. Two uploads racing for one slot cannot both win:
 * the index decides, with no count-then-insert and no counter to drift.
 * At the 10 MiB cap that bounds an account at 500 MiB and the server at
 * 10 GiB. Deleting or expiring a row frees its slots.
 */

export const ACCOUNT_SLOTS = 50;
export const PENDING_SLOTS = 20;
export const GLOBAL_SLOTS = 1024;

/** Attempts at a free set of slots before the route gives up as contended. */
export const SLOT_ATTEMPTS = 5;

export type SlotKind = 'account' | 'pending' | 'global';

export interface Slots {
  account: number;
  pending: number;
  global: number;
}

export interface UsedSlots {
  account: Iterable<number>;
  pending: Iterable<number>;
  global: Iterable<number>;
}

/** Index names, as Postgres reports them in a 23505. */
export const SLOT_INDEXES: Record<SlotKind, string> = {
  account: 'thread_uploads_account_slot_key',
  pending: 'thread_uploads_pending_slot_key',
  global: 'thread_uploads_global_slot_key',
};

/** The free slot numbers in [0, capacity), ascending. */
export function freeSlots(used: Iterable<number>, capacity: number): number[] {
  const taken = new Set(used);
  const free: number[] = [];
  for (let slot = 0; slot < capacity; slot++) if (!taken.has(slot)) free.push(slot);
  return free;
}

/**
 * Pick a full set, or name the kind that is full. Account and pending slots
 * take the lowest free number; the global slot takes a random free one, so
 * accounts uploading at once rarely collide on it.
 */
export function pickSlots(
  used: UsedSlots,
  random: () => number = Math.random
): { ok: true; slots: Slots } | { ok: false; full: SlotKind } {
  const account = freeSlots(used.account, ACCOUNT_SLOTS);
  if (account.length === 0) return { ok: false, full: 'account' };
  const pending = freeSlots(used.pending, PENDING_SLOTS);
  if (pending.length === 0) return { ok: false, full: 'pending' };
  const global = freeSlots(used.global, GLOBAL_SLOTS);
  if (global.length === 0) return { ok: false, full: 'global' };
  const pick = Math.min(global.length - 1, Math.floor(random() * global.length));
  return { ok: true, slots: { account: account[0], pending: pending[0], global: global[pick] } };
}

/** Which slot index a unique violation names, or null for any other error. */
export function slotConflictOf(
  error: { code?: string; message?: string; details?: string } | null
): SlotKind | null {
  if (error?.code !== '23505') return null;
  const text = `${error.message ?? ''} ${error.details ?? ''}`;
  for (const kind of ['account', 'pending', 'global'] as const) {
    if (text.includes(SLOT_INDEXES[kind])) return kind;
  }
  return null;
}

export type SlotInsertResult<T> =
  | { ok: true; slots: Slots; row: T }
  | { ok: false; reason: 'full'; full: SlotKind }
  | { ok: false; reason: 'contended' };

/**
 * Read the slots in use, pick a set, try the insert; on a slot conflict,
 * read again and retry, up to SLOT_ATTEMPTS. Any other error is the caller's.
 * `full` answers 429 (account, pending) or 507 (global); `contended`, 503.
 */
export async function insertWithSlots<T>(
  readUsed: () => Promise<UsedSlots>,
  tryInsert: (slots: Slots) => Promise<{ ok: true; row: T } | { ok: false; conflict: SlotKind }>,
  random: () => number = Math.random
): Promise<SlotInsertResult<T>> {
  for (let attempt = 0; attempt < SLOT_ATTEMPTS; attempt++) {
    const picked = pickSlots(await readUsed(), random);
    if (!picked.ok) return { ok: false, reason: 'full', full: picked.full };
    const inserted = await tryInsert(picked.slots);
    if (inserted.ok) return { ok: true, slots: picked.slots, row: inserted.row };
  }
  return { ok: false, reason: 'contended' };
}
