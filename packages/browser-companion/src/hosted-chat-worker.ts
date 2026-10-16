import { ConnectionError, createBrowserConnection, type BrowserChatOperation } from './connection';
import type { PairingRecord } from './pairing';
import { parseBrowserChatPage, type BrowserChatPage } from '@inklabs/shared/browser-chat';

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const uuid = (v: unknown): v is string =>
  typeof v === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(v);
type PendingMessage = { operationId: string; body: string; page?: BrowserChatPage };
type Pending = string | PendingMessage; // Old references remain read-only recoverable.
const pendingId = (entry: Pending) => (typeof entry === 'string' ? entry : entry.operationId);
const validPage = (page: unknown) => {
  try {
    parseBrowserChatPage(page);
    return true;
  } catch {
    return false;
  }
};
const validPending = (entry: unknown): entry is Pending =>
  uuid(entry) ||
  (uuid(object(entry).operationId) &&
    typeof object(entry).body === 'string' &&
    String(object(entry).body).trim().length > 0 &&
    String(object(entry).body).length <= 4_000 &&
    (object(entry).page === undefined || validPage(object(entry).page)));

/** A port is bound by Chrome to one authenticated extension document. Opening it
 * does no IO; only the panel's in-memory Connect intent starts a connection.
 * Port loss closes every bearer. A surviving panel may explicitly re-send its
 * intent after worker suspension; a new/reloaded document starts without it. */
export function registerHostedChatWorker(
  getRecord: () => Promise<PairingRecord>,
  getPage?: (snapshotId: string) => Promise<BrowserChatPage>
) {
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
    if (value === undefined) return {} as Record<string, Pending>;
    if (value === null || typeof value !== 'object' || Array.isArray(value))
      throw new Error('Pending delivery state unavailable.');
    const entries = object(value);
    if (
      Object.keys(entries).length > 100 ||
      Object.entries(entries).some(
        ([key, entry]) =>
          key.split(':').length !== 2 || !key.split(':').every(uuid) || !validPending(entry)
      )
    )
      throw new Error('Pending delivery state unavailable.');
    return entries as Record<string, Pending>;
  }
  async function clearPending(key: string, operationId: string) {
    await serial(async () => {
      const entries = await pending();
      if (!entries[key] || pendingId(entries[key]) !== operationId) return;
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
        if (message.type !== 'chat' && message.type !== 'retry')
          throw new Error('Unsupported chat request.');
        if (!connection || !grantId) throw new Error('Connect first.');
        if (busy) throw new Error('A chat operation is already pending.');
        const op = object(message.operation) as unknown as BrowserChatOperation;
        // Page bytes must come from a worker-held capture, never an RPC-supplied page.
        if ('page' in object(message.operation)) throw new Error('Invalid page authority.');
        if (message.type === 'retry' && op.kind !== 'message') throw new Error('Invalid retry.');
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
          let outgoing = op;
          const key = op.kind === 'inklings' ? '' : `${grantId}:${op.inklingId}`;
          if (op.kind === 'message') {
            let rejected = false;
            await serial(async () => {
              alive();
              const entries = await pending();
              alive();
              const previous = entries[key];
              if (message.type === 'retry') {
                // Only an explicit retry of the byte-identical saved request.
                // The server's unique client-message index supplies deduplication.
                if (
                  !previous ||
                  typeof previous === 'string' ||
                  previous.operationId !== op.operationId ||
                  previous.body !== op.body
                )
                  throw new Error('Retry must match the original message.');
                outgoing = {
                  kind: 'message',
                  inklingId: op.inklingId,
                  operationId: op.operationId,
                  body: op.body,
                  ...(previous.page ? { page: parseBrowserChatPage(previous.page) } : {}),
                };
                return;
              }
              if (previous || Object.keys(entries).length >= 100)
                throw new Error('Check the previous delivery before sending again.');
              let page: BrowserChatPage | undefined;
              const pageId = object(message.operation).pageId;
              if (pageId !== undefined) {
                try {
                  if (typeof pageId !== 'string' || !getPage)
                    throw new Error('Invalid page capture.');
                  page = parseBrowserChatPage(await getPage(pageId));
                } catch {
                  // No prior pending request, write or dispatch: this refusal is
                  // definitely not sent. Storage/transport failures stay unknown.
                  rejected = true;
                  return;
                }
              }
              alive();
              // Durable-before-dispatch. A crash may leave an unsent unknown,
              // but cannot silently replay a potentially accepted send.
              await chrome.storage.session.set({
                chatPending: {
                  ...entries,
                  [key]: { operationId: op.operationId, body: op.body, ...(page ? { page } : {}) },
                },
              });
              outgoing = {
                kind: 'message',
                inklingId: op.inklingId,
                operationId: op.operationId,
                body: op.body,
                ...(page ? { page } : {}),
              };
            });
            alive();
            if (rejected) return { operationId: op.operationId, status: 'rejected' };
          }
          const result = await connection.chat(outgoing);
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
            const entry = entries[key];
            if (entry) {
              const operationId = pendingId(entry);
              const receipt = await connection.chat({
                kind: 'receipt',
                inklingId: op.inklingId,
                operationId,
              });
              alive();
              if (receipt.operationId === operationId && receipt.status === 'stored') {
                await clearPending(key, operationId);
                result.receipt = { operationId, status: 'stored' };
              } else {
                result.pendingOperationId = operationId;
                if (typeof entry !== 'string')
                  result.pendingMessage = {
                    operationId,
                    body: entry.body,
                    ...(entry.page ? { page: parseBrowserChatPage(entry.page) } : {}),
                  };
              }
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
        (error: unknown) => {
          post({
            id,
            ok: false,
            error: 'Chat unavailable. Check connection and delivery before retrying.',
          });
          if (
            error instanceof ConnectionError &&
            ['expired', 'refused', 'closed'].includes(error.code)
          ) {
            post({ type: 'connection-ended', reason: error.code });
            stop();
            connection = undefined;
            grantId = undefined;
            try {
              port.disconnect();
            } catch {
              /* Already closed. */
            }
          } else if (message.type === 'connect') disconnect();
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
