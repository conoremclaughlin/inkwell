// @vitest-environment jsdom
/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import markup from './entrypoints/sidepanel/index.html?raw';
import { mountHostedChatPanel } from './hosted-chat-panel';
import { SNAPSHOT_TTL_MS } from './protocol';
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
let changed: (changes: unknown, area: string) => void;
const requestPage = vi.fn<() => Promise<unknown>>();
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
  requestPage.mockReset();
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
      sendMessage: requestPage,
    },
    storage: {
      onChanged: {
        addListener: (fn: typeof changed) => {
          changed = fn;
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
  it.each([true, false])(
    'rejects an expired attachment without a silent text-only send (timer runs: %s)',
    async (runTimer) => {
      await ready();
      vi.useFakeTimers();
      const capturedAt = Date.now();
      requestPage.mockResolvedValue({
        ok: true,
        value: {
          version: 1,
          id: '44444444-4444-4444-8444-444444444444',
          capturedAt,
          url: 'https://fixture.example/setup',
          title: 'Expiring fixture',
          mode: 'page',
          text: 'Synthetic steps.',
          truncated: false,
          fields: [],
        },
      });
      [...document.querySelectorAll('button')]
        .find((b) => b.textContent === 'Share this page')!
        .click();
      await vi.waitFor(() =>
        expect(document.body.textContent).toContain('Review: Expiring fixture')
      );
      composer().value = 'Keep this draft.';
      composer().dispatchEvent(new Event('input'));
      if (runTimer) {
        await vi.advanceTimersByTimeAsync(SNAPSHOT_TTL_MS + 1);
        expect(document.body.textContent).not.toContain('Attached for your next message only');
        expect(document.body.textContent).not.toContain('Review: Expiring fixture');
      } else {
        // A sleeping panel may see the clock jump before its timeout is delivered.
        vi.setSystemTime(capturedAt + SNAPSHOT_TTL_MS + 1);
      }
      submit().click();
      await vi.waitFor(() =>
        expect(document.body.textContent).toContain('Rejected — not accepted')
      );
      expect(composer().value).toBe('Keep this draft.');
      expect(submit().disabled).toBe(false);
      expect(document.body.textContent).not.toContain('Outcome unknown');
      expect(send.mock.calls.some(([request]) => request.operation?.kind === 'message')).toBe(
        false
      );
      [...document.querySelectorAll('button')]
        .find((b) => b.textContent === 'Remove page')!
        .click();
      submit().click();
      await vi.waitFor(() => expect(composer().value).toBe(''));
      const dispatched = send.mock.calls.filter(
        ([request]) => request.operation?.kind === 'message'
      );
      expect(dispatched).toHaveLength(1);
      expect(dispatched[0]![0].operation).not.toHaveProperty('pageId');
    }
  );
  it('keeps a definitely rejected snapshot send editable without losing the intended attachment silently', async () => {
    await ready();
    requestPage.mockResolvedValue({
      ok: true,
      value: {
        version: 1,
        id: '44444444-4444-4444-8444-444444444444',
        capturedAt: Date.now(),
        url: 'https://fixture.example/setup',
        title: 'Racing fixture',
        mode: 'page',
        text: 'Synthetic steps.',
        truncated: false,
        fields: [],
      },
    });
    [...document.querySelectorAll('button')]
      .find((b) => b.textContent === 'Share this page')!
      .click();
    await vi.waitFor(() => expect(document.body.textContent).toContain('Review: Racing fixture'));
    const original = send.getMockImplementation()!;
    send.mockImplementation(async (request) =>
      request.operation?.kind === 'message'
        ? { operationId: request.operation.operationId, status: 'rejected' }
        : original(request)
    );
    composer().value = 'Keep the rejected draft.';
    composer().dispatchEvent(new Event('input'));
    submit().click();
    await vi.waitFor(() => expect(document.body.textContent).toContain('Rejected — not accepted'));
    expect(submit().disabled).toBe(false);
    expect(composer().value).toBe('Keep the rejected draft.');
    submit().click();
    await vi.waitFor(() => expect(submit().disabled).toBe(false));
    expect(
      send.mock.calls.filter(([request]) => request.operation?.kind === 'message')
    ).toHaveLength(1);
  });
  it('consumes a staged snapshot even when delivery is uncertain, without claiming plain chat shared one', async () => {
    await ready();
    composer().value = 'A plain message.';
    composer().dispatchEvent(new Event('input'));
    submit().click();
    await vi.waitFor(() => expect(composer().value).toBe(''));
    expect(document.body.textContent).not.toContain('Snapshot sent with that message');
    requestPage.mockResolvedValue({
      ok: true,
      value: {
        version: 1,
        id: '44444444-4444-4444-8444-444444444444',
        capturedAt: Date.now(),
        url: 'https://fixture.example/setup',
        title: 'Uncertain fixture',
        mode: 'page',
        text: 'Synthetic steps.',
        truncated: false,
        fields: [],
      },
    });
    [...document.querySelectorAll('button')]
      .find((b) => b.textContent === 'Share this page')!
      .click();
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain('Review: Uncertain fixture')
    );
    const original = send.getMockImplementation()!;
    send.mockImplementation(async (request) =>
      request.operation?.kind === 'message'
        ? { operationId: request.operation.operationId, status: 'unknown' }
        : original(request)
    );
    composer().value = 'An uncertain attachment.';
    composer().dispatchEvent(new Event('input'));
    submit().click();
    await vi.waitFor(() => expect(document.body.textContent).toContain('Delivery is uncertain'));
    expect(document.body.textContent).not.toContain('Review: Uncertain fixture');
    expect(document.body.textContent).toContain('Check delivery below');
  });
  it('discards capture completion after Stop without sending page bytes', async () => {
    await ready();
    let finish!: (value: unknown) => void;
    requestPage.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    [...document.querySelectorAll('button')]
      .find((b) => b.textContent === 'Share this page')!
      .click();
    expect(submit().disabled).toBe(true);
    panel.stop();
    finish({
      ok: true,
      value: {
        version: 1,
        id: '44444444-4444-4444-8444-444444444444',
        capturedAt: Date.now(),
        url: 'https://fixture.example/setup',
        title: 'Late fixture',
        mode: 'page',
        text: 'Do not attach this.',
        truncated: false,
        fields: [],
      },
    });
    await vi.waitFor(() => expect(document.body.textContent).not.toContain('Capturing the page'));
    expect(document.body.textContent).not.toContain('Review: Late fixture');
    expect(send.mock.calls.some(([request]) => request.operation?.kind === 'message')).toBe(false);
  });
  it('attaches only on a click, previews privately, then sends its worker reference', async () => {
    await ready();
    const snapshot = {
      version: 1,
      id: '44444444-4444-4444-8444-444444444444',
      capturedAt: Date.now(),
      url: 'https://fixture.example/setup',
      title: 'Setup fixture',
      mode: 'page',
      text: 'Synthetic steps.',
      truncated: false,
      fields: [],
    };
    requestPage.mockResolvedValue({ ok: true, value: snapshot });
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
    [...document.querySelectorAll('button')]
      .find((b) => b.textContent === 'Share this page')!
      .click();
    await vi.waitFor(() => expect(document.body.textContent).toContain('Review: Setup fixture'));
    expect(send.mock.calls.some(([request]) => request.operation?.kind === 'message')).toBe(false);
    composer().value = 'Help me understand this.';
    composer().dispatchEvent(new Event('input'));
    submit().click();
    await vi.waitFor(() =>
      expect(send.mock.calls.some(([request]) => request.operation?.kind === 'message')).toBe(true)
    );
    expect(
      send.mock.calls.find(([request]) => request.operation?.kind === 'message')![0].operation
    ).toMatchObject({ pageId: snapshot.id, body: 'Help me understand this.' });
    expect(document.body.textContent).not.toContain('Review: Setup fixture');
  });
  it('discards a staged snapshot when the source capture changes', async () => {
    await ready();
    const snapshot = {
      version: 1,
      id: '44444444-4444-4444-8444-444444444444',
      capturedAt: Date.now(),
      url: 'https://fixture.example/setup',
      title: 'Setup fixture',
      mode: 'page',
      text: 'Synthetic steps.',
      truncated: false,
      fields: [],
    };
    requestPage.mockResolvedValueOnce({ ok: true, value: snapshot });
    [...document.querySelectorAll('button')]
      .find((b) => b.textContent === 'Share this page')!
      .click();
    await vi.waitFor(() => expect(document.body.textContent).toContain('Review: Setup fixture'));
    requestPage.mockResolvedValue({ ok: true, value: {} });
    changed({}, 'session');
    await vi.waitFor(() =>
      expect(document.body.textContent).not.toContain('Review: Setup fixture')
    );
  });
  it('shows a saved unknown message after reload and retries only on an explicit click', async () => {
    const operationId = '33333333-3333-4333-8333-333333333333';
    const original = send.getMockImplementation()!;
    send.mockImplementation(async (request) =>
      request.operation?.kind === 'messages'
        ? {
            threadKey: 'thread:fixture-chat',
            messages: [],
            pendingOperationId: operationId,
            pendingMessage: { operationId, body: 'Exact original text.' },
          }
        : original(request)
    );
    connect().click();
    await vi.waitFor(() => expect(document.getElementById('chat-retry')?.hidden).toBe(false));
    expect(submit().disabled).toBe(true);
    expect(document.getElementById('chat-retry-body')!.textContent).toBe('Exact original text.');
    expect(document.getElementById('hosted-chat')!.textContent).not.toContain('Disconnected');
    expect(send.mock.calls.some(([request]) => request.type === 'retry')).toBe(false);
    composer().value = 'A different draft must not be sent.';
    composer().dispatchEvent(new Event('input'));
    document.getElementById('chat-retry-send')!.click();
    await vi.waitFor(() =>
      expect(send.mock.calls.some(([request]) => request.type === 'retry')).toBe(true)
    );
    expect(send.mock.calls.find(([request]) => request.type === 'retry')![0].operation).toEqual({
      kind: 'message',
      inklingId,
      operationId,
      body: 'Exact original text.',
    });
  });
  it('offers Reconnect after grant expiry rather than automatically resuming stale intent', async () => {
    vi.useFakeTimers();
    await ready();
    connections[0]!.deliver({ type: 'connection-ended', reason: 'expired' });
    expect(connect().textContent).toBe('Reconnect');
    expect(connect().disabled).toBe(false);
    expect(submit().disabled).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(connections).toHaveLength(1);
    expect(document.getElementById('chat-status')!.textContent).toContain('pair again');
  });
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
