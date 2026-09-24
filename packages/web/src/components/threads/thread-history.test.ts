import { describe, expect, it } from 'vitest';
import {
  absorbNewest,
  absorbOlder,
  dropGap,
  EMPTY_HISTORY,
  MAX_CATCH_UP_PAGES,
  type ThreadHistory,
} from './thread-history';
import type { ThreadMessage, ThreadMessagesResponse } from './thread-types';

const PAGE = 100;
const at = (i: number) => new Date(Date.UTC(2026, 8, 22, 0, 0, i)).toISOString();
const message = (i: number): ThreadMessage => ({
  id: `m${String(i).padStart(4, '0')}`,
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

/** Work every outstanding gap, as the component's effect does. */
function fillGaps(history: ThreadHistory, api: ReturnType<typeof server>): ThreadHistory {
  let current = history;
  for (let guard = 0; current.gaps.length > 0 && guard < 50; guard++) {
    const gap = current.gaps[0];
    current = absorbOlder(current, api.before(gap.beforeId), gap);
  }
  return current;
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

    it('gives up after a bounded number of pages and opens anyway', () => {
      const api = server(2_000);
      let history = absorbNewest(EMPTY_HISTORY, api.newest(), at(5));
      history = fillGaps(history, api);
      expect(history.ready).toBe(true);
      expect(history.oldestReached).toBe(false);
      expect(numbers(history)).toHaveLength(PAGE * (1 + MAX_CATCH_UP_PAGES));
      expect(contiguous(history)).toBe(true);
    });

    it('opens when a catch-up fetch fails', () => {
      const history = absorbNewest(EMPTY_HISTORY, server(200).newest(), at(50));
      const dropped = dropGap(history, history.gaps[0]);
      expect(dropped.ready).toBe(true);
      expect(dropped.gaps).toEqual([]);
    });

    it('never waits on a thread that fits in one page', () => {
      const history = absorbNewest(EMPTY_HISTORY, server(40).newest(), at(1));
      expect(history.ready).toBe(true);
      expect(history.oldestReached).toBe(true);
    });
  });
});
