// @vitest-environment jsdom
/**
 * Reopen is an explicit action on the thread it was clicked for. These pin
 * the request shape, the refetches that make the new status visible, and
 * the per-thread partition (a reopen in flight for A never locks B).
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReopenThreadButton } from './reopen-button';

const apiPost = vi.fn();
vi.mock('@/lib/api/client', () => ({
  apiGet: vi.fn(),
  apiPost: (...args: unknown[]) => apiPost(...args),
  apiPut: vi.fn(),
  apiPatch: vi.fn(),
  apiDelete: vi.fn(),
}));

function renderButton(threadKey: string) {
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const ui = (key: string) => (
    <QueryClientProvider client={queryClient}>
      <ReopenThreadButton threadKey={key} />
    </QueryClientProvider>
  );
  const utils = render(ui(threadKey));
  return { queryClient, select: (key: string) => utils.rerender(ui(key)) };
}

const button = () => screen.getByRole('button', { name: /reopen/i }) as HTMLButtonElement;

describe('ReopenThreadButton', () => {
  beforeEach(() => {
    apiPost.mockReset();
  });
  // Testing Library only auto-cleans under a globals-enabled runner; this
  // suite must not depend on which vitest config picked it up.
  afterEach(cleanup);

  it('posts the thread key and refetches the thread and the spine list', async () => {
    apiPost.mockResolvedValue({
      success: true,
      threadKey: 'pr:a',
      reopened: true,
      alreadyOpen: false,
    });
    const { queryClient } = renderButton('pr:a');
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

    fireEvent.click(button());

    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith('/api/admin/threads/reopen', { key: 'pr:a' })
    );
    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['thread-messages', 'pr:a'] })
    );
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['thread-spines'] });
  });

  it('a reopen in flight for thread A does not lock the button for thread B', async () => {
    let resolveReopen!: (value: unknown) => void;
    apiPost.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveReopen = resolve;
        })
    );
    const { select } = renderButton('pr:a');
    fireEvent.click(button());
    await waitFor(() => expect(button().disabled).toBe(true));

    select('pr:b');
    expect(button().getAttribute('aria-label')).toBe('Reopen pr:b');
    expect(button().disabled).toBe(false);

    await act(async () => {
      resolveReopen({ success: true, threadKey: 'pr:a', reopened: true, alreadyOpen: false });
    });
    expect(apiPost).toHaveBeenCalledTimes(1);
  });

  it('shows the server error instead of pretending the thread reopened', async () => {
    apiPost.mockRejectedValue(new Error('No thread with key "pr:a"'));
    renderButton('pr:a');
    fireEvent.click(button());
    await waitFor(() => expect(screen.getByText('No thread with key "pr:a"')).toBeTruthy());
    expect(button().disabled).toBe(false);
  });
});
