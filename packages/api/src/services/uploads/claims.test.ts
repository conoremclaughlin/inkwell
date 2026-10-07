import { describe, expect, it } from 'vitest';
import {
  canonicalManifest,
  claimRowsFor,
  classifyClaimError,
  contentDigest,
  isSameSend,
  manifestDigest,
  mediaUploadIds,
  messageMatchesClaim,
  reconcileClaim,
  RECONCILE_MIN_AGE_MS,
  type ClaimAttempt,
  type StoredClaim,
  type StoredThreadMessage,
} from './claims.js';

const A = '0a0a0a0a-0000-4000-8000-00000000000a';
const B = '0b0b0b0b-0000-4000-8000-00000000000b';
const C = '0c0c0c0c-0000-4000-8000-00000000000c';
const D = '0d0d0d0d-0000-4000-8000-00000000000d';
const E = '0e0e0e0e-0000-4000-8000-00000000000e';
const THREAD = '1a1a1a1a-0000-4000-8000-000000000001';
const SEND = '2b2b2b2b-0000-4000-8000-000000000002';
const ADA = '3c3c3c3c-0000-4000-8000-000000000003';
const SAM = '4d4d4d4d-0000-4000-8000-000000000004';
const MESSAGE = '5e5e5e5e-0000-4000-8000-000000000005';

const attempt: ClaimAttempt = {
  threadId: THREAD,
  clientMessageId: SEND,
  userId: ADA,
  content: 'Here are the receipts',
  uploadIds: [A, B],
  createdAt: '2026-10-07T09:00:00.000Z',
};

const stored = (a: ClaimAttempt = attempt, extra: Partial<StoredClaim> = {}): StoredClaim[] =>
  claimRowsFor(a).map(({ claim_gate: _gate, ...row }) => ({
    ...row,
    message_id: null,
    held_reason: null,
    created_at: '2026-10-07T09:00:00.000Z',
    ...extra,
  }));

const message = (over: Partial<StoredThreadMessage> = {}): StoredThreadMessage => ({
  id: MESSAGE,
  thread_id: THREAD,
  sender_kind: 'user',
  sender_user_id: ADA,
  content: attempt.content,
  metadata: { clientMessageId: SEND, media: [{ upload: B }, { upload: A }] },
  ...over,
});

describe('canonicalManifest', () => {
  it('sorts 1–4 distinct canonical ids', () => {
    expect(canonicalManifest([B, A])).toEqual({ ok: true, ids: [A, B] });
    expect(canonicalManifest([D, C, B, A])).toEqual({ ok: true, ids: [A, B, C, D] });
  });

  it('refuses anything else, and names why', () => {
    expect(canonicalManifest('a')).toEqual({ ok: false, reason: 'not-a-list' });
    expect(canonicalManifest([])).toEqual({ ok: false, reason: 'empty' });
    expect(canonicalManifest([A, B, C, D, E])).toEqual({ ok: false, reason: 'too-many' });
    expect(canonicalManifest([A, A.toUpperCase()])).toEqual({ ok: false, reason: 'not-an-id' });
    expect(canonicalManifest([A, 7])).toEqual({ ok: false, reason: 'not-an-id' });
    expect(canonicalManifest([A, B, A])).toEqual({ ok: false, reason: 'duplicate' });
  });
});

describe('claimRowsFor', () => {
  it('numbers the rows by manifest position and repeats the digests on every row', () => {
    const rows = claimRowsFor(attempt);
    expect(rows.map((r) => [r.upload_id, r.manifest_index])).toEqual([
      [A, 0],
      [B, 1],
    ]);
    for (const row of rows) {
      expect(row).toMatchObject({
        claim_gate: 'open',
        thread_id: THREAD,
        client_message_id: SEND,
        user_id: ADA,
        content_sha256: contentDigest(attempt.content),
        manifest_sha256: manifestDigest([A, B]),
        created_at: attempt.createdAt,
      });
    }
  });

  it('gives different manifests different digests, whatever the order they came in', () => {
    expect(manifestDigest([A, B])).not.toBe(manifestDigest([A, C]));
    expect(manifestDigest([A])).not.toBe(manifestDigest([A, B]));
    const reordered = canonicalManifest([B, A]);
    expect(reordered.ok && manifestDigest(reordered.ids)).toBe(manifestDigest([A, B]));
  });
});

describe('classifyClaimError', () => {
  it('reads a unique violation as taken and a foreign-key violation as not claimable', () => {
    expect(classifyClaimError({ code: '23505' })).toBe('taken');
    expect(classifyClaimError({ code: '23503' })).toBe('not-claimable');
    expect(classifyClaimError({ code: '57014' })).toBeNull();
    expect(classifyClaimError(null)).toBeNull();
  });
});

