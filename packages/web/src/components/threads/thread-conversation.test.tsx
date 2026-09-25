// @vitest-environment jsdom
/**
 * ThreadConversation's hand-off to the view: which messages it passes, and
 * when it says they are ready to position. The view itself is replaced by a
 * probe that records its props, because these failures are about the data
 * the view is given, not how it scrolls — both were found by Lumen on #670
 * in Chromium, and the first scenario is Lumen's regression probe.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createReadCursorStore } from './read-cursors';
import type { ThreadMessagesResponse, ThreadSpine } from '@inklabs/shared/stories/threads-api';

const fake = vi.hoisted(() => ({
  newest: undefined as unknown,
  /** When the poll last succeeded; a new value with the same page is a quiet poll. */
  updatedAt: 0,
  apiGet: vi.fn(),
  viewProps: [] as Array<{
    loading: boolean;
    ids: string[];
    hasOlder: boolean;
    unreadBeyond: boolean;
  }>,
}));

vi.mock('@/lib/api', () => ({
  useApiQuery: () => ({
    data: fake.newest,
    dataUpdatedAt: fake.updatedAt,
    isLoading: fake.newest === undefined,
  }),
  apiGet: (path: string) => fake.apiGet(path) as Promise<unknown>,
}));
vi.mock('./reply-composer', () => ({ ReplyComposer: () => null }));
vi.mock('./reopen-button', () => ({ ReopenThreadButton: () => null }));
vi.mock('@/components/conversation/conversation-view', () => ({
  ConversationView: (props: {
    messages: Array<{ id: string }>;
    loading: boolean;
    hasOlder: boolean;
    unreadBeyond: boolean;
    onLoadOlder: () => void;
  }) => {
    fake.viewProps.push({
      loading: props.loading,
      ids: props.messages.map((m) => m.id),
      hasOlder: props.hasOlder,
      unreadBeyond: props.unreadBeyond,
    });
    return (
      <div>
        <button type="button" onClick={props.onLoadOlder}>
          Load
        </button>
        <span data-testid="loading">{String(props.loading)}</span>
        <span data-testid="hasOlder">{String(props.hasOlder)}</span>
        <span data-testid="unreadBeyond">{String(props.unreadBeyond)}</span>
        {props.messages.map((m) => (
          <div key={m.id} data-testid={m.id} />
        ))}
      </div>
    );
  },
}));

import { ThreadConversation } from './thread-conversation';

const at = (i: number) => new Date(Date.UTC(2026, 8, 22, 0, i)).toISOString();

/** The server's paging: newest 100 of 1..latest, or the 100 before a message. */
function pageOf(from: number, to: number): ThreadMessagesResponse {
  const start = Math.max(from, to - 99);
  return {
    thread: null,
    messages: Array.from({ length: Math.max(0, to - start + 1) }, (_, j) => ({
      id: `m${start + j}`,
      senderKind: 'sb' as const,
      senderSlug: 'wren',
      content: `Message ${start + j}`,
      createdAt: at(start + j),
      messageType: 'message',
      priority: 'normal',
    })),
    meta: { fetched: to - start + 1, total: to, truncated: start > 1 },
  };
}
const olderThan = (path: string) => Number(/before=m(\d+)/.exec(path)?.[1] ?? '0') - 1;

const spine = {
  key: 'fixture:thread:review',
  sources: ['thread'],
  thread: null,
  participants: [],
  sessions: [],
  studios: [],
  taskGroups: [],
  identity: null,
  lastActivityAt: at(200),
} as ThreadSpine;

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
  const rendered = render(ui());
  return { rerender: () => rendered.rerender(ui()) };
}

afterEach(() => {
  cleanup();
  fake.apiGet.mockReset();
  fake.updatedAt = 0;
  fake.viewProps = [];
});

