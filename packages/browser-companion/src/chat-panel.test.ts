// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CHAT_PANEL_LIMITS,
  createChatPanel,
  type ChatConnectionState,
  type ChatDeliveryState,
  type ChatPanelCallbacks,
  type ChatPanelMessage,
  type ChatPanelViewState,
} from './chat-panel';

function view(overrides: Partial<ChatPanelViewState> = {}): ChatPanelViewState {
  return {
    conversation: {
      scopeId: 'synthetic-workspace',
      threadKey: 'thread:synthetic-page',
      sbSlug: 'synthetic-sb',
      sbName: 'Example SB',
    },
    page: {
      title: 'Example page',
      url: 'https://example.test/page',
      binding: {
        controllerSessionId: 'synthetic-controller',
        grantId: 'synthetic-grant',
        tabId: 7,
        documentId: 'synthetic-document',
        navigationId: 'synthetic-navigation',
        origin: 'https://example.test',
      },
    },
    connection: 'ready',
    sharing: { state: 'active', sessionId: 'synthetic-read-session' },
    messages: [],
    ...overrides,
  };
}

function message(id: string, status: ChatDeliveryState, body = id): ChatPanelMessage {
  return { id, status, author: 'Example author', body };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, refuse) => {
    resolve = accept;
    reject = refuse;
  });
  return { promise, resolve, reject };
}

