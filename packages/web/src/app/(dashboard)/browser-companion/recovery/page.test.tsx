// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  browserRecoveryPath,
  parseBrowserRecoveryTarget,
} from '@inklabs/browser-companion/protocol';
import { getSelectedWorkspaceId, setSelectedWorkspaceId } from '@/lib/workspace-selection';

const fake = vi.hoisted(() => ({ query: '', read: vi.fn(), post: vi.fn() }));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(fake.query) }));
vi.mock('@/lib/api/client', () => ({
  apiGet: (...args: unknown[]) => fake.read(...args),
  apiPost: fake.post,
}));
import BrowserRecoveryPage from './page';

const a = '00000000-0000-4000-8000-00000000000a';
const b = '00000000-0000-4000-8000-00000000000b';
const key = 'thread:browser-fixture';
function target(workspaceId: string | null, thread = key) {
  fake.query = browserRecoveryPath(thread, workspaceId).split('?')[1];
}
function receipt(scope: string | null, thread = key) {
  return {
    thread: { threadKey: thread, title: 'Synthetic original conversation' },
    messages: [
      {
        id: 'synthetic-message',
        senderSlug: 'fixture-sb',
        content: `Original reply in ${scope ?? 'default'}`,
      },
    ],
    meta: { truncated: true },
  };
}
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = () => (
    <QueryClientProvider client={client}>
      <BrowserRecoveryPage />
    </QueryClientProvider>
  );
  const rendered = render(view());
  return { client, rerender: () => rendered.rerender(view()) };
}
beforeEach(() => {
  target(a);
  setSelectedWorkspaceId(b);
  fake.read.mockReset().mockImplementation(async (_path, binding) => receipt(binding.workspaceId));
  fake.post.mockReset();
});
afterEach(() => {
  cleanup();
  setSelectedWorkspaceId(null);
});

describe('read-only browser recovery', () => {
  it.each([a, null])(
    'reads the original workspace %s, including after invalidation and sidebar switches',
    async (scope) => {
      target(scope);
      const page = mount();
      expect(await screen.findByText(`Original reply in ${scope ?? 'default'}`)).toBeTruthy();
      expect(fake.read.mock.calls.every(([, binding]) => binding.workspaceId === scope)).toBe(true);
      expect(getSelectedWorkspaceId()).toBe(b);
      await act(async () => {
        setSelectedWorkspaceId(a);
        await page.client.invalidateQueries();
      });
      expect(fake.read.mock.calls.every(([, binding]) => binding.workspaceId === scope)).toBe(true);
      expect(screen.queryByRole('textbox')).toBeNull();
      expect(screen.queryByRole('button')).toBeNull();
      expect(fake.post).not.toHaveBeenCalled();
      expect(screen.getByText(/not confirmation that a particular request/)).toBeTruthy();
      expect(screen.getByText(/Only the latest messages/)).toBeTruthy();
    }
  );

  it('does not replace a scoped cache entry with another workspace on navigation', async () => {
    const page = mount();
    expect(await screen.findByText(`Original reply in ${a}`)).toBeTruthy();
    target(b);
    page.rerender();
    expect(screen.queryByText(`Original reply in ${a}`)).toBeNull();
    expect(await screen.findByText(`Original reply in ${b}`)).toBeTruthy();
    expect(page.client.getQueryData(['thread-messages', key, { workspaceId: a }])).toEqual(
      receipt(a)
    );
    target(b, 'thread:second-fixture');
    fake.read.mockResolvedValue(receipt(b, 'thread:second-fixture'));
    page.rerender();
    expect(await screen.findByText('thread:second-fixture')).toBeTruthy();
    expect(fake.read.mock.calls.at(-1)?.[0]).toContain('thread%3Asecond-fixture');
  });

  it('retains confirmed messages on read failure without treating the error as non-delivery', async () => {
    const page = mount();
    expect(await screen.findByText(`Original reply in ${a}`)).toBeTruthy();
    fake.read.mockRejectedValue(new Error('Synthetic outage'));
    await act(async () => {
      await page.client.invalidateQueries();
    });
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Last confirmed messages remain'
    );
    expect(screen.getByText(`Original reply in ${a}`)).toBeTruthy();
    expect(screen.queryByText(/No conversation was found/)).toBeNull();
    expect(fake.post).not.toHaveBeenCalled();
  });

  it('reports an initial read outage without messages or a send action', async () => {
    fake.read.mockRejectedValue(new Error('Synthetic initial outage'));
    mount();
    expect((await screen.findByRole('alert')).textContent).toContain(
      'delivery status is unconfirmed'
    );
    expect(screen.queryByRole('region', { name: 'Original conversation' })).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('keeps an empty read distinct from failed delivery', async () => {
    fake.read.mockResolvedValue({ thread: null, messages: [] });
    mount();
    expect(await screen.findByText(/in-flight request may still arrive/)).toBeTruthy();
    expect(fake.post).not.toHaveBeenCalled();
  });

  it('withholds mismatched response messages', async () => {
    fake.read.mockResolvedValue(receipt(a, 'thread:wrong-fixture'));
    mount();
    expect(await screen.findByText(/response did not match/)).toBeTruthy();
    expect(screen.queryByText(`Original reply in ${a}`)).toBeNull();
  });

  it.each([
    'key=x',
    'workspace=default',
    'key=x&workspace=',
    'key=x&workspace=invalid',
    'key=x&workspace=default&workspace=' + a,
    'key=x&key=y&workspace=default',
  ])('refuses malformed or incomplete target %s without a read', async (query) => {
    fake.query = query;
    mount();
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(fake.read).not.toHaveBeenCalled();
  });

  it('encodes keys and never makes the default an absent scope', () => {
    const path = browserRecoveryPath('thread:fixture?a&b#c', null);
    expect(parseBrowserRecoveryTarget(new URLSearchParams(path.split('?')[1]))).toEqual({
      key: 'thread:fixture?a&b#c',
      workspaceId: null,
    });
  });
});
