/**
 * Claiming uploads for a send, over FakePostgrest with the claim table's two
 * keys declared. Two PostgreSQL behaviours are proved against a disposable
 * cluster instead (probe-uploads-migration.cjs): the foreign key's 23503 on a
 * gate that is not open, and the claim set landing whole or not at all. The
 * fake inserts row by row, so the tests that collide put the colliding row
 * first, where PostgreSQL's all-or-nothing outcome and the fake's agree.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakePostgrest } from '../../test/fake-postgrest';

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { claimUploadsForSend, confirmUploadsForSend, sendKeyHasClaims } from './send';
import { contentDigest, manifestDigest, type ClaimAttempt } from './claims';

const ADA = '0a0a0a0a-0000-4000-8000-0000000000aa';
const SAM = '0b0b0b0b-0000-4000-8000-0000000000bb';
const WS = '1c1c1c1c-0000-4000-8000-0000000000cc';
const THREAD = '2e2e2e2e-0000-4000-8000-0000000000ee';
const OTHER_THREAD = '2f2f2f2f-0000-4000-8000-0000000000ef';
const U1 = '5a5a5a5a-0000-4000-8000-000000000001';
const U2 = '5a5a5a5a-0000-4000-8000-000000000002';
const RECEIVING = '5a5a5a5a-0000-4000-8000-000000000003';
const SAMS = '5a5a5a5a-0000-4000-8000-000000000004';
const ELSEWHERE = '5a5a5a5a-0000-4000-8000-000000000005';
const SEND = '6b6b6b6b-0000-4000-8000-000000000001';
const OTHER_SEND = '6b6b6b6b-0000-4000-8000-000000000002';
const MESSAGE = '7c7c7c7c-0000-4000-8000-000000000001';
const AT = '2026-10-07T10:00:00.000Z';

let db: FakePostgrest;

beforeEach(() => {
  db = new FakePostgrest();
  db.unique.thread_upload_claims = [
    { name: 'thread_upload_claims_pkey', key: (r) => String(r.upload_id) },
    {
      name: 'thread_upload_claims_send_key',
      key: (r) => `${r.thread_id}|${r.client_message_id}|${r.manifest_index}`,
    },
  ];
  const upload = (id: string, over: Record<string, unknown> = {}) =>
    db.seed('thread_uploads', {
      id,
      user_id: ADA,
      workspace_id: WS,
      thread_id: THREAD,
      state: 'live',
      claim_gate: 'open',
      pending_slot: 3,
      // Written by the API a minute before the send.
      created_at: '2026-10-07T09:59:00.000Z',
      ...over,
    });
  upload(U1);
  upload(U2, { pending_slot: 4 });
  upload(RECEIVING, { claim_gate: 'receiving' });
  upload(SAMS, { user_id: SAM });
  upload(ELSEWHERE, { thread_id: OTHER_THREAD });
});

const attempt = (over: Partial<ClaimAttempt> = {}): ClaimAttempt & { workspaceId: string } => ({
  threadId: THREAD,
  clientMessageId: SEND,
  userId: ADA,
  content: 'The receipts',
  uploadIds: [U1, U2],
  createdAt: AT,
  workspaceId: WS,
  ...over,
});
const claims = () => db.rows('thread_upload_claims');
const pending = (id: string) => db.rows('thread_uploads').find((r) => r.id === id)!.pending_slot;

describe('claimUploadsForSend', () => {
  it('claims the whole set, stamped by the API, and releases the pending slots', async () => {
    expect(await claimUploadsForSend(db as never, attempt())).toEqual({ ok: true });
    expect(claims().map((r) => [r.upload_id, r.manifest_index])).toEqual([
      [U1, 0],
      [U2, 1],
    ]);
    expect(claims()[0]).toMatchObject({
      thread_id: THREAD,
      client_message_id: SEND,
      user_id: ADA,
      content_sha256: contentDigest('The receipts'),
      manifest_sha256: manifestDigest([U1, U2]),
      created_at: AT,
    });
    expect([pending(U1), pending(U2)]).toEqual([null, null]);
  });

  it('takes a retry of the same send as the same send, without a second set', async () => {
    await claimUploadsForSend(db as never, attempt());
    const retry = attempt({ createdAt: '2026-10-07T10:00:30.000Z' });
    expect(await claimUploadsForSend(db as never, retry)).toEqual({ ok: true });
    expect(claims()).toHaveLength(2);
  });

  it('refuses an upload another send holds, and claims nothing', async () => {
    await claimUploadsForSend(db as never, attempt({ uploadIds: [U1] }));
    expect(
      await claimUploadsForSend(
        db as never,
        attempt({ clientMessageId: OTHER_SEND, uploadIds: [U1] })
      )
    ).toEqual({ ok: false, reason: 'unavailable' });
    expect(claims().filter((r) => r.client_message_id === OTHER_SEND)).toEqual([]);
  });

  it('refuses the same client message id with other words or another set, as a conflict', async () => {
    await claimUploadsForSend(db as never, attempt({ uploadIds: [U1] }));
    expect(
      await claimUploadsForSend(db as never, attempt({ uploadIds: [U1], content: 'Edited' }))
    ).toEqual({ ok: false, reason: 'conflict' });
    // A disjoint set under the same id collides on the send key at index 0.
    expect(await claimUploadsForSend(db as never, attempt({ uploadIds: [U2] }))).toEqual({
      ok: false,
      reason: 'conflict',
    });
    expect(claims().map((r) => r.upload_id)).toEqual([U1]);
  });

  it('refuses before claiming anything an upload that is unfinished, not theirs or from another thread', async () => {
    for (const other of [RECEIVING, SAMS, ELSEWHERE, '5a5a5a5a-0000-4000-8000-0000000000ff']) {
      expect(
        await claimUploadsForSend(db as never, attempt({ uploadIds: [U1, other].sort() }))
      ).toEqual({ ok: false, reason: 'unavailable' });
    }
    expect(claims()).toEqual([]);
    expect(pending(U1)).toBe(3);
  });

  it('reads a foreign-key refusal as unavailable, and throws on any other failure', async () => {
    const refusing = (code: string) => {
      const from = db.from.bind(db);
      return {
        from: (table: string) =>
          table === 'thread_upload_claims'
            ? { insert: async () => ({ error: { code, message: 'refused' } }) }
            : from(table),
      };
    };
    expect(await claimUploadsForSend(refusing('23503') as never, attempt())).toEqual({
      ok: false,
      reason: 'unavailable',
    });
    await expect(claimUploadsForSend(refusing('57014') as never, attempt())).rejects.toThrow(
      /Failed to claim uploads/
    );
  });
});

describe('claimUploadsForSend: what may be claimed at all', () => {
  const row = (id: string) => db.rows('thread_uploads').find((r) => r.id === id)!;

  it('refuses an upload no send claimed within its pending hour, on the API clock', async () => {
    row(U1).created_at = '2026-10-07T09:00:00.000Z';
    expect(await claimUploadsForSend(db as never, attempt({ uploadIds: [U1] }))).toEqual({
      ok: false,
      reason: 'unavailable',
    });
    expect(claims()).toEqual([]);
    row(U1).created_at = '2026-10-07T09:00:00.001Z';
    expect(await claimUploadsForSend(db as never, attempt({ uploadIds: [U1] }))).toEqual({
      ok: true,
    });
  });

  it('still lets the send that already holds it retry after the hour', async () => {
    await claimUploadsForSend(db as never, attempt({ uploadIds: [U1] }));
    const later = attempt({ uploadIds: [U1], createdAt: '2026-10-07T12:00:00.000Z' });
    expect(await claimUploadsForSend(db as never, later)).toEqual({ ok: true });
    // Another send cannot use the age to take it.
    expect(
      await claimUploadsForSend(db as never, { ...later, clientMessageId: OTHER_SEND })
    ).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('refuses damaged bytes, first try and retry alike', async () => {
    await claimUploadsForSend(db as never, attempt({ uploadIds: [U1] }));
    row(U1).damaged_at = '2026-10-07T09:59:30.000Z';
    expect(await claimUploadsForSend(db as never, attempt({ uploadIds: [U1] }))).toEqual({
      ok: false,
      reason: 'unavailable',
    });
    row(U2).damaged_at = '2026-10-07T09:59:30.000Z';
    expect(await claimUploadsForSend(db as never, attempt({ uploadIds: [U2] }))).toEqual({
      ok: false,
      reason: 'unavailable',
    });
    expect(claims().map((c) => c.upload_id)).toEqual([U1]);
  });

  it('reads an unreadable time as past the hour', async () => {
    row(U1).created_at = 'soon';
    expect(await claimUploadsForSend(db as never, attempt({ uploadIds: [U1] }))).toEqual({
      ok: false,
      reason: 'unavailable',
    });
  });
});

describe('sendKeyHasClaims', () => {
  it('is true only for a send key carrying claims', async () => {
    expect(await sendKeyHasClaims(db as never, THREAD, SEND)).toBe(false);
    await claimUploadsForSend(db as never, attempt({ uploadIds: [U1] }));
    expect(await sendKeyHasClaims(db as never, THREAD, SEND)).toBe(true);
    expect(await sendKeyHasClaims(db as never, THREAD, OTHER_SEND)).toBe(false);
  });
});

describe('confirmUploadsForSend', () => {
  it('records the message on this send’s claims and clears a hold, touching nothing else', async () => {
    await claimUploadsForSend(db as never, attempt({ uploadIds: [U1] }));
    await claimUploadsForSend(
      db as never,
      attempt({ clientMessageId: OTHER_SEND, uploadIds: [U2] })
    );
    claims()[0].held_reason = 'not_found';
    claims()[0].held_at = AT;
    await confirmUploadsForSend(db as never, {
      threadId: THREAD,
      clientMessageId: SEND,
      uploadIds: [U1, U2],
      messageId: MESSAGE,
    });
    expect(claims()[0]).toMatchObject({ message_id: MESSAGE, held_reason: null, held_at: null });
    expect(claims()[1].message_id).toBeUndefined();
  });

  it('never overwrites a message already recorded', async () => {
    await claimUploadsForSend(db as never, attempt({ uploadIds: [U1] }));
    claims()[0].message_id = MESSAGE;
    await confirmUploadsForSend(db as never, {
      threadId: THREAD,
      clientMessageId: SEND,
      uploadIds: [U1],
      messageId: '7c7c7c7c-0000-4000-8000-000000000002',
    });
    expect(claims()[0].message_id).toBe(MESSAGE);
  });
});
