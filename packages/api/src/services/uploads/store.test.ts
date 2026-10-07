/**
 * The upload tables' state changes, each one conditional update that names
 * the state it moves from. FakePostgrest has no foreign keys, so the claim
 * gate's 23503 is fed in through a stub here and proved against PostgreSQL
 * separately.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { FakePostgrest, type Row } from '../../test/fake-postgrest';
import {
  beginRemoval,
  closeGate,
  finishRemoval,
  isPersonParticipant,
  loadUpload,
  markDamaged,
  openGate,
  usedSlots,
} from './store';
import { pickSlots } from './slots';

const ADA = '0a0a0a0a-0000-4000-8000-0000000000aa';
const SAM = '0b0b0b0b-0000-4000-8000-0000000000bb';
const WS = '1c1c1c1c-0000-4000-8000-0000000000cc';
const OTHER_WS = '1d1d1d1d-0000-4000-8000-0000000000dd';
const THREAD = '2e2e2e2e-0000-4000-8000-0000000000ee';
const T1 = '2026-10-07T10:00:00.000Z';
const T2 = '2026-10-07T11:00:00.000Z';

let db: FakePostgrest;
let row: Row;

beforeEach(() => {
  db = new FakePostgrest();
  row = db.seed('thread_uploads', {
    id: '5a5a5a5a-0000-4000-8000-000000000001',
    user_id: ADA,
    workspace_id: WS,
    thread_id: THREAD,
    state: 'live',
    claim_gate: 'receiving',
    account_slot: 0,
    pending_slot: 0,
    global_slot: 0,
    damaged_at: null,
  });
});
const id = () => String(row.id);

describe('gate changes', () => {
  it('opens only a live receiving upload, and never reopens a closed one', async () => {
    expect(await openGate(db as never, id())).toBe(true);
    expect(row.claim_gate).toBe('open');
    expect(await openGate(db as never, id())).toBe(false);
    row.claim_gate = 'closed';
    expect(await openGate(db as never, id())).toBe(false);
    expect(row.claim_gate).toBe('closed');
    row.claim_gate = 'receiving';
    row.state = 'removing';
    expect(await openGate(db as never, id())).toBe(false);
  });

  it('closes only from the state named, and only a live row', async () => {
    expect(await closeGate(db as never, id(), 'open')).toBe(false);
    expect(row.claim_gate).toBe('receiving');
    row.state = 'removing';
    expect(await closeGate(db as never, id(), 'receiving')).toBe(false);
    row.state = 'live';
    expect(await closeGate(db as never, id(), 'receiving')).toBe(true);
    expect(row.claim_gate).toBe('closed');
  });

  it('reads a foreign-key refusal as the claim winning, and throws on anything else', async () => {
    const refusing = (code: string) => ({
      from: () => {
        const chain = {
          update: () => chain,
          eq: () => chain,
          select: async () => ({ data: null, error: { code, message: 'refused' } }),
        };
        return chain;
      },
    });
    expect(await closeGate(refusing('23503') as never, id(), 'open')).toBe(false);
    await expect(closeGate(refusing('57014') as never, id(), 'open')).rejects.toThrow(
      /Failed to close an upload/
    );
  });
});

describe('removal', () => {
  it('begins once, from live only, keeping its first reason and time', async () => {
    expect(await beginRemoval(db as never, id(), 'orphan', T1)).toBe(true);
    expect(await beginRemoval(db as never, id(), 'manual', T2)).toBe(false);
    expect(row).toMatchObject({ state: 'removing', end_reason: 'orphan', ended_at: T1 });
  });

  it('finishes only a removing row', async () => {
    expect(await finishRemoval(db as never, id(), T1)).toBe(false);
    expect(row.state).toBe('live');
    await beginRemoval(db as never, id(), 'orphan', T1);
    expect(await finishRemoval(db as never, id(), T2)).toBe(true);
    expect(row).toMatchObject({ state: 'removed', removed_at: T2 });
    expect(await finishRemoval(db as never, id(), T2)).toBe(false);
  });

  it('marks damage once and never moves its time', async () => {
    await markDamaged(db as never, id(), T1);
    await markDamaged(db as never, id(), T2);
    expect(row.damaged_at).toBe(T1);
  });
});

describe('reads', () => {
  it('counts slots held by live and removing rows, never removed ones', async () => {
    db.seed('thread_uploads', {
      user_id: ADA,
      state: 'removing',
      account_slot: 1,
      pending_slot: null,
      global_slot: 1,
    });
    db.seed('thread_uploads', {
      user_id: ADA,
      state: 'removed',
      account_slot: 2,
      pending_slot: 2,
      global_slot: 2,
    });
    db.seed('thread_uploads', {
      user_id: SAM,
      state: 'live',
      account_slot: 0,
      pending_slot: 0,
      global_slot: 3,
    });
    expect(await usedSlots(db as never, ADA)).toEqual({
      account: [0, 1],
      pending: [0],
      global: [0, 1, 3],
    });
  });

  it('reads every global slot past the row cap, so a full server reads as full', async () => {
    db.maxRows = 1000;
    db.rows('thread_uploads').length = 0;
    for (let slot = 0; slot < 1024; slot++) {
      db.seed('thread_uploads', {
        user_id: SAM,
        state: 'live',
        account_slot: 0,
        pending_slot: null,
        global_slot: slot,
      });
    }
    const used = await usedSlots(db as never, ADA);
    expect(new Set(used.global).size).toBe(1024);
    expect(pickSlots(used)).toEqual({ ok: false, full: 'global' });
  });

  it('finds an upload only in the caller’s workspace', async () => {
    expect(await loadUpload(db as never, id(), WS)).toMatchObject({ id: id() });
    expect(await loadUpload(db as never, id(), OTHER_WS)).toBeNull();
  });

  it('counts a person participant, never an SB row', async () => {
    db.seed('inbox_thread_participants', {
      thread_id: THREAD,
      workspace_id: WS,
      user_id: ADA,
      sb_id: null,
    });
    db.seed('inbox_thread_participants', {
      thread_id: THREAD,
      workspace_id: WS,
      user_id: SAM,
      sb_id: 'sb-fern',
    });
    const member = (userId: string, workspaceId = WS) =>
      isPersonParticipant(db as never, { threadId: THREAD, userId, workspaceId });
    expect(await member(ADA)).toBe(true);
    expect(await member(SAM)).toBe(false);
    expect(await member(ADA, OTHER_WS)).toBe(false);
  });
});
