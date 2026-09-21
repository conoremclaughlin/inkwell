// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import ThreadsPage from './page';

const state = vi.hoisted(() => ({
  query: 'key=thread%3Abrowser-fixture',
  push: vi.fn(),
  queryCalls: vi.fn(),
  failed: false,
  absent: false,
}));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(state.query),
  useRouter: () => ({ push: state.push }),
}));
vi.mock('@/components/threads/reply-composer', () => ({
  ReplyComposer: ({ threadKey }: { threadKey: string }) => <div>Reply to {threadKey}</div>,
  senderLabel: () => 'Fixture SB',
}));
vi.mock('@/components/threads/reopen-button', () => ({ ReopenThreadButton: () => null }));
vi.mock('@/lib/api', () => ({
  useApiQuery: (key: string[], url: string) => {
    state.queryCalls(key, url);
    if (key[0] === 'thread-spines')
      return {
        data: {
          spines: [],
          meta: {
            threads: { fetched: 0, total: 1, truncated: true },
            sessions: { fetched: 0, total: 0, truncated: false },
            taskGroups: { fetched: 0, total: 0, truncated: false },
            parseUnavailable: false,
          },
        },
      };
    if (key[0] === 'thread-graph-evidence') return { data: { groups: [] } };
    if (state.failed) return { error: new Error('synthetic unavailable') };
    return {
      data: {
        thread: state.absent ? null : { status: 'open', title: 'Fixture thread' },
        messages: state.absent
          ? []
          : [
              {
                id: 'synthetic-message',
                senderSlug: 'fixture-sb',
                content: `Receipt on ${key[1]}`,
                messageType: 'message',
                createdAt: '2026-01-01T12:00:00Z',
              },
            ],
      },
    };
  },
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  state.query = 'key=thread%3Abrowser-fixture';
  state.failed = false;
  state.absent = false;
});
describe('Threads recovery deep links', () => {
  it('reads the exact key and renders messages even outside the capped feed', () => {
    render(<ThreadsPage />);
    expect(state.queryCalls).toHaveBeenCalledWith(
      ['thread-messages', 'thread:browser-fixture'],
      '/api/admin/threads/messages?key=thread%3Abrowser-fixture'
    );
    expect(screen.getByText('Receipt on thread:browser-fixture')).toBeTruthy();
    expect(screen.getByText('Reply to thread:browser-fixture')).toBeTruthy();
    expect(screen.queryByText('no thread yet')).toBeNull();
    expect(screen.getByText(/outside the current activity feed/)).toBeTruthy();
  });
  it('follows changed query parameters and clears selection through navigation', () => {
    const { rerender } = render(<ThreadsPage />);
    state.query = 'key=thread%3Asecond-fixture';
    rerender(<ThreadsPage />);
    expect(screen.getByText('Receipt on thread:second-fixture')).toBeTruthy();
    expect(screen.queryByText('Receipt on thread:browser-fixture')).toBeNull();
    fireEvent.click(screen.getByText('All threads'));
    expect(state.push).toHaveBeenCalledWith('/threads', { scroll: false });
    state.query = '';
    rerender(<ThreadsPage />);
    expect(screen.getByText('Select a thread to see everything on its key.')).toBeTruthy();
  });
  it('reports read failures rather than claiming the attempted send was absent', () => {
    state.failed = true;
    render(<ThreadsPage />);
    expect(screen.getByRole('alert').textContent).toContain('Could not read');
    expect(screen.getByText('thread unconfirmed')).toBeTruthy();
    expect(screen.queryByText(/No conversation was found/)).toBeNull();
    expect(screen.queryByText('Reply to thread:browser-fixture')).toBeNull();
  });
  it('does not treat a missing thread as a receipt or create a reply composer', () => {
    state.absent = true;
    render(<ThreadsPage />);
    expect(screen.getByText(/in-flight request may still arrive/)).toBeTruthy();
    expect(screen.queryByText('Reply to thread:browser-fixture')).toBeNull();
  });
});
