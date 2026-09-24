/**
 * Display name for a message sender. The server names every author (spec
 * inkmail-thread-scope §3): an SB by its slug, a person from their profile,
 * the system as 'system'. It also says which person is the viewer — that
 * comparison happens there, against the PCP user, which is not the id this
 * app holds from its auth provider (Lumen, #620). Only the viewer's own
 * message reads "You"; another person's message carries their name.
 */
export interface SenderLike {
  senderKind?: 'sb' | 'user' | 'system' | string | null;
  senderSlug?: string | null;
  senderName?: string | null;
  isOwn?: boolean | null;
}

export function senderLabel(m: SenderLike): string {
  if (m.isOwn) return 'You';
  if (m.senderName) return m.senderName;
  // Older payloads name nobody: fall back to what the kind says.
  if (m.senderKind === 'user') return 'a workspace member';
  if (m.senderKind === 'system') return 'system';
  return m.senderSlug ?? 'system';
}
