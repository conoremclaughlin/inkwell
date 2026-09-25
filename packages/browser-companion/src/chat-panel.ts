/** View-only contracts, not server wire formats or authorization decisions. */
export type ChatDeliveryState =
  | 'stored'
  | 'queued'
  | 'active'
  | 'completed'
  | 'rejected'
  | 'unknown';
export type ChatConnectionState = 'ready' | 'disconnected' | 'unpaired' | 'unsupported' | 'expired';

export interface ChatConversation {
  /** Adapter-owned account/workspace binding; never a credential. */
  scopeId: string;
  threadKey: string;
  sbSlug: string;
  sbName: string;
}

export interface ChatPanelMessage {
  /** Stable UI identity. Echo a send's operationId here to reconcile its local row. */
  id: string;
  author: string;
  body: string;
  status: ChatDeliveryState;
}

/** Trusted adapter metadata, never identity asserted by page content. */
export interface ChatPageBinding {
  controllerSessionId: string;
  /** Opaque grant identity, never the grant token. Change it on regrant. */
  grantId: string;
  tabId: number;
  documentId: string;
  navigationId: string;
  origin: string;
}

export interface ChatPanelViewState {
  conversation: ChatConversation | null;
  page: { title: string; url: string; binding: ChatPageBinding } | null;
  connection: ChatConnectionState;
  sharing: { state: 'active'; sessionId: string } | { state: 'off' | 'stopped' | 'expired' };
  /** Oldest first, with statuses established by the adapter, not inferred from HTTP success. */
  messages: readonly ChatPanelMessage[];
}

export interface ChatSendRequest {
  /** Local correlation only: NOT a server idempotency key or proof of delivery. */
  operationId: string;
  conversation: Readonly<ChatConversation>;
  pageBinding: Readonly<ChatPageBinding> | null;
  body: string;
}

export interface ChatPanelCallbacks {
  /** Return only a verified stage. Transport ambiguity must return unknown or reject.
   * Respect abort where possible; abort does not prove remote cancellation.
   */
  send(
    request: Readonly<ChatSendRequest>,
    signal: AbortSignal
  ): Promise<{ status: ChatDeliveryState }>;
  /** Must revoke locally synchronously, without waiting for network IO. */
  stop(request: {
    conversation: Readonly<ChatConversation> | null;
    pageBinding: Readonly<ChatPageBinding> | null;
    operationId?: string;
    readSessionId?: string;
  }): void;
  subscribe?(receive: (state: ChatPanelViewState) => void): () => void;
}

export const CHAT_PANEL_LIMITS = Object.freeze({
  messages: 100,
  messageChars: 8_000,
  draftChars: 4_000,
  labelChars: 256,
  identityChars: 1_024,
  unresolvedTargets: 100,
});

const deliveryLabels: Record<ChatDeliveryState, string> = {
  stored: 'Stored — not confirmed read',
  queued: 'Queued — awaiting execution',
  active: 'Active — execution reported',
  completed: 'Completed — execution reported',
  rejected: 'Rejected — not accepted',
  unknown: 'Outcome unknown — check the thread before retrying',
};
const connectionLabels: Record<ChatConnectionState, string> = {
  ready: 'Connected',
  disconnected: 'Disconnected — draft preserved',
  unpaired: 'Not paired — draft preserved',
  unsupported: 'Live chat unsupported — draft preserved',
  expired: 'Authorization expired — draft preserved',
};
const accepted = (status: ChatDeliveryState) =>
  status === 'stored' || status === 'queued' || status === 'active' || status === 'completed';
const identity = (value: string) =>
  value.length > 0 && value.length <= CHAT_PANEL_LIMITS.identityChars;
const clip = (value: string, limit: number) =>
  value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
const targetKey = (state: ChatPanelViewState) => {
  const conversation = state.conversation;
  const binding = state.page?.binding;
  return JSON.stringify([
    conversation?.scopeId,
    conversation?.threadKey,
    conversation?.sbSlug,
    binding?.controllerSessionId,
    binding?.grantId,
    binding?.tabId,
    binding?.documentId,
    binding?.navigationId,
    binding?.origin,
  ]);
};
const receiptStatus = (receipt: unknown): ChatDeliveryState => {
  if (receipt && typeof receipt === 'object' && 'status' in receipt) {
    const status = receipt.status;
    if (typeof status === 'string' && Object.hasOwn(deliveryLabels, status))
      return status as ChatDeliveryState;
  }
  return 'unknown';
};

