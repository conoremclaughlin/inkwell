import { describe, expect, it } from 'vitest';
import { createReadCursorStore, hasUnread, READ_CURSORS_STORAGE_KEY } from './read-cursors';

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    data,
  };
}

const T0 = '2026-09-23T10:00:00.000Z';
const T1 = '2026-09-23T11:00:00.000Z';
const T2 = '2026-09-23T12:00:00.000Z';

describe('read cursor store', () => {
  it('treats every thread as read up to the first visit, so history is not all "new"', () => {
    const store = createReadCursorStore(memoryStorage(), () => new Date(T1));
    expect(store.cursorFor('pr:1')).toBe(T1);
    expect(hasUnread({ createdAt: T0, sentByUser: false }, store.cursorFor('pr:1'))).toBe(false);
    expect(hasUnread({ createdAt: T2, sentByUser: false }, store.cursorFor('pr:1'))).toBe(true);
  });

  it('keeps its baseline across visits instead of resetting it', () => {
    const storage = memoryStorage();
    createReadCursorStore(storage, () => new Date(T0));
    const later = createReadCursorStore(storage, () => new Date(T2));
    expect(later.cursorFor('pr:1')).toBe(T0);
  });

  it('only ever moves a cursor forward', () => {
    const store = createReadCursorStore(memoryStorage(), () => new Date(T0));
    store.advance('pr:1', T2);
    store.advance('pr:1', T1);
    expect(store.cursorFor('pr:1')).toBe(T2);
  });

  it('persists cursors per thread, and another tab’s advance wins over a stale one', () => {
    const storage = memoryStorage();
    const tabA = createReadCursorStore(storage, () => new Date(T0));
    const tabB = createReadCursorStore(storage, () => new Date(T0));
    tabA.advance('pr:1', T2);
    // Tab B never reloaded, but must not write T1 over A's T2.
    tabB.advance('pr:1', T1);
    expect(createReadCursorStore(storage).cursorFor('pr:1')).toBe(T2);
    expect(createReadCursorStore(storage).cursorFor('pr:2')).toBe(T0);
  });

  it('notifies subscribers when a cursor moves, and not when it does not', () => {
    const store = createReadCursorStore(memoryStorage(), () => new Date(T0));
    let calls = 0;
    store.subscribe(() => (calls += 1));
    store.advance('pr:1', T1);
    store.advance('pr:1', T0);
    expect(calls).toBe(1);
    expect(store.version()).toBe(1);
  });

  it('starts fresh from unreadable storage rather than failing', () => {
    const corrupt = memoryStorage({ [READ_CURSORS_STORAGE_KEY]: '{not json' });
    expect(createReadCursorStore(corrupt, () => new Date(T1)).cursorFor('pr:1')).toBe(T1);

    const throwing = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    const store = createReadCursorStore(throwing, () => new Date(T0));
    store.advance('pr:1', T1);
    expect(store.cursorFor('pr:1')).toBe(T1);
  });

  it('reads a thread key named like an Object prototype member as a thread, not a builtin', () => {
    const store = createReadCursorStore(memoryStorage(), () => new Date(T0));
    expect(store.cursorFor('constructor')).toBe(T0);
    expect(store.cursorFor('__proto__')).toBe(T0);
  });
});

describe('hasUnread', () => {
  it('never counts the viewer’s own message, or a thread with no messages', () => {
    expect(hasUnread({ createdAt: T2, sentByUser: true }, T0)).toBe(false);
    expect(hasUnread(null, T0)).toBe(false);
    expect(hasUnread(undefined, T0)).toBe(false);
  });
});
