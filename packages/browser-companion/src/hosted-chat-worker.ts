import { createBrowserConnection, type BrowserChatOperation } from './connection';
import type { PairingRecord } from './pairing';

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const uuid = (v: unknown): v is string =>
  typeof v === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(v);

/** A port is bound by Chrome to one authenticated extension document. Opening it
 * does no IO; only the panel's in-memory Connect intent starts a connection.
 * Port loss closes every bearer. A surviving panel may explicitly re-send its
 * intent after worker suspension; a new/reloaded document starts without it. */
export function registerHostedChatWorker(getRecord: () => Promise<PairingRecord>) {
  const stops = new Set<() => void>();
  let epoch = 0;
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>) => {
    const next = tail.then(fn, fn);
    tail = next.catch(() => undefined);
    return next;
  };
  async function pending() {
    const value: unknown = (await chrome.storage.session.get('chatPending')).chatPending;
    if (value === undefined) return {} as Record<string, string>;
    if (value === null || typeof value !== 'object' || Array.isArray(value))
      throw new Error('Pending delivery state unavailable.');
    const entries = object(value);
    if (
      Object.keys(entries).length > 100 ||
      Object.entries(entries).some(
        ([key, id]) => key.split(':').length !== 2 || !key.split(':').every(uuid) || !uuid(id)
      )
    )
      throw new Error('Pending delivery state unavailable.');
    return entries as Record<string, string>;
  }
  async function clearPending(key: string, operationId: string) {
    await serial(async () => {
      const entries = await pending();
      if (entries[key] !== operationId) return;
      delete entries[key];
      await chrome.storage.session.set({ chatPending: entries });
    });
  }
  chrome.runtime.onConnect.addListener((port) => {
    const sender = port.sender;
    if (
      port.name !== 'hosted-chat' ||
      sender?.id !== chrome.runtime.id ||
      sender.url !== chrome.runtime.getURL('sidepanel.html') ||
      !sender.documentId ||
      (sender.frameId !== undefined && sender.frameId !== 0) ||
      stops.size >= 16
    ) {
      port.disconnect();
      return;
    }
    const lifetime = new AbortController();
    const admittedEpoch = epoch;
    let connection: ReturnType<typeof createBrowserConnection> | undefined;
    let grantId: string | undefined;
    let connecting = false;
    let busy = false;
    const alive = () => {
      lifetime.signal.throwIfAborted();
      if (epoch !== admittedEpoch) throw new Error('Disconnected.');
    };
    const post = (value: unknown) => {
      if (!lifetime.signal.aborted) {
        try {
          port.postMessage(value);
        } catch {
          stop();
        }
      }
    };
    const stop = () => {
      if (lifetime.signal.aborted) return;
      lifetime.abort();
      connection?.close();
      stops.delete(disconnect);
    };
    const disconnect = () => {
      post({ type: 'disconnected' });
      stop();
      try {
        port.disconnect();
      } catch {
        /* Already closed. */
      }
    };
    stops.add(disconnect);
    port.onDisconnect.addListener(stop);
    port.onMessage.addListener((raw: unknown) => {
      const message = object(raw);
      const id = message.id;
      if (!uuid(id)) return;
      const run = async () => {
        alive();
        if (message.type === 'connect') {
          if (connecting || connection) throw new Error('Already connecting.');
          connecting = true;
          const record = await getRecord();
          alive();
          connection = createBrowserConnection(record, lifetime.signal);
          const view = await connection.refresh();
          alive();
          grantId = view.grantId;
          return view;
        }
        if (message.type !== 'chat') throw new Error('Unsupported chat request.');
        if (!connection || !grantId) throw new Error('Connect first.');
        if (busy) throw new Error('A chat operation is already pending.');
        const op = object(message.operation) as unknown as BrowserChatOperation;
        if (!['inklings', 'messages', 'message'].includes(op.kind))
          throw new Error('Unsupported chat operation.');
        if (op.kind !== 'inklings' && !uuid(op.inklingId)) throw new Error('Invalid inkling.');
        if (
          op.kind === 'message' &&
          (!uuid(op.operationId) ||
            typeof op.body !== 'string' ||
            !op.body.trim() ||
            op.body.length > 4_000)
        )
          throw new Error('Invalid message.');
        busy = true;
        try {
          const key = op.kind === 'inklings' ? '' : `${grantId}:${op.inklingId}`;
          if (op.kind === 'message') {
            await serial(async () => {
              alive();
              const entries = await pending();
              alive();
              if (entries[key] || Object.keys(entries).length >= 100)
                throw new Error('Check the previous delivery before sending again.');
              // Durable-before-dispatch. A crash may leave an unsent unknown,
              // but cannot permit replay of a potentially accepted send.
              await chrome.storage.session.set({
                chatPending: { ...entries, [key]: op.operationId },
              });
            });
            alive();
          }
          const result = await connection.chat(op);
          alive();
          if (
            op.kind === 'message' &&
            result.operationId === op.operationId &&
            ['stored', 'queued'].includes(String(result.status))
          )
            await clearPending(key, op.operationId);
          if (op.kind === 'messages') {
            const entries = await pending();
            alive();
            const operationId = entries[key];
            if (operationId) {
              const receipt = await connection.chat({
                kind: 'receipt',
                inklingId: op.inklingId,
                operationId,
              });
              alive();
              if (receipt.operationId === operationId && receipt.status === 'stored') {
                await clearPending(key, operationId);
                result.receipt = { operationId, status: 'stored' };
              } else result.pendingOperationId = operationId;
            }
          }
          alive();
          return result;
        } finally {
          busy = false;
        }
      };
      void run().then(
        (value) => post({ id, ok: true, value }),
        () => {
          post({
            id,
            ok: false,
            error: 'Chat unavailable. Check connection and delivery before retrying.',
          });
          if (message.type === 'connect') disconnect();
        }
      );
    });
  });
  return {
    disconnect() {
      ++epoch; // Fence all connections before any storage or revocation wait.
      for (const stop of [...stops]) stop();
      // Also clear intent in panels between port attempts. Delivery failure is
      // residual, not confirmation of storage or remote grant revocation.
      void chrome.runtime.sendMessage({ type: 'chat:disconnected' }).catch(() => undefined);
    },
  };
}
