/**
 * Display name for a message sender. Since the thread-scope cutover a
 * message names its author by kind (spec inkmail-thread-scope §3): an SB by
 * identity with its slug for display, a person by user id, or the system
 * with neither. The kind is authoritative; the old `metadata.sentBy` hint
 * is no longer consulted.
 */
export interface SenderLike {
  senderKind?: 'sb' | 'user' | 'system' | string | null;
  senderAgentId?: string | null;
}

export function senderLabel(m: SenderLike): string {
  if (m.senderKind === 'user') return 'You';
  if (m.senderKind === 'system') return 'system';
  return m.senderAgentId ?? 'system';
}
