// @vitest-environment jsdom
/**
 * What the reader is marked as having read, with the REAL ConversationView
 * and its positioning and read effects. Only the API, the composer and the
 * scroll geometry are stand-ins: 20px per row and a 400px view, so "at the
 * end" means something. The first scenario is Lumen's round-3 probe on
 * #670 — with the view mocked, every earlier test passed while a reader
 * pinned at the end was acknowledged past a stretch that had not loaded.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createReadCursorStore } from './read-cursors';
import type { ThreadMessagesResponse, ThreadSpine } from '@inklabs/shared/stories/threads-api';

const fake = vi.hoisted(() => ({
  page: undefined as unknown,
  apiGet: vi.fn(),
  updated: 1,
}));
vi.mock('@/lib/api', () => ({
  useApiQuery: () => ({
    data: fake.page,
    dataUpdatedAt: fake.updated,
    isLoading: fake.page === undefined,
  }),
  apiGet: (path: string) => fake.apiGet(path) as Promise<unknown>,
}));
vi.mock('./reply-composer', () => ({ ReplyComposer: () => null }));
vi.mock('./reopen-button', () => ({ ReopenThreadButton: () => null }));

import { ThreadConversation } from './thread-conversation';

const at = (n: number) => new Date(Date.UTC(2026, 8, 22, 0, n)).toISOString();
function page(lo: number, hi: number): ThreadMessagesResponse {
  return {
    thread: null,
    messages: Array.from({ length: hi - lo + 1 }, (_, j) => ({
      id: `m${lo + j}`,
      senderKind: 'sb' as const,
      senderSlug: 'wren',
      content: `Message ${lo + j}`,
      messageType: 'message',
      priority: 'normal',
      createdAt: at(lo + j),
    })),
    meta: { fetched: hi - lo + 1, total: hi, truncated: lo > 1 },
  };
}
const olderThan = (path: string) => Number(/before=m(\d+)/.exec(path)?.[1] ?? '0') - 1;

const spine = {
  key: 'fixture:thread:read-gap',
  sources: ['thread'],
  thread: null,
  participants: [],
  sessions: [],
  studios: [],
  taskGroups: [],
  identity: null,
  lastActivityAt: at(200),
} as ThreadSpine;

const saved = new Map<string, PropertyDescriptor | undefined>();
beforeEach(() => {
  const tops = new WeakMap<HTMLElement, number>();
  for (const key of ['scrollHeight', 'clientHeight', 'scrollTop']) {
    saved.set(key, Object.getOwnPropertyDescriptor(HTMLElement.prototype, key));
  }
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.querySelectorAll('[data-message-id]').length * 20 + 100;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get: () => 400,
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
    configurable: true,
    get(this: HTMLElement) {
      return tops.get(this) ?? 0;
    },
    set(this: HTMLElement, n: number) {
      tops.set(this, Math.max(0, Math.min(n, this.scrollHeight - this.clientHeight)));
    },
  });
});
afterEach(() => {
  cleanup();
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(HTMLElement.prototype, key, descriptor);
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[key];
  }
  fake.apiGet.mockReset();
});

function mount(cursorAt: string) {
  const cursors = createReadCursorStore(null, () => new Date(cursorAt));
  const ui = () => (
    <ThreadConversation
      spine={spine}
      nameFor={(s) => s}
      cursors={cursors}
      onBack={() => {}}
      detailsOpen={false}
      onToggleDetails={() => {}}
    />
  );
  const view = render(ui());
  return { cursors, rerender: () => view.rerender(ui()) };
}

const fromEnd = (log: HTMLElement) => log.scrollHeight - log.scrollTop - log.clientHeight;

describe('read acknowledgment against a history with holes', () => {
  it('acknowledges only up to a stretch still missing, and past it once filled', async () => {
    fake.page = page(101, 200);
    fake.updated = 1;
    let complete!: (p: ThreadMessagesResponse) => void;
    fake.apiGet.mockImplementation(
      () => new Promise<ThreadMessagesResponse>((resolve) => (complete = resolve))
    );
    const { cursors, rerender } = mount(at(200));
    const log = screen.getByRole('log');
    expect(fromEnd(log)).toBe(0);

    // A poll jumps ahead; 201–250 are missing until the backfill returns.
    fake.page = page(251, 350);
    fake.updated = 2;
    rerender();
    await waitFor(() =>
      expect(fake.apiGet).toHaveBeenCalledWith(expect.stringContaining('before=m251'))
    );
    expect(document.querySelector('[data-message-id="m225"]')).toBeNull();
    expect(
      cursors.cursorFor(spine.key),
      'Must not mark missing 201–250 read before the backfill even returns'
    ).toBe(at(200));

    await act(async () => {
      complete(page(151, 250));
      await Promise.resolve();
    });
    expect(document.querySelector('[data-message-id="m225"]')).not.toBeNull();
    // Still pinned — the filled stretch grew the content above, not the end
    // — and with the history whole, the reader is read through the newest.
    expect(fromEnd(log)).toBe(0);
    await waitFor(() => expect(cursors.cursorFor(spine.key)).toBe(at(350)));
  });

  it('never acknowledges past unread messages a paused catch-up has not loaded', async () => {
    // Pages of ten: the catch-up's limit is in pages, and six hundred
    // markdown rows are more than jsdom renders in a test's time.
    const small = (to: number) => page(Math.max(1, to - 9), to);
    fake.page = small(100);
    fake.apiGet.mockImplementation((path: string) => Promise.resolve(small(olderThan(path))));
    const { cursors } = mount(at(5));
    await screen.findByRole('button', { name: 'Load earlier unread messages' });
    expect(document.querySelector('[data-message-id="m6"]')).toBeNull();

    const log = screen.getByRole('log');
    log.scrollTop = log.scrollHeight;
    fireEvent.scroll(log);
    expect(fromEnd(log)).toBe(0);
    // At the end, page visible — and still not read past the cursor,
    // because 6–40 were never loaded.
    expect(cursors.cursorFor(spine.key)).toBe(at(5));

    // The explicit way past them.
    fireEvent.click(screen.getByRole('button', { name: 'Mark all read' }));
    expect(cursors.cursorFor(spine.key)).toBe(at(100));
    expect(screen.queryByRole('button', { name: 'Load earlier unread messages' })).toBeNull();
  });
});