function snapshot(state: ChatPanelViewState): ChatPanelViewState {
  const conversation = state.conversation;
  const binding = state.page?.binding;
  const pageValid =
    !state.page ||
    (binding &&
      Number.isSafeInteger(binding.tabId) &&
      binding.tabId >= 0 &&
      [
        binding.controllerSessionId,
        binding.grantId,
        binding.documentId,
        binding.navigationId,
        binding.origin,
      ].every(identity));
  return {
    conversation:
      pageValid &&
      conversation &&
      [conversation.scopeId, conversation.threadKey, conversation.sbSlug].every(identity)
        ? {
            scopeId: conversation.scopeId,
            threadKey: conversation.threadKey,
            sbSlug: conversation.sbSlug,
            sbName: clip(conversation.sbName, CHAT_PANEL_LIMITS.labelChars),
          }
        : null,
    connection: state.connection,
    page:
      state.page && binding && pageValid
        ? {
            title: clip(state.page.title, CHAT_PANEL_LIMITS.labelChars),
            url: clip(state.page.url, 2_048),
            binding: {
              controllerSessionId: binding.controllerSessionId,
              grantId: binding.grantId,
              tabId: binding.tabId,
              documentId: binding.documentId,
              navigationId: binding.navigationId,
              origin: binding.origin,
            },
          }
        : null,
    sharing:
      state.sharing.state === 'active'
        ? identity(state.sharing.sessionId)
          ? { state: 'active', sessionId: state.sharing.sessionId }
          : { state: 'expired' }
        : { state: state.sharing.state },
    messages: state.messages
      .slice(-CHAT_PANEL_LIMITS.messages)
      .filter((message) => identity(message.id))
      .map((message) => ({
        id: message.id,
        author: clip(message.author, CHAT_PANEL_LIMITS.labelChars),
        body: clip(message.body, CHAT_PANEL_LIMITS.messageChars),
        status: receiptStatus(message),
      })),
  };
}

/** Dependency-free conversation view; intentionally not wired to any entrypoint.
 * No network, capture, persistence, credentials, HTML/Markdown interpretation or retry.
 * Same-target updates preserve the draft; changing scope/thread/SB/page/controller discards it instead
 * of carrying potentially private text to another recipient. An unknown send locks
 * further sends to that target until an adapter update reconciles its operationId.
 * This bounded in-memory guard survives view switches, not destroy/reload. The adapter
 * must retain/reconcile ambiguous deliveries durably; UI IDs do not ensure exactly-once.
 * Destroy removes this view, not remote work: the owner must also end page-read grants.
 */
