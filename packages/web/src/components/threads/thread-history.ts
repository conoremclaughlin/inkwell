/**
 * The messages of one open thread, accumulated. Every page the server sends —
 * each poll of the newest page, each older page — is merged in, and nothing
 * leaves. Without that, the newest page rolling forward drops the rows it no
 * longer covers, and a thread whose older history was already exhausted has
 * no way to get them back (Lumen, #670 review).
 *
 * The history is kept contiguous: when a poll's newest page does not reach
 * back to what was already loaded (more than a page arrived between polls),
 * the stretch in between is recorded as a gap and filled by paging backwards
 * from the new page until it meets known messages. The same mechanism brings
 * a thread opened far behind its read cursor up to that cursor before the
 * view positions itself — so it opens on the real first unread message, not
 * on the first unread message that happened to fit in the newest page.
 *
 * Pure: the component runs the fetches and feeds the pages back in.
 */

import type { ThreadMessage, ThreadMessagesResponse } from './thread-types';

/** Older pages fetched to reach the read cursor before a thread opens. */
export const MAX_CATCH_UP_PAGES = 5;

/** A point in the (created_at, id) order the server pages in. */
export interface HistoryPosition {
  createdAt: string;
  id: string;
}

export interface HistoryGap {
  /** Fetch the page older than this message... */
  beforeId: string;
  /** ...until it reaches back to here. */
  floor: HistoryPosition;
  /** Catching up to the read cursor on open, rather than repairing a poll. */
  initial: boolean;
  /** Older pages fetched for this gap so far. */
  pages: number;
}

export interface ThreadHistory {
  /** Ascending, one entry per id. */
  messages: ThreadMessage[];
  /** Nothing exists before the first message. */
  oldestReached: boolean;
  /** Stretches still to fetch, oldest-first processing order. */
  gaps: HistoryGap[];
  /** The history reaches the read cursor (or gave up trying): safe to position. */
  ready: boolean;
  /** The first newest page has arrived. */
  started: boolean;
}

export const EMPTY_HISTORY: ThreadHistory = {
  messages: [],
  oldestReached: false,
  gaps: [],
  ready: false,
  started: false,
};

/** The server's order: created_at, then id. */
export function comparePosition(a: HistoryPosition, b: HistoryPosition): number {
  const byTime = Date.parse(a.createdAt) - Date.parse(b.createdAt);
  if (byTime !== 0) return byTime;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function mergeMessages(
  existing: ThreadMessage[],
  incoming: ThreadMessage[]
): ThreadMessage[] {
  if (incoming.length === 0) return existing;
  const byId = new Map<string, ThreadMessage>();
  for (const message of existing) byId.set(message.id, message);
  // A refetched message replaces the stored copy: the server's is newer.
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()].sort(comparePosition);
}

function oldestOf(messages: ThreadMessage[]): ThreadMessage | undefined {
  return [...messages].sort(comparePosition)[0];
}

/**
 * Merge a newest page (the poll). The first one starts the history, and —
 * when the viewer's read cursor is older than anything on it — opens an
 * initial gap back to the cursor, holding `ready` until it closes.
 */
export function absorbNewest(
  history: ThreadHistory,
  page: ThreadMessagesResponse,
  unreadAfter: string | null
): ThreadHistory {
  const incoming = page.messages;
  const truncated = page.meta?.truncated ?? false;
  const oldest = oldestOf(incoming);

  if (!history.started) {
    const start: ThreadHistory = {
      messages: mergeMessages([], incoming),
      oldestReached: !truncated,
      gaps: [],
      ready: true,
      started: true,
    };
    if (
      truncated &&
      oldest &&
      unreadAfter &&
      Date.parse(oldest.createdAt) > Date.parse(unreadAfter)
    ) {
      start.gaps = [
        { beforeId: oldest.id, floor: { createdAt: unreadAfter, id: '' }, initial: true, pages: 0 },
      ];
      start.ready = false;
    }
    return start;
  }

  const knownNewest = history.messages[history.messages.length - 1];
  const next: ThreadHistory = {
    ...history,
    messages: mergeMessages(history.messages, incoming),
    oldestReached: history.oldestReached || !truncated,
  };
  // The page stops short of what was loaded: fill the stretch between.
  if (truncated && oldest && knownNewest && comparePosition(oldest, knownNewest) > 0) {
    next.gaps = [
      ...history.gaps,
      { beforeId: oldest.id, floor: knownNewest, initial: false, pages: 0 },
    ];
  }
  return next;
}

/**
 * Merge a page of older messages. With `gap`, the page was fetched for it:
 * the gap closes once the page reaches its floor (or the thread's start),
 * and otherwise moves down to continue from the page's oldest message. An
 * initial catch-up gives up after MAX_CATCH_UP_PAGES and opens anyway.
 * Without `gap`, the reader asked for older history.
 */
export function absorbOlder(
  history: ThreadHistory,
  page: ThreadMessagesResponse,
  gap: HistoryGap | null
): ThreadHistory {
  const incoming = page.messages;
  const truncated = page.meta?.truncated ?? false;
  const next: ThreadHistory = {
    ...history,
    messages: mergeMessages(history.messages, incoming),
    // A page that is not truncated holds everything before its cursor.
    oldestReached: history.oldestReached || !truncated,
  };
  if (!gap) return next;

  const others = history.gaps.filter((g) => g.beforeId !== gap.beforeId);
  const oldest = oldestOf(incoming);
  const closed = !truncated || !oldest || comparePosition(oldest, gap.floor) <= 0;
  if (closed) {
    next.gaps = others;
    if (gap.initial) next.ready = true;
    return next;
  }
  const continued: HistoryGap = { ...gap, beforeId: oldest.id, pages: gap.pages + 1 };
  if (gap.initial && continued.pages >= MAX_CATCH_UP_PAGES) {
    next.gaps = others;
    next.ready = true;
    return next;
  }
  next.gaps = [continued, ...others];
  return next;
}

/** Abandon a gap whose fetch failed, so the thread still opens. */
export function dropGap(history: ThreadHistory, gap: HistoryGap): ThreadHistory {
  return {
    ...history,
    gaps: history.gaps.filter((g) => g.beforeId !== gap.beforeId),
    ready: gap.initial ? true : history.ready,
  };
}
