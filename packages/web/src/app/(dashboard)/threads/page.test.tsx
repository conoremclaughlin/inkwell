// @vitest-environment jsdom
/**
 * The Threads list's order, through the real page: the server's spines in
 * the order it sends them, the page's own sort, and the rows it renders.
 * Only the HTTP client and the router are faked.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { threadMessagesPath, type ThreadSpine } from '@inklabs/shared/stories/threads-api';
import { setSelectedWorkspaceId } from '@/lib/workspace-selection';

const fake = vi.hoisted(() => ({
  spines: [] as unknown[],
  query: '',
  replace: vi.fn(),
  read: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: fake.replace }),
  usePathname: () => '/threads',
  useSearchParams: () => new URLSearchParams(fake.query),
}));

vi.mock('@/lib/api/client', () => ({
  apiGet: async (path: string, options?: { workspaceId: string | null }) => {
    if (path === '/api/admin/threads') {
      return {
        spines: fake.spines,
        meta: {
          threads: { fetched: fake.spines.length, total: fake.spines.length, truncated: false },
          sessions: { fetched: 0, total: 0, truncated: false },
          taskGroups: { fetched: 0, total: 0, truncated: false },
          parseUnavailable: false,
        },
      };
    }
    if (path === '/api/admin/individuals') return { individuals: [] };
    if (path.startsWith('/api/admin/threads/messages?')) return fake.read(path, options);
    throw new Error(`unexpected GET ${path}`);
  },
  apiPost: async () => ({}),
  apiPut: async () => ({}),
  apiPatch: async () => ({}),
  apiDelete: async () => ({}),
}));

import ThreadsPage from './page';

/** A thread whose newest message and last activity on its key are set apart. */
function spine(key: string, title: string, messageAt: string, activityAt: string): ThreadSpine {
  return {
    key,
    identity: null,
    thread: {
      title,
      status: 'open',
      createdBySlug: 'myra',
      participants: ['myra', 'wren'],
      closedAt: null,
      lastMessage: {
        id: `${key}-last`,
        senderKind: 'sb',
        senderSlug: 'myra',
        senderName: 'myra',
        isOwn: false,
        messageType: 'message',
        preview: 'Latest word',
        createdAt: messageAt,
      },
    },
    sessions: [],
    studios: [],
    taskGroups: [],
    participants: ['myra', 'wren'],
    sources: ['thread'],
    lastActivityAt: activityAt,
  };
}

beforeEach(() => {
  fake.spines = [];
  fake.query = '';
  fake.replace.mockReset();
  fake.read.mockReset();
  window.localStorage.clear();
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
});

afterEach(cleanup);

describe('Threads list order', () => {
  it('lists the newest message first, whatever order the server sends', async () => {
    // The server's order: most recent activity on the key, which counts a
    // session's lifecycle updates and a task group's (Conor, 2026-10-03).
    fake.spines = [
      spine('fixture:thread:busy', 'Busy session', '2026-10-03T01:00:00Z', '2026-10-03T07:05:00Z'),
      spine(
        'fixture:thread:answered',
        'Just answered',
        '2026-10-03T07:00:00Z',
        '2026-10-03T07:00:00Z'
      ),
      spine(
        'fixture:thread:yesterday',
        'Yesterday',
        '2026-10-02T09:00:00Z',
        '2026-10-03T06:00:00Z'
      ),
    ];

    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <ThreadsPage />
      </QueryClientProvider>
    );

    const rows = () =>
      within(screen.getByRole('listbox', { name: 'Threads' })).queryAllByRole('option');
    await waitFor(() => expect(rows()).toHaveLength(3));
    const titles = rows().map((row) =>
      ['Just answered', 'Busy session', 'Yesterday'].find((t) => row.textContent?.includes(t))
    );
    expect(titles).toEqual(['Just answered', 'Busy session', 'Yesterday']);
    expect(fake.read).not.toHaveBeenCalled();
  });
});

/** Synthetic receipt text, not a claim about delivery of a particular request. */
function receipt(key: string, scope = 'default') {
  return {
    thread: {
      threadKey: key,
      title: 'Fixture conversation',
      status: 'open',
      createdBySlug: 'fixture-sb',
      createdAt: '2026-01-01T12:00:00Z',
      closedAt: null,
    },
    messages: [
      {
        id: `synthetic-message-${scope}`,
        senderKind: 'sb',
        senderSlug: 'fixture-sb',
        content: `Receipt on ${key} in ${scope}`,
        messageType: 'message',
        createdAt: '2026-01-01T12:00:00Z',
      },
    ],
  };
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = () => (
    <QueryClientProvider client={client}>
      <ThreadsPage />
    </QueryClientProvider>
  );
  const rendered = render(view());
  return { client, rerender: () => rendered.rerender(view()) };
}