describe('ThreadConversation', () => {
  it('keeps the rows a poll rolls past, after older history is exhausted', async () => {
    fake.newest = pageOf(1, 200);
    fake.apiGet.mockImplementation((path: string) => Promise.resolve(pageOf(1, olderThan(path))));
    const view = mount(at(150));

    fireEvent.click(screen.getByRole('button', { name: 'Load' }));
    await waitFor(() => expect(screen.getByTestId('m1')).toBeTruthy());
    expect(screen.getByTestId('hasOlder').textContent).toBe('false');

    fake.newest = pageOf(1, 201);
    view.rerender();
    expect(screen.getByTestId('m201')).toBeTruthy();
    expect(
      screen.queryByTestId('m101'),
      'Message 101 must survive the poll after older history is exhausted'
    ).not.toBeNull();
  });

  it('fills the stretch a poll skipped, with no request from the reader', async () => {
    fake.newest = pageOf(1, 200);
    fake.apiGet.mockImplementation((path: string) => Promise.resolve(pageOf(1, olderThan(path))));
    const view = mount(at(200));
    expect(screen.getByTestId('m200')).toBeTruthy();

    fake.newest = pageOf(1, 350);
    view.rerender();
    await waitFor(() => expect(screen.getByTestId('m225')).toBeTruthy());
    for (const n of [101, 200, 201, 250, 251, 350]) {
      expect(screen.queryByTestId(`m${n}`), `m${n}`).not.toBeNull();
    }
  });

  it('retries a failed fill once a poll succeeds, even a poll that brought nothing new', async () => {
    fake.newest = pageOf(1, 200);
    fake.updatedAt = 1;
    let down = true;
    fake.apiGet.mockImplementation((path: string) =>
      down ? Promise.reject(new Error('network down')) : Promise.resolve(pageOf(1, olderThan(path)))
    );
    const view = mount(at(200));

    fake.newest = pageOf(1, 350);
    fake.updatedAt = 2;
    view.rerender();
    await waitFor(() => expect(screen.getByText('network down')).toBeTruthy());
    expect(screen.queryByTestId('m225')).toBeNull();

    // The server answers again, and the poll hands back the same page.
    down = false;
    fake.updatedAt = 3;
    view.rerender();
    await waitFor(() => expect(screen.getByTestId('m225')).toBeTruthy());
  });

  /**
   * Cursor at 50, 200 messages. The view must not be told it can position
   * until the history reaches the cursor: positioned on the newest page, it
   * opened at 101 and the real boundary (51) ended up thousands of pixels
   * offscreen once the older page arrived as an ordinary prepend.
   */
  it('holds the view until the history reaches the read cursor', async () => {
    fake.newest = pageOf(1, 200);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    fake.apiGet.mockImplementation(async (path: string) => {
      await gate;
      return pageOf(1, olderThan(path));
    });
    mount(at(50));

    expect(screen.getByTestId('loading').textContent).toBe('true');
    expect(fake.apiGet).toHaveBeenCalledWith(expect.stringContaining('before=m101'));
    await act(async () => {
      release();
      await gate;
    });

    await waitFor(() => expect(screen.getByTestId('loading').textContent).toBe('false'));
    // Never ready without the boundary: every render that said "position
    // now" already held message 51.
    const readyRenders = fake.viewProps.filter((p) => !p.loading);
    expect(readyRenders.length).toBeGreaterThan(0);
    expect(readyRenders.every((p) => p.ids.includes('m51'))).toBe(true);
  });

  /**
   * Lumen's round-2 shape: 669 messages, cursor at 50. The catch-up stops at
   * its page limit and the view opens — but is told unread messages remain
   * above, and nothing loads further until the reader asks.
   */
  it('opens a paused catch-up as incomplete, and continues it on request', async () => {
    fake.newest = pageOf(1, 669);
    fake.apiGet.mockImplementation((path: string) => Promise.resolve(pageOf(1, olderThan(path))));
    mount(at(50));

    await waitFor(() => expect(screen.getByTestId('loading').textContent).toBe('false'));
    expect(screen.getByTestId('unreadBeyond').textContent).toBe('true');
    expect(screen.queryByTestId('m51')).toBeNull();
    const fetchedOnOpen = fake.apiGet.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fake.apiGet.mock.calls.length, 'nothing more loads unasked').toBe(fetchedOnOpen);

    fireEvent.click(screen.getByRole('button', { name: 'Load' }));
    await waitFor(() => expect(screen.getByTestId('unreadBeyond').textContent).toBe('false'));
    expect(screen.getByTestId('m51')).toBeTruthy();
  });

  it('is ready at once when the newest page covers the cursor', () => {
    fake.newest = pageOf(1, 200);
    mount(at(150));
    expect(screen.getByTestId('loading').textContent).toBe('false');
    expect(fake.apiGet).not.toHaveBeenCalled();
  });
});
