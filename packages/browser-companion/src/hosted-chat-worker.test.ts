// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerHostedChatWorker } from './hosted-chat-worker';
const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  chat: vi.fn(),
  close: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock('./connection', () => ({ createBrowserConnection: mocks.create }));
const grantId = '11111111-1111-4111-8111-111111111111';
const inklingId = '22222222-2222-4222-8222-222222222222';
const operationId = '33333333-3333-4333-8333-333333333333';
const extensionId = 'a'.repeat(32);
let onConnect: (port: chrome.runtime.Port) => void;
let stored: Record<string, unknown>;
let write: ReturnType<typeof vi.fn>;
let record: ReturnType<typeof vi.fn>;
let worker: ReturnType<typeof registerHostedChatWorker>;
const deferred = <T>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
function port(sender: Partial<chrome.runtime.MessageSender> = {}) {
  let receive: (message: unknown) => void;
  let closed: () => void;
  const p = {
    name: 'hosted-chat',
    sender: {
      id: extensionId,
      url: `chrome-extension://${extensionId}/sidepanel.html`,
      documentId: 'fixture-document',
      frameId: 0,
      ...sender,
    },
    postMessage: vi.fn(),
    disconnect: vi.fn(() => closed?.()),
    onMessage: {
      addListener: (fn: typeof receive) => {
        receive = fn;
      },
    },
    onDisconnect: {
      addListener: (fn: typeof closed) => {
        closed = fn;
      },
    },
  };
  onConnect(p as unknown as chrome.runtime.Port);
  const request = async (message: Record<string, unknown>) => {
    const id = crypto.randomUUID();
    receive({ ...message, id });
    await vi.waitFor(() =>
      expect(p.postMessage.mock.calls.some(([reply]) => reply.id === id)).toBe(true)
    );
    return p.postMessage.mock.calls.find(([reply]) => reply.id === id)![0];
  };
  return { ...p, request, emit: (message: unknown) => receive(message) };
}
beforeEach(() => {
  vi.resetAllMocks();
  stored = {};
  mocks.refresh.mockResolvedValue({ grantId });
  mocks.chat.mockResolvedValue({ messages: [], status: 'stored', operationId });
  mocks.create.mockReturnValue({
    refresh: mocks.refresh,
    current: () => ({ grantId }),
    chat: mocks.chat,
    close: mocks.close,
  });
  write = vi.fn(async (value) => {
    stored = { ...stored, ...structuredClone(value) };
  });
  vi.stubGlobal('chrome', {
    runtime: {
      id: extensionId,
      getURL: (path: string) => `chrome-extension://${extensionId}/${path}`,
      onConnect: {
        addListener: (fn: typeof onConnect) => {
          onConnect = fn;
        },
      },
      sendMessage: vi.fn(async () => undefined),
    },
    storage: { session: { get: async () => stored, set: write } },
  });
  record = vi.fn(async () => ({ phase: 'paired' }));
  worker = registerHostedChatWorker(record as never);
});
afterEach(() => {
  worker.disconnect();
  vi.unstubAllGlobals();
});
const message = {
  type: 'chat',
  operation: { kind: 'message', inklingId, operationId, body: 'Synthetic text.' },
};
describe('document-bound hosted chat worker', () => {
  it('does nothing when a port opens or a status is requested without Connect', async () => {
    const p = port();
    expect(record).not.toHaveBeenCalled();
    expect((await p.request(message)).ok).toBe(false);
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it.each([
    { id: 'other' },
    { url: 'https://fixture.test' },
    { url: `chrome-extension://${extensionId}/other.html` },
    { documentId: undefined },
    { frameId: 1 },
  ])('refuses an unauthenticated panel %j', (sender) => {
    const p = port(sender);
    expect(p.disconnect).toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });
  it('Connect binds the record to a live intent and returns only the view', async () => {
    const p = port();
    expect(await p.request({ type: 'connect' })).toMatchObject({ ok: true, value: { grantId } });
    expect(mocks.create.mock.calls[0]![1].aborted).toBe(false);
    p.disconnect();
    expect(mocks.create.mock.calls[0]![1].aborted).toBe(true);
  });
  it('Disconnect fences a record lookup before it can mint', async () => {
    const waiting = deferred<unknown>();
    record.mockReturnValue(waiting.promise);
    const p = port();
    p.emit({ type: 'connect', id: crypto.randomUUID() });
    worker.disconnect();
    waiting.resolve({ phase: 'paired' });
    await Promise.resolve();
    expect(mocks.create).not.toHaveBeenCalled();
    expect(p.postMessage).toHaveBeenCalledWith({ type: 'disconnected' });
  });
  it('Disconnect closes every panel before broadcast or storage IO', async () => {
    const a = port();
    const b = port();
    await a.request({ type: 'connect' });
    await b.request({ type: 'connect' });
    worker.disconnect();
    expect(a.disconnect).toHaveBeenCalled();
    expect(b.disconnect).toHaveBeenCalled();
    expect(mocks.close).toHaveBeenCalledTimes(2);
    expect(write).not.toHaveBeenCalled();
  });
  it('persists uncertainty before dispatch and clears only a matching positive receipt', async () => {
    const p = port();
    await p.request({ type: 'connect' });
    mocks.chat.mockImplementation(async () => {
      expect(stored.chatPending).toEqual({ [`${grantId}:${inklingId}`]: operationId });
      return { status: 'stored', operationId };
    });
    expect((await p.request(message)).ok).toBe(true);
    expect(stored.chatPending).toEqual({});
  });
  it('never dispatches when persistence fails', async () => {
    const p = port();
    await p.request({ type: 'connect' });
    write.mockRejectedValue(new Error('invented write failure'));
    expect((await p.request(message)).ok).toBe(false);
    expect(mocks.chat).not.toHaveBeenCalled();
  });
  it('does not resend after an ambiguous send, including after worker replacement', async () => {
    const p = port();
    await p.request({ type: 'connect' });
    mocks.chat.mockRejectedValue(new Error('invented lost response'));
    await p.request(message);
    expect(mocks.chat).toHaveBeenCalledTimes(1);
    worker.disconnect();
    worker = registerHostedChatWorker(record as never);
    const next = port();
    await next.request({ type: 'connect' });
    expect((await next.request(message)).ok).toBe(false);
    expect(mocks.chat).toHaveBeenCalledTimes(1);
  });
  it('checks the exact uncertain receipt and does not turn absence into rejection', async () => {
    const p = port();
    await p.request({ type: 'connect' });
    stored.chatPending = { [`${grantId}:${inklingId}`]: operationId };
    mocks.chat.mockImplementation(async (op) =>
      op.kind === 'receipt' ? { operationId, status: 'unknown' } : { messages: [] }
    );
    const request = { type: 'chat', operation: { kind: 'messages', inklingId } };
    expect((await p.request(request)).value.pendingOperationId).toBe(operationId);
    expect(stored.chatPending).toHaveProperty(`${grantId}:${inklingId}`);
    mocks.chat.mockImplementation(async (op) =>
      op.kind === 'receipt' ? { operationId, status: 'stored' } : { messages: [] }
    );
    expect((await p.request(request)).value.receipt).toEqual({ operationId, status: 'stored' });
    expect(stored.chatPending).toEqual({});
  });
  it('fences cross-panel simultaneous sends by durable target, not by port', async () => {
    const a = port();
    const b = port();
    await a.request({ type: 'connect' });
    await b.request({ type: 'connect' });
    const waiting = deferred<unknown>();
    mocks.chat.mockReturnValue(waiting.promise);
    a.emit({ ...message, id: crypto.randomUUID() });
    await vi.waitFor(() => expect(mocks.chat).toHaveBeenCalledTimes(1));
    expect((await b.request(message)).ok).toBe(false);
    expect(mocks.chat).toHaveBeenCalledTimes(1);
    waiting.resolve({ status: 'unknown' });
  });
  it.each([null, [], 'invalid', { bad: operationId }])(
    'refuses corrupt pending state %j',
    async (invalid) => {
      stored.chatPending = invalid;
      const p = port();
      await p.request({ type: 'connect' });
      expect((await p.request(message)).ok).toBe(false);
      expect(mocks.chat).not.toHaveBeenCalled();
    }
  );
  it('rejects arbitrary methods, URLs and malformed IDs', async () => {
    const p = port();
    await p.request({ type: 'connect' });
    for (const operation of [
      { kind: 'fetch', url: 'https://fixture.test' },
      { kind: 'message', inklingId: '../admin' },
    ])
      expect((await p.request({ type: 'chat', operation })).ok).toBe(false);
    expect(mocks.chat).not.toHaveBeenCalled();
  });
});
