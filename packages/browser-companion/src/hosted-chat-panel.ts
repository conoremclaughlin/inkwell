import { createChatPanel, type ChatPanelMessage, type ChatPanelViewState } from './chat-panel';
import type { ConnectionView } from './connection';
import './chat-panel.css';
import { cleanBrowserText } from './browser-text';

const object = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** Intent lives in this document only. Nothing in session storage opens a port
 * or starts a token exchange on a newly opened panel. */
export function mountHostedChatPanel() {
  const host = document.getElementById('hosted-chat')!;
  const connect = document.getElementById('chat-connect') as HTMLButtonElement;
  const select = document.getElementById('chat-inkling') as HTMLSelectElement;
  const status = document.getElementById('chat-status')!;
  let intent = false;
  let revision = 0;
  let attempted = false;
  let port: chrome.runtime.Port | undefined;
  let identity: ConnectionView | undefined;
  let poll: ReturnType<typeof setTimeout> | undefined;
  let busy = false;
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
      render();
      const version = revision;
      try {
        const result = await rpc({
          type: 'chat',
          operation: {
            kind: 'message',
            inklingId: select.value,
            operationId: request.operationId,
            body: request.body,
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
    panel.setState({ ...state, busy });
  }
  function stop() {
    intent = false; // Synchronous, before disconnecting the port or any await.
    ++revision;
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
        connection: result.pendingOperationId ? 'disconnected' : 'ready',
      };
      status.textContent = result.pendingOperationId
        ? 'Checking an uncertain delivery. Nothing will be resent automatically.'
        : 'Connected. Chat uses your inkling’s usual tools. No page is shared.';
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
  connect.onclick = () => {
    if (!intent) {
      intent = true;
      attempted = true;
      void open();
    }
  };
  select.onchange = () => {
    ++revision;
    // The pending send keeps its immutable target; prevent switching until it settles.
    state = { ...state, conversation: null, messages: [], connection: 'disconnected' };
    render();
    void refresh();
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
  return { stop };
}
