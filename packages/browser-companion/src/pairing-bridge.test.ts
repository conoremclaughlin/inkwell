// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { connectPairingApproval, createPairingApprovalBridge } from './pairing-bridge';
import { pairingApprovalPath } from './protocol';
const installationId = '11111111-1111-4111-8111-111111111111';
const code = 'ABCD-EFGH-JKLM';
let stored: Record<string, unknown>;
let view: { phase: string; installationId: string; approvalUrl: string };
let client: { status: ReturnType<typeof vi.fn>; claim: ReturnType<typeof vi.fn> };
let arm: (message: unknown, sender: unknown) => void;
let fake: ReturnType<typeof makeChrome>;
function makeChrome() {
  return {
    runtime: {
      id: 'fixture-extension',
      sendMessage: vi.fn(async () => ({ ok: true, value: { phase: 'paired' } })),
      onMessage: {
        addListener: vi.fn((fn) => {
          arm = fn;
        }),
        removeListener: vi.fn(),
      },
    },
    storage: {
      session: {
        get: vi.fn(async () => stored),
        set: vi.fn(async (value) => {
          stored = { ...stored, ...structuredClone(value) };
        }),
        remove: vi.fn(async (key) => {
          delete stored[key];
        }),
      },
    },
    tabs: {
      create: vi.fn(async () => ({ id: 7 })),
      get: vi.fn(async () => ({ id: 7, status: 'complete', url: view.approvalUrl })),
      sendMessage: vi.fn(async () => undefined),
    },
    scripting: {
      executeScript: vi.fn(async () => [{ documentId: 'approved-document', result: true }]),
    },
  };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('crypto', webcrypto);
  window.history.replaceState(null, '', pairingApprovalPath(installationId, 'a'.repeat(64)));
  view = { phase: 'ready', installationId, approvalUrl: location.href };
  stored = {};
  client = { status: vi.fn(async () => view), claim: vi.fn(async () => ({ phase: 'paired' })) };
  fake = makeChrome();
  vi.stubGlobal('chrome', fake);
});
afterEach(() => {
  (globalThis as typeof globalThis & { __inkPairingCleanup?: () => void }).__inkPairingCleanup?.();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const make = () => createPairingApprovalBridge(async () => client as never);
const sender = () =>
  ({
    id: fake.runtime.id,
    tab: { id: 7 },
    frameId: 0,
    documentId: 'approved-document',
    url: view.approvalUrl,
  }) as chrome.runtime.MessageSender;
const message = () => ({
  type: 'bridge:pairing',
  installationId,
  bridgeId: (stored.pairingApproval as { bridgeId: string }).bridgeId,
  code,
});
describe('automatic pairing callback', () => {
  it('fences a callback waiting for the client when Disconnect occurs', async () => {
    let finish!: (value: typeof client) => void;
    let wait = false;
    const bridge = createPairingApprovalBridge(
      async () =>
        (wait
          ? await new Promise<typeof client>((resolve) => {
              finish = resolve;
            })
          : client) as never
    );
    await bridge.open(view as never);
    wait = true;
    const claiming = bridge.claim(message(), sender());
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    bridge.stop();
    finish(client);
    await expect(claiming).rejects.toThrow('Pairing changed');
    expect(client.claim).not.toHaveBeenCalled();
  });
  it('arms only after persisting the exact injected document and survives worker replacement', async () => {
    await make().open(view as never);
    expect(fake.tabs.sendMessage).toHaveBeenCalledWith(
      7,
      { type: 'pairing:arm', bridgeId: message().bridgeId },
      { documentId: 'approved-document' }
    );
    expect(await make().claim(message(), sender())).toEqual({ phase: 'paired' });
    expect(client.claim).toHaveBeenCalledWith(code, { installationId, origin: location.origin });
    expect(JSON.stringify(stored)).not.toContain(code);
  });
  it.each([
    { id: 'other-extension' },
    { tab: { id: 8 } },
    { frameId: 1 },
    { documentId: 'old-document' },
    { url: 'https://fixture.example/other' },
  ])('rejects the wrong callback source %j', async (wrong) => {
    const bridge = make();
    await bridge.open(view as never);
    await expect(
      bridge.claim(message(), { ...sender(), ...wrong } as chrome.runtime.MessageSender)
    ).rejects.toThrow();
    expect(client.claim).not.toHaveBeenCalled();
  });
  it('refuses mismatched request and bridge identities', async () => {
    const bridge = make();
    await bridge.open(view as never);
    for (const wrong of [
      { installationId: crypto.randomUUID() },
      { bridgeId: crypto.randomUUID() },
    ])
      await expect(bridge.claim({ ...message(), ...wrong }, sender())).rejects.toThrow();
    expect(client.claim).not.toHaveBeenCalled();
  });
  it('does not persist or inject a tab that finishes opening after Disconnect', async () => {
    let finish!: (value: { id: number }) => void;
    fake.tabs.create.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    const bridge = make();
    const opening = bridge.open(view as never);
    bridge.stop();
    finish({ id: 7 });
    await opening;
    expect(fake.scripting.executeScript).not.toHaveBeenCalled();
    expect(stored.pairingApproval).toBeUndefined();
  });
  it('leaves a different-origin or navigated approval tab untouched', async () => {
    fake.tabs.get.mockResolvedValue({
      id: 7,
      status: 'complete',
      url: 'https://fixture.example/elsewhere',
    });
    await make().open(view as never);
    expect(fake.scripting.executeScript).not.toHaveBeenCalled();
  });
});
describe('injected approval bridge', () => {
  it('requires worker arming and exact window/origin; forwards a code only once', async () => {
    const bridgeId = crypto.randomUUID();
    expect(connectPairingApproval(location.href, bridgeId, installationId)).toBe(true);
    const approved = (extra: MessageEventInit = {}) =>
      window.dispatchEvent(
        new MessageEvent('message', {
          source: window,
          origin: location.origin,
          data: { type: 'inkwell:pairing-approved', bridgeId, installationId, code },
          ...extra,
        })
      );
    approved();
    expect(fake.runtime.sendMessage).not.toHaveBeenCalled();
    arm({ type: 'pairing:arm', bridgeId }, { id: fake.runtime.id });
    approved({ origin: 'https://foreign.example' });
    approved({ source: null });
    expect(fake.runtime.sendMessage).not.toHaveBeenCalled();
    approved();
    approved();
    expect(fake.runtime.sendMessage).toHaveBeenCalledExactlyOnceWith({
      type: 'bridge:pairing',
      bridgeId,
      installationId,
      code,
    });
  });
  it('does not install into a document that navigated during injection', () => {
    expect(
      connectPairingApproval(location.href + 'changed', crypto.randomUUID(), installationId)
    ).toBe(false);
    expect(fake.runtime.onMessage.addListener).not.toHaveBeenCalled();
  });
});
