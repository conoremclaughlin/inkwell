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
 * A gap is never forgotten while messages are missing. The catch-up to the
 * read cursor stops after a few pages so the thread opens promptly, and the
 * gap stays, paused, as the explicit record that unread messages remain
 * above; the reader's next request for older history continues it. A failed
 * fetch blocks a gap until the next successful poll shows the server
 * answering again. Dropping either would leave a hole nothing could find later
 * (Lumen, #670 round 2).
 *
 * Pure: useThreadHistory runs the fetches and feeds the pages back in.
 */

import { compareInstants } from '../threads-api/index.js';
import type { ThreadMessage, ThreadMessagesResponse } from '../threads-api/index.js';

/** Older pages fetched on open, toward the read cursor, before the thread shows. */
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
  /**
   * The catch-up reached its page limit: the thread opened, and unread
   * messages remain above what is loaded. Continued by the reader, not
   * automatically.
   */
  paused: boolean;
  /** A fetch for this gap failed. Retried once a newest page arrives. */
  blocked: boolean;
}

export interface ThreadHistory {
  /** Ascending in the server's order, one entry per id. */
  messages: ThreadMessage[];
  /** Nothing exists before the first message. */
  oldestReached: boolean;
  /** Stretches still missing. */
  gaps: HistoryGap[];
  /** Safe to position: the history reaches the read cursor, or says it doesn't. */
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

/** The server's order: created_at at full precision, then id. */
export function comparePosition(a: HistoryPosition, b: HistoryPosition): number {
  const byTime = compareInstants(a.createdAt, b.createdAt);
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

/** The gap to fetch next without being asked: not paused, not blocked. */
export function nextGap(history: ThreadHistory): HistoryGap | null {
  return history.gaps.find((gap) => !gap.paused && !gap.blocked) ?? null;
}

/**
 * The catch-up to the read cursor stopped short — paused at its page limit,
 * or blocked by a failed fetch — so unread messages exist above the first
 * loaded one.
 */
export function unreadBeyondLoaded(history: ThreadHistory): boolean {
  return history.gaps.some((gap) => gap.initial);
}

/**
 * The gap a request for older history should continue: the paused or
 * blocked catch-up, which starts at the oldest loaded message. Null when
 * older history is an ordinary page back.
 */
export function olderGap(history: ThreadHistory): HistoryGap | null {
  return history.gaps.find((gap) => gap.initial) ?? null;
}

/**
 * Merge a newest page (the poll). The first one starts the history, and —
 * when the viewer's read cursor is older than anything on it — opens an
 * initial gap back to the cursor, holding `ready` until it closes or pauses.
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
    if (truncated && oldest && unreadAfter && compareInstants(oldest.createdAt, unreadAfter) > 0) {
      start.gaps = [
        {
          beforeId: oldest.id,
          floor: { createdAt: unreadAfter, id: '' },
          initial: true,
          pages: 0,
          paused: false,
          blocked: false,
        },
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
      ...next.gaps,
      {
        beforeId: oldest.id,
        floor: knownNewest,
        initial: false,
        pages: 0,
        paused: false,
        blocked: false,
      },
    ];
  }
  return next;
}

/**
 * Merge a page of older messages. With `gap`, the page was fetched for it:
 * the gap closes once the page reaches its floor (or the thread's start),
 * and otherwise moves down to continue from the page's oldest message. The
 * catch-up to the read cursor pauses at MAX_CATCH_UP_PAGES — the thread
 * opens, and the gap stays to say what is still missing. Without `gap`, the
 * reader asked for an ordinary page of older history.
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
  const continued: HistoryGap = {
    ...gap,
    beforeId: oldest.id,
    pages: gap.pages + 1,
    blocked: false,
  };
  if (gap.initial && continued.pages >= MAX_CATCH_UP_PAGES) {
    continued.paused = true;
    next.ready = true;
  }
  next.gaps = [continued, ...others];
  return next;
}

/**
 * A fetch for `gap` failed. The gap stays — the messages are still missing —
 * but waits for unblockGaps before it is tried again. A catch-up that fails
 * still lets the thread open.
 */
export function failGap(history: ThreadHistory, gap: HistoryGap): ThreadHistory {
  return {
    ...history,
    gaps: history.gaps.map((g) => (g.beforeId === gap.beforeId ? { ...g, blocked: true } : g)),
    ready: gap.initial ? true : history.ready,
  };
}

/**
 * The server answered a fetch: try blocked gaps again. Called on every
 * successful poll, including one that brought nothing new — a quiet thread
 * must still recover what it failed to load.
 */
export function unblockGaps(history: ThreadHistory): ThreadHistory {
  if (!history.gaps.some((gap) => gap.blocked)) return history;
  return {
    ...history,
    gaps: history.gaps.map((gap) => (gap.blocked ? { ...gap, blocked: false } : gap)),
  };
}

/**
 * How far a reader at `message` can be said to have read. Never past a
 * stretch that is still missing: a reader pinned at the end of a poll that
 * jumped ahead has not seen what the gap below them will bring, and
 * acknowledging through it would lose those messages' unread state for
 * good if they leave before it fills (Lumen, #670 round 3). The limit is
 * the floor of the earliest gap — for a catch-up, the read cursor itself.
 */
export function readableThrough(gaps: HistoryGap[], message: HistoryPosition): HistoryPosition {
  let limit = message;
  for (const gap of gaps) {
    if (comparePosition(gap.floor, limit) < 0) limit = gap.floor;
  }
  return limit;
}

/**
 * The reader marked everything read with unread messages still unloaded
 * above: the catch-up has nothing left to catch up to. What it was
 * fetching is now ordinary older history.
 */
export function abandonCatchUp(history: ThreadHistory): ThreadHistory {
  if (!history.gaps.some((gap) => gap.initial)) return history;
  return { ...history, gaps: history.gaps.filter((gap) => !gap.initial) };
}
