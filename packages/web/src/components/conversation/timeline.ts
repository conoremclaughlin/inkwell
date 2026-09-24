/**
 * What a conversation renders, in order: day dividers, the "new messages"
 * divider, and messages marked as continuations of the one before. Pure, so
 * every rule about where a divider falls or when a header repeats is tested
 * here rather than read off a screenshot.
 */

import { formatDayLabel, isSameDay } from './format';
import type { ConversationMessage } from './types';

/** Consecutive messages from one author within this window share a header. */
export const GROUP_WINDOW_MS = 5 * 60_000;

export type TimelineItem =
  | { type: 'day'; key: string; label: string }
  | { type: 'unread'; key: string; count: number }
  | { type: 'message'; key: string; message: ConversationMessage; continuation: boolean };

/**
 * A message the viewer has not seen: newer than their read cursor, and
 * neither their own nor a system event. Nobody leaves their own message
 * unread, and "thread closed" is not news anyone has to catch up on.
 */
export function isUnread(message: ConversationMessage, unreadAfterMs: number): boolean {
  return (
    !message.author.isOwn &&
    message.author.kind !== 'system' &&
    Date.parse(message.createdAt) > unreadAfterMs
  );
}

function sameAuthor(a: ConversationMessage, b: ConversationMessage): boolean {
  return a.author.kind === b.author.kind && a.author.id === b.author.id;
}

export function buildTimeline(
  messages: ConversationMessage[],
  options: {
    /** The viewer's read cursor (ISO). Null or absent: no divider. */
    unreadAfter?: string | null;
    now?: Date;
  } = {}
): TimelineItem[] {
  const now = options.now ?? new Date();
  const sorted = [...messages].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));

  const unreadAfterMs = options.unreadAfter ? Date.parse(options.unreadAfter) : NaN;
  const unread = Number.isNaN(unreadAfterMs)
    ? []
    : sorted.filter((message) => isUnread(message, unreadAfterMs));
  const firstUnread = unread[0];

  const items: TimelineItem[] = [];
  let previous: ConversationMessage | null = null;
  for (const message of sorted) {
    // A divider starts a new group: a header after "Today" or "New
    // messages" is what tells the reader who is speaking.
    let startsGroup = false;
    if (!previous || !isSameDay(previous.createdAt, message.createdAt)) {
      items.push({
        type: 'day',
        key: `day:${message.createdAt}`,
        label: formatDayLabel(message.createdAt, now),
      });
      startsGroup = true;
    }
    if (message === firstUnread) {
      items.push({ type: 'unread', key: 'unread', count: unread.length });
      startsGroup = true;
    }
    const continuation =
      !startsGroup &&
      previous !== null &&
      sameAuthor(previous, message) &&
      previous.author.kind !== 'system' &&
      message.author.kind !== 'system' &&
      // A task request or notification carries its label in the header.
      !message.label &&
      Date.parse(message.createdAt) - Date.parse(previous.createdAt) <= GROUP_WINDOW_MS;
    items.push({ type: 'message', key: message.id, message, continuation });
    previous = message;
  }
  return items;
}
