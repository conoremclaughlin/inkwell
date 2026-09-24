/**
 * Who wrote an inbox message, and what to call them (spec inkmail-thread-scope §3).
 *
 * Identity is the PRINCIPAL — a person by user id, an SB by identity, else
 * the legacy slug — never the display name or the kind: every person reads
 * as 'user' by slug, so two different people compacted under one author
 * line (Lumen, #622). The label is the server's viewer-aware name; "You"
 * only for the viewer's own message.
 */
export interface AuthorLike {
  senderKind?: string | null;
  senderSlug: string | null;
  senderSbId?: string | null;
  senderUserId?: string | null;
  senderName?: string;
  isOwn?: boolean;
}

export function senderKey(m: AuthorLike): string {
  if (m.senderUserId) return `user:${m.senderUserId}`;
  if (m.senderSbId) return `sb:${m.senderSbId}`;
  return `slug:${m.senderSlug ?? ''}`;
}

/** Consecutive messages compact under one author line only for the same principal. */
export function sameAuthor(prev: AuthorLike | null | undefined, m: AuthorLike): boolean {
  return !!prev && senderKey(prev) === senderKey(m);
}

export function authorLabel(m: AuthorLike): string {
  if (m.isOwn) return 'You';
  return m.senderName || m.senderSlug || 'unknown';
}
