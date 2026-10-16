import { createPairingClient, type PairingView } from './pairing';

/** Serialized into the approved dashboard document. No credentials are sent to the page. */
export function connectPairingApproval(
  expectedUrl: string,
  bridgeId: string,
  installationId: string
): boolean {
  if (location.href !== expectedUrl) return false;
  const host = globalThis as typeof globalThis & { __inkPairingCleanup?: () => void };
  host.__inkPairingCleanup?.();
  const origin = location.origin;
  let active = true;
  let armed = false;
  let sent = false;
  const offer = () => {
    if (active && armed && !sent && location.href === expectedUrl)
      window.postMessage({ type: 'inkwell:pairing-ready', bridgeId, installationId }, origin);
  };
  const arm = (
    message: { type?: string; bridgeId?: string },
    sender: chrome.runtime.MessageSender
  ) => {
    if (
      sender.id === chrome.runtime.id &&
      message.type === 'pairing:arm' &&
      message.bridgeId === bridgeId
    ) {
      armed = true;
      offer();
    }
  };
  const handler = (event: MessageEvent) => {
    if (
      !active ||
      !armed ||
      sent ||
      location.href !== expectedUrl ||
      event.source !== window ||
      event.origin !== origin ||
      event.data?.type !== 'inkwell:pairing-approved' ||
      event.data.bridgeId !== bridgeId ||
      event.data.installationId !== installationId ||
      typeof event.data.code !== 'string' ||
      !/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789-]{12,14}$/.test(event.data.code)
    )
      return;
    sent = true; // Never replay a claim after an ambiguous worker/network outcome.
    void chrome.runtime
      .sendMessage({ type: 'bridge:pairing', bridgeId, installationId, code: event.data.code })
      .then(
        (reply) => {
          if (active && location.href === expectedUrl)
            window.postMessage(
              {
                type: 'inkwell:pairing-receipt',
                bridgeId,
                installationId,
                phase: reply?.ok ? reply.value?.phase : 'unavailable',
              },
              origin
            );
        },
        () => {
          if (active && location.href === expectedUrl)
            window.postMessage(
              { type: 'inkwell:pairing-receipt', bridgeId, installationId, phase: 'unknown' },
              origin
            );
        }
      );
  };
  window.addEventListener('message', handler);
  chrome.runtime.onMessage.addListener(arm);
  const interval = setInterval(offer, 1000);
  const timeout = setTimeout(cleanup, 10 * 60 * 1000);
  function cleanup() {
    active = false;
    clearInterval(interval);
    clearTimeout(timeout);
    window.removeEventListener('message', handler);
    chrome.runtime.onMessage.removeListener(arm);
  }
  host.__inkPairingCleanup = cleanup;
  return true;
}

interface ApprovalTab {
  url: string;
  installationId: string;
  bridgeId: string;
  tabId: number;
  documentId?: string;
}

/** Bind the callback to the extension-created tab and the injected top-level document. */
export function createPairingApprovalBridge(
  getClient: () => Promise<ReturnType<typeof createPairingClient>>
) {
  let generation = 0;
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(action: () => Promise<T>) => {
    const next = tail.then(action, action);
    tail = next.catch(() => undefined);
    return next;
  };
  const read = async (): Promise<ApprovalTab | undefined> => {
    const raw = (await chrome.storage.session.get('pairingApproval')).pairingApproval;
    if (raw === undefined) return;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      throw new Error('Approval callback unavailable.');
    const value = raw as Record<string, unknown>;
    if (
      typeof value.url !== 'string' ||
      typeof value.installationId !== 'string' ||
      typeof value.bridgeId !== 'string' ||
      !Number.isInteger(value.tabId) ||
      (value.documentId !== undefined && typeof value.documentId !== 'string')
    )
      throw new Error('Approval callback unavailable.');
    return {
      url: value.url,
      installationId: value.installationId,
      bridgeId: value.bridgeId,
      tabId: value.tabId as number,
      ...(value.documentId ? { documentId: value.documentId as string } : {}),
    };
  };
  async function attach() {
    const revision = generation;
    const approval = await read();
    if (!approval) return;
    const client = await getClient();
    const state = await client.status();
    if (
      state.phase !== 'ready' ||
      state.approvalUrl !== approval.url ||
      state.installationId !== approval.installationId
    )
      return;
    const tab = await chrome.tabs.get(approval.tabId);
    if (tab.url !== approval.url || (tab.status && tab.status !== 'complete')) return;
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: approval.tabId },
      world: 'ISOLATED',
      func: connectPairingApproval,
      args: [approval.url, approval.bridgeId, approval.installationId],
    });
    if (revision !== generation || !result?.documentId || result.result !== true) return;
    await chrome.storage.session.set({
      pairingApproval: { ...approval, documentId: result.documentId },
    });
    if (revision !== generation) return;
    await chrome.tabs.sendMessage(
      approval.tabId,
      { type: 'pairing:arm', bridgeId: approval.bridgeId },
      { documentId: result.documentId }
    );
  }
  return {
    async open(state: PairingView) {
      if (!state.approvalUrl || !state.installationId) return;
      const revision = ++generation;
      const tab = await chrome.tabs.create({ url: state.approvalUrl });
      if (revision !== generation || tab.id === undefined) return;
      await serial(async () => {
        if (revision !== generation) return;
        await chrome.storage.session.set({
          pairingApproval: {
            url: state.approvalUrl,
            installationId: state.installationId,
            bridgeId: crypto.randomUUID(),
            tabId: tab.id,
          },
        });
        await attach().catch(() => undefined); // Manual code remains available if the bridge cannot attach.
      });
    },
    changed(tabId: number, change: chrome.tabs.OnUpdatedInfo) {
      void serial(async () => {
        const approval = await read();
        if (approval?.tabId !== tabId) return;
        if (change.status === 'loading' || change.url) {
          ++generation;
          await chrome.storage.session.set({
            pairingApproval: { ...approval, documentId: undefined },
          });
        }
        if (change.status === 'complete') await attach();
      }).catch(() => undefined);
    },
    removed(tabId: number) {
      void serial(async () => {
        if ((await read())?.tabId === tabId) {
          ++generation;
          await chrome.storage.session.remove('pairingApproval');
        }
      }).catch(() => undefined);
    },
    stop() {
      ++generation;
      void serial(() => chrome.storage.session.remove('pairingApproval')).catch(() => undefined);
    },
    async claim(message: Record<string, unknown>, sender: chrome.runtime.MessageSender) {
      const revision = generation;
      const approval = await read();
      if (
        !approval ||
        !approval.documentId ||
        sender.id !== chrome.runtime.id ||
        sender.frameId !== 0 ||
        sender.tab?.id !== approval.tabId ||
        sender.documentId !== approval.documentId ||
        sender.url !== approval.url ||
        message.bridgeId !== approval.bridgeId ||
        message.installationId !== approval.installationId
      )
        throw new Error('Unrecognized approval callback.');
      const client = await getClient();
      if (revision !== generation) throw new Error('Pairing changed.');
      return client.claim(String(message.code ?? ''), {
        installationId: approval.installationId,
        origin: new URL(approval.url).origin,
      });
    },
  };
}
