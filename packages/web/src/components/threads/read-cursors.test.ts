import { describe, expect, it } from 'vitest';
import { hasUnread } from '@inklabs/shared/stories/thread-read-state';
import { createReadCursorStore, READ_CURSORS_STORAGE_KEY } from './read-cursors';

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
    expect(
      hasUnread({ createdAt: T0, isOwn: false, senderKind: 'sb' }, store.cursorFor('pr:1'))
    ).toBe(false);
    expect(
      hasUnread({ createdAt: T2, isOwn: false, senderKind: 'sb' }, store.cursorFor('pr:1'))
    ).toBe(true);
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

  it('moves forward by microseconds, which Date.parse cannot see', () => {
    const store = createReadCursorStore(memoryStorage(), () => new Date(T0));
    store.advance('pr:1', '2026-09-23T11:00:00.123100+00:00');
    store.advance('pr:1', '2026-09-23T11:00:00.123900+00:00');
    expect(store.cursorFor('pr:1')).toBe('2026-09-23T11:00:00.123900+00:00');
    expect(
      hasUnread(
        { createdAt: '2026-09-23T11:00:00.123950+00:00', isOwn: false, senderKind: 'sb' },
        store.cursorFor('pr:1')
      )
    ).toBe(true);
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

  /**
   * A full quota lets getItem succeed while setItem throws, so storage holds
   * a stale copy and this tab's progress lives only in memory. Taking the
   * stale copy on the next read un-reads threads (Lumen, #670 review). The
   * all-throwing test above cannot see this: its reads fail too.
   */
  describe('when storage reads but will not write', () => {
    const readOnly = () => {
      const saved = JSON.stringify({ baselineAt: T0, cursors: {} });
      return {
        getItem: () => saved,
        setItem: () => {
          throw new Error('QuotaExceededError');
        },
      };
    };

    it('keeps one thread’s progress when another thread advances', () => {
      const store = createReadCursorStore(readOnly());
      store.advance('pr:a', T1);
      store.advance('pr:b', T2);
      expect(store.cursorFor('pr:a')).toBe(T1);
      expect(store.cursorFor('pr:b')).toBe(T2);
    });

    it('does not move a thread back when it is advanced to an older point', () => {
      const store = createReadCursorStore(readOnly());
      store.advance('pr:a', T2);
      store.advance('pr:a', T1);
      expect(store.cursorFor('pr:a')).toBe(T2);
    });

    it('keeps unsaved progress through a reload from another tab', () => {
      const store = createReadCursorStore(readOnly());
      store.advance('pr:a', T2);
      store.reload();
      expect(store.cursorFor('pr:a')).toBe(T2);
    });
  });

  it('takes another tab’s newer cursor on reload without losing its own', () => {
    const storage = memoryStorage();
    const tabA = createReadCursorStore(storage, () => new Date(T0));
    const tabB = createReadCursorStore(storage, () => new Date(T0));
    tabA.advance('pr:1', T1);
    tabB.advance('pr:2', T2);
    tabA.reload();
    expect(tabA.cursorFor('pr:1')).toBe(T1);
    expect(tabA.cursorFor('pr:2')).toBe(T2);
  });

  it('reads a thread key named like an Object prototype member as a thread, not a builtin', () => {
    const store = createReadCursorStore(memoryStorage(), () => new Date(T0));
    expect(store.cursorFor('constructor')).toBe(T0);
    expect(store.cursorFor('__proto__')).toBe(T0);
  });
});
