import { describe, expect, it } from 'vitest';
import {
  abandonCatchUp,
  absorbNewest,
  absorbOlder,
  EMPTY_HISTORY,
  failGap,
  MAX_CATCH_UP_PAGES,
  nextGap,
  olderGap,
  readableThrough,
  unblockGaps,
  unreadBeyondLoaded,
  type ThreadHistory,
} from './thread-history';
import type { ThreadMessage, ThreadMessagesResponse } from './thread-types';

const PAGE = 100;
const at = (i: number) => new Date(Date.UTC(2026, 8, 22, 0, 0, i)).toISOString();
const message = (i: number): ThreadMessage => ({
  id: `m${String(i).padStart(4, '0')}`,
  senderKind: 'sb',
  senderSlug: 'wren',
  content: `Message ${i}`,
  messageType: 'message',
  priority: 'normal',
  createdAt: at(i),
});

/**
 * Pages the way GET /threads/messages does: the newest PAGE of messages
 * 1..latest, or the PAGE strictly older than a cursor message, with
 * `truncated` meaning more exists further back.
 */
function server(latest: number) {
  const range = (from: number, to: number) => {
    const start = Math.max(1, to - PAGE + 1);
    const messages =
      to >= from ? Array.from({ length: to - start + 1 }, (_, j) => message(start + j)) : [];
    return {
      thread: null,
      messages,
      meta: { fetched: messages.length, total: to, truncated: start > 1 },
    } satisfies ThreadMessagesResponse;
  };
  return {
    newest: () => range(1, latest),
    before: (id: string) => range(1, Number(id.slice(1)) - 1),
  };
}

/** Work the gaps the component's effect would, without being asked. */
function fillGaps(history: ThreadHistory, api: ReturnType<typeof server>): ThreadHistory {
  let current = history;
  for (let guard = 0; guard < 50; guard++) {
    const gap = nextGap(current);
    if (!gap) break;
    current = absorbOlder(current, api.before(gap.beforeId), gap);
  }
  return current;
}

/** The reader asking for older history, as loadOlder does. */
function readUpwards(history: ThreadHistory, api: ReturnType<typeof server>): ThreadHistory {
  const catchUp = olderGap(history);
  return absorbOlder(history, api.before(catchUp?.beforeId ?? history.messages[0].id), catchUp);
}

const numbers = (history: ThreadHistory) => history.messages.map((m) => Number(m.id.slice(1)));
const contiguous = (history: ThreadHistory) => {
  const n = numbers(history);
  return n.every((value, i) => i === 0 || value === n[i - 1] + 1);
};

