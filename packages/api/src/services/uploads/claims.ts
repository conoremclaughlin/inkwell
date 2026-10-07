/**
 * The claim set: how a send takes its uploads (upload design r4 §2–3).
 *
 * One send is (thread, clientMessageId). Its claim set is one row per
 * upload, numbered by position in the sorted manifest, and every row carries
 * the same immutable author, content digest and manifest digest. The row at
 * index 0 is unique per send (`UNIQUE (thread_id, client_message_id,
 * manifest_index)`), so the set is the send's attempt record: a second
 * admission that differs in anything collides in the same statement that
 * would have claimed, and claims nothing. A claim row is never deleted or
 * moved back; it only gains `message_id` (confirmed) or a held reason.
 *
 * Everything here is pure. The route and the reconciler do the reads and
 * writes; these decide what the rows mean.
 */

import { createHash } from 'crypto';
import { isCanonicalId } from './layout.js';

export const MAX_UPLOADS_PER_MESSAGE = 4;

/** A claim this young is left alone: its send may still be committing. */
export const RECONCILE_MIN_AGE_MS = 5 * 60 * 1000;

export type ManifestRefusal = 'not-a-list' | 'empty' | 'too-many' | 'not-an-id' | 'duplicate';

export type Manifest = { ok: true; ids: string[] } | { ok: false; reason: ManifestRefusal };

/** The request's `uploads`, as a sorted list of 1–4 distinct canonical ids. */
export function canonicalManifest(raw: unknown): Manifest {
  if (!Array.isArray(raw)) return { ok: false, reason: 'not-a-list' };
  if (raw.length === 0) return { ok: false, reason: 'empty' };
  if (raw.length > MAX_UPLOADS_PER_MESSAGE) return { ok: false, reason: 'too-many' };
  if (!raw.every(isCanonicalId)) return { ok: false, reason: 'not-an-id' };
  const ids = [...raw].sort();
  if (ids.some((id, i) => i > 0 && id === ids[i - 1])) return { ok: false, reason: 'duplicate' };
  return { ok: true, ids };
}

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** Digest of a sorted manifest; ids are fixed-width, so the separator cannot be forged. */
export function manifestDigest(sortedIds: readonly string[]): string {
  return sha256(sortedIds.join('\n'));
}

export function contentDigest(content: string): string {
  return sha256(content);
}

export interface ClaimAttempt {
  threadId: string;
  clientMessageId: string;
  userId: string;
  content: string;
  /** From canonicalManifest: sorted, distinct. */
  uploadIds: readonly string[];
  /**
   * When the API made this attempt, from the API's own clock (ISO 8601).
   * Never the database's: its container clock stops while the host sleeps,
   * and every age this module and authorize.ts compute is against the API's
   * clock. A retry has a later time and is still the same send.
   */
  createdAt: string;
}

/** A row as inserted. `claim_gate` is the FK's half of the fence and is always 'open'. */
export interface ClaimInsertRow {
  upload_id: string;
  claim_gate: 'open';
  thread_id: string;
  client_message_id: string;
  user_id: string;
  content_sha256: string;
  manifest_sha256: string;
  manifest_index: number;
  created_at: string;
}

/** The whole set, for one bulk insert: one PostgREST request is one statement. */
export function claimRowsFor(attempt: ClaimAttempt): ClaimInsertRow[] {
  const content_sha256 = contentDigest(attempt.content);
  const manifest_sha256 = manifestDigest(attempt.uploadIds);
  return attempt.uploadIds.map((upload_id, manifest_index) => ({
    upload_id,
    claim_gate: 'open',
    thread_id: attempt.threadId,
    client_message_id: attempt.clientMessageId,
    user_id: attempt.userId,
    content_sha256,
    manifest_sha256,
    manifest_index,
    created_at: attempt.createdAt,
  }));
}

export interface StoredClaim extends Omit<ClaimInsertRow, 'claim_gate'> {
  message_id: string | null;
  held_reason: 'not_found' | 'mismatch' | null;
}

/**
 * The claim insert refused. `taken`: a unique key (this send's key, or an
 * upload another send holds); the route reads this send's rows and asks
 * `isSameSend`. `not-claimable`: the FK found no open gate, because the upload
 * is still receiving, was swept, or is gone.
 */
export function classifyClaimError(
  error: { code?: string } | null
): 'taken' | 'not-claimable' | null {
  if (error?.code === '23505') return 'taken';
  if (error?.code === '23503') return 'not-claimable';
  return null;
}

