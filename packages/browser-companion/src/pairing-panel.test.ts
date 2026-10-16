// @vitest-environment jsdom
/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import markup from './entrypoints/sidepanel/index.html?raw';
import { mountPairingPanel } from './pairing-panel';
import type { PairingView } from './pairing';
const request = vi.hoisted(() => vi.fn());
vi.mock('./state', () => ({ panelRequest: request }));
let view: PairingView;
const permission = vi.fn();
const button = (id: string) => document.getElementById(id) as HTMLButtonElement;
beforeEach(() => {
  // Real panel markup, synthetic worker and permission responses.
  document.body.innerHTML = markup;
  view = { phase: 'unpaired' };
  request.mockReset().mockImplementation(async (message) => {
    if (message.type === 'pair:disconnect')
      view = { phase: 'disconnected', revocation: 'confirmed' };
    return view;
  });
  permission.mockReset().mockResolvedValue(true);
  vi.stubGlobal('chrome', {
    storage: { onChanged: { addListener: vi.fn() } },
    permissions: { request: permission },
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});
describe('pairing panel with actual markup', () => {
  it('auto-connects only a pairing initiated by this surviving panel', async () => {
    const onPaired = vi.fn();
    const id = '11111111-1111-4111-8111-111111111111';
    request.mockImplementation(async (message) => {
      if (message.type === 'pair:prepare') view = { phase: 'ready', installationId: id };
      return view;
    });
    mountPairingPanel({ onPaired });
    await vi.waitFor(() => expect(request).toHaveBeenCalled());
    button('pair-open').click();
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith({
        type: 'pair:prepare',
        origin: 'http://localhost:3002',
      })
    );
    view = { phase: 'paired', installationId: id };
    const changed = vi.mocked(chrome.storage.onChanged.addListener).mock.calls[0]![0];
    changed({}, 'session');
    await vi.waitFor(() => expect(onPaired).toHaveBeenCalledTimes(1));
    changed({}, 'session');
    await Promise.resolve();
    expect(onPaired).toHaveBeenCalledTimes(1);
  });
  it('does not auto-connect when a new panel finds an already paired installation', async () => {
    view = { phase: 'paired', installationId: '11111111-1111-4111-8111-111111111111' };
    const onPaired = vi.fn();
    mountPairingPanel({ onPaired });
    await vi.waitFor(() => expect(button('pair-disconnect').disabled).toBe(false));
    expect(onPaired).not.toHaveBeenCalled();
  });
  it.each(['pending', 'confirmed'] as const)(
    'keeps storage failure distinct from %s revocation and fences new pairing',
    async (revocation) => {
      view = {
        phase: 'disconnected',
        revocation,
        storageUnavailable: true,
        ...(revocation === 'pending' ? { cleanup: 'revocation' as const } : {}),
      };
      mountPairingPanel();
      await vi.waitFor(() =>
        expect(document.getElementById('pair-status')?.textContent).toContain(
          'Session storage is unavailable'
        )
      );
      expect(button('pair-open').disabled).toBe(true);
      expect(button('pair-claim').disabled).toBe(true);
      expect(button('pair-disconnect').disabled).toBe(false);
      expect(button('pair-retry').disabled).toBe(revocation === 'confirmed');
      const text = document.getElementById('pair-status')?.textContent;
      expect(text).not.toContain('You can start a new pairing');
      expect(text).toContain(
        revocation === 'pending' ? 'Remote revocation is not confirmed' : 'No revocation is pending'
      );
    }
  );
  it('does not suggest that closing the panel revokes an unconfirmed grant', async () => {
    view = { phase: 'paired' };
    request.mockImplementation(async (message) => {
      if (message.type === 'pair:disconnect') throw new Error('synthetic worker unavailable');
      return view;
    });
    mountPairingPanel();
    await vi.waitFor(() => expect(button('pair-disconnect').disabled).toBe(false));
    button('pair-disconnect').click();
    await vi.waitFor(() =>
      expect(document.getElementById('pair-status')?.textContent).toContain(
        'Closing this panel does not revoke a server grant'
      )
    );
  });
  it('requires a human click and host permission before preparing approval', async () => {
    mountPairingPanel();
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith({ type: 'pair:status' }));
    expect(permission).not.toHaveBeenCalled();
    button('pair-open').click();
    expect(permission).toHaveBeenCalledWith({ origins: ['http://localhost/*'] });
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith({
        type: 'pair:prepare',
        origin: 'http://localhost:3002',
      })
    );
  });
  it('Disconnect cancels preparation even while permission is pending', async () => {
    let finish!: (allowed: boolean) => void;
    permission.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    mountPairingPanel();
    button('pair-open').click();
    expect(button('pair-disconnect').disabled).toBe(false);
    button('pair-disconnect').click();
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith({ type: 'pair:disconnect' }));
    finish(true);
    await vi.waitFor(() => expect(button('pair-open').disabled).toBe(false));
    expect(request.mock.calls.some(([m]) => m.type === 'pair:prepare')).toBe(false);
  });
  it('keeps Disconnect available during claim and never restores an old error after stopping', async () => {
    let fail!: (error: Error) => void;
    view = { phase: 'ready', origin: 'https://dashboard.example.test' };
    request.mockImplementation(async (message) => {
      if (message.type === 'pair:claim')
        return new Promise((_resolve, reject) => {
          fail = reject;
        });
      if (message.type === 'pair:disconnect')
        view = { phase: 'disconnected', revocation: 'pending', cleanup: 'awaiting-receipt' };
      return view;
    });
    mountPairingPanel();
    await vi.waitFor(() => expect(button('pair-claim').disabled).toBe(false));
    const code = document.getElementById('pair-code') as HTMLInputElement;
    code.value = 'ABCD-EFGH-JKLM';
    button('pair-claim').click();
    expect(code.value).toBe('');
    expect(button('pair-disconnect').disabled).toBe(false);
    button('pair-disconnect').click();
    await vi.waitFor(() =>
      expect(document.getElementById('pair-status')?.textContent).toContain('Disconnected locally')
    );
    view = { phase: 'disconnected', revocation: 'pending', cleanup: 'missing-receipt' };
    fail(new Error('old failure must not replace Disconnect'));
    await vi.waitFor(() => expect(button('pair-open').disabled).toBe(false));
    expect(button('pair-retry').hidden).toBe(true);
    expect(document.getElementById('pair-status')?.textContent).toContain('Disconnected locally');
  });
  it.each(['awaiting-receipt', 'missing-receipt', 'revocation'] as const)(
    'offers only the action available for %s',
    async (cleanup) => {
      view = { phase: 'disconnected', revocation: 'pending', cleanup };
      mountPairingPanel();
      await vi.waitFor(() =>
        expect(document.getElementById('pair-status')?.textContent).toContain(
          'Disconnected locally'
        )
      );
      expect(button('pair-open').disabled).toBe(cleanup !== 'missing-receipt');
      expect(button('pair-retry').hidden).toBe(cleanup !== 'revocation');
      expect(button('pair-retry').disabled).toBe(cleanup !== 'revocation');
      if (cleanup === 'missing-receipt')
        expect(document.getElementById('pair-status')?.textContent).toContain(
          'starting again does not revoke it'
        );
    }
  );
  it('keeps new pairing fenced when the receipt is missing and storage has failed', async () => {
    view = {
      phase: 'disconnected',
      revocation: 'pending',
      cleanup: 'missing-receipt',
      storageUnavailable: true,
    };
    mountPairingPanel();
    await vi.waitFor(() =>
      expect(document.getElementById('pair-status')?.textContent).toContain(
        'Session storage is unavailable'
      )
    );
    expect(button('pair-open').disabled).toBe(true);
    expect(button('pair-retry').hidden).toBe(true);
    expect(document.getElementById('pair-status')?.textContent).not.toContain('You can start');
  });
});
