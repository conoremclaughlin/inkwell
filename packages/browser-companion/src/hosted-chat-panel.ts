import { createChatPanel, type ChatPanelMessage, type ChatPanelViewState } from './chat-panel';
import type { ConnectionView } from './connection';
import './chat-panel.css';
import { cleanBrowserText } from './browser-text';
import { parseBrowserChatPage, type BrowserChatPage } from '@inklabs/shared/browser-chat';
import { panelRequest, type CompanionState } from './state';
import { assertFresh, parseSnapshot } from './protocol';

const object = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** Intent lives in this document only. Nothing in session storage opens a port
 * or starts a token exchange on a newly opened panel. */
export function mountHostedChatPanel() {
  const host = document.getElementById('hosted-chat')!;
  const connect = document.getElementById('chat-connect') as HTMLButtonElement;
  const select = document.getElementById('chat-inkling') as HTMLSelectElement;
  const status = document.getElementById('chat-status')!;
  const retryBox = document.getElementById('chat-retry')!;
  const retryBody = document.getElementById('chat-retry-body')!;
  const retryButton = document.getElementById('chat-retry-send') as HTMLButtonElement;
  let pendingRetry:
    | { inklingId: string; operationId: string; body: string; page?: BrowserChatPage }
    | undefined;
  let pendingOperationId: string | undefined;
  let intent = false;
  let revision = 0;
  let attempted = false;
  let port: chrome.runtime.Port | undefined;
  let identity: ConnectionView | undefined;
  let poll: ReturnType<typeof setTimeout> | undefined;
  let busy = false;
  let capturing = false;
  let attachment: BrowserChatPage | undefined;
  let attachmentRevision = 0;
  const requests = new Map<
    string,
    { resolve(value: Record<string, unknown>): void; reject(): void }
  >();
  let state: ChatPanelViewState = {
    conversation: null,
    page: null,
    connection: 'disconnected',
    sharing: { state: 'off' },
    messages: [],
  };
  const panel = createChatPanel(host, state, {
    async send(request) {
      if (!intent || !identity || !select.value || busy) throw new Error('Connect first.');
      busy = true;
      const version = revision;
      const attached = attachment;
      // Consume the staging slot once, even if delivery becomes uncertain.
      // Only the worker's immutable pending request may retain it for retry.
      if (attached)
        clearAttachment('Snapshot selected for this message only. Check delivery below.');
      render();
      try {
        const result = await rpc({
          type: 'chat',
          operation: {
            kind: 'message',
            inklingId: select.value,
            operationId: request.operationId,
            body: request.body,
            ...(attached ? { pageId: attached.id } : {}),
          },
        });
        if (version !== revision || result.operationId !== request.operationId)
          return { status: 'unknown' };
        return {
          status:
            result.status === 'stored' || result.status === 'queued' ? result.status : 'unknown',
        };
      } finally {
        busy = false;
        render();
        schedule();
      }
    },
    stop() {
      stop();
      status.textContent =
        'Stopped locally. A message already sent may still run. Reconnect to check it.';
    },
    inspectDelivery() {
      void refresh();
    },
  });
  const pageTools = document.createElement('div');
  pageTools.className = 'chat-page-tools';
  const sharePage = document.createElement('button');
  sharePage.type = 'button';
  sharePage.textContent = 'Share this page';
  const removePage = document.createElement('button');
  removePage.type = 'button';
  removePage.className = 'secondary';
  removePage.textContent = 'Remove page';
  const pageStatus = document.createElement('p');
  pageStatus.setAttribute('role', 'status');
  pageStatus.textContent =
    'One snapshot, sent with your next message. Review it first; page text can be private. No form values.';
  const pagePreview = document.createElement('details');
  const pageLabel = document.createElement('summary');
  const pageText = document.createElement('pre');
  pagePreview.append(pageLabel, pageText);
  pageTools.append(sharePage, removePage, pageStatus, pagePreview);
  host.querySelector('form')!.prepend(pageTools);
  function clearAttachment(message?: string) {
    ++attachmentRevision;
    attachment = undefined;
    if (message) pageStatus.textContent = message;
  }
  sharePage.onclick = async () => {
    if (!intent || !identity || !select.value || busy || capturing || pendingOperationId) return;
    const version = revision;
    const captureVersion = ++attachmentRevision;
    capturing = true;
    attachment = undefined;
    pageStatus.textContent = 'Capturing the page you opened this panel from…';
    render();
    try {
      const snapshot = parseSnapshot(await panelRequest({ type: 'capture', mode: 'page' }));
      assertFresh(snapshot);
      if (!intent || version !== revision || captureVersion !== attachmentRevision) return;
      const { id, capturedAt, url, title, text, truncated } = snapshot;
      attachment = parseBrowserChatPage({ id, capturedAt, url, title, text, truncated });
      pageStatus.textContent =
        'Attached for your next message only. Review the snapshot or remove it before sending.';
    } catch {
      if (version === revision && captureVersion === attachmentRevision)
        pageStatus.textContent =
          'Could not capture. Click the extension icon on the page, then try Share this page.';
    } finally {
      capturing = false;
      render();
    }
  };
  removePage.onclick = () => {
    clearAttachment('Page removed. Nothing was sent.');
    render();
  };
  chrome.storage.onChanged.addListener((_changes, area) => {
    if (area !== 'session' || !attachment) return;
    const version = attachmentRevision;
    const id = attachment.id;
    void panelRequest<CompanionState>({ type: 'state' })
      .then((current) => {
        if (version === attachmentRevision && current.snapshot?.id !== id) {
          clearAttachment(
            'The page changed or the capture expired. Share it again before sending.'
          );
          render();
        }
      })
      .catch(() => {
        if (version === attachmentRevision) {
          clearAttachment('Capture unavailable. Share the page again.');
          render();
        }
      });
  });
  const composer = host.querySelector('textarea')!;
  composer.addEventListener('paste', (event) => {
    if (!event.clipboardData) return;
    const cleaned = cleanBrowserText(event.clipboardData.getData('text/plain'));
    if (!cleaned.removed) return;
    event.preventDefault();
    const room = Math.max(
      0,
      composer.maxLength -
        (composer.value.length - (composer.selectionEnd - composer.selectionStart))
    );
    composer.setRangeText(
      cleaned.text.slice(0, room),
      composer.selectionStart,
      composer.selectionEnd,
      'end'
    );
    composer.dispatchEvent(new Event('input', { bubbles: true }));
    status.textContent = `Removed ${cleaned.removed} hidden control characters from pasted text. Review the message before sending.`;
  });

  function rpc(message: Record<string, unknown>): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      if (!intent || !port) {
        reject(new Error('Disconnected.'));
        return;
      }
      const id = crypto.randomUUID();
      const timer = setTimeout(() => {
        requests.delete(id);
        reject(new Error('Outcome unknown.'));
      }, 40_000);
      requests.set(id, {
        resolve(value) {
          clearTimeout(timer);
          resolve(value);
        },
        reject() {
          clearTimeout(timer);
          reject(new Error('Chat unavailable.'));
        },
      });
      try {
        port.postMessage({ ...message, id });
      } catch {
        requests.get(id)?.reject();
        requests.delete(id);
      }
    });
  }
  function render() {
    connect.disabled = intent;
    connect.textContent = intent
      ? identity
        ? 'Connected'
        : 'Connecting…'
      : attempted
        ? 'Reconnect'
        : 'Connect';
    select.disabled = !identity || !intent || busy;
    retryBox.hidden = !pendingRetry || pendingRetry.inklingId !== select.value;
    retryButton.disabled = !intent || !identity || busy || retryBox.hidden;
    retryBody.textContent = retryBox.hidden
      ? ''
      : pendingRetry!.body +
        (pendingRetry!.page
          ? `\n\nOriginal page snapshot: ${pendingRetry!.page.title}\n${pendingRetry!.page.url}\n${pendingRetry!.page.text}`
          : '');
    sharePage.disabled =
      !intent || !identity || !select.value || busy || capturing || !!pendingOperationId;
    removePage.hidden = !attachment;
    removePage.disabled = busy;
    pagePreview.hidden = !attachment;
    pageLabel.textContent = attachment
      ? `Review: ${attachment.title || 'Untitled page'}${attachment.truncated ? ' (truncated)' : ''}`
      : '';
    pageText.textContent = attachment ? `${attachment.url}\n\n${attachment.text}` : '';
    panel.setState({ ...state, busy: busy || capturing || !!pendingOperationId });
  }
  function stop() {
    intent = false; // Synchronous, before disconnecting the port or any await.
    ++revision;
    clearAttachment('No page attached. Nothing is watched in the background.');
    clearTimeout(poll);
    const old = port;
    port = undefined;
    identity = undefined;
    for (const request of requests.values()) request.reject();
    requests.clear();
    old?.disconnect();
    state = { ...state, connection: 'disconnected' };
    render();
  }
  function schedule() {
    clearTimeout(poll);
    if (intent && identity) poll = setTimeout(() => void refresh(), 3_000);
  }
  async function refresh() {
    if (!intent || !identity || busy || !select.value) {
      schedule();
      return;
    }
    busy = true;
    render();
    const version = revision;
    const inklingId = select.value;
    try {
      const result = await rpc({ type: 'chat', operation: { kind: 'messages', inklingId } });
      if (version !== revision) return;
      if (typeof result.threadKey !== 'string' || !Array.isArray(result.messages))
        throw new Error('Invalid conversation.');
      const messages: ChatPanelMessage[] = result.messages.slice(-100).map((raw: unknown) => {
        const row = object(raw);
        if (
          typeof row.id !== 'string' ||
          typeof row.body !== 'string' ||
          typeof row.author !== 'string'
        )
          throw new Error('Invalid message.');
        return {
          id: row.id,
          body: row.body,
          author: row.author,
          status: row.status === 'stored' ? 'stored' : 'unknown',
        };
      });
      const receipt = object(result.receipt);
      pendingOperationId =
        typeof result.pendingOperationId === 'string' ? result.pendingOperationId : undefined;
      const uncertain = object(result.pendingMessage);
      pendingRetry =
        typeof uncertain.operationId === 'string' &&
        uncertain.operationId === result.pendingOperationId &&
        typeof uncertain.body === 'string' &&
        uncertain.body.length <= 4_000
          ? {
              inklingId,
              operationId: uncertain.operationId,
              body: uncertain.body,
              ...(uncertain.page === undefined
                ? {}
                : { page: parseBrowserChatPage(uncertain.page) }),
            }
          : undefined;
      if (
        typeof receipt.operationId === 'string' &&
        receipt.status === 'stored' &&
        !messages.some((row) => row.id === receipt.operationId)
      ) {
        messages.push({
          id: receipt.operationId,
          body: 'Earlier message confirmed stored.',
          author: 'You',
          status: 'stored',
        });
      }
      state = {
        ...state,
        conversation: {
          scopeId: `${identity!.origin}:${identity!.workspaceId}:${identity!.userId}:${identity!.grantId}`,
          threadKey: result.threadKey,
          sbSlug: inklingId,
          sbName: select.selectedOptions[0]?.textContent ?? 'Inkling',
        },
        messages,
        connection: 'ready',
      };
      status.textContent = result.pendingOperationId
        ? pendingRetry
          ? 'Checking an uncertain delivery. Review the saved message below to retry it explicitly.'
          : 'Checking an uncertain delivery. No saved retry body is available; nothing will be resent.'
        : 'Connected. Chat uses your companion’s usual tools. Page snapshots are shared only when you send them.';
    } catch {
      if (version === revision) {
        state = { ...state, connection: 'disconnected' };
        status.textContent = 'Conversation unavailable. Checking again; nothing will be resent.';
      }
    } finally {
      busy = false;
      render();
      schedule();
    }
  }
  async function open() {
    const version = ++revision;
    status.textContent = 'Connecting…';
    render();
    const next = chrome.runtime.connect({ name: 'hosted-chat' });
    port = next;
    next.onMessage.addListener((raw: unknown) => {
      if (next !== port) return;
      const message = object(raw);
      if (message.type === 'connection-ended') {
        stop();
        status.textContent =
          'Connection ended. Reconnect, or pair again if authorization has expired or been revoked.';
        return;
      }
      if (message.type === 'disconnected') {
        stop();
        status.textContent = 'Disconnected across this browser.';
        return;
      }
      if (typeof message.id !== 'string') return;
      const request = requests.get(message.id);
      requests.delete(message.id);
      if (message.ok === true) request?.resolve(object(message.value));
      else request?.reject();
    });
    next.onDisconnect.addListener(() => {
      if (next !== port) return;
      port = undefined;
      identity = undefined;
      clearAttachment('Connection interrupted. Share the page again after reconnecting.');
      ++revision;
      for (const request of requests.values()) request.reject();
      requests.clear();
      state = { ...state, connection: 'disconnected' };
      render();
      // A worker restart is not a new document. Resume only surviving intent.
      if (intent)
        poll = setTimeout(() => {
          if (intent) void open();
        }, 1_000);
    });
    try {
      const verified = await rpc({ type: 'connect' });
      if (!intent || version !== revision) return;
      identity = verified as unknown as ConnectionView;
      const result = await rpc({ type: 'chat', operation: { kind: 'inklings' } });
      if (!intent || version !== revision) return;
      if (!Array.isArray(result.inklings)) throw new Error('Invalid inklings.');
      const previous = select.value;
      select.replaceChildren();
      for (const raw of result.inklings.slice(0, 100)) {
        const inkling = object(raw);
        if (typeof inkling.id !== 'string' || typeof inkling.name !== 'string')
          throw new Error('Invalid inkling.');
        const option = document.createElement('option');
        option.value = inkling.id;
        option.textContent = inkling.name;
        select.append(option);
      }
      if ([...select.options].some((option) => option.value === previous)) select.value = previous;
      status.textContent = select.value
        ? 'Loading your conversation…'
        : 'No inklings in this space. Awaken one in the app first.';
      render();
      await refresh();
    } catch {
      if (version !== revision) return;
      stop();
      status.textContent = 'Could not connect. Check pairing and the server, then Reconnect.';
    }
  }
  const start = () => {
    if (!intent) {
      intent = true;
      attempted = true;
      void open();
    }
  };
  connect.onclick = start;
  select.onchange = () => {
    ++revision;
    clearAttachment('Recipient changed. No page attached.');
    pendingRetry = undefined;
    pendingOperationId = undefined;
    // The pending send keeps its immutable target; prevent switching until it settles.
    state = { ...state, conversation: null, messages: [], connection: 'disconnected' };
    render();
    void refresh();
  };
  retryButton.onclick = async () => {
    const saved = pendingRetry;
    if (!saved || saved.inklingId !== select.value || !intent || !identity || busy) return;
    const version = revision;
    busy = true;
    render();
    try {
      await rpc({
        type: 'retry',
        operation: {
          kind: 'message',
          inklingId: saved.inklingId,
          operationId: saved.operationId,
          body: saved.body,
        },
      });
    } catch {
      // Still unknown. Keep the original request; never create a replacement ID.
    } finally {
      busy = false;
      render();
      if (version === revision) await refresh();
    }
  };
  document.getElementById('pair-disconnect')!.addEventListener('click', stop);
  chrome.runtime.onMessage.addListener((message, sender) => {
    if (sender.id === chrome.runtime.id && message?.type === 'chat:disconnected') {
      stop();
      status.textContent = 'Disconnected across this browser.';
    }
  });
  window.addEventListener('pagehide', stop);
  render();
  return { stop, connect: start };
}