/**
 * After a `taken` refusal: are the rows stored under this send key exactly
 * this attempt, so it is a retry or a racing copy of the same send that can go
 * on to the insert? Anything else, including no rows (the upload is held by
 * a different send), is a 409.
 */
export function isSameSend(existing: readonly StoredClaim[], attempt: ClaimAttempt): boolean {
  const expected = claimRowsFor(attempt);
  if (existing.length !== expected.length) return false;
  const byIndex = [...existing].sort((a, b) => a.manifest_index - b.manifest_index);
  return expected.every((want, i) => {
    const got = byIndex[i];
    return (
      got.manifest_index === want.manifest_index &&
      got.upload_id === want.upload_id &&
      got.thread_id === want.thread_id &&
      got.client_message_id === want.client_message_id &&
      got.user_id === want.user_id &&
      got.content_sha256 === want.content_sha256 &&
      got.manifest_sha256 === want.manifest_sha256
    );
  });
}

/** The columns of inbox_thread_messages this module reads. */
export interface StoredThreadMessage {
  id: string;
  thread_id: string;
  sender_kind: string;
  sender_user_id: string | null;
  content: string;
  metadata: unknown;
}

/**
 * The upload ids a stored message names, sorted, or null when its media list
 * is malformed. Entries without an `upload` key are other media and do not
 * count; an `upload` that is not a canonical id makes the whole list null.
 */
export function mediaUploadIds(metadata: unknown): string[] | null {
  const media = (metadata as { media?: unknown } | null)?.media;
  if (media === undefined || media === null) return [];
  if (!Array.isArray(media)) return null;
  const ids: string[] = [];
  for (const entry of media) {
    if (!entry || typeof entry !== 'object' || !('upload' in entry)) continue;
    const id = (entry as { upload: unknown }).upload;
    if (!isCanonicalId(id)) return null;
    ids.push(id);
  }
  return ids.sort();
}

/**
 * Is this the committed message the claim was made for? Same thread and
 * clientMessageId, sent by the claim's person (never an SB or anyone else),
 * with the same words and exactly the claimed manifest. This, not the
 * confirm state, is what authorizes reads and resolves.
 */
export function messageMatchesClaim(message: StoredThreadMessage, claim: StoredClaim): boolean {
  const meta = message.metadata as { clientMessageId?: unknown } | null;
  if (message.thread_id !== claim.thread_id) return false;
  if (meta?.clientMessageId !== claim.client_message_id) return false;
  if (message.sender_kind !== 'user' || message.sender_user_id !== claim.user_id) return false;
  if (contentDigest(message.content) !== claim.content_sha256) return false;
  const ids = mediaUploadIds(message.metadata);
  return (
    ids !== null && ids.includes(claim.upload_id) && manifestDigest(ids) === claim.manifest_sha256
  );
}

/** What the reconciler's lookup of (thread, clientMessageId) returned. */
export type ReconcileLookup =
  | { kind: 'error' }
  | { kind: 'none' }
  | { kind: 'found'; message: StoredThreadMessage };

export type ReconcileOutcome =
  | { action: 'skip'; why: 'confirmed' | 'too-recent' | 'read-failed' }
  | { action: 'confirm'; messageId: string }
  | { action: 'hold'; reason: 'not_found' | 'mismatch' };

/**
 * One claim with no confirmed message. Nothing here ever deletes: a claim
 * either confirms or is held, keeping its bytes, until expiry, account
 * deletion or manual recovery. A failed read is never taken for "not found".
 */
export function reconcileClaim(
  claim: StoredClaim,
  lookup: ReconcileLookup,
  now: number,
  minAgeMs = RECONCILE_MIN_AGE_MS
): ReconcileOutcome {
  if (claim.message_id) return { action: 'skip', why: 'confirmed' };
  const created = Date.parse(claim.created_at);
  // An unreadable time is treated as too recent: nothing is decided on it.
  if (!Number.isFinite(created) || now - created < minAgeMs) {
    return { action: 'skip', why: 'too-recent' };
  }
  switch (lookup.kind) {
    case 'error':
      return { action: 'skip', why: 'read-failed' };
    case 'none':
      return { action: 'hold', reason: 'not_found' };
    case 'found':
      return messageMatchesClaim(lookup.message, claim)
        ? { action: 'confirm', messageId: lookup.message.id }
        : { action: 'hold', reason: 'mismatch' };
  }
}
