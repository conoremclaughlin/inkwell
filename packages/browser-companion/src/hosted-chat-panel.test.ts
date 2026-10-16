// @vitest-environment jsdom
/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import markup from './entrypoints/sidepanel/index.html?raw';
import { mountHostedChatPanel } from './hosted-chat-panel';
const inklingId = '22222222-2222-4222-8222-222222222222';
let connections: ReturnType<typeof makePort>[];
let send: ReturnType<
  typeof vi.fn<
    (request: {
      type: string;
      operation: { kind: string; operationId: string };
    }) => Promise<Record<string, unknown>>
  >
>;
let broadcast: (message: unknown, sender: unknown) => void;
let panel: ReturnType<typeof mountHostedChatPanel>;
function makePort() {
  let message: (data: unknown) => void;
  let lost: () => void;
  const port = {
    postMessage: vi.fn((request) => {
      void Promise.resolve().then(async () => {
        const value = await send(request);
        message({ id: request.id, ok: true, value });
      });
    }),
    disconnect: vi.fn(() => lost()),
    onMessage: {
      addListener: (fn: typeof message) => {
        message = fn;
      },
    },
    onDisconnect: {
      addListener: (fn: typeof lost) => {
        lost = fn;
      },
    },
    deliver: (value: unknown) => message(value),
  };
  return port;
}
beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto);
  document.body.innerHTML = markup;
  connections = [];
  send = vi.fn(async (request) => {
    if (request.type === 'connect')
      return {
        origin: 'https://fixture.example.test',
        grantId: 'grant',
        workspaceId: 'workspace',
        userId: 'user',
      };
    if (request.operation.kind === 'inklings')
      return { inklings: [{ id: inklingId, name: 'Moss' }] };
    if (request.operation.kind === 'message')
      return { operationId: request.operation.operationId, status: 'queued' };
    return { threadKey: 'thread:fixture-chat', messages: [] };
  });
  vi.stubGlobal('chrome', {
    runtime: {
      id: 'fixture-extension',
      connect: vi.fn(() => {
        const p = makePort();
        connections.push(p);
        return p;
      }),
      onMessage: {
        addListener: (fn: typeof broadcast) => {
          broadcast = fn;
        },
      },
    },
  });
  panel = mountHostedChatPanel();
});
afterEach(() => {
  panel.stop();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.body.replaceChildren();
});
const connect = () => document.getElementById('chat-connect') as HTMLButtonElement;
const composer = () => document.querySelector('#hosted-chat textarea') as HTMLTextAreaElement;
const submit = () =>
  document.querySelector('#hosted-chat button[type="submit"]') as HTMLButtonElement;
