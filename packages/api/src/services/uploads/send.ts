/**
 * How a person's reply takes its uploads (upload design r4 §2, r5).
 *
 * POST /threads/reply calls `claimUploadsForSend` after its replay check and
 * before `handleSendToInbox`, and `confirmUploadsForSend` once the message is
 * stored. The claim set is one insert, so it lands whole or not at all; the
 * database's keys decide every race (migration 20261007093000):
 *   - another send already holds one of these uploads, or this send's key
 *     already carries a different set: 23505, and only an identical set is
 *     taken as this same send retried;
 *   - an upload's gate is not open (still receiving, swept, or gone): 23503.
 * Nothing here ever deletes or reverts a claim.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '../../utils/logger';
import { PENDING_TTL_MS } from './authorize';
import {
  claimRowsFor,
  classifyClaimError,
  isSameSend,
  type ClaimAttempt,
  type StoredClaim,
} from './claims';

export type ClaimForSend =
  | { ok: true }
  /** An upload this person can no longer attach here: gone, not theirs, or not finished. */
  | { ok: false; reason: 'unavailable' }
  /** This client message id already carries a different send. */
  | { ok: false; reason: 'conflict' };

const CLAIM_COLUMNS =
  'upload_id, thread_id, client_message_id, user_id, content_sha256, manifest_sha256, manifest_index, message_id, held_reason, created_at';

/** The claims stored under one send key, (thread, clientMessageId). */
async function sendClaims(
  db: SupabaseClient,
  threadId: string,
  clientMessageId: string
): Promise<StoredClaim[]> {
  const { data, error } = await db
    .from('thread_upload_claims')
    .select(CLAIM_COLUMNS)
    .eq('thread_id', threadId)
    .eq('client_message_id', clientMessageId);
  if (error) throw new Error(`Failed to read a send's claims: ${error.message}`);
  return (data ?? []) as StoredClaim[];
}

/**
 * Does this send key already carry claimed uploads? A send naming no uploads
 * under such a key is a different send, and a 409, even when nothing was
 * stored: the key belongs to the send that claimed them.
 */
export async function sendKeyHasClaims(
  db: SupabaseClient,
  threadId: string,
  clientMessageId: string
): Promise<boolean> {
  return (await sendClaims(db, threadId, clientMessageId)).length > 0;
}

/**
 * Claim `attempt.uploadIds` for this send. The pre-check gives a clean answer
 * for the common cases; the insert is what decides, under concurrency.
 */
export async function claimUploadsForSend(
  db: SupabaseClient,
  attempt: ClaimAttempt & { workspaceId: string }
): Promise<ClaimForSend> {
  const { data: uploads, error: readError } = await db
    .from('thread_uploads')
    .select('id, created_at, damaged_at')
    .in('id', [...attempt.uploadIds])
    .eq('user_id', attempt.userId)
    .eq('workspace_id', attempt.workspaceId)
    .eq('thread_id', attempt.threadId)
    .eq('state', 'live')
    .eq('claim_gate', 'open');
  if (readError) throw new Error(`Failed to read uploads for a send: ${readError.message}`);
  const rows = (uploads ?? []) as Array<{
    id: string;
    created_at: string;
    damaged_at: string | null;
  }>;
  const found = new Set(rows.map((u) => u.id));
  // An upload already claimed is open too; whether it is this send's is the insert's to say.
  if (!attempt.uploadIds.every((id) => found.has(id))) return { ok: false, reason: 'unavailable' };
  // Bytes already known to be damaged can never be delivered, so no send,
  // first try or retry, may take them.
  if (rows.some((u) => u.damaged_at)) return { ok: false, reason: 'unavailable' };
  // An upload no send claimed within its pending hour is an orphan, as reads
  // already treat it (authorize.ts); a claim now would restart its clock.
  // Only a retry of the send that already holds it goes on. Both times are the
  // API's clock.
  const now = Date.parse(attempt.createdAt);
  const pastPending = rows.some((u) => {
    const created = Date.parse(u.created_at);
    return !Number.isFinite(now) || !Number.isFinite(created) || now - created >= PENDING_TTL_MS;
  });
  if (
    pastPending &&
    !isSameSend(await sendClaims(db, attempt.threadId, attempt.clientMessageId), attempt)
  ) {
    return { ok: false, reason: 'unavailable' };
  }

  const { error } = await db.from('thread_upload_claims').insert(claimRowsFor(attempt));
  if (error) {
    const refusal = classifyClaimError(error);
    if (refusal === 'not-claimable') return { ok: false, reason: 'unavailable' };
    if (refusal !== 'taken') throw new Error(`Failed to claim uploads: ${error.message}`);
    const existing = await sendClaims(db, attempt.threadId, attempt.clientMessageId);
    if (!isSameSend(existing, attempt)) {
      return { ok: false, reason: existing.length > 0 ? 'conflict' : 'unavailable' };
    }
  }

  // A claimed upload no longer counts against the person's pending slots
  // (idempotent: a slot already released stays released). If this write is
  // lost the count stays high, never low, until the reconciler's next pass.
  const { error: releaseError } = await db
    .from('thread_uploads')
    .update({ pending_slot: null })
    .in('id', [...attempt.uploadIds]);
  if (releaseError) {
    logger.warn('[Uploads] pending slots not released; the reconciler will', {
      error: releaseError.message,
    });
  }
  return { ok: true };
}

/**
 * Record the stored message on the claims: bookkeeping only, since reads and
 * dispatches authorize from the message itself. Best effort; the reconciler
 * confirms anything this misses.
 */
export async function confirmUploadsForSend(
  db: SupabaseClient,
  input: {
    threadId: string;
    clientMessageId: string;
    uploadIds: readonly string[];
    messageId: string;
  }
): Promise<void> {
  const { error } = await db
    .from('thread_upload_claims')
    .update({ message_id: input.messageId, held_reason: null, held_at: null })
    .in('upload_id', [...input.uploadIds])
    .eq('thread_id', input.threadId)
    .eq('client_message_id', input.clientMessageId)
    .is('message_id', null);
  if (error) {
    logger.warn('[Uploads] claims not confirmed; the reconciler will', { error: error.message });
  }
}