const panels: ReturnType<typeof createChatPanel>[] = [];
function setup(initial = view(), extra: Partial<ChatPanelCallbacks> = {}) {
  const host = document.createElement('div');
  document.body.append(host);
  const result = deferred<{ status: ChatDeliveryState }>();
  const send = vi.fn<ChatPanelCallbacks['send']>().mockReturnValue(result.promise);
  const stop = vi.fn<ChatPanelCallbacks['stop']>();
  const panel = createChatPanel(host, initial, { send, stop, ...extra });
  panels.push(panel);
  const composer = host.querySelector('textarea')!;
  const form = host.querySelector('form')!;
  const sendButton = host.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  const stopButton = host.querySelector<HTMLButtonElement>('button[type="button"]')!;
  const input = (text: string) => {
    composer.value = text;
    composer.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const submit = () => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  const rows = () => [...host.querySelectorAll('li')].map((node) => node.textContent);
  return {
    panel,
    host,
    composer,
    form,
    send,
    stop,
    sendButton,
    stopButton,
    input,
    submit,
    rows,
    result,
  };
}

afterEach(() => {
  for (const panel of panels.splice(0)) panel.destroy();
  document.body.replaceChildren();
});

describe('chat panel view', () => {
  it('labels the recipient, thread, attached page, sharing, composer and message log', () => {
    const p = setup();
    expect(p.host.textContent).toContain('With Example SB');
    expect(p.host.textContent).toContain('Thread: thread:synthetic-page');
    expect(p.host.textContent).toContain('Attached page: Example page');
    expect(p.host.textContent).toContain('https://example.test/page');
    expect(p.host.textContent).toContain('Page sharing active');
    expect(p.host.querySelector('[role="log"]')?.getAttribute('aria-label')).toBe(
      'Conversation messages'
    );
    expect(p.composer.closest('label')?.textContent).toBe('Message to selected SB');
    expect(p.composer.getAttribute('aria-label')).toBe('Message to selected SB');
    expect(p.sendButton.disabled).toBe(true);
    expect(p.stopButton.disabled).toBe(false);
    p.input('A question');
    expect(p.sendButton.disabled).toBe(false);
  });

  it('renders every untrusted field as literal text, never links, HTML or Markdown', () => {
    const payload =
      '<img src="x" onerror="alert(1)"><script>example()</script> [link](javascript:example())';
    const state = view();
    state.conversation!.sbName = payload;
    state.conversation!.threadKey = payload;
    state.page = { ...state.page!, title: payload, url: payload };
    state.messages = [
      { id: 'synthetic-message', author: payload, body: payload, status: 'completed' },
    ];
    const p = setup(state);
    expect(p.host.querySelector('img, script, a, iframe')).toBeNull();
    expect(p.host.querySelector('h2')?.textContent).toBe(`With ${payload}`);
    expect(p.host.querySelector('li strong')?.textContent).toBe(payload);
    expect(p.host.querySelector('li pre')?.textContent).toBe(payload);
    expect(p.host.textContent).toContain(`Attached page: ${payload}\n${payload}`);
    p.input(payload);
    p.submit();
    expect(p.host.querySelector('img, script, a, iframe')).toBeNull();
    expect(p.send.mock.calls[0]![0].body).toBe(payload);
  });

  it('preserves adapter order and distinguishes storage from reading and execution', () => {
    const statuses: ChatDeliveryState[] = [
      'stored',
      'queued',
      'active',
      'completed',
      'rejected',
      'unknown',
    ];
    const p = setup(
      view({ messages: statuses.map((status, index) => message(`row-${index}`, status)) })
    );
    expect([...p.host.querySelectorAll('li pre')].map((node) => node.textContent)).toEqual(
      statuses.map((_status, index) => `row-${index}`)
    );
    expect(p.rows()[0]).toContain('Stored — not confirmed read');
    expect(p.rows()[1]).toContain('Queued — awaiting execution');
    expect(p.rows()[2]).toContain('Active — execution reported');
    expect(p.rows()[3]).toContain('Completed — execution reported');
    expect(p.rows()[4]).toContain('Rejected — not accepted');
    expect(p.rows()[5]).toContain('Outcome unknown');
  });

  it('handles no recipient or attachment without assuming permission to capture', () => {
    const p = setup(view({ conversation: null, page: null, sharing: { state: 'off' } }));
    p.input('Keep this draft');
    p.submit();
    expect(p.host.textContent).toContain('Choose an SB');
    expect(p.host.textContent).toContain('No page attached');
    expect(p.host.textContent).toContain('Page not shared');
    expect(p.send).not.toHaveBeenCalled();
    expect(p.stopButton.disabled).toBe(true);
    expect(p.composer.value).toBe('Keep this draft');
  });

  it.each<Exclude<ChatConnectionState, 'ready'>>([
    'disconnected',
    'unpaired',
    'unsupported',
    'expired',
  ])('disables sends while %s but preserves an editable draft and Stop', (connection) => {
    const p = setup();
    p.input('Unsent draft');
    p.panel.setState(view({ connection }));
    expect(p.sendButton.disabled).toBe(true);
    expect(p.composer.disabled).toBe(false);
    expect(p.composer.value).toBe('Unsent draft');
    expect(p.stopButton.disabled).toBe(false);
    p.submit();
    expect(p.send).not.toHaveBeenCalled();
    p.input('Edited while unavailable');
    p.panel.setState(view());
    expect(p.composer.value).toBe('Edited while unavailable');
    expect(p.sendButton.disabled).toBe(false);
    expect(p.send).not.toHaveBeenCalled();
  });

  it('owns a bounded snapshot rather than retaining mutable message/page/recipient objects', () => {
    const state = view({ messages: [message('synthetic-message', 'stored', 'Original')] });
    const p = setup(state);
    state.page!.title = 'Changed outside';
    state.conversation!.sbName = 'Changed outside';
    state.messages[0]!.body = 'Changed outside';
    p.input('Rerender');
    expect(p.host.textContent).not.toContain('Changed outside');
    expect(p.host.textContent).toContain('Original');
  });

  it('bounds input, label length, message text, DOM count and retained history', () => {
    const messages = Array.from({ length: 150 }, (_item, index) =>
      message(`row-${index}`, 'stored', 'b'.repeat(12_000))
    );
    const state = view({
      messages,
      page: { ...view().page!, title: 't'.repeat(1_000), url: 'u'.repeat(4_000) },
    });
    state.conversation!.sbName = 's'.repeat(1_000);
    const p = setup(state);
    expect(p.host.querySelectorAll('li')).toHaveLength(CHAT_PANEL_LIMITS.messages);
    expect(p.host.querySelector('li pre')?.textContent).toHaveLength(
      CHAT_PANEL_LIMITS.messageChars
    );
    expect(p.host.querySelector('h2')?.textContent).toHaveLength(
      'With '.length + CHAT_PANEL_LIMITS.labelChars
    );
    expect(p.host.querySelectorAll('*').length).toBeLessThan(500);
    p.input('d'.repeat(CHAT_PANEL_LIMITS.draftChars + 100));
    expect(p.composer.maxLength).toBe(CHAT_PANEL_LIMITS.draftChars);
    expect(p.composer.value).toHaveLength(CHAT_PANEL_LIMITS.draftChars);
    p.submit();
    expect(p.send.mock.calls[0]![0].body).toHaveLength(CHAT_PANEL_LIMITS.draftChars);
    expect(p.host.querySelectorAll('li')).toHaveLength(CHAT_PANEL_LIMITS.messages);
    expect(p.host.textContent).toContain('Older history stays in the thread');
  });

  it('refuses oversized route identities rather than truncating to a different destination', () => {
    const state = view();
    state.conversation!.threadKey = 't'.repeat(CHAT_PANEL_LIMITS.identityChars + 1);
    const p = setup(state);
    p.input('Question');
    p.submit();
    expect(p.sendButton.disabled).toBe(true);
    expect(p.send).not.toHaveBeenCalled();
  });

  it('blocks whitespace-only submissions', () => {
    const p = setup();
    p.input(' \n\t ');
    p.submit();
    expect(p.send).not.toHaveBeenCalled();
  });

  it('preserves transcript nodes and selection while typing or refreshing unchanged history', async () => {
    const state = view({
      messages: [message('synthetic-message', 'completed', 'Select this answer')],
    });
    const p = setup(state);
    const row = p.host.querySelector('li')!;
    const body = row.querySelector('pre')!;
    const range = document.createRange();
    range.selectNodeContents(body);
    document.getSelection()!.addRange(range);
    const mutations = vi.fn();
    const observer = new MutationObserver(mutations);
    observer.observe(p.host.querySelector('[role="log"]')!, {
      subtree: true,
      childList: true,
      attributes: true,
    });
    p.input('A follow-up');
    p.panel.setState(view({ messages: [...state.messages] }));
    await Promise.resolve();
    expect(p.host.querySelector('li')).toBe(row);
    expect(p.host.querySelector('pre')).toBe(body);
    expect(document.getSelection()!.toString()).toBe('Select this answer');
    expect(mutations).not.toHaveBeenCalled();
    observer.disconnect();
    document.getSelection()!.removeAllRanges();
  });
});

describe('send receipts and draft fencing', () => {
  it('takes an immutable exact-target request and admits only one pending submit', async () => {
    const p = setup();
    p.input('  Please explain this page.  ');
    p.submit();
    p.submit();
    p.sendButton.click();
    expect(p.send).toHaveBeenCalledTimes(1);
    const [request, signal] = p.send.mock.calls[0]!;
    expect(request.body).toBe('  Please explain this page.  ');
    expect(request.conversation).toEqual(view().conversation);
    expect(request.pageBinding).toEqual(view().page!.binding);
    expect(Object.isFrozen(request.pageBinding)).toBe(true);
    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.isFrozen(request.conversation)).toBe(true);
    expect(request.operationId.length).toBeGreaterThan(0);
    expect(signal.aborted).toBe(false);
    expect(p.composer.value).toBe(request.body);
    expect(p.composer.disabled).toBe(false);
    expect(p.rows().at(-1)).toContain('Sending — delivery unconfirmed');
    expect(p.host.querySelector('[role="log"]')?.getAttribute('aria-busy')).toBe('true');
    p.result.resolve({ status: 'stored' });
    await Promise.resolve();
    expect(p.composer.value).toBe('');
    expect(p.rows().at(-1)).toContain('Stored — not confirmed read');
    expect(p.host.querySelector('[role="log"]')?.getAttribute('aria-busy')).toBe('false');
  });

  it.each<ChatDeliveryState>(['stored', 'queued', 'active', 'completed', 'rejected', 'unknown'])(
    'renders an explicit %s receipt without inventing a later stage',
    async (status) => {
      const p = setup();
      p.input('Sent draft');
      p.submit();
      p.result.resolve({ status });
      await Promise.resolve();
      expect(p.composer.value).toBe(
        status === 'rejected' || status === 'unknown' ? 'Sent draft' : ''
      );
      expect(p.rows()).toHaveLength(1);
      if (status !== 'completed') expect(p.rows()[0]).not.toContain('Completed');
      if (status !== 'active') expect(p.rows()[0]).not.toContain('Active');
      if (status === 'rejected') expect(p.sendButton.disabled).toBe(false);
      if (status === 'unknown') expect(p.sendButton.disabled).toBe(true);
    }
  );

  it('never clears a newer draft when an earlier send is acknowledged', async () => {
    const p = setup();
    p.input('First draft');
    p.submit();
    p.input('Second draft');
    p.panel.setState(
      view({ page: { ...view().page!, title: 'Updated title', url: 'https://example.test/other' } })
    );
    p.result.resolve({ status: 'queued' });
    await Promise.resolve();
    expect(p.composer.value).toBe('Second draft');
    expect(p.sendButton.disabled).toBe(false);
  });

  it('uses edit revision, not string equality, to protect a replacement draft', async () => {
    const p = setup();
    p.input('Repeated text');
    p.submit();
    p.input('Different');
    p.input('Repeated text');
    p.result.resolve({ status: 'stored' });
    await Promise.resolve();
    expect(p.composer.value).toBe('Repeated text');
  });

  it.each(['threadKey', 'sbSlug', 'scopeId'] as const)(
    'fences pending results when %s changes, even after returning to the original target',
    async (field) => {
      const p = setup();
      p.input('Old scope draft');
      p.submit();
      const signal = p.send.mock.calls[0]![1];
      const other = view();
      other.conversation![field] = `synthetic-other-${field}`;
      other.messages = [message('new-scope-message', 'completed', 'Other scope content')];
      p.panel.setState(other);
      expect(signal.aborted).toBe(true);
      expect(p.composer.value).toBe('');
      expect(p.host.textContent).not.toContain('Old scope draft');
      p.input('Other scope draft');
      p.result.resolve({ status: 'completed' });
      await Promise.resolve();
      expect(p.composer.value).toBe('Other scope draft');
      expect(p.host.textContent).not.toContain('Old scope draft');
      p.panel.setState(view());
      p.input('Returned scope draft');
      await Promise.resolve();
      expect(p.composer.value).toBe('Returned scope draft');
      expect(p.rows()).toHaveLength(0);
    }
  );

  it('ignores a late old receipt after switching away and back while a new send is pending', async () => {
    const p = setup();
    p.input('Old question');
    p.submit();
    const oldId = p.send.mock.calls[0]![0].operationId;
    p.panel.setState(view({ conversation: null }));
    p.panel.setState(view());
    // Returning to the same scope does not clear an ambiguous in-flight send.
    p.input('New question');
    expect(p.sendButton.disabled).toBe(true);
    p.panel.setState(view({ messages: [message(oldId, 'rejected', 'Old question')] }));
    const next = deferred<{ status: ChatDeliveryState }>();
    p.send.mockReturnValueOnce(next.promise);
    p.input('New question');
    p.submit();
    p.result.resolve({ status: 'completed' });
    await Promise.resolve();
    expect(p.composer.value).toBe('New question');
    expect(p.rows()).toHaveLength(2);
    expect(p.rows().at(-1)).toContain('Sending — delivery unconfirmed');
    next.resolve({ status: 'queued' });
    await Promise.resolve();
    expect(p.composer.value).toBe('');
    expect(p.rows().at(-1)).toContain('Queued');
  });

  it('reconciles the adapter echo without duplicate rows or downgrading a completed message', async () => {
    const p = setup();
    p.input('Question');
    p.submit();
    const id = p.send.mock.calls[0]![0].operationId;
    p.panel.setState(
      view({
        messages: [message(id, 'completed', 'Question'), message('reply', 'completed', 'Answer')],
      })
    );
    p.result.resolve({ status: 'stored' });
    await Promise.resolve();
    expect(p.rows()).toHaveLength(2);
    expect(p.rows()[0]).toContain('Completed');
    expect(p.rows()[1]).toContain('Answer');
  });

  it.each(['throw', 'reject'] as const)(
    'treats a callback %s as unknown, hides raw errors and never retries',
    async (mode) => {
      const p = setup();
      if (mode === 'throw')
        p.send.mockImplementationOnce(() => {
          throw new Error('Synthetic internal debug payload');
        });
      p.input('Keep uncertain draft');
      p.submit();
      if (mode === 'reject') p.result.reject(new Error('Synthetic internal debug payload'));
      await Promise.resolve();
      expect(p.host.textContent).toContain('No automatic retry');
      expect(p.host.textContent).not.toContain('Synthetic internal debug payload');
      expect(p.composer.value).toBe('Keep uncertain draft');
      p.input('Even an edited draft waits for reconciliation');
      p.panel.setState(view());
      p.submit();
      expect(p.sendButton.disabled).toBe(true);
      expect(p.send).toHaveBeenCalledTimes(1);
    }
  );

  it('treats a malformed runtime receipt as unknown rather than successful delivery', async () => {
    const p = setup();
    p.send.mockResolvedValueOnce({ status: 'invalid' } as unknown as { status: ChatDeliveryState });
    p.input('Question');
    p.submit();
    await Promise.resolve();
    expect(p.composer.value).toBe('Question');
    expect(p.host.textContent).toContain('Outcome unknown');
    expect(p.sendButton.disabled).toBe(true);
  });

  it('unlocks an unknown send only after adapter reconciliation, without auto-resubmitting', async () => {
    const p = setup();
    p.input('Uncertain question');
    p.submit();
    const id = p.send.mock.calls[0]![0].operationId;
    p.result.resolve({ status: 'unknown' });
    await Promise.resolve();
    p.panel.setState(view({ messages: [message(id, 'queued', 'Uncertain question')] }));
    expect(p.composer.value).toBe('');
    expect(p.host.textContent).not.toContain('No automatic retry');
    expect(p.send).toHaveBeenCalledTimes(1);
    p.input('A new question');
    expect(p.sendButton.disabled).toBe(false);
  });

  it('preserves a newer draft when an unknown send is reconciled', async () => {
    const p = setup();
    p.input('Original question');
    p.submit();
    const id = p.send.mock.calls[0]![0].operationId;
    p.result.resolve({ status: 'unknown' });
    await Promise.resolve();
    p.input('New question');
    p.panel.setState(view({ messages: [message(id, 'stored', 'Original question')] }));
    expect(p.composer.value).toBe('New question');
    expect(p.sendButton.disabled).toBe(false);
  });

  it.each(['controllerSessionId', 'grantId', 'documentId', 'navigationId', 'origin'] as const)(
    'fences a changed %s binding within the same thread and SB',
    async (field) => {
      const p = setup();
      p.input('Old binding question');
      p.submit();
      const [request, signal] = p.send.mock.calls[0]!;
      const next = view();
      next.page!.binding[field] = `synthetic-new-${field}`;
      p.panel.setState(next);
      expect(signal.aborted).toBe(true);
      expect(request.pageBinding![field]).toBe(view().page!.binding[field]);
      expect(p.composer.value).toBe('');
      p.input('New binding question');
      p.result.resolve({ status: 'completed' });
      await Promise.resolve();
      expect(p.composer.value).toBe('New binding question');
      expect(p.rows()).toHaveLength(0);
      // A new page binding is not a new conversation; the old send is still ambiguous.
      expect(p.sendButton.disabled).toBe(true);
    }
  );

  it.each(['tab', 'detach'] as const)(
    'fences a %s change independent of page title or URL',
    async (kind) => {
      const p = setup();
      p.input('Old binding question');
      p.submit();
      const next = view();
      if (kind === 'tab') next.page!.binding.tabId++;
      else next.page = null;
      p.panel.setState(next);
      p.input('New binding question');
      p.result.resolve({ status: 'stored' });
      await Promise.resolve();
      expect(p.composer.value).toBe('New binding question');
      expect(p.rows()).toHaveLength(0);
    }
  );

  it('bounds unresolved targets without evicting ambiguity and silently enabling duplicate sends', async () => {
    const p = setup();
    const unresolvedIds: string[] = [];
    for (let index = 0; index < CHAT_PANEL_LIMITS.unresolvedTargets; index++) {
      const state = view();
      state.conversation!.threadKey = `thread:synthetic-${index}`;
      p.panel.setState(state);
      p.send.mockResolvedValueOnce({ status: 'unknown' });
      p.input('Uncertain question');
      p.submit();
      unresolvedIds.push(p.send.mock.calls.at(-1)![0].operationId);
      await Promise.resolve();
    }
    p.panel.setState(view());
    p.input('Another question');
    p.submit();
    expect(p.sendButton.disabled).toBe(true);
    expect(p.host.textContent).toContain('Too many unresolved deliveries');
    expect(p.send).toHaveBeenCalledTimes(CHAT_PANEL_LIMITS.unresolvedTargets);
    const first = view({ messages: [message(unresolvedIds[0]!, 'rejected')] });
    first.conversation!.threadKey = 'thread:synthetic-0';
    p.panel.setState(first);
    p.input('Explicitly reconciled question');
    expect(p.sendButton.disabled).toBe(false);
  });
});

