/**
 * What counts as news for the viewer. The conversation's "new messages"
 * divider and the list's unread dot answer the same question, so they share
 * one rule: a message is unread when it is newer than the viewer's read
 * cursor and is neither their own nor a system event. Nobody leaves their own
 * message unread, and "thread closed" is not news anyone has to catch up on.
 */

import { compareInstants } from '../threads-api/index.js';

/** One message in a conversation, against the viewer's read cursor (ISO). */
export function isUnread(
  message: { createdAt: string; author: { isOwn: boolean; kind: string } },
  unreadAfter: string
): boolean {
  return (
    !message.author.isOwn &&
    message.author.kind !== 'system' &&
    compareInstants(message.createdAt, unreadAfter) > 0
  );
}

/**
 * A thread has news for the viewer: its newest message is someone else's —
 * an SB's or another person's — after their cursor. System events are not
 * news, as in the conversation's own divider.
 */
export function hasUnread(
  lastMessage: { createdAt: string; isOwn: boolean; senderKind: string } | null | undefined,
  cursor: string
): boolean {
  if (!lastMessage || lastMessage.isOwn || lastMessage.senderKind === 'system') return false;
  return compareInstants(lastMessage.createdAt, cursor) > 0;
}
