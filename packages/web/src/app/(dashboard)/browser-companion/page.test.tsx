// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { formatBrowserRequest, type BrowserSnapshot } from '@inklabs/browser-companion/protocol';
import * as protocol from '@inklabs/browser-companion/protocol';
import BrowserCompanionPage from './page';

const post = vi.hoisted(() => vi.fn());
const replyState = vi.hoisted(() => ({
  messages: [] as Array<{
    id: string;
    senderSlug: string;
    content: string;
    metadata?: { triggerFailure?: boolean };
  }>,
}));
vi.mock('@/lib/api', () => ({
  apiPost: post,
  useApiQuery: (key: string[]) =>
    key[0] === 'companion-recipients'
      ? { data: { individuals: [{ sbSlug: 'fixture-sb', name: 'Fixture SB' }] } }
      : { data: replyState },
}));
const snapshot: BrowserSnapshot = {
  version: 1,
  id: '00000000-0000-4000-8000-000000000001',
  capturedAt: Date.now(),
  url: 'https://fixture.test/form',
  title: 'Fixture',
  mode: 'page',
  text: '<script>page data, not code</script>',
  truncated: false,
  fields: [],
};
function offer(
  origin = window.location.origin,
  capture = snapshot,
  bridgeId = '00000000-0000-4000-8000-000000000002'
) {
  window.dispatchEvent(
    new MessageEvent('message', {
      source: window,
      origin,
      data: { type: 'inkwell:offer', bridgeId, snapshot: capture },
    })
  );
}
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  replyState.messages = [];
});
describe('browser dashboard human-send boundary', () => {
  it('scans attention cues per capture rather than on every instruction edit', () => {
    const scan = vi.spyOn(protocol, 'privacySignals');
    render(<BrowserCompanionPage />);
    act(() => offer());
    expect(scan).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByLabelText('Instruction'), { target: { value: 'Draft' } });
    fireEvent.change(screen.getByLabelText('Instruction'), { target: { value: 'Draft a reply' } });
    expect(scan).toHaveBeenCalledTimes(1);
    act(() =>
      offer(window.location.origin, {
        ...snapshot,
        id: '00000000-0000-4000-8000-000000000003',
      })
    );
    fireEvent.click(screen.getByText('Review new capture — keep my instruction'));
    expect(scan).toHaveBeenCalledTimes(2);
  });
  it('stages a valid offer but never sends without instruction, recipient and human action', async () => {
    render(<BrowserCompanionPage />);
    act(() => offer());
    expect(post).not.toHaveBeenCalled();
    const send = screen.getByText('Send reviewed context') as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Instruction'), {
      target: { value: 'Investigate this page' },
    });
    fireEvent.change(screen.getByLabelText('Recipient'), { target: { value: 'fixture-sb' } });
    expect(post).not.toHaveBeenCalled();
    post.mockResolvedValue({ messageId: 'synthetic-message' });
    fireEvent.click(send);
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post).toHaveBeenCalledWith('/api/admin/threads', {
      key: `thread:browser-${snapshot.id}`,
      recipients: ['fixture-sb'],
      title: 'Browser assistance',
      content: formatBrowserRequest(snapshot, 'Investigate this page'),
    });
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Stored'));
    expect(send.disabled).toBe(true);
  });
  it('ignores a foreign-origin offer', () => {
    render(<BrowserCompanionPage />);
    act(() => offer('https://attacker.test'));
    expect(screen.queryByLabelText('Instruction')).toBeNull();
    expect(post).not.toHaveBeenCalled();
  });
  it('does not falsely claim delivery or retry after an ambiguous failure', async () => {
    render(<BrowserCompanionPage />);
    act(() => offer());
    fireEvent.change(screen.getByLabelText('Instruction'), {
      target: { value: 'Help investigate' },
    });
    fireEvent.change(screen.getByLabelText('Recipient'), { target: { value: 'fixture-sb' } });
    post.mockRejectedValue(new Error('network unavailable'));
    fireEvent.click(screen.getByText('Send reviewed context'));
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toContain('may have been stored')
    );
    expect(post).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('link', { name: 'Open thread' }).getAttribute('href')).toBe(
      `/threads?key=${encodeURIComponent(`thread:browser-${snapshot.id}`)}`
    );
    expect((screen.getByText('Send reviewed context') as HTMLButtonElement).disabled).toBe(true);
  });
  it('requires a fresh review on recapture and preserves the instruction', () => {
    render(<BrowserCompanionPage />);
    act(() => offer());
    fireEvent.change(screen.getByLabelText('Instruction'), {
      target: { value: 'Keep this instruction' },
    });
    const next = { ...snapshot, id: '00000000-0000-4000-8000-000000000003', title: 'New capture' };
    act(() => offer(window.location.origin, next));
    expect(screen.getByText('Review new capture — keep my instruction')).toBeTruthy();
    expect(post).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Review new capture — keep my instruction'));
    expect((screen.getByLabelText('Instruction') as HTMLTextAreaElement).value).toBe(
      'Keep this instruction'
    );
    expect(screen.getByRole('status').textContent).toContain('New capture');
    expect(post).not.toHaveBeenCalled();
  });
  it('surfaces structured trigger failures without claiming the recipient is dead', () => {
    replyState.messages = [
      {
        id: 'synthetic-failure',
        senderSlug: 'system',
        content: 'Synthetic failure',
        metadata: { triggerFailure: true },
      },
    ];
    render(<BrowserCompanionPage />);
    act(() => offer());
    expect(screen.getByRole('alert').textContent).toContain('wake-up attempt failed');
    expect(screen.getByRole('alert').textContent).toContain('not confirmed');
  });
  it('refreshes a same-snapshot bridge without reopening the send boundary', async () => {
    render(<BrowserCompanionPage />);
    act(() => offer());
    fireEvent.change(screen.getByLabelText('Instruction'), { target: { value: 'Investigate' } });
    fireEvent.change(screen.getByLabelText('Recipient'), { target: { value: 'fixture-sb' } });
    post.mockResolvedValue({ messageId: 'synthetic-message' });
    fireEvent.click(screen.getByText('Send reviewed context'));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Stored'));
    act(() => offer(window.location.origin, snapshot, '00000000-0000-4000-8000-000000000004'));
    expect((screen.getByText('Send reviewed context') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText('Review new capture — keep my instruction')).toBeNull();
    expect(post).toHaveBeenCalledTimes(1);
  });
});