async function ready() {
  connect().click();
  await vi.waitFor(() =>
    expect(document.getElementById('chat-status')!.textContent).toContain('Connected.')
  );
}
describe('mounted hosted panel with synthetic worker replies', () => {
  it('does not turn a click during background refresh into an uncertain send', async () => {
    vi.useFakeTimers();
    await ready();
    composer().value = 'Keep this draft.';
    composer().dispatchEvent(new Event('input'));
    let finish!: (result: Record<string, unknown>) => void;
    send.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    await vi.advanceTimersByTimeAsync(3_000);
    expect(submit().disabled).toBe(true);
    submit().click();
    expect(send.mock.calls.some(([request]) => request.operation?.kind === 'message')).toBe(false);
    finish({ threadKey: 'thread:fixture-chat', messages: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(submit().disabled).toBe(false);
    expect(composer().value).toBe('Keep this draft.');
    expect(document.getElementById('hosted-chat')!.textContent).not.toContain(
      'Delivery is uncertain.'
    );
  });
  it('cleans pasted controls in the visible draft before any send, preserving ordinary emoji', async () => {
    await ready();
    const paste = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(paste, 'clipboardData', {
      value: { getData: () => 'Hello\u200B\u202E 👩\u200D💻' },
    });
    composer().dispatchEvent(paste);
    expect(paste.defaultPrevented).toBe(true);
    expect(composer().value).toBe('Hello 👩\u200D💻');
    expect(document.getElementById('chat-status')!.textContent).toContain(
      'Removed 2 hidden control characters'
    );
    expect(send.mock.calls.some(([request]) => request.operation?.kind === 'message')).toBe(false);
  });
  it('requires explicit Connect on each new panel, even when pairing exists', async () => {
    expect(connections).toHaveLength(0);
    expect(submit().disabled).toBe(true);
    await ready();
    expect(connections).toHaveLength(1);
    expect(send.mock.calls[0]![0].type).toBe('connect');
  });
  it('renders a chosen inkling and submits through the shared conversation view', async () => {
    await ready();
    composer().value = 'Help me plan a synthetic reading list.';
    composer().dispatchEvent(new Event('input'));
    submit().click();
    await vi.waitFor(() =>
      expect(send.mock.calls.some(([request]) => request.operation?.kind === 'message')).toBe(true)
    );
    const request = send.mock.calls.find(([request]) => request.operation?.kind === 'message')![0];
    expect(request.operation).toEqual({
      kind: 'message',
      inklingId,
      operationId: expect.any(String),
      body: 'Help me plan a synthetic reading list.',
    });
    expect(request.operation).not.toHaveProperty('pageBinding');
    await vi.waitFor(() => expect(composer().value).toBe(''));
  });
  it('clears local intent synchronously on Disconnect, including before other click listeners', async () => {
    await ready();
    let closedWhenHandlerRuns = false;
    document.getElementById('pair-disconnect')!.onclick = () => {
      closedWhenHandlerRuns = connect().disabled === false;
    };
    document.getElementById('pair-disconnect')!.click();
    expect(closedWhenHandlerRuns).toBe(true);
    expect(connections[0]!.disconnect).toHaveBeenCalled();
    expect(submit().disabled).toBe(true);
  });
  it('does not resume after an installation-wide Disconnect broadcast', async () => {
    await ready();
    vi.useFakeTimers();
    broadcast({ type: 'chat:disconnected' }, { id: 'fixture-extension' });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(connections).toHaveLength(1);
    expect(connect().disabled).toBe(false);
  });
  it('ignores a foreign Disconnect message', async () => {
    await ready();
    broadcast({ type: 'chat:disconnected' }, { id: 'another-extension' });
    expect(connect().disabled).toBe(true);
    expect(connections[0]!.disconnect).not.toHaveBeenCalled();
  });
  it('resumes a lost worker only while this document retains intent', async () => {
    await ready();
    vi.useFakeTimers();
    connections[0]!.disconnect();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(connections).toHaveLength(2);
    panel.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(connections).toHaveLength(2);
  });
  it('does not mint on reload: a new mounted document starts disconnected', async () => {
    await ready();
    panel.stop();
    document.body.innerHTML = markup;
    panel = mountHostedChatPanel();
    expect(connections).toHaveLength(1);
    expect(connect().disabled).toBe(false);
  });
  it('blocks a new send while an earlier operation has no receipt after reconnect', async () => {
    send.mockImplementation(async (request) =>
      request.type === 'connect'
        ? {
            origin: 'https://fixture.example.test',
            grantId: 'grant',
            workspaceId: 'workspace',
            userId: 'user',
          }
        : request.operation.kind === 'inklings'
          ? { inklings: [{ id: inklingId, name: 'Moss' }] }
          : { threadKey: 'thread:fixture', messages: [], pendingOperationId: 'pending-operation' }
    );
    connect().click();
    await vi.waitFor(() =>
      expect(document.getElementById('chat-status')!.textContent).toContain('uncertain delivery')
    );
    composer().value = 'Do not duplicate.';
    composer().dispatchEvent(new Event('input'));
    expect(submit().disabled).toBe(true);
  });
});
