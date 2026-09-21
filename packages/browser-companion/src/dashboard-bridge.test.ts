// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectDashboard } from './dashboard-bridge';
import type { BrowserSnapshot } from './protocol';

const snapshot: BrowserSnapshot = {
  version: 1,
  id: '00000000-0000-4000-8000-000000000001',
  capturedAt: Date.now(),
  url: 'https://fixture.test/form',
  title: 'Synthetic',
  mode: 'page',
  text: 'Private fixture',
  truncated: false,
  fields: [],
};
const proposal = { version: 1, snapshotId: snapshot.id, changes: [] };
const send = vi.fn();
function message(type: string, overrides: Partial<MessageEventInit> = {}) {
  window.dispatchEvent(
    new MessageEvent('message', {
      source: window,
      origin: location.origin,
      data: { type, bridgeId: 'fixture-bridge', proposal },
      ...overrides,
    })
  );
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('chrome', { runtime: { sendMessage: send } });
  send.mockReset().mockResolvedValue({ ok: true });
  // Observe outgoing packets without scheduling jsdom's asynchronous postMessage.
  vi.spyOn(window, 'postMessage').mockImplementation(() => {});
});
afterEach(() => {
  (
    globalThis as typeof globalThis & { __inkwellBridgeCleanup?: () => void }
  ).__inkwellBridgeCleanup?.();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});
describe('serialized dashboard bridge', () => {
  it('exposes no snapshot if navigation won the lookup/injection race', () => {
    expect(
      connectDashboard(snapshot, 'fixture-bridge', 'https://different.test/browser-companion')
    ).toBe(false);
    expect(window.postMessage).not.toHaveBeenCalled();
  });
  it('repeats offers until a same-window receipt, then stops', () => {
    connectDashboard(snapshot, 'fixture-bridge', location.href);
    expect(window.postMessage).toHaveBeenCalledWith(
      { type: 'inkwell:offer', bridgeId: 'fixture-bridge', snapshot },
      location.origin
    );
    vi.advanceTimersByTime(2000);
    expect(window.postMessage).toHaveBeenCalledTimes(3);
    message('inkwell:received');
    vi.advanceTimersByTime(2000);
    expect(window.postMessage).toHaveBeenCalledTimes(3);
  });
  it('forwards proposals to the runtime and reports its result without applying anything', async () => {
    connectDashboard(snapshot, 'fixture-bridge', location.href);
    message('inkwell:propose');
    await Promise.resolve();
    expect(send).toHaveBeenCalledExactlyOnceWith({
      type: 'bridge:proposal',
      bridgeId: 'fixture-bridge',
      proposal,
    });
    expect(window.postMessage).toHaveBeenLastCalledWith(
      { type: 'inkwell:proposal-receipt', bridgeId: 'fixture-bridge', result: { ok: true } },
      location.origin
    );
  });
  it('returns a generic error receipt if the runtime disappears', async () => {
    send.mockRejectedValue(new Error('synthetic private detail'));
    connectDashboard(snapshot, 'fixture-bridge', location.href);
    message('inkwell:propose');
    await Promise.resolve();
    await Promise.resolve();
    expect(window.postMessage).toHaveBeenLastCalledWith(
      {
        type: 'inkwell:proposal-receipt',
        bridgeId: 'fixture-bridge',
        result: { ok: false, error: 'Extension unavailable. Reopen its panel.' },
      },
      location.origin
    );
  });
  it.each([
    { source: null },
    { origin: 'https://foreign.test' },
    { data: { type: 'inkwell:propose', bridgeId: 'wrong-bridge', proposal } },
  ])('rejects a foreign source/origin/nonce while accepting a control', async (overrides) => {
    connectDashboard(snapshot, 'fixture-bridge', location.href);
    message('inkwell:propose', overrides);
    expect(send).not.toHaveBeenCalled();
    message('inkwell:propose');
    await Promise.resolve();
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('does not stop offering on a foreign receipt', () => {
    connectDashboard(snapshot, 'fixture-bridge', location.href);
    message('inkwell:received', { origin: 'https://foreign.test' });
    vi.advanceTimersByTime(1000);
    expect(window.postMessage).toHaveBeenCalledTimes(2);
  });
  it('reinjection removes the old closure, including delayed runtime receipts', async () => {
    let resolve!: (result: unknown) => void;
    send.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        })
    );
    connectDashboard(snapshot, 'fixture-bridge', location.href);
    message('inkwell:propose');
    connectDashboard(snapshot, 'new-bridge', location.href);
    vi.mocked(window.postMessage).mockClear();
    message('inkwell:propose');
    expect(send).toHaveBeenCalledTimes(1);
    resolve({ ok: true });
    await Promise.resolve();
    expect(window.postMessage).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(window.postMessage).toHaveBeenCalledExactlyOnceWith(
      { type: 'inkwell:offer', bridgeId: 'new-bridge', snapshot },
      location.origin
    );
    message('inkwell:propose', {
      data: { type: 'inkwell:propose', bridgeId: 'new-bridge', proposal },
    });
    await Promise.resolve();
    expect(send).toHaveBeenCalledTimes(2);
  });
  it('navigation after injection prevents further offers and proposals', () => {
    connectDashboard(snapshot, 'fixture-bridge', location.href);
    window.history.replaceState(null, '', '/different');
    vi.mocked(window.postMessage).mockClear();
    message('inkwell:propose');
    vi.advanceTimersByTime(1000);
    expect(send).not.toHaveBeenCalled();
    expect(window.postMessage).not.toHaveBeenCalled();
  });
  it('expiry removes both the offer timer and the proposal listener', () => {
    connectDashboard(snapshot, 'fixture-bridge', location.href);
    vi.advanceTimersByTime(600_001);
    vi.mocked(window.postMessage).mockClear();
    message('inkwell:propose');
    vi.advanceTimersByTime(2000);
    expect(window.postMessage).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});
