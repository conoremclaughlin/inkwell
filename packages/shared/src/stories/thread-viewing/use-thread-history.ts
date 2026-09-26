/**
 * One open thread's history, kept whole while the reader is on it: every
 * newest page the poll brings is merged in, gaps it leaves are filled, and
 * older pages load on request. history.ts decides what each page means; this
 * hook only runs the fetches and feeds the pages back in, so every client
 * (web, mobile, the desktop app) gets the same history from the same polls.
 *
 * It holds one visit to one conversation at a time. A visit ends, and the
 * hook starts over as a fresh mount would, when:
 * - the thread changes (`threadKey`), or whatever else names it (`scope`,
 *   such as the workspace: one key can name a different thread in each);
 * - the host's page source is reset: `newestPage` goes back to undefined
 *   after a page arrived, which a query library does when its cache is
 *   reset (a workspace switch resets every query).
 * Every change the hook makes is tagged with the visit it belongs to and
 * dropped once that visit is over, so a fetch that finishes late can never
 * land in another visit's history, even one to the same thread.
 * (The mobile app hit both: a deep link reused an open thread's screen for
 * another thread, and a workspace switch kept one workspace's messages under
 * the same key in the next — Lumen, #679.)
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
   * Whatever else names the conversation besides its key, such as the
   * workspace: the same key can be a different thread in another one.
   */
  scope?: string | null;
  /**
   * The thread's newest page, as the poll last returned it. A new object is a
   * new page. It must be this thread's: a query keyed by the thread key
   * gives exactly that. Undefined after a page has arrived means the source
   * was reset, and the history starts over.
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

/** Everything the hook holds for one visit. */
interface Tracked {
  /** Which conversation: the key and its scope. */
  identity: string;
  /** Which visit to it. Every change names the visit it belongs to. */
  visit: number;
  openingCursor: string | null;
  history: ThreadHistory;
  /** The newest page already merged in. */
  absorbed: ThreadMessagesResponse | undefined;
  loadingOlder: boolean;
  error: string | null;
}

function fresh(identity: string, openingCursor: string | null, visit: number): Tracked {
  return {
    identity,
    visit,
    openingCursor,
    history: EMPTY_HISTORY,
    absorbed: undefined,
    loadingOlder: false,
    error: null,
  };
}

const identityOf = (threadKey: string, scope: string | null | undefined): string =>
  JSON.stringify([scope ?? null, threadKey]);

const messageOf = (failure: unknown, fallback: string): string =>
  failure instanceof Error ? failure.message : fallback;

export function useThreadHistory(input: ThreadHistoryInput): ThreadHistoryState {
  const { newestPage, newestPageAt, newestPageLoading } = input;
  const identity = identityOf(input.threadKey, input.scope);

  const [tracked, setTracked] = useState<Tracked>(() => fresh(identity, input.openingCursor, 0));
  // A change to one visit. Dropped once that visit is over, which is what
  // keeps a late fetch out of the next visit's history.
  const update = useCallback(
    (forVisit: number, change: (state: Tracked) => Tracked) =>
      setTracked((state) => (state.visit === forVisit ? change(state) : state)),
    []
  );

  // The latest fetcher, so a caller passing a fresh function each render
  // does not restart a fetch already in flight.
  const fetchOlderRef = useRef(input.fetchOlder);
  useEffect(() => {
    fetchOlderRef.current = input.fetchOlder;
  });

  // Another conversation, or a page source that was reset, starts a new
  // visit, as a fresh mount would.
  let current = tracked;
  const sourceReset = newestPage === undefined && tracked.absorbed !== undefined;
  if (tracked.identity !== identity || sourceReset) {
    current = fresh(identity, input.openingCursor, tracked.visit + 1);
    setTracked(current);
  }
  const { visit, history } = current;

  // Every newest page is merged into the history in the render it arrives,
  // so no poll ever shows the conversation without rows it had a moment ago.
  if (newestPage && newestPage !== current.absorbed) {
    update(visit, (state) => ({
      ...state,
      absorbed: newestPage,
      history: absorbNewest(state.history, newestPage, state.openingCursor),
    }));
  }

  // Every successful poll — even one that brought nothing new, which hands
  // back the same page object — is the server answering: retry what failed.
  useEffect(() => {
    if (newestPageAt) {
      update(visit, (state) => ({ ...state, history: unblockGaps(state.history) }));
    }
  }, [newestPageAt, visit, update]);

  // Work the history's gaps one at a time: the catch-up to the read cursor
  // on open, and any stretch a poll skipped. Paused and blocked gaps wait.
  const gap = nextGap(history);
  useEffect(() => {
    if (!gap) return;
    let cancelled = false;
    fetchOlderRef
      .current(gap.beforeId)
      .then((page) => {
        if (cancelled) return;
        update(visit, (state) => ({
          ...state,
          history: absorbOlder(state.history, page, gap),
        }));
      })
      .catch((failure: unknown) => {
        if (cancelled) return;
        update(visit, (state) => ({
          ...state,
          error: messageOf(failure, 'Failed to load messages'),
          history: failGap(state.history, gap),
        }));
      });
    return () => {
      cancelled = true;
    };
  }, [gap, visit, update]);

  const loadOlder = useCallback(async () => {
    const oldest = history.messages[0];
    if (current.loadingOlder || !oldest) return;
    const catchUp = olderGap(history);
    update(visit, (state) => ({ ...state, loadingOlder: true, error: null }));
    try {
      const page = await fetchOlderRef.current(catchUp?.beforeId ?? oldest.id);
      update(visit, (state) => ({
        ...state,
        history: absorbOlder(state.history, page, catchUp),
      }));
    } catch (failure) {
      update(visit, (state) => ({
        ...state,
        error: messageOf(failure, 'Failed to load earlier messages'),
      }));
    } finally {
      update(visit, (state) => ({ ...state, loadingOlder: false }));
    }
  }, [current.loadingOlder, visit, history, update]);

  const abandonCatchUp = useCallback(
    () => update(visit, (state) => ({ ...state, history: dropCatchUp(state.history) })),
    [visit, update]
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
