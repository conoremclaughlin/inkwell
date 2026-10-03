// @vitest-environment jsdom
/**
 * The Threads list's order, through the real page: the server's spines in
 * the order it sends them, the page's own sort, and the rows it renders.
 * Only the HTTP client and the router are faked.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ThreadSpine } from '@inklabs/shared/stories/threads-api';

const fake = vi.hoisted(() => ({ spines: [] as unknown[] }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: () => {} }),
  usePathname: () => '/threads',
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/lib/api/client', () => ({
  apiGet: async (path: string) => {
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

afterEach(cleanup);

describe('Threads list order', () => {
  it('lists the newest message first, whatever order the server sends', async () => {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia;

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
  });
});