describe('Threads recovery deep links', () => {
  const key = 'thread:browser-fixture';
  beforeEach(() => {
    fake.query = `key=${encodeURIComponent(key)}`;
    fake.read.mockImplementation(async (path: string, options: { workspaceId: string | null }) =>
      receipt(
        new URL(path, 'https://example.invalid').searchParams.get('key')!,
        options.workspaceId ?? 'default'
      )
    );
  });

  it('reads the exact key outside the capped feed, without inventing membership', async () => {
    renderPage();
    expect(await screen.findByText(`Receipt on ${key} in default`)).toBeTruthy();
    expect(fake.read).toHaveBeenCalledWith(threadMessagesPath(key), { workspaceId: null });
    expect(screen.getByRole('textbox', { name: `Reply to ${key}` })).toBeTruthy();
    expect(screen.queryByText('no thread yet')).toBeNull();
    expect(screen.getByText(/outside the current activity feed/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /add reaction/i })).toBeNull();
  });

  it('follows navigation and drops the previous conversation and draft', async () => {
    const page = renderPage();
    expect(await screen.findByText(`Receipt on ${key} in default`)).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: `Reply to ${key}` }), {
      target: { value: 'Draft only for the first thread' },
    });
    fake.query = 'key=thread%3Asecond-fixture&fixture=kept';
    page.rerender();
    expect(screen.queryByText(`Receipt on ${key} in default`)).toBeNull();
    expect(await screen.findByText('Receipt on thread:second-fixture in default')).toBeTruthy();
    expect(screen.queryByDisplayValue('Draft only for the first thread')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'All threads' }));
    expect(fake.replace).toHaveBeenCalledWith('/threads?fixture=kept', { scroll: false });
    fake.query = '';
    page.rerender();
    expect(screen.queryByText('Receipt on thread:second-fixture in default')).toBeNull();
    expect(screen.queryByRole('textbox', { name: /^Reply to / })).toBeNull();
  });

  it('reports read failures without claiming the attempted send was absent', async () => {
    fake.read.mockRejectedValue(new Error('Synthetic read unavailable'));
    renderPage();
    expect((await screen.findByRole('alert')).textContent).toContain('Could not read');
    expect(screen.queryByText(/No conversation was found/)).toBeNull();
    expect(screen.queryByRole('textbox', { name: /^Reply to / })).toBeNull();
  });

  it('does not treat a missing thread as a receipt or offer to reply', async () => {
    fake.read.mockResolvedValue({ thread: null, messages: [] });
    renderPage();
    expect(await screen.findByText(/in-flight request may still arrive/)).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: /^Reply to / })).toBeNull();
  });

  it('withholds a recovered composer when a later read fails, even with cached data', async () => {
    const page = renderPage();
    expect(await screen.findByRole('textbox', { name: `Reply to ${key}` })).toBeTruthy();
    fake.read.mockRejectedValue(new Error('Synthetic refresh unavailable'));
    await act(async () => {
      await page.client.invalidateQueries({ queryKey: ['thread-messages', key] });
    });
    expect((await screen.findByRole('alert')).textContent).toContain('Could not read');
    expect(screen.queryByRole('textbox', { name: /^Reply to / })).toBeNull();
  });

  it('reads the same key in the selected workspace without reusing the old workspace content', async () => {
    setSelectedWorkspaceId('synthetic-workspace-a');
    renderPage();
    expect(await screen.findByText(`Receipt on ${key} in synthetic-workspace-a`)).toBeTruthy();
    act(() => setSelectedWorkspaceId('synthetic-workspace-b'));
    expect(screen.queryByText(`Receipt on ${key} in synthetic-workspace-a`)).toBeNull();
    expect(await screen.findByText(`Receipt on ${key} in synthetic-workspace-b`)).toBeTruthy();
    expect(fake.read).toHaveBeenCalledWith(threadMessagesPath(key), {
      workspaceId: 'synthetic-workspace-b',
    });
  });
});