describe('local Stop and cleanup', () => {
  it('calls Stop synchronously during a pending send, aborts locally and ignores late success', async () => {
    const p = setup();
    p.input('Pending question');
    p.submit();
    const [request, signal] = p.send.mock.calls[0]!;
    expect(p.stopButton.disabled).toBe(false);
    p.stopButton.click();
    expect(p.stop).toHaveBeenCalledTimes(1);
    expect(p.stop).toHaveBeenCalledWith({
      conversation: view().conversation,
      pageBinding: view().page!.binding,
      operationId: request.operationId,
      readSessionId: 'synthetic-read-session',
    });
    expect(signal.aborted).toBe(true);
    expect(p.composer.value).toBe('Pending question');
    expect(p.host.textContent).toContain('remote cancellation is not confirmed');
    expect(p.rows()[0]).toContain('Outcome unknown');
    p.result.resolve({ status: 'completed' });
    await Promise.resolve();
    expect(p.composer.value).toBe('Pending question');
    expect(p.rows()[0]).not.toContain('Completed');
    expect(p.stopButton.disabled).toBe(true);
  });

  it('can stop pending delivery with no active sharing session', () => {
    const p = setup(view({ sharing: { state: 'off' } }));
    expect(p.stopButton.disabled).toBe(true);
    p.input('Question');
    p.submit();
    expect(p.stopButton.disabled).toBe(false);
    p.stopButton.click();
    expect(p.stop.mock.calls[0]![0].readSessionId).toBeUndefined();
  });

  it.each<Exclude<ChatConnectionState, 'ready'>>([
    'disconnected',
    'unpaired',
    'unsupported',
    'expired',
  ])('keeps Stop local and available when a pending send becomes %s', (connection) => {
    const p = setup();
    p.input('In-flight question');
    p.submit();
    p.panel.setState(view({ connection, sharing: { state: 'expired' } }));
    expect(p.sendButton.disabled).toBe(true);
    expect(p.stopButton.disabled).toBe(false);
    p.stopButton.click();
    expect(p.stop).toHaveBeenCalledTimes(1);
    expect(p.send.mock.calls[0]![1].aborted).toBe(true);
    expect(p.composer.value).toBe('In-flight question');
  });

  it('does not let a stale sharing refresh undo a local Stop; a new session is distinct', () => {
    const p = setup();
    p.stopButton.click();
    expect(p.host.textContent).toContain('Page sharing stop requested');
    p.panel.setState(view());
    expect(p.stopButton.disabled).toBe(true);
    expect(p.host.textContent).not.toContain('Page sharing active');
    p.panel.setState(view({ sharing: { state: 'stopped' } }));
    expect(p.host.textContent).toContain('Page sharing stopped locally');
    p.panel.setState(
      view({ sharing: { state: 'active', sessionId: 'synthetic-new-read-session' } })
    );
    expect(p.stopButton.disabled).toBe(false);
    expect(p.host.textContent).toContain('Page sharing active');
  });

  it('reports local stop failure without exposing error text or claiming remote cancellation', () => {
    const p = setup(
      { ...view() },
      {
        stop: () => {
          throw new Error('Synthetic private debug detail');
        },
      }
    );
    p.input('Question');
    p.submit();
    p.stopButton.click();
    expect(p.host.textContent).toContain('Local stop callback failed');
    expect(p.host.textContent).not.toContain('Synthetic private debug detail');
    expect(p.send.mock.calls[0]![1].aborted).toBe(true);
    expect(p.stopButton.disabled).toBe(false);
  });

  it('unsubscribes once, clears handlers and ignores stale updates/results after destroy', async () => {
    let receive!: (state: ChatPanelViewState) => void;
    const unsubscribe = vi.fn();
    const p = setup(view(), {
      subscribe: (listener) => {
        receive = listener;
        return unsubscribe;
      },
    });
    const sibling = document.createElement('p');
    sibling.textContent = 'Sibling view';
    p.host.append(sibling);
    p.input('Question');
    p.submit();
    const signal = p.send.mock.calls[0]![1];
    p.panel.destroy();
    p.panel.destroy();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(signal.aborted).toBe(true);
    expect(p.composer.value).toBe('');
    expect(p.host.textContent).toBe('Sibling view');
    p.input('Detached draft');
    p.submit();
    p.stopButton.click();
    receive(view({ messages: [message('late', 'completed', 'Late state')] }));
    p.panel.setState(view());
    p.result.resolve({ status: 'completed' });
    await Promise.resolve();
    expect(p.host.textContent).toBe('Sibling view');
    expect(p.send).toHaveBeenCalledTimes(1);
    expect(p.stop).not.toHaveBeenCalled();
  });

  it('supports synchronous initial subscription updates', () => {
    const p = setup(view(), {
      subscribe: (receive) => {
        receive(view({ connection: 'expired' }));
        return () => {};
      },
    });
    p.input('Question');
    expect(p.host.textContent).toContain('Authorization expired');
    expect(p.sendButton.disabled).toBe(true);
  });

  it('aborts and detaches even if unsubscribe throws', () => {
    const p = setup(view(), {
      subscribe: () => () => {
        throw new Error('Synthetic unsubscribe failure');
      },
    });
    p.input('Question');
    p.submit();
    expect(() => p.panel.destroy()).toThrow('Synthetic unsubscribe failure');
    expect(p.send.mock.calls[0]![1].aborted).toBe(true);
    expect(p.host.childElementCount).toBe(0);
    expect(() => p.panel.destroy()).not.toThrow();
  });

  it('removes its partially mounted view if subscription setup throws', () => {
    const host = document.createElement('div');
    expect(() =>
      createChatPanel(host, view(), {
        send: async () => ({ status: 'stored' }),
        stop: () => {},
        subscribe: () => {
          throw new Error('Synthetic internal subscription detail');
        },
      })
    ).toThrow('Conversation subscription failed.');
    expect(host.childElementCount).toBe(0);
  });
});