export function createChatPanel(
  host: HTMLElement,
  initial: ChatPanelViewState,
  callbacks: ChatPanelCallbacks
): { setState(state: ChatPanelViewState): void; destroy(): void } {
  const doc = host.ownerDocument;
  const element = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '') => {
    const node = doc.createElement(tag);
    node.textContent = text;
    return node;
  };
  const root = element('section');
  root.className = 'ink-chat-panel';
  root.setAttribute('aria-label', 'Page conversation');
  const heading = element('h2');
  const thread = element('p');
  const page = element('p');
  const sharing = element('p');
  const connection = element('p');
  connection.setAttribute('role', 'status');
  const log = element('section');
  log.setAttribute('role', 'log');
  log.setAttribute('aria-label', 'Conversation messages');
  const history = element(
    'p',
    `Showing up to ${CHAT_PANEL_LIMITS.messages} recent messages. Older history stays in the thread.`
  );
  const messages = element('ol');
  log.append(history, messages);
  const form = element('form');
  const label = element('label', 'Message to selected SB');
  const composer = element('textarea');
  composer.setAttribute('aria-label', 'Message to selected SB');
  composer.maxLength = CHAT_PANEL_LIMITS.draftChars;
  composer.rows = 4;
  label.append(composer);
  const count = element('p');
  const send = element('button', 'Send message');
  send.type = 'submit';
  const stop = element('button', 'Stop');
  stop.type = 'button';
  stop.setAttribute('aria-label', 'Stop sharing and pending operation');
  const notice = element('p');
  notice.setAttribute('role', 'status');
  const guard = element('p');
  guard.setAttribute('role', 'status');
  form.append(label, count, send, stop, notice, guard);
  root.append(heading, thread, page, sharing, connection, log, form);
  host.append(root);

  let state = snapshot(initial);
  let destroyed = false;
  let revision = 0;
  let stoppedReadSession: string | undefined;
  let unsubscribe: (() => void) | undefined;
  type LocalMessage = Omit<ChatPanelMessage, 'status'> & {
    status: ChatDeliveryState | 'sending';
    draftRevision: number;
  };
  let local: LocalMessage[] = [];
  const unresolved = new Map<string, string>();
  type Operation = { id: string; key: string; revision: number; abort: AbortController };
  let pending: Operation | undefined;
  let renderedMessages: readonly (ChatPanelMessage | LocalMessage)[] = [];

  const uncertain = () => unresolved.has(targetKey(state));
  const activeRead = () =>
    state.sharing.state === 'active' && state.sharing.sessionId !== stoppedReadSession
      ? state.sharing.sessionId
      : undefined;
  const canSend = () =>
    !destroyed &&
    state.connection === 'ready' &&
    !!state.conversation &&
    !pending &&
    !uncertain() &&
    unresolved.size < CHAT_PANEL_LIMITS.unresolvedTargets &&
    composer.value.trim().length > 0 &&
    composer.value.length <= CHAT_PANEL_LIMITS.draftChars;

  function renderControls() {
    if (destroyed) return;
    send.disabled = !canSend();
    stop.disabled = !pending && !activeRead();
    count.textContent = `${composer.value.length}/${CHAT_PANEL_LIMITS.draftChars} characters`;
    guard.textContent = uncertain()
      ? 'Delivery is uncertain. No automatic retry. Check the thread to reconcile before sending again.'
      : unresolved.size >= CHAT_PANEL_LIMITS.unresolvedTargets
        ? 'Too many unresolved deliveries. Reconcile earlier sends before sending again.'
        : '';
    const busy = String(!!pending);
    if (log.getAttribute('aria-busy') !== busy) log.setAttribute('aria-busy', busy);
  }

  function render() {
    if (destroyed) return;
    renderControls();
    heading.textContent = state.conversation ? `With ${state.conversation.sbName}` : 'Choose an SB';
    thread.textContent = state.conversation
      ? `Thread: ${state.conversation.threadKey}`
      : 'No thread selected';
    page.textContent = state.page
      ? `Attached page: ${state.page.title}\n${state.page.url}`
      : 'No page attached';
    sharing.textContent = activeRead()
      ? 'Page sharing active'
      : state.sharing.state === 'expired'
        ? 'Page sharing expired'
        : state.sharing.state === 'active'
          ? 'Page sharing stop requested'
          : state.sharing.state === 'stopped'
            ? 'Page sharing stopped locally'
            : 'Page not shared';
    connection.textContent = connectionLabels[state.connection];
    const suppliedIds = new Set(state.messages.map((message) => message.id));
    const all = [...state.messages, ...local.filter((message) => !suppliedIds.has(message.id))];
    const visible = all.slice(-CHAT_PANEL_LIMITS.messages);
    if (
      visible.length === renderedMessages.length &&
      visible.every((message, index) => {
        const previous = renderedMessages[index]!;
        return (
          message.id === previous.id &&
          message.body === previous.body &&
          message.author === previous.author &&
          message.status === previous.status
        );
      })
    )
      return;
    renderedMessages = visible;
    messages.replaceChildren();
    for (const message of visible) {
      const row = element('li');
      row.append(
        element('strong', message.author),
        element('pre', message.body),
        element(
          'p',
          message.status === 'sending'
            ? 'Sending — delivery unconfirmed'
            : deliveryLabels[message.status]
        )
      );
      messages.append(row);
    }
  }

  function finish(operation: Operation, status: ChatDeliveryState) {
    if (destroyed || pending !== operation) return;
    pending = undefined;
    const supplied = state.messages.find((message) => message.id === operation.id);
    const verified = supplied && supplied.status !== 'unknown' ? supplied.status : status;
    if (verified === 'unknown') unresolved.set(operation.key, operation.id);
    else unresolved.delete(operation.key);
    local = local.map((message) =>
      message.id === operation.id ? { ...message, status: verified } : message
    );
    if (accepted(verified) && revision === operation.revision) {
      composer.value = '';
      revision++;
    }
    notice.textContent = deliveryLabels[verified];
    render();
  }

  function input() {
    composer.value = composer.value.slice(0, CHAT_PANEL_LIMITS.draftChars);
    revision++;
    // Typing must not replace transcript nodes, disturb selection or reannounce the log.
    renderControls();
  }

  function submit(event: Event) {
    event.preventDefault();
    if (!canSend() || !state.conversation) return;
    const operation: Operation = {
      id: crypto.randomUUID(),
      key: targetKey(state),
      revision,
      abort: new AbortController(),
    };
    const request: Readonly<ChatSendRequest> = Object.freeze({
      operationId: operation.id,
      conversation: Object.freeze({ ...state.conversation }),
      pageBinding: state.page && Object.freeze({ ...state.page.binding }),
      body: composer.value,
    });
    pending = operation;
    local = [
      ...local,
      {
        id: operation.id,
        author: 'You',
        body: request.body,
        status: 'sending' as const,
        draftRevision: revision,
      },
    ].slice(-CHAT_PANEL_LIMITS.messages);
    notice.textContent = 'Sending — delivery unconfirmed';
    render();
    try {
      void callbacks.send(request, operation.abort.signal).then(
        (receipt) => finish(operation, receiptStatus(receipt)),
        () => finish(operation, 'unknown')
      );
    } catch {
      finish(operation, 'unknown');
    }
  }

  function stopLocal() {
    if (destroyed || (!pending && !activeRead())) return;
    const key = targetKey(state);
    const request = {
      conversation: state.conversation && Object.freeze({ ...state.conversation }),
      pageBinding: state.page && Object.freeze({ ...state.page.binding }),
      operationId: pending?.id,
      readSessionId: activeRead(),
    };
    stoppedReadSession = request.readSessionId ?? stoppedReadSession;
    const operation = pending;
    if (operation) finish(operation, 'unknown');
    notice.textContent =
      'Stopped locally. Already submitted messages may still run; remote cancellation is not confirmed.';
    render();
    try {
      // Call the local revoker in this gesture, not behind a transport promise.
      callbacks.stop(request);
    } catch {
      if (!destroyed && targetKey(state) === key) {
        // A failed revoker must not leave the only Stop control permanently disabled.
        stoppedReadSession = undefined;
        notice.textContent = 'Local stop callback failed. Remote cancellation is not confirmed.';
        render();
      }
    } finally {
      operation?.abort.abort();
    }
  }

  function setState(next: ChatPanelViewState) {
    if (destroyed) return;
    const copy = snapshot(next);
    if (targetKey(state) !== targetKey(copy)) {
      const operation = pending;
      if (operation) unresolved.set(operation.key, operation.id);
      pending = undefined;
      local = [];
      composer.value = '';
      revision++;
      stoppedReadSession = undefined;
      notice.textContent =
        'Conversation or page binding changed. Drafts are not carried to another target.';
      state = copy;
      operation?.abort.abort();
    } else {
      state = copy;
    }
    const updates = new Map(state.messages.map((message) => [message.id, message.status]));
    const unresolvedId = unresolved.get(targetKey(state));
    if (unresolvedId && updates.has(unresolvedId) && updates.get(unresolvedId) !== 'unknown')
      unresolved.delete(targetKey(state));
    local = local.map((message) => {
      const status = updates.get(message.id) ?? message.status;
      if (message.status === 'unknown' && status !== 'unknown' && status !== 'sending') {
        notice.textContent = deliveryLabels[status];
        if (accepted(status) && message.draftRevision === revision) {
          composer.value = '';
          revision++;
        }
      }
      return { ...message, status };
    });
    render();
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    const operation = pending;
    pending = undefined;
    local = [];
    renderedMessages = [];
    unresolved.clear();
    state = {
      conversation: null,
      page: null,
      sharing: { state: 'off' },
      connection: 'unpaired',
      messages: [],
    };
    composer.value = '';
    form.removeEventListener('submit', submit);
    composer.removeEventListener('input', input);
    stop.removeEventListener('click', stopLocal);
    for (const node of [heading, thread, page, sharing, connection, messages, notice, guard])
      node.replaceChildren();
    root.replaceChildren();
    root.remove();
    try {
      unsubscribe?.();
    } finally {
      unsubscribe = undefined;
      operation?.abort.abort();
    }
  }

  form.addEventListener('submit', submit);
  composer.addEventListener('input', input);
  stop.addEventListener('click', stopLocal);
  render();
  try {
    unsubscribe = callbacks.subscribe?.(setState);
  } catch {
    destroy();
    throw new Error('Conversation subscription failed.');
  }
  return { setState, destroy };
}