describe('thread history', () => {
  /**
   * Lumen's repro on #670: 101–200 loaded, older history 1–100 loaded (and
   * exhausted), then the poll returns 102–201. Replacing the newest page
   * dropped 101, and with nothing older left to load it was gone for good.
   */
  it('keeps rows the newest page rolls past', () => {
    let history = absorbNewest(EMPTY_HISTORY, server(200).newest(), at(200));
    history = absorbOlder(history, server(200).before('m0101'), null);
    expect(history.oldestReached).toBe(true);

    history = absorbNewest(history, server(201).newest(), at(200));
    expect(numbers(history)).toHaveLength(201);
    expect(numbers(history)).toContain(101);
    expect(contiguous(history)).toBe(true);
    expect(history.gaps).toEqual([]);
  });

  it('fills the stretch a poll skipped when more than a page arrived between polls', () => {
    let history = absorbNewest(EMPTY_HISTORY, server(200).newest(), at(200));
    const later = server(350);
    history = absorbNewest(history, later.newest(), at(200));
    // 251–350 arrived; 201–250 is unknown until the gap is filled.
    expect(history.gaps).toHaveLength(1);
    expect(numbers(history)).not.toContain(225);

    history = fillGaps(history, later);
    expect(numbers(history)[0]).toBe(101);
    expect(numbers(history).at(-1)).toBe(350);
    expect(contiguous(history)).toBe(true);
  });

  /**
   * Lumen's round-2 counterexample: 1–100 loaded, a poll jumps to 251–350,
   * and the fetch for 101–250 fails once. Dropping the gap forgot the hole;
   * the next poll (252–351) overlapped what was known and never recreated
   * it, and with the oldest page exhausted there was no older button either.
   */
  it('keeps a failed gap, and fills it once the server answers again', () => {
    let history = absorbNewest(EMPTY_HISTORY, server(100).newest(), at(100));
    history = absorbNewest(history, server(350).newest(), at(100));
    history = failGap(history, history.gaps[0]);
    history = absorbNewest(history, server(351).newest(), at(100));
    expect(history.gaps).toHaveLength(1);
    expect(nextGap(history), 'a blocked gap waits for the next successful poll').toBeNull();

    history = fillGaps(unblockGaps(history), server(351));
    expect(history.gaps).toEqual([]);
    expect(numbers(history)).toHaveLength(351);
    expect(contiguous(history)).toBe(true);
  });

  /**
   * Lumen's round-2 counterexample: Postgres keeps microseconds. Two
   * hundred messages inside one millisecond, with UUIDs in the opposite
   * order to time: compared by Date.parse they tie, the UUID decides, the
   * "oldest" loaded message is really the newest, and every older page is
   * requested from the same cursor.
   */
  it('pages by the server’s microsecond order, not Date.parse', () => {
    const all: ThreadMessage[] = Array.from({ length: 200 }, (_, i) => ({
      ...message(i + 1),
      id: `00000000-0000-4000-8000-${String(1000 - i).padStart(12, '0')}`,
      createdAt: `2026-09-22T00:00:00.${String(123001 + i)}+00:00`,
    }));
    const slice = (end: number): ThreadMessagesResponse => ({
      thread: null,
      messages: all.slice(Math.max(0, end - PAGE), end),
      meta: { fetched: Math.min(PAGE, end), total: end, truncated: end > PAGE },
    });

    let history = absorbNewest(EMPTY_HISTORY, slice(200), '2026-09-23T00:00:00Z');
    expect(history.messages[0].id).toBe(all[100].id);
    for (let i = 0; i < 3 && !history.oldestReached; i++) {
      const end = all.findIndex((m) => m.id === history.messages[0].id);
      history = absorbOlder(history, slice(end), null);
    }
    expect(history.messages).toHaveLength(200);
    expect(history.messages.map((m) => m.id)).toEqual(all.map((m) => m.id));
  });

  describe('how far a reader can be said to have read', () => {
    const newest = (h: ThreadHistory) => h.messages[h.messages.length - 1];

    it('is wherever they are when nothing is missing', () => {
      const history = absorbNewest(EMPTY_HISTORY, server(200).newest(), at(200));
      expect(readableThrough(history.gaps, newest(history)).id).toBe('m0200');
    });

    it('stops below a stretch a poll skipped, until it fills', () => {
      let history = absorbNewest(EMPTY_HISTORY, server(200).newest(), at(200));
      history = absorbNewest(history, server(350).newest(), at(200));
      expect(readableThrough(history.gaps, newest(history)).id).toBe('m0200');
      history = fillGaps(history, server(350));
      expect(readableThrough(history.gaps, newest(history)).id).toBe('m0350');
    });

    it('stays at the read cursor while a catch-up has not reached it', () => {
      let history = absorbNewest(EMPTY_HISTORY, server(800).newest(), at(50));
      history = fillGaps(history, server(800));
      expect(readableThrough(history.gaps, newest(history)).createdAt).toBe(at(50));
      // Marking all read abandons the catch-up; nothing holds the reader back.
      history = abandonCatchUp(history);
      expect(unreadBeyondLoaded(history)).toBe(false);
      expect(readableThrough(history.gaps, newest(history)).id).toBe('m0800');
    });
  });

  describe('opening behind the read cursor', () => {
    it('is ready at once when the newest page already covers the cursor', () => {
      const history = absorbNewest(EMPTY_HISTORY, server(200).newest(), at(150));
      expect(history.ready).toBe(true);
      expect(history.gaps).toEqual([]);
    });

    /**
     * Lumen's second repro: cursor at 50, 200 messages. The view positioned
     * on the newest page (first unread there: 101), and the older page then
     * arrived as an ordinary prepend, leaving the real boundary (51)
     * thousands of pixels offscreen. The history now reaches the cursor
     * before it says it is ready.
     */
    it('loads back to the cursor before it is ready to position', () => {
      const api = server(200);
      let history = absorbNewest(EMPTY_HISTORY, api.newest(), at(50));
      expect(history.ready).toBe(false);

      history = fillGaps(history, api);
      expect(history.ready).toBe(true);
      expect(numbers(history)).toContain(50);
      expect(numbers(history)).toContain(51);
      expect(contiguous(history)).toBe(true);
    });

    /**
     * Lumen's round-2 counterexample: 669 messages, cursor at 50. The
     * catch-up stops at its page limit with 70–669 loaded. Opening there is
     * fine; calling it complete was not — 51–69 were unread, unloaded, and
     * nothing said so.
     */
    it('pauses at its page limit and says unread messages remain above', () => {
      const api = server(669);
      let history = absorbNewest(EMPTY_HISTORY, api.newest(), at(50));
      history = fillGaps(history, api);
      expect(history.ready).toBe(true);
      expect(numbers(history)[0]).toBe(669 - PAGE * (1 + MAX_CATCH_UP_PAGES) + 1);
      expect(numbers(history)).not.toContain(51);
      expect(unreadBeyondLoaded(history)).toBe(true);
      expect(olderGap(history)?.paused).toBe(true);

      // Reading upwards continues the catch-up until it reaches the cursor.
      for (let guard = 0; unreadBeyondLoaded(history) && guard < 10; guard++) {
        history = readUpwards(history, api);
      }
      expect(unreadBeyondLoaded(history)).toBe(false);
      expect(numbers(history)).toContain(50);
      expect(numbers(history)).toContain(51);
      expect(contiguous(history)).toBe(true);
    });

    it('opens when a catch-up fetch fails, and still knows what it is missing', () => {
      const api = server(200);
      let history = absorbNewest(EMPTY_HISTORY, api.newest(), at(50));
      history = failGap(history, history.gaps[0]);
      expect(history.ready).toBe(true);
      expect(unreadBeyondLoaded(history)).toBe(true);
      expect(nextGap(history)).toBeNull();

      history = fillGaps(unblockGaps(history), api);
      expect(unreadBeyondLoaded(history)).toBe(false);
      expect(numbers(history)).toContain(51);
    });

    it('never waits on a thread that fits in one page', () => {
      const history = absorbNewest(EMPTY_HISTORY, server(40).newest(), at(1));
      expect(history.ready).toBe(true);
      expect(history.oldestReached).toBe(true);
    });
  });
});
