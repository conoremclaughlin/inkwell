/**
 * Who may read an upload, and which dispatch may attach it (upload design
 * r2 §5, r3, r5).
 *
 * Two kinds of read, never mixed:
 *
 * - Shared read: a current person participant of the thread, in its
 *   workspace, once the upload's message has committed. "Committed" means
 *   the upload's claim, plus the message stored under that claim's (thread,
 *   clientMessageId) from the claim's own person, with the same words and
 *   exactly the claimed manifest (content and full manifest digests, not
 *   just this id). A message anyone else writes naming the id authorizes
 *   nothing, and the claim's confirm state is never consulted.
 * - Owner preview: before such a message exists (pending, claimed or held),
 *   the uploader alone, in the upload's workspace.
 *
 * A dispatch may attach an upload only for the committed message it is
 * delivering.
 *
 * Every refusal is answered the same way by the caller (a 404, or no
 * attachment); the reason is for counting.
 */

import { messageMatchesClaim, type StoredClaim, type StoredThreadMessage } from './claims.js';

/** An upload no send has claimed is an orphan after this long. */
export const PENDING_TTL_MS = 60 * 60 * 1000;

export interface UploadRow {
  id: string;
  user_id: string;
  workspace_id: string;
  thread_id: string;
  state: 'live' | 'removing' | 'removed';
  claim_gate: 'receiving' | 'open' | 'closed';
  damaged_at: string | null;
  /** Written by the API from its own clock, as `now` is; the column has no default. */
  created_at: string;
}

export type UploadAccess =
  /** A person reading through the route. Participation is read fresh by the caller. */
  | {
      kind: 'read';
      userId: string;
      workspaceId: string;
      isPersonParticipant: boolean;
    }
  /** A dispatch attaching media from the stored message it is delivering. */
  | { kind: 'resolve'; messageId: string };

export type UploadDenial =
  | 'gone'
  | 'damaged'
  | 'not-ready'
  | 'expired'
  | 'not-committed'
  | 'not-yours';

export type UploadDecision = { ok: true } | { ok: false; reason: UploadDenial };

export interface UploadAuthInput {
  upload: UploadRow;
  /** The upload's claim row, if it has one. */
  claim: StoredClaim | null;
  /** The message stored under the claim's (thread, clientMessageId), if any. */
  message: StoredThreadMessage | null;
  access: UploadAccess;
  now: number;
  /**
   * How long a claimed upload stays readable, counted from its claim, or null
   * for no automatic expiry. Retention is a product decision that has not
   * been made; until it is, callers pass null and claimed uploads leave only
   * by account deletion or authorized manual removal.
   */
  retentionMs: number | null;
}

export function authorizeUpload({
  upload,
  claim,
  message,
  access,
  now,
  retentionMs,
}: UploadAuthInput): UploadDecision {
  const deny = (reason: UploadDenial): UploadDecision => ({ ok: false, reason });

  if (upload.state !== 'live') return deny('gone');
  if (upload.damaged_at) return deny('damaged');
  if (upload.claim_gate === 'receiving') return deny('not-ready');
  if (claim && (claim.upload_id !== upload.id || claim.thread_id !== upload.thread_id)) {
    return deny('not-yours');
  }

  // Expiry is decided here as well as by the sweep, so a sweep that is late
  // or down never extends access.
  const from = Date.parse(claim ? claim.created_at : upload.created_at);
  const ttl = claim ? retentionMs : PENDING_TTL_MS;
  if (!Number.isFinite(from) || (ttl !== null && now - from >= ttl)) return deny('expired');

  const committed =
    claim !== null &&
    message !== null &&
    message.thread_id === upload.thread_id &&
    claim.user_id === upload.user_id &&
    messageMatchesClaim(message, claim);

  if (access.kind === 'resolve') {
    return committed && message!.id === access.messageId ? { ok: true } : deny('not-committed');
  }

  if (access.workspaceId !== upload.workspace_id) return deny('not-yours');
  if (committed) {
    // Shared read. A person removed from the thread loses access at once,
    // the uploader too.
    return access.isPersonParticipant ? { ok: true } : deny('not-yours');
  }
  // Owner preview.
  return access.userId === upload.user_id ? { ok: true } : deny('not-committed');
}