describe('isSameSend', () => {
  it('is true only for exactly this send', () => {
    expect(isSameSend(stored(), attempt)).toBe(true);
    expect(isSameSend(stored().reverse(), attempt)).toBe(true);
  });

  it('is true for a retry made later, which is still the same send', () => {
    expect(isSameSend(stored(), { ...attempt, createdAt: '2026-10-07T09:04:59.000Z' })).toBe(true);
  });

  it('is false for a different author, words, manifest, thread or a missing row', () => {
    expect(isSameSend(stored({ ...attempt, userId: SAM }), attempt)).toBe(false);
    expect(isSameSend(stored({ ...attempt, content: 'Other words' }), attempt)).toBe(false);
    expect(isSameSend(stored({ ...attempt, uploadIds: [A, C] }), attempt)).toBe(false);
    expect(isSameSend(stored({ ...attempt, uploadIds: [A] }), attempt)).toBe(false);
    expect(isSameSend(stored({ ...attempt, threadId: MESSAGE }), attempt)).toBe(false);
    expect(isSameSend(stored().slice(0, 1), attempt)).toBe(false);
    // No rows under this send key: the upload is held by a different send.
    expect(isSameSend([], attempt)).toBe(false);
  });

  it('is false when one row of an otherwise identical set has been altered', () => {
    const rows = stored();
    rows[1] = { ...rows[1], manifest_sha256: manifestDigest([A, C]) };
    expect(isSameSend(rows, attempt)).toBe(false);
  });
});

describe('mediaUploadIds', () => {
  it('returns the sorted upload ids and ignores other media', () => {
    expect(mediaUploadIds({ media: [{ upload: B }, { path: '/x.png' }, { upload: A }] })).toEqual([
      A,
      B,
    ]);
    expect(mediaUploadIds({})).toEqual([]);
    expect(mediaUploadIds(null)).toEqual([]);
  });

  it('is null for a malformed list or a malformed upload id', () => {
    expect(mediaUploadIds({ media: 'x' })).toBeNull();
    expect(mediaUploadIds({ media: [{ upload: '../x' }] })).toBeNull();
  });
});

describe('messageMatchesClaim', () => {
  const [claimA] = stored();

  it('matches the claim person’s message with the same words and exactly the manifest', () => {
    expect(messageMatchesClaim(message(), claimA)).toBe(true);
  });

  it('never matches another sender, kind, thread, client id, words or manifest', () => {
    expect(messageMatchesClaim(message({ sender_user_id: SAM }), claimA)).toBe(false);
    expect(messageMatchesClaim(message({ sender_kind: 'sb', sender_user_id: null }), claimA)).toBe(
      false
    );
    // An SB's row is never the person's send, even one carrying their user id.
    expect(messageMatchesClaim(message({ sender_kind: 'sb' }), claimA)).toBe(false);
    expect(messageMatchesClaim(message({ thread_id: MESSAGE }), claimA)).toBe(false);
    expect(
      messageMatchesClaim(
        message({ metadata: { clientMessageId: MESSAGE, media: [{ upload: A }, { upload: B }] } }),
        claimA
      )
    ).toBe(false);
    expect(messageMatchesClaim(message({ content: 'Edited' }), claimA)).toBe(false);
    expect(
      messageMatchesClaim(
        message({ metadata: { clientMessageId: SEND, media: [{ upload: A }] } }),
        claimA
      )
    ).toBe(false);
    expect(
      messageMatchesClaim(
        message({
          metadata: { clientMessageId: SEND, media: [{ upload: A }, { upload: B }, { upload: C }] },
        }),
        claimA
      )
    ).toBe(false);
  });

  it('does not match a message that names the manifest but not this upload', () => {
    const other = { ...claimA, upload_id: C };
    expect(messageMatchesClaim(message(), other)).toBe(false);
  });
});

describe('reconcileClaim', () => {
  const [claimA] = stored();
  const old = Date.parse(claimA.created_at) + RECONCILE_MIN_AGE_MS;

  it('confirms a matching committed message', () => {
    expect(reconcileClaim(claimA, { kind: 'found', message: message() }, old)).toEqual({
      action: 'confirm',
      messageId: MESSAGE,
    });
  });

  it('holds, never deletes, when nothing was found or the message does not match', () => {
    expect(reconcileClaim(claimA, { kind: 'none' }, old)).toEqual({
      action: 'hold',
      reason: 'not_found',
    });
    expect(
      reconcileClaim(claimA, { kind: 'found', message: message({ content: 'Other' }) }, old)
    ).toEqual({ action: 'hold', reason: 'mismatch' });
  });

  it('confirms a held claim whose message committed late', () => {
    const held = { ...claimA, held_reason: 'not_found' as const };
    expect(reconcileClaim(held, { kind: 'found', message: message() }, old)).toEqual({
      action: 'confirm',
      messageId: MESSAGE,
    });
  });

  it('changes nothing on a failed read, a young claim, an unreadable time or a confirmed claim', () => {
    expect(reconcileClaim(claimA, { kind: 'error' }, old)).toEqual({
      action: 'skip',
      why: 'read-failed',
    });
    expect(reconcileClaim(claimA, { kind: 'none' }, old - 1)).toEqual({
      action: 'skip',
      why: 'too-recent',
    });
    expect(reconcileClaim({ ...claimA, created_at: 'soon' }, { kind: 'none' }, old)).toEqual({
      action: 'skip',
      why: 'too-recent',
    });
    expect(reconcileClaim({ ...claimA, message_id: MESSAGE }, { kind: 'none' }, old)).toEqual({
      action: 'skip',
      why: 'confirmed',
    });
  });
});
