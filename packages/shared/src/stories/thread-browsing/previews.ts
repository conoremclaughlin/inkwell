/**
 * A thread's newest message as one line of the thread list.
 */

import type { ThreadLastMessage } from '../threads-api/index.js';
import type { NameFor } from '../thread-viewing/index.js';

/**
 * Markdown reduced to what reads well on one line of a list: emphasis,
 * code ticks, heading and quote markers, and link syntax removed, the text
 * they wrapped kept.
 */
export function plainPreview(markdown: string): string {
  return markdown
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/```[a-z]*|`/gi, '')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|\s)[*_](\S(?:.*?\S)?)[*_](?=\s|$|[.,;:!?])/g, '$1$2')
    .replace(/(^|\s)(#{1,6}|>)\s+/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** "Lumen: Round 2 — approve" for a list row. */
export function previewLine(
  lastMessage: Pick<
    ThreadLastMessage,
    'senderKind' | 'senderSlug' | 'senderName' | 'isOwn' | 'preview'
  >,
  nameFor: NameFor
): { sender: string; text: string } {
  const sender = lastMessage.isOwn
    ? 'You'
    : lastMessage.senderKind === 'sb'
      ? nameFor(lastMessage.senderSlug)
      : lastMessage.senderName;
  return { sender, text: plainPreview(lastMessage.preview) };
}
