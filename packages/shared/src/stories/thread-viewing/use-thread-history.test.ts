// @vitest-environment jsdom
/**
 * useThreadHistory's own contract, beside it: what the hook does with the
 * fetcher, the opening cursor and a thread that unmounts mid-fetch. The web
 * page's tests reach the hook through a component; these reach it directly,
 * as any client (the phone, the desktop app) will.
 *
 * Probes by Lumen from the #677 review, adopted as written apart from
 * formatting and imports.
 */
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { ThreadMessagesResponse } from '../threads-api/index.js';
import { useThreadHistory } from './use-thread-history.js';

const at = (n: number) => new Date(Date.UTC(2026, 8, 22, 0, n)).toISOString();
const page = (lo: number, hi: number): ThreadMessagesResponse => ({
  thread: null,
  messages: Array.from({ length: hi - lo + 1 }, (_, i) => ({
    id: `m${lo + i}`,
    senderKind: 'sb',
    senderSlug: 'fixture-sb',
    content: `Synthetic ${lo + i}`,
    createdAt: at(lo + i),
    messageType: 'message',
    priority: 'normal',
  })),
  meta: { fetched: hi - lo + 1, total: hi, truncated: lo > 1 },
});
const deferred = () => {
  let resolve!: (p: ThreadMessagesResponse) => void;
  const promise = new Promise<ThreadMessagesResponse>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
afterEach(cleanup);

it('keeps the in-flight gap when the fetcher changes, then uses the latest fetcher', async () => {
  const pending = deferred();
  const first = vi.fn(() => pending.promise);
  const second = vi.fn(async () => page(1, 10));
  const newest = page(21, 30);
  const input = {
    threadKey: 'fixture:thread:a',
    newestPage: newest,
    newestPageAt: 1,
    newestPageLoading: false,
    openingCursor: at(5),
    fetchOlder: first,
  };
  const view = renderHook((props) => useThreadHistory(props), { initialProps: input });
  expect(first).toHaveBeenCalledExactlyOnceWith('m21');
  view.rerender({ ...input, fetchOlder: second });
  expect(second).not.toHaveBeenCalled();
  await act(async () => {
    pending.resolve(page(11, 20));
  });
  await waitFor(() => expect(view.result.current.opening).toBe(false));
  expect(first).toHaveBeenCalledTimes(1);
  expect(second).toHaveBeenCalledExactlyOnceWith('m11');
  expect(view.result.current.history.messages).toHaveLength(30);
});

it('manual paging also uses the latest committed fetcher', async () => {
  const first = vi.fn(async () => page(1, 10));
  const second = vi.fn(async () => page(1, 10));
  const input = {
    threadKey: 'fixture:thread:a',
    newestPage: page(11, 20),
    newestPageAt: 1,
    newestPageLoading: false,
    openingCursor: at(20),
    fetchOlder: first,
  };
  const view = renderHook((props) => useThreadHistory(props), { initialProps: input });
  view.rerender({ ...input, fetchOlder: second });
  await act(async () => {
    await view.result.current.loadOlder();
  });
  expect(first).not.toHaveBeenCalled();
  expect(second).toHaveBeenCalledExactlyOnceWith('m11');
  expect(view.result.current.history.messages).toHaveLength(20);
});

it('holds the original opening cursor despite an updated cursor prop', async () => {
  const first = vi.fn(async () => page(1, 10));
  const input = {
    threadKey: 'fixture:thread:a',
    newestPage: undefined as ThreadMessagesResponse | undefined,
    newestPageAt: 0,
    newestPageLoading: true,
    openingCursor: at(5),
    fetchOlder: first,
  };
  const view = renderHook((props) => useThreadHistory(props), { initialProps: input });
  view.rerender({
    ...input,
    threadKey: 'fixture:thread:a',
    newestPage: page(11, 20),
    newestPageAt: 1,
    newestPageLoading: false,
    openingCursor: at(20),
  });
  await waitFor(() => expect(view.result.current.opening).toBe(false));
  expect(first).toHaveBeenCalledExactlyOnceWith('m11');
  expect(view.result.current.history.messages).toHaveLength(20);
});

it('keeps late results from an unmounted thread out of a new mount', async () => {
  const old = deferred();
  const fetchOlder = vi.fn(() => old.promise);
  const newest = page(11, 20);
  const first = renderHook(() =>
    useThreadHistory({
      threadKey: 'fixture:thread:a',
      newestPage: newest,
      newestPageAt: 1,
      newestPageLoading: false,
      openingCursor: at(5),
      fetchOlder,
    })
  );
  expect(fetchOlder).toHaveBeenCalledExactlyOnceWith('m11');
  first.unmount();
  const nextPage = page(31, 40);
  const second = renderHook(() =>
    useThreadHistory({
      threadKey: 'fixture:thread:a',
      newestPage: nextPage,
      newestPageAt: 1,
      newestPageLoading: false,
      openingCursor: at(40),
      fetchOlder,
    })
  );
  await act(async () => {
    old.resolve(page(1, 10));
  });
  expect(second.result.current.history.messages).toHaveLength(10);
  expect(second.result.current.history.messages[0].id).toBe('m31');
  expect(fetchOlder).toHaveBeenCalledTimes(1);
});

// ─── One mount, two threads ─────────────────────────────────────────────────
// The mobile app reused an open thread's screen for another thread (a deep
// link), and the first thread's messages showed in the second.

const otherThread = (lo: number, hi: number): ThreadMessagesResponse => {
  const base = page(lo, hi);
  return { ...base, messages: base.messages.map((m) => ({ ...m, id: `other-${m.id}` })) };
};

it('starts over when the same mount is given another thread', async () => {
  const fetchOlder = vi.fn(async () => page(1, 10));
  const input = {
    threadKey: 'fixture:thread:a',
    newestPage: page(11, 20),
    newestPageAt: 1,
    newestPageLoading: false,
    openingCursor: at(20),
    fetchOlder,
  };
  const view = renderHook((props) => useThreadHistory(props), { initialProps: input });
  expect(view.result.current.history.messages).toHaveLength(10);

  view.rerender({
    ...input,
    threadKey: 'fixture:thread:b',
    newestPage: otherThread(1, 3),
    newestPageAt: 2,
  });
  const ids = view.result.current.history.messages.map((m) => m.id);
  expect(ids).toEqual(['other-m1', 'other-m2', 'other-m3']);
  expect(view.result.current.history.oldestReached).toBe(true);
});

it('drops an older page that finishes after the thread changed', async () => {
  const pending = deferred();
  const fetchOlder = vi.fn(() => pending.promise);
  const input = {
    threadKey: 'fixture:thread:a',
    newestPage: page(11, 20),
    newestPageAt: 1,
    newestPageLoading: false,
    openingCursor: at(20),
    fetchOlder,
  };
  const view = renderHook((props) => useThreadHistory(props), { initialProps: input });
  let loading!: Promise<void>;
  act(() => {
    loading = view.result.current.loadOlder();
  });
  expect(fetchOlder).toHaveBeenCalledExactlyOnceWith('m11');

  view.rerender({
    ...input,
    threadKey: 'fixture:thread:b',
    newestPage: otherThread(1, 3),
    newestPageAt: 2,
  });
  await act(async () => {
    pending.resolve(page(1, 10));
    await loading;
  });
  const ids = view.result.current.history.messages.map((m) => m.id);
  expect(ids).toEqual(['other-m1', 'other-m2', 'other-m3']);
  expect(view.result.current.loadingOlder).toBe(false);
});
