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
        view = { phase: 'disconnected', revocation: 'pending' };
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
    fail(new Error('old failure must not replace Disconnect'));
    await vi.waitFor(() => expect(button('pair-retry').disabled).toBe(false));
    expect(document.getElementById('pair-status')?.textContent).toContain('Disconnected locally');
  });
});
