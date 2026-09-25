/**
 * One open thread's history, kept whole while the reader is on it: every
 * newest page the poll brings is merged in, gaps it leaves are filled, and
 * older pages load on request. history.ts decides what each page means; this
 * hook only runs the fetches and feeds the pages back in, so every client
 * (web, mobile, the desktop app) gets the same history from the same polls.
 *
 * Mount it once per thread, keyed by the thread's key: the read cursor it
 * opens on and the pages it has loaded belong to one thread.
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
  /** The thread's newest page, as the poll last returned it. A new object is a new page. */
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
   * The viewer's read cursor as the thread opened (ISO), or null. Read once:
   * the history catches up to where the reader was, whatever they read since.
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

export function useThreadHistory(input: ThreadHistoryInput): ThreadHistoryState {
  const { newestPage, newestPageAt, newestPageLoading } = input;
  const [openingCursor] = useState(input.openingCursor);

  // The latest fetcher, so a caller passing a fresh function each render
  // does not restart a fetch already in flight.
  const fetchOlderRef = useRef(input.fetchOlder);
  useEffect(() => {
    fetchOlderRef.current = input.fetchOlder;
  });

  // Every newest page is merged into the history in the render it arrives,
  // so no poll ever shows the conversation without rows it had a moment ago.
  const [history, setHistory] = useState<ThreadHistory>(EMPTY_HISTORY);
  const [absorbed, setAbsorbed] = useState<ThreadMessagesResponse | undefined>(undefined);
  if (newestPage && newestPage !== absorbed) {
    setAbsorbed(newestPage);
    setHistory((current) => absorbNewest(current, newestPage, openingCursor));
  }

  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Every successful poll — even one that brought nothing new, which hands
  // back the same page object — is the server answering: retry what failed.
  useEffect(() => {
    if (newestPageAt) setHistory((current) => unblockGaps(current));
  }, [newestPageAt]);

  // Work the history's gaps one at a time: the catch-up to the read cursor
  // on open, and any stretch a poll skipped. Paused and blocked gaps wait.
  const gap = nextGap(history);
  useEffect(() => {
    if (!gap) return;
    let cancelled = false;
    fetchOlderRef
      .current(gap.beforeId)
      .then((page) => {
        if (!cancelled) setHistory((current) => absorbOlder(current, page, gap));
      })
      .catch((failure: unknown) => {
        if (cancelled) return;
        setError(failure instanceof Error ? failure.message : 'Failed to load messages');
        setHistory((current) => failGap(current, gap));
      });
    return () => {
      cancelled = true;
    };
  }, [gap]);

  const loadOlder = useCallback(async () => {
    const oldest = history.messages[0];
    if (loadingOlder || !oldest) return;
    const catchUp = olderGap(history);
    setLoadingOlder(true);
    setError(null);
    try {
      const page = await fetchOlderRef.current(catchUp?.beforeId ?? oldest.id);
      setHistory((current) => absorbOlder(current, page, catchUp));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Failed to load earlier messages');
    } finally {
      setLoadingOlder(false);
    }
  }, [loadingOlder, history]);

  const abandonCatchUp = useCallback(() => setHistory((current) => dropCatchUp(current)), []);

  return {
    history,
    opening: history.started ? !history.ready : newestPageLoading,
    loadingOlder,
    error,
    loadOlder,
    abandonCatchUp,
  };
}
