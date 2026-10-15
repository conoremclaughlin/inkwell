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
  post: vi.fn(),
  feed: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: fake.replace }),
  usePathname: () => '/threads',
  useSearchParams: () => new URLSearchParams(fake.query),
}));

vi.mock('@/lib/api/client', () => ({
  apiGet: async (path: string, options?: { workspaceId: string | null }) => {
    if (path === '/api/admin/threads') {
      await fake.feed();
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
  apiPost: (...args: unknown[]) => fake.post(...args),
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
  fake.post.mockReset().mockResolvedValue({});
  fake.feed.mockReset().mockResolvedValue(undefined);
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

  it('keeps the mounted draft through a read outage and recovery, withholding sends only', async () => {
    const page = renderPage();
    const composer = (await screen.findByRole('textbox', {
      name: `Reply to ${key}`,
    })) as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: 'Keep this unsent draft' } });
    fake.read.mockRejectedValue(new Error('Synthetic refresh unavailable'));
    await act(async () => {
      await page.client.invalidateQueries({ queryKey: ['thread-messages', key] });
    });
    expect((await screen.findByRole('alert')).textContent).toContain('Could not refresh');
    expect(screen.getByRole('textbox', { name: `Reply to ${key}` })).toBe(composer);
    expect(composer.value).toBe('Keep this unsent draft');
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(composer, { key: 'Enter' });
    expect(fake.post).not.toHaveBeenCalled();
    fake.read.mockResolvedValue(receipt(key));
    await act(async () => {
      await page.client.invalidateQueries({ queryKey: ['thread-messages', key] });
    });
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(screen.getByRole('textbox', { name: `Reply to ${key}` })).toBe(composer);
    expect(composer.value).toBe('Keep this unsent draft');
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(
      false
    );
  });

  it('does not erase a failed reply or its draft when the thread read fails and recovers', async () => {
    fake.post.mockRejectedValue(new Error('Synthetic reply outcome unknown'));
    const page = renderPage();
    const composer = await screen.findByRole('textbox', { name: `Reply to ${key}` });
    fireEvent.change(composer, { target: { value: 'A reply whose receipt is missing' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Synthetic reply outcome unknown')).toBeTruthy();
    fake.read.mockRejectedValue(new Error('Synthetic refresh unavailable'));
    await act(async () => {
      await page.client.invalidateQueries({ queryKey: ['thread-messages', key] });
    });
    await screen.findByRole('alert');
    expect(screen.getByText('Synthetic reply outcome unknown')).toBeTruthy();
    fake.read.mockResolvedValue(receipt(key));
    await act(async () => {
      await page.client.invalidateQueries({ queryKey: ['thread-messages', key] });
    });
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(screen.getByDisplayValue('A reply whose receipt is missing')).toBe(composer);
    expect(screen.getByText('Synthetic reply outcome unknown')).toBeTruthy();
    expect(fake.post).toHaveBeenCalledTimes(1);
  });

  it.each(['loading', 'error'] as const)(
    'does not claim absence from a %s feed',
    async (feedState) => {
      let release!: () => void;
      if (feedState === 'loading')
        fake.feed.mockReturnValue(
          new Promise<void>((resolve) => {
            release = resolve;
          })
        );
      else fake.feed.mockRejectedValue(new Error('Synthetic feed unavailable'));
      const page = renderPage();
      expect(await screen.findByText(`Receipt on ${key} in default`)).toBeTruthy();
      expect(screen.queryByText(/outside the current activity feed/)).toBeNull();
      if (feedState === 'loading') {
        await act(async () => release());
      } else {
        fake.feed.mockResolvedValue(undefined);
        await act(async () => {
          await page.client.invalidateQueries({ queryKey: ['thread-spines'] });
        });
      }
      expect(await screen.findByText(/outside the current activity feed/)).toBeTruthy();
    }
  );

  it('keeps a first read pending rather than claiming the send is absent', async () => {
    let release!: (value: unknown) => void;
    fake.read.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      })
    );
    renderPage();
    expect(await screen.findByText('Reading this thread…')).toBeTruthy();
    expect(screen.queryByText(/No conversation was found/)).toBeNull();
    expect(screen.queryByRole('textbox', { name: /^Reply to / })).toBeNull();
    await act(async () => release(receipt(key)));
    expect(await screen.findByRole('textbox', { name: `Reply to ${key}` })).toBeTruthy();
  });

  it('does not use a mismatched thread row as confirmation', async () => {
    fake.read.mockResolvedValue(receipt('thread:synthetic-other'));
    renderPage();
    expect((await screen.findByRole('alert')).textContent).toContain('thread unconfirmed');
    expect(screen.queryByRole('textbox', { name: /^Reply to / })).toBeNull();
    expect(screen.queryByText(/Receipt on thread:synthetic-other/)).toBeNull();
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
