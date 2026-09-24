/**
 * Where the person using this dashboard has read each thread up to.
 *
 * Kept in this browser for now. The server-side home for a person's read
 * pointer is inbox_thread_read_status itself — spec inkmail-thread-scope §3
 * gives a person their own row there, next to every SB's, and warns that a
 * second cursor store for humans would recreate the drift that spec exists
 * to end. Until that lands, this store answers the same question locally,
 * behind the same shape (a thread key → the createdAt of the newest message
 * seen), so moving it to the server swaps the storage and nothing else.
 */

import { useSyncExternalStore } from 'react';

export const READ_CURSORS_STORAGE_KEY = 'ink.threads.read-cursors.v1';

/** Oldest cursors are dropped past this many threads. */
const MAX_CURSORS = 2_000;

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

interface Stored {
  /**
   * When this browser started keeping cursors. A thread it has never
   * opened counts as read up to here: the first visit must not mark the
   * whole history unread.
   */
  baselineAt: string;
  cursors: Record<string, string>;
}

export interface ReadCursorStore {
  /** Read through this instant (ISO): the thread's cursor, or the baseline. */
  cursorFor: (threadKey: string) => string;
  /** Move a thread's cursor forward. Never moves it back. */
  advance: (threadKey: string, throughIso: string) => void;
  /** Re-read storage — another tab advanced a cursor. */
  reload: () => void;
  subscribe: (listener: () => void) => () => void;
  /** Changes whenever any cursor does; a render key for subscribers. */
  version: () => number;
}

function parse(raw: string | null): Stored | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const value = parsed as Partial<Stored>;
    if (typeof value.baselineAt !== 'string' || Number.isNaN(Date.parse(value.baselineAt))) {
      return null;
    }
    const cursors = Object.create(null) as Record<string, string>;
    if (value.cursors && typeof value.cursors === 'object') {
      for (const [key, at] of Object.entries(value.cursors)) {
        if (typeof at === 'string' && !Number.isNaN(Date.parse(at))) cursors[key] = at;
      }
    }
    return { baselineAt: value.baselineAt, cursors };
  } catch {
    return null;
  }
}

const has = (record: Record<string, string>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(record, key);

/**
 * Two copies of the cursors — this tab's and storage's — combined so neither
 * can move one backwards: per thread the later cursor, and the later baseline.
 *
 * Storage alone is not the truth. When a write fails (a full quota lets
 * getItem succeed while setItem throws) this tab's progress exists only in
 * memory, and taking storage's copy over it would silently un-read threads
 * (Lumen, #670 review).
 */
function mergeStored(local: Stored, persisted: Stored | null): Stored {
  if (!persisted) return local;
  const cursors = Object.create(null) as Record<string, string>;
  for (const source of [local.cursors, persisted.cursors]) {
    for (const [key, at] of Object.entries(source)) {
      if (!has(cursors, key) || Date.parse(at) > Date.parse(cursors[key])) cursors[key] = at;
    }
  }
  const baselineAt =
    Date.parse(persisted.baselineAt) > Date.parse(local.baselineAt)
      ? persisted.baselineAt
      : local.baselineAt;
  return { baselineAt, cursors };
}

export function createReadCursorStore(
  storage: StorageLike | null,
  now: () => Date = () => new Date()
): ReadCursorStore {
  const listeners = new Set<() => void>();
  let version = 0;

  const read = (): Stored | null => {
    try {
      return parse(storage?.getItem(READ_CURSORS_STORAGE_KEY) ?? null);
    } catch {
      return null;
    }
  };
  const write = (value: Stored) => {
    try {
      storage?.setItem(READ_CURSORS_STORAGE_KEY, JSON.stringify(value));
    } catch {
      // Private mode or a full quota: the cursors still work for this visit.
    }
  };

  let state: Stored = read() ?? {
    baselineAt: now().toISOString(),
    cursors: Object.create(null) as Record<string, string>,
  };
  write(state);

  const notify = () => {
    version += 1;
    for (const listener of listeners) listener();
  };

  const cursorFor = (threadKey: string): string =>
    has(state.cursors, threadKey) ? state.cursors[threadKey] : state.baselineAt;

  return {
    cursorFor,
    advance: (threadKey, throughIso) => {
      const through = Date.parse(throughIso);
      if (Number.isNaN(through)) return;
      // Another tab may have moved it further since this one last looked.
      state = mergeStored(state, read());
      if (through <= Date.parse(cursorFor(threadKey))) return;
      const cursors = { ...state.cursors, [threadKey]: throughIso };
      const keys = Object.keys(cursors);
      if (keys.length > MAX_CURSORS) {
        keys
          .sort((a, b) => Date.parse(cursors[a]) - Date.parse(cursors[b]))
          .slice(0, keys.length - MAX_CURSORS)
          .forEach((key) => delete cursors[key]);
      }
      state = { baselineAt: state.baselineAt, cursors };
      write(state);
      notify();
    },
    reload: () => {
      state = mergeStored(state, read());
      notify();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    version: () => version,
  };
}

let browserStore: ReadCursorStore | null = null;

function getBrowserStore(): ReadCursorStore {
  if (typeof window === 'undefined') return createReadCursorStore(null);
  if (!browserStore) {
    let storage: StorageLike | null = null;
    try {
      storage = window.localStorage;
    } catch {
      storage = null;
    }
    const store = createReadCursorStore(storage);
    window.addEventListener('storage', (event) => {
      if (event.key === READ_CURSORS_STORAGE_KEY) store.reload();
    });
    browserStore = store;
  }
  return browserStore;
}

/** The browser's read cursors; re-renders when any of them moves, in any tab. */
export function useReadCursors(): ReadCursorStore {
  const store = getBrowserStore();
  useSyncExternalStore(store.subscribe, store.version, () => 0);
  return store;
}

/** A thread has news for the viewer: its newest message is someone else's, after their cursor. */
export function hasUnread(
  lastMessage: { createdAt: string; sentByUser: boolean } | null | undefined,
  cursor: string
): boolean {
  if (!lastMessage || lastMessage.sentByUser) return false;
  return Date.parse(lastMessage.createdAt) > Date.parse(cursor);
}