describe('review regressions: conversation receipts and keyed history', () => {
  describe.each(['navigation', 'grant', 'detach'] as const)(
    'retained echo evidence after %s',
    (change) => {
      it.each<ChatDeliveryState | 'never-echoed'>([
        'stored',
        'queued',
        'active',
        'completed',
        'rejected',
        'unknown',
        'never-echoed',
      ])('uses %s evidence even after the history window slides', (status) => {
        const p = setup();
        p.input('Original question');
        p.submit();
        const [request, signal] = p.send.mock.calls[0]!;
        if (status !== 'never-echoed') {
          p.panel.setState(view({ messages: [message(request.operationId, status)] }));
        }
        const newer = Array.from({ length: CHAT_PANEL_LIMITS.messages }, (_, index) =>
          message(`newer-${index}`, 'completed')
        );
        p.panel.setState(view({ messages: newer }));
        const next = view({ messages: newer });
        if (change === 'navigation') next.page!.binding.navigationId = 'synthetic-navigation-2';
        if (change === 'grant') next.page!.binding.grantId = 'synthetic-grant-2';
        if (change === 'detach') next.page = null;
        p.panel.setState(next);
        expect(signal.aborted).toBe(true);
        expect(p.composer.value).toBe('');
        p.input('Next question');
        const mustLock = status === 'unknown' || status === 'never-echoed';
        expect(p.sendButton.disabled).toBe(mustLock);
        expect(p.host.textContent?.includes('Delivery is uncertain')).toBe(mustLock);
        expect(p.send).toHaveBeenCalledTimes(1);
        expect(p.rows()).toHaveLength(CHAT_PANEL_LIMITS.messages);
      });
    }
  );

  it('keeps the latest unknown echo locked even after an earlier positive echo', () => {
    const p = setup();
    p.input('Question');
    p.submit();
    const id = p.send.mock.calls[0]![0].operationId;
    p.panel.setState(view({ messages: [message(id, 'stored')] }));
    p.panel.setState(view({ messages: [message(id, 'unknown')] }));
    p.panel.setState(view());
    p.panel.setState(view({ page: null }));
    p.input('Next question');
    expect(p.sendButton.disabled).toBe(true);
    p.submit();
    expect(p.send).toHaveBeenCalledTimes(1);
  });

  it('fences a late callback after navigating with an evicted positive echo', async () => {
    const p = setup();
    p.input('Original question');
    p.submit();
    const id = p.send.mock.calls[0]![0].operationId;
    p.panel.setState(view({ messages: [message(id, 'stored')] }));
    p.panel.setState(view());
    p.panel.setState(view({ page: null }));
    p.input('New question');
    expect(p.sendButton.disabled).toBe(false);
    const next = deferred<{ status: ChatDeliveryState }>();
    p.send.mockReturnValueOnce(next.promise);
    p.submit();
    expect(p.send).toHaveBeenCalledTimes(2);
    p.result.resolve({ status: 'unknown' });
    await Promise.resolve();
    expect(p.composer.value).toBe('New question');
    expect(p.rows()).toHaveLength(1);
    expect(p.rows()[0]).toContain('Sending — delivery unconfirmed');
    expect(p.host.textContent).not.toContain('Delivery is uncertain');
    next.resolve({ status: 'stored' });
    await Promise.resolve();
    expect(p.composer.value).toBe('');
    p.input('Another question');
    expect(p.sendButton.disabled).toBe(false);
  });

  it.each(['navigation', 'grant', 'detach'] as const)(
    'keeps uncertainty conversation-scoped after %s and reconciles on the new binding',
    async (change) => {
      const p = setup();
      p.input('Uncertain original question');
      p.submit();
      const id = p.send.mock.calls[0]![0].operationId;
      p.result.resolve({ status: 'unknown' });
      await Promise.resolve();
      expect(p.sendButton.disabled).toBe(true);
      const next = view();
      if (change === 'navigation') next.page!.binding.navigationId = 'synthetic-navigation-2';
      if (change === 'grant') next.page!.binding.grantId = 'synthetic-grant-2';
      if (change === 'detach') next.page = null;
      p.panel.setState(next);
      p.input('New binding draft');
      p.submit();
      expect(p.sendButton.disabled).toBe(true);
      expect(p.send).toHaveBeenCalledTimes(1);
      p.panel.setState({ ...next, messages: [message('unrelated-receipt', 'completed')] });
      expect(p.sendButton.disabled).toBe(true);
      p.panel.setState({ ...next, messages: [message(id, 'unknown')] });
      expect(p.sendButton.disabled).toBe(true);
      p.panel.setState({ ...next, messages: [message(id, 'stored')] });
      expect(p.sendButton.disabled).toBe(false);
      expect(p.composer.value).toBe('New binding draft');
      expect(p.send).toHaveBeenCalledTimes(1);
    }
  );

  it('navigation churn cannot create many ambiguous sends to one conversation', async () => {
    const p = setup();
    p.send.mockResolvedValue({ status: 'unknown' });
    for (let index = 0; index <= CHAT_PANEL_LIMITS.unresolvedTargets; index++) {
      const next = view();
      next.page!.binding.navigationId = `synthetic-navigation-${index}`;
      p.panel.setState(next);
      p.input('Question');
      p.submit();
      await Promise.resolve();
    }
    expect(p.send).toHaveBeenCalledTimes(1);
    expect(p.host.textContent).toContain('Delivery is uncertain');
    expect(p.host.textContent).not.toContain('Too many unresolved');
    const other = view();
    other.conversation!.threadKey = 'thread:synthetic-other';
    p.panel.setState(other);
    p.input('Other conversation question');
    expect(p.sendButton.disabled).toBe(false);
    p.submit();
    expect(p.send).toHaveBeenCalledTimes(2);
  });

  it.each(['before', 'after'] as const)(
    'never resurrects an echoed local row when its receipt arrives %s the history slides',
    async (timing) => {
      const p = setup();
      p.input('Old question');
      p.submit();
      const id = p.send.mock.calls[0]![0].operationId;
      if (timing === 'before') {
        p.result.resolve({ status: 'stored' });
        await Promise.resolve();
      }
      p.panel.setState(view({ messages: [message(id, 'completed', 'Old question')] }));
      expect(p.rows()).toHaveLength(1);
      const newer = Array.from({ length: CHAT_PANEL_LIMITS.messages }, (_, index) =>
        message(`newer-${index}`, 'completed', `Newer ${index}`)
      );
      p.panel.setState(view({ messages: [message(id, 'completed', 'Old question'), ...newer] }));
      expect(p.rows()).toHaveLength(CHAT_PANEL_LIMITS.messages);
      expect(p.rows().at(-1)).toContain('Newer 99');
      expect(p.host.textContent).not.toContain('Old question');
      if (timing === 'after') {
        // A lost direct acknowledgment cannot override an earlier authoritative echo.
        p.result.resolve({ status: 'unknown' });
        await Promise.resolve();
      }
      p.input('Next question');
      expect(p.sendButton.disabled).toBe(false);
      expect(p.host.textContent).not.toContain('Old question');
      expect(p.rows().at(-1)).toContain('Newer 99');
    }
  );

  it('keeps an unechoed local row visible until the adapter supplies it', async () => {
    const p = setup();
    p.input('Unobserved local question');
    p.submit();
    p.result.resolve({ status: 'stored' });
    await Promise.resolve();
    p.panel.setState(view({ messages: [message('reply', 'completed', 'Other message')] }));
    expect(p.rows().at(-1)).toContain('Unobserved local question');
  });

  it('preserves selected text, row and body identity and scroll across append and status ticks', () => {
    const first = message('first', 'stored', 'Selected answer');
    const p = setup(view({ messages: [first] }));
    const row = p.host.querySelector('li')!;
    const body = row.querySelector('pre')!;
    body.scrollTop = 37;
    body.scrollLeft = 11;
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    const range = document.createRange();
    range.selectNodeContents(body);
    selection.addRange(range);
    expect(selection.toString()).toBe('Selected answer');
    const observer = new MutationObserver(() => {});
    observer.observe(body, { subtree: true, childList: true, characterData: true });
    const reply = message('reply', 'completed', 'Appended reply');
    p.panel.setState(view({ messages: [first, reply] }));
    p.panel.setState(view({ messages: [{ ...first, status: 'completed' }, reply] }));
    expect(p.host.querySelector('li')).toBe(row);
    expect(row.querySelector('pre')).toBe(body);
    expect(row.textContent).toContain('Completed');
    expect(body.scrollTop).toBe(37);
    expect(body.scrollLeft).toBe(11);
    expect(selection.toString()).toBe('Selected answer');
    expect(observer.takeRecords()).toHaveLength(0);
    observer.disconnect();
    selection.removeAllRanges();
  });

  it('preserves existing history while a local send is added, echoed and acknowledged', async () => {
    const first = message('history', 'completed', 'Existing answer');
    const p = setup(view({ messages: [first] }));
    const historyRow = p.host.querySelector('li')!;
    p.input('Question');
    p.submit();
    const id = p.send.mock.calls[0]![0].operationId;
    const localRow = p.host.querySelector('li:last-child')!;
    expect(p.host.querySelector('li')).toBe(historyRow);
    p.panel.setState(view({ messages: [first, message(id, 'queued', 'Question')] }));
    expect(p.host.querySelector('li:last-child')).toBe(localRow);
    p.result.resolve({ status: 'stored' });
    await Promise.resolve();
    expect(p.host.querySelector('li')).toBe(historyRow);
    expect(p.host.querySelector('li:last-child')).toBe(localRow);
    expect(localRow.textContent).toContain('Queued');
  });

  it('removes only evicted rows and preserves adapter order on replacement and reorder', () => {
    const a = message('a', 'stored', 'Alpha');
    const b = message('b', 'stored', 'Beta');
    const c = message('c', 'stored', 'Gamma');
    const p = setup(view({ messages: [a, b] }));
    const oldRows = [...p.host.querySelectorAll('li')];
    p.panel.setState(view({ messages: [b, c] }));
    expect(oldRows[0]!.isConnected).toBe(false);
    expect(p.host.querySelector('li')).toBe(oldRows[1]);
    const cRow = p.host.querySelector('li:last-child');
    p.panel.setState(view({ messages: [c, { ...b, body: 'Updated Beta' }] }));
    expect(p.host.querySelector('li')).toBe(cRow);
    expect(p.host.querySelector('li:last-child')).toBe(oldRows[1]);
    expect([...p.host.querySelectorAll('pre')].map((node) => node.textContent)).toEqual([
      'Gamma',
      'Updated Beta',
    ]);
  });

  it('does not rewrite unchanged live-region text on typing or refresh', async () => {
    const p = setup();
    p.input('Question');
    p.submit();
    p.result.resolve({ status: 'unknown' });
    await Promise.resolve();
    expect(p.host.textContent).toContain('Delivery is uncertain');
    const observer = new MutationObserver(() => {});
    for (const node of p.host.querySelectorAll('[role="status"]'))
      observer.observe(node, { childList: true, subtree: true, characterData: true });
    p.input('Updated question');
    p.panel.setState(view());
    expect(observer.takeRecords()).toHaveLength(0);
    observer.disconnect();
  });

  it.each(['thread', 'page'] as const)(
    'cannot revive the same stopped read session after switching %s bindings',
    (kind) => {
      const p = setup();
      p.stopButton.click();
      expect(p.host.textContent).toContain('Page sharing stop requested');
      const next = view();
      if (kind === 'thread') next.conversation!.threadKey = 'thread:synthetic-other';
      else next.page!.binding.navigationId = 'synthetic-new-navigation';
      p.panel.setState(next);
      expect(p.host.textContent).not.toContain('Page sharing active');
      expect(p.stopButton.disabled).toBe(true);
      p.panel.setState(view());
      expect(p.host.textContent).not.toContain('Page sharing active');
      p.panel.setState({
        ...next,
        sharing: { state: 'active', sessionId: 'synthetic-fresh-read' },
      });
      expect(p.host.textContent).toContain('Page sharing active');
      expect(p.stopButton.disabled).toBe(false);
    }
  );
});
