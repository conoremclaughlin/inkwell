/**
 * Switching workspace must leave every mounted screen with FRESH data and a
 * settled fetch state. The first version evicted the queries (removeQueries)
 * and a screen that was observing one kept spinning forever — TanStack's
 * documented caveat, seen live in the simulator. This mounts a real observer
 * and drives the switch against it, which is the only test that would have
 * caught that.
 *
 * One subscription per observer for the whole test: a QueryObserver whose
 * listener count drops to zero refetches on the next subscribe, and that
 * mount-refetch would show up in the recording as if the switch caused it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryObserver } from '@tanstack/react-query';

vi.hoisted(() => {
  (globalThis as Record<string, unknown>).__DEV__ = true;
});
vi.mock('expo-constants', () => ({ default: { expoConfig: { hostUri: '10.0.0.5:8081' } } }));
vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(async () => null),
  setItemAsync: vi.fn(async () => undefined),
  deleteItemAsync: vi.fn(async () => undefined),
}));
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => undefined),
    removeItem: vi.fn(async () => undefined),
  },
}));

import { resetQueriesForWorkspaceSwitch } from './useInkwell';

interface Seen<T> {
  data: T | undefined;
  fetchStatus: string;
}

/** Subscribe once; record every result; wait for predicates over the log. */
function record<T, K extends readonly unknown[]>(observer: QueryObserver<T, Error, T, T, K>) {
  const seen: Seen<T>[] = [];
  const waiters: Array<{ pred: (s: Seen<T>) => boolean; resolve: () => void }> = [];
  const unsubscribe = observer.subscribe((r) => {
    const entry = { data: r.data, fetchStatus: r.fetchStatus };
    seen.push(entry);
    for (const w of [...waiters]) {
      if (w.pred(entry)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve();
      }
    }
  });
  const waitFor = (pred: (s: Seen<T>) => boolean, label: string): Promise<void> => {
    if (seen.some(pred)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`never saw ${label}`)), 1500);
      waiters.push({
        pred,
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
      });
    });
  };
  const idleWith = (data: T) => (s: Seen<T>) => s.fetchStatus === 'idle' && s.data === data;
  return { seen, waitFor, idleWith, unsubscribe };
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

function makeClient() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  cleanups.push(() => client.clear());
  return client;
}

describe('resetQueriesForWorkspaceSwitch', () => {
  it('leaves mounted observers settled with the NEW workspace data', async () => {
    const client = makeClient();
    let workspace = 'A';
    const threads = record(
      new QueryObserver(client, {
        queryKey: ['threads'],
        queryFn: async () => `threads-of-${workspace}`,
      })
    );
    const workspaces = record(
      new QueryObserver(client, {
        queryKey: ['workspaces'],
        queryFn: async () => `list-${workspace}`,
      })
    );
    cleanups.push(threads.unsubscribe, workspaces.unsubscribe);

    await threads.waitFor(threads.idleWith('threads-of-A'), 'threads A');
    await workspaces.waitFor(workspaces.idleWith('list-A'), 'workspaces A');

    workspace = 'B';
    await resetQueriesForWorkspaceSwitch(client);

    // Threads was reset — its observer refetched and is idle with B's data.
    await threads.waitFor(threads.idleWith('threads-of-B'), 'threads B');
    // Workspaces was only invalidated, and also refetched.
    await workspaces.waitFor(workspaces.idleWith('list-B'), 'workspaces B');
  });

  it('goes blank while refetching instead of showing the old workspace', async () => {
    const client = makeClient();
    let calls = 0;
    const sessions = record(
      new QueryObserver(client, {
        queryKey: ['sessions'],
        queryFn: async () => {
          calls += 1;
          return calls === 1 ? 'old' : 'new';
        },
      })
    );
    cleanups.push(sessions.unsubscribe);
    await sessions.waitFor(sessions.idleWith('old'), 'old');
    const before = sessions.seen.length;

    await resetQueriesForWorkspaceSwitch(client);
    await sessions.waitFor(sessions.idleWith('new'), 'new');

    const during = sessions.seen.slice(before);
    const firstNew = during.findIndex((s) => s.data === 'new');
    expect(firstNew).toBeGreaterThan(0);
    const transition = during.slice(0, firstNew);
    // What a screen rendered between the switch and the new data: blank —
    // never the previous workspace with a spinner (that is what
    // invalidateQueries would have shown).
    expect(transition.some((s) => s.data === undefined)).toBe(true);
    expect(transition.some((s) => s.data === 'old')).toBe(false);
  });
});
