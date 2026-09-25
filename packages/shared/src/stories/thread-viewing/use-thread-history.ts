/**
 * One open thread's history, kept whole while the reader is on it: every
 * newest page the poll brings is merged in, gaps it leaves are filled, and
 * older pages load on request. history.ts decides what each page means; this
 * hook only runs the fetches and feeds the pages back in, so every client
 * (web, mobile, the desktop app) gets the same history from the same polls.
 *
 * It belongs to one thread at a time. Given a different `threadKey`, it
 * starts over as a fresh mount would, and a fetch that finishes for the
 * thread it left is dropped. Every piece of its state carries the key it
 * belongs to, so nothing from one thread can land in another's history.
 * (The mobile app hit this: a deep link reused the open thread's screen for
 * another thread, and the first thread's messages showed in the second.)
 *
 * React is the only thing it needs from its host. The client owns the poll
 * (its own query library, its own interval) and the fetch (its own auth),
 * and hands both in.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ThreadMessagesResponse } from '../threads-api/index.js';
import {
  abandonCatchUp as dropCatchUp,
  absorbNewest,
  absorbOlder,
  EMPTY_HISTORY,
  failGap,
  nextGap,
  olderGap,
  unblockGaps,
  type ThreadHistory,
} from './history.js';

export interface ThreadHistoryInput {
  /** The thread this history is for. */
  threadKey: string;
  /**
   * The thread's newest page, as the poll last returned it. A new object is a
   * new page. It must be this thread's: a query keyed by the thread key
   * gives exactly that.
   */
  newestPage: ThreadMessagesResponse | undefined;
  /**
   * When the poll last succeeded, in ms — even one that brought nothing new.
   * The server answering again is what retries a gap whose fetch failed.
   */
  newestPageAt: number;
  /** Still waiting for the first newest page. */
  newestPageLoading: boolean;
  /** Fetch the page of messages older than `beforeId`. */
  fetchOlder: (beforeId: string) => Promise<ThreadMessagesResponse>;
  /**
   * The viewer's read cursor as the thread opened (ISO), or null. Read once
   * per thread: the history catches up to where the reader was, whatever
   * they read since.
   */
  openingCursor: string | null;
}

export interface ThreadHistoryState {
  history: ThreadHistory;
  /**
   * The history has not reached the read cursor yet. A view positions once,
   * so it should wait: opening early lands on the wrong first unread message.
   */
  opening: boolean;
  loadingOlder: boolean;
  /** The last fetch that failed, for a notice. Cleared by the next request for older messages. */
  error: string | null;
  /**
   * Older history: continues the catch-up when one stopped short, so reading
   * upwards closes it, and is otherwise an ordinary page back from the
   * oldest loaded message.
   */
  loadOlder: () => Promise<void>;
  /** The reader marked everything read: stop catching up to the old cursor. */
  abandonCatchUp: () => void;
}

/** Everything the hook holds, with the thread it belongs to. */
interface Tracked {
  threadKey: string;
  openingCursor: string | null;
  history: ThreadHistory;
  /** The newest page already merged in. */
  absorbed: ThreadMessagesResponse | undefined;
  loadingOlder: boolean;
  error: string | null;
}

function fresh(threadKey: string, openingCursor: string | null): Tracked {
  return {
    threadKey,
    openingCursor,
    history: EMPTY_HISTORY,
    absorbed: undefined,
    loadingOlder: false,
    error: null,
  };
}

const messageOf = (failure: unknown, fallback: string): string =>
  failure instanceof Error ? failure.message : fallback;

export function useThreadHistory(input: ThreadHistoryInput): ThreadHistoryState {
  const { threadKey, newestPage, newestPageAt, newestPageLoading } = input;

  const [tracked, setTracked] = useState<Tracked>(() => fresh(threadKey, input.openingCursor));
  // A change to the state of one thread. Dropped when the hook has moved on
  // to another, which is what keeps a late fetch out of the wrong thread.
  const update = useCallback(
    (forKey: string, change: (state: Tracked) => Tracked) =>
      setTracked((state) => (state.threadKey === forKey ? change(state) : state)),
    []
  );

  // The latest fetcher, so a caller passing a fresh function each render
  // does not restart a fetch already in flight.
  const fetchOlderRef = useRef(input.fetchOlder);
  useEffect(() => {
    fetchOlderRef.current = input.fetchOlder;
  });

  // Another thread in the same mount starts over, as a fresh mount would.
  let current = tracked;
  if (tracked.threadKey !== threadKey) {
    current = fresh(threadKey, input.openingCursor);
    setTracked(current);
  }

  // Every newest page is merged into the history in the render it arrives,
  // so no poll ever shows the conversation without rows it had a moment ago.
  if (newestPage && newestPage !== current.absorbed) {
    update(threadKey, (state) => ({
      ...state,
      absorbed: newestPage,
      history: absorbNewest(state.history, newestPage, state.openingCursor),
    }));
  }

  // Every successful poll — even one that brought nothing new, which hands
  // back the same page object — is the server answering: retry what failed.
  useEffect(() => {
    if (newestPageAt) {
      update(threadKey, (state) => ({ ...state, history: unblockGaps(state.history) }));
    }
  }, [newestPageAt, threadKey, update]);

  // Work the history's gaps one at a time: the catch-up to the read cursor
  // on open, and any stretch a poll skipped. Paused and blocked gaps wait.
  const { history } = current;
  const gap = nextGap(history);
  useEffect(() => {
    if (!gap) return;
    let cancelled = false;
    fetchOlderRef
      .current(gap.beforeId)
      .then((page) => {
        if (cancelled) return;
        update(threadKey, (state) => ({
          ...state,
          history: absorbOlder(state.history, page, gap),
        }));
      })
      .catch((failure: unknown) => {
        if (cancelled) return;
        update(threadKey, (state) => ({
          ...state,
          error: messageOf(failure, 'Failed to load messages'),
          history: failGap(state.history, gap),
        }));
      });
    return () => {
      cancelled = true;
    };
  }, [gap, threadKey, update]);

  const loadOlder = useCallback(async () => {
    const oldest = history.messages[0];
    if (current.loadingOlder || !oldest) return;
    const forKey = current.threadKey;
    const catchUp = olderGap(history);
    update(forKey, (state) => ({ ...state, loadingOlder: true, error: null }));
    try {
      const page = await fetchOlderRef.current(catchUp?.beforeId ?? oldest.id);
      update(forKey, (state) => ({
        ...state,
        history: absorbOlder(state.history, page, catchUp),
      }));
    } catch (failure) {
      update(forKey, (state) => ({
        ...state,
        error: messageOf(failure, 'Failed to load earlier messages'),
      }));
    } finally {
      update(forKey, (state) => ({ ...state, loadingOlder: false }));
    }
  }, [current.loadingOlder, current.threadKey, history, update]);

  const abandonCatchUp = useCallback(
    () => update(threadKey, (state) => ({ ...state, history: dropCatchUp(state.history) })),
    [threadKey, update]
  );

  return {
    history,
    opening: history.started ? !history.ready : newestPageLoading,
    loadingOlder: current.loadingOlder,
    error: current.error,
    loadOlder,
    abandonCatchUp,
  };
}
