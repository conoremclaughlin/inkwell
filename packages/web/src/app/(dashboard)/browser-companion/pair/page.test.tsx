// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { pairingApprovalPath } from '@inklabs/browser-companion/protocol';
import { setSelectedWorkspaceId } from '@/lib/workspace-selection';
import Page from './page';
const post = vi.hoisted(() => vi.fn());
const get = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api', () => ({ apiPost: post, apiGet: get }));
const id = '00000000-0000-4000-8000-000000000001';
const a = '00000000-0000-4000-8000-00000000000a';
const b = '00000000-0000-4000-8000-00000000000b';
const offer = { installationId: id, installationCommitment: 'a'.repeat(64) };
const receipt = {
  installationId: id,
  pairingCode: 'ABCD-EFGH-JKLM',
  pairingCodeExpiresAt: '2099-01-01T00:00:00.000Z',
};
beforeEach(() => {
  window.history.replaceState(null, '', pairingApprovalPath(id, offer.installationCommitment));
  post.mockReset().mockResolvedValue(receipt);
  get.mockReset().mockResolvedValue({ recipients: [] });
  setSelectedWorkspaceId(a);
});
afterEach(async () => {
  await act(async () => {});
  cleanup();
  setSelectedWorkspaceId(null);
});
function approve() {
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'Create pairing code' }));
}
describe('dashboard pairing consent', () => {
  it('requires renewed consent for a named ordinary companion and checks the echoed binding', async () => {
    get.mockResolvedValue({ recipients: [{ id: b, name: 'River' }] });
    post.mockResolvedValue({ ...receipt, recipientId: b });
    render(<Page />);
    await screen.findByRole('option', { name: 'River' });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: b } });
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
    expect(screen.getByText(/Anyone holding this pairing/)).toBeTruthy();
    approve();
    await screen.findByText(receipt.pairingCode);
    expect(post).toHaveBeenCalledWith(
      expect.anything(),
      { ...offer, recipientId: b, fullToolsApproved: true },
      { workspaceId: a }
    );
  });
  it('does not display a code whose recipient binding differs from the consent', async () => {
    get.mockResolvedValue({ recipients: [{ id: b, name: 'River' }] });
    render(<Page />);
    await screen.findByRole('option', { name: 'River' });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: b } });
    approve();
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toContain('No confirmed pairing-code receipt')
    );
    expect(screen.queryByText(receipt.pairingCode)).toBeNull();
  });
  it('ignores stale workspace choices and does not carry the selected companion across a switch', async () => {
    let finish!: (value: unknown) => void;
    get.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    render(<Page />);
    act(() => setSelectedWorkspaceId(b));
    await act(async () => finish({ recipients: [{ id, name: 'Stale River' }] }));
    expect(screen.queryByRole('option', { name: 'Stale River' })).toBeNull();
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('');
    expect(post).not.toHaveBeenCalled();
  });
  it('only mints on explicit human consent, bound to the current workspace', async () => {
    render(<Page />);
    expect(post).not.toHaveBeenCalled();
    expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true);
    approve();
    await screen.findByText(receipt.pairingCode);
    expect(post).toHaveBeenCalledExactlyOnceWith(
      '/api/admin/browser-companion/pairing-code',
      offer,
      { workspaceId: a }
    );
    expect(screen.getByText(/Pairing enables browser chat/)).toBeTruthy();
  });
  it('does not carry consent into another workspace', async () => {
    await act(async () => {
      render(<Page />);
    });
    fireEvent.click(screen.getByRole('checkbox'));
    await act(async () => setSelectedWorkspaceId(b));
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
    expect(post).not.toHaveBeenCalled();
  });
  it('keeps an in-flight result in its original workspace', async () => {
    let finish!: (value: typeof receipt) => void;
    post.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    render(<Page />);
    approve();
    act(() => setSelectedWorkspaceId(b));
    await act(async () => finish(receipt));
    expect(screen.getByText(/The sidebar selection changed/)).toBeTruthy();
    expect(screen.getByText(a)).toBeTruthy();
    expect(post).toHaveBeenCalledTimes(1);
  });
  it('uses explicit default workspace binding, not whatever is selected later', async () => {
    setSelectedWorkspaceId(null);
    render(<Page />);
    approve();
    await screen.findByText(receipt.pairingCode);
    expect(post).toHaveBeenCalledWith(expect.anything(), offer, { workspaceId: null });
  });
  it.each(['', '#installationId=bad', '#' + new URLSearchParams(offer) + '&installationId=' + id])(
    'refuses missing or malformed public requests',
    async (hash) => {
      window.history.replaceState(null, '', '/browser-companion/pair' + hash);
      await act(async () => {
        render(<Page />);
      });
      expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true);
      expect(post).not.toHaveBeenCalled();
    }
  );
  it('does not approve a changed fragment before React receives hashchange', async () => {
    await act(async () => {
      render(<Page />);
    });
    fireEvent.click(screen.getByRole('checkbox'));
    window.history.replaceState(null, '', pairingApprovalPath(id, 'b'.repeat(64)));
    fireEvent.click(screen.getByRole('button'));
    expect(post).not.toHaveBeenCalled();
  });
  it.each(['outage', 'mismatch', 'expired'])(
    'does not retry an uncertain or invalid mint receipt: %s',
    async (kind) => {
      if (kind === 'outage') post.mockRejectedValue(new Error('synthetic error'));
      else
        post.mockResolvedValue({
          ...receipt,
          ...(kind === 'mismatch'
            ? { installationId: b }
            : { pairingCodeExpiresAt: '2000-01-01T00:00:00Z' }),
        });
      render(<Page />);
      approve();
      await waitFor(() =>
        expect(screen.getByRole('status').textContent).toContain(
          'No confirmed pairing-code receipt'
        )
      );
      expect(post).toHaveBeenCalledTimes(1);
      expect(screen.queryByText(receipt.pairingCode)).toBeNull();
      expect(screen.queryByRole('button')).toBeNull();
    }
  );
});
