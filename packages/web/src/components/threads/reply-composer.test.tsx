// @vitest-environment jsdom
/**
 * The composer is per thread. Lumen's PR #613 review drove Chromium against
 * the real page and watched a draft typed for thread A get posted with
 * thread B's key after switching — the component held one draft for the
 * whole detail pane. These tests pin the partition: switching threads shows
 * an empty, enabled box; a send still in flight for the previous thread
 * completes against that thread and never touches the new one.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReplyComposer } from './reply-composer';

const apiPost = vi.fn();
vi.mock('@/lib/api/client', () => ({
  apiGet: vi.fn(),
  apiPost: (...args: unknown[]) => apiPost(...args),
  apiPut: vi.fn(),
  apiPatch: vi.fn(),
  apiDelete: vi.fn(),
}));

function renderComposer(threadKey: string) {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  const ui = (key: string) => (
    <QueryClientProvider client={queryClient}>
      <ReplyComposer threadKey={key} closed={false} />
    </QueryClientProvider>
  );
  const utils = render(ui(threadKey));
  return { queryClient, select: (key: string) => utils.rerender(ui(key)) };
}

const textarea = () => screen.getByRole('textbox') as HTMLTextAreaElement;
const sendButton = () => screen.getByRole('button', { name: /send/i }) as HTMLButtonElement;

describe('ReplyComposer', () => {
  beforeEach(() => {
    apiPost.mockReset();
  });
  // Testing Library only auto-cleans under a globals-enabled runner; this
  // suite must not depend on which vitest config picked it up.
  afterEach(cleanup);

  it('a draft typed for thread A is not shown for thread B', () => {
    const { select } = renderComposer('pr:a');
    fireEvent.change(textarea(), { target: { value: 'private draft intended only for A' } });
    expect(textarea().value).toBe('private draft intended only for A');

    select('pr:b');

    expect(textarea().getAttribute('aria-label')).toBe('Reply to pr:b');
    expect(textarea().value).toBe('');
    expect(sendButton().disabled).toBe(true);
    expect(apiPost).not.toHaveBeenCalled();
  });

  it("switching while a send is pending leaves B usable and completes A's send against A", async () => {
    let resolveSend!: (value: unknown) => void;
    apiPost.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSend = resolve;
        })
    );
    const { select, queryClient } = renderComposer('pr:a');
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

    fireEvent.change(textarea(), { target: { value: 'keep going on A' } });
    fireEvent.click(sendButton());

    // In flight for A: the box is locked and the request went out for A.
    // (React Query publishes mutation state on a macrotask, so wait for it.)
    await waitFor(() => expect(textarea().disabled).toBe(true));
    expect(apiPost).toHaveBeenCalledTimes(1);
    expect(apiPost).toHaveBeenCalledWith('/api/admin/threads/reply', {
      key: 'pr:a',
      content: 'keep going on A',
    });

    select('pr:b');

    // B gets its own composer: empty, enabled, no pending state borrowed from A.
    expect(textarea().getAttribute('aria-label')).toBe('Reply to pr:b');
    expect(textarea().disabled).toBe(false);
    expect(textarea().value).toBe('');

    await act(async () => {
      resolveSend({ success: true, messageId: 'msg-1', threadId: 'thread-a' });
    });

    // A's send finished against A, and nothing was sent for B.
    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['thread-messages', 'pr:a'] })
    );
    expect(apiPost).toHaveBeenCalledTimes(1);
    expect(textarea().value).toBe('');
  });

  it('⌘↩ sends the draft for the thread it was typed in', async () => {
    apiPost.mockResolvedValue({ success: true, messageId: 'msg-2', threadId: 'thread-a' });
    renderComposer('pr:a');
    fireEvent.change(textarea(), { target: { value: 'ship it' } });
    fireEvent.keyDown(textarea(), { key: 'Enter', metaKey: true });

    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith('/api/admin/threads/reply', {
        key: 'pr:a',
        content: 'ship it',
      })
    );
    // The draft clears once the reply lands.
    await waitFor(() => expect(textarea().value).toBe(''));
  });
});
