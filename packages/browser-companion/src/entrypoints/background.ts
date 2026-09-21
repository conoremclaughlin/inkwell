import { defineBackground } from 'wxt/utils/define-background';
import {
  BRIDGE_PATH,
  assertFresh,
  dashboardOrigin,
  dashboardPermission,
  parseProposal,
  parseSnapshot,
} from '../protocol';
import { connectDashboard } from '../dashboard-bridge';
import type { CompanionState, Reply } from '../state';

export default defineBackground(() => {
  // MV3 suspension is normal. Persist only transient state, never tokens,
  // captures in sync/local storage, or assumed liveness from a keepalive port.
  const read = async (): Promise<CompanionState> =>
    (await chrome.storage.session.get('companion')).companion || {};
  const write = (state: CompanionState) => chrome.storage.session.set({ companion: state });
  let tail: Promise<unknown> = Promise.resolve();
  const serialized = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = tail.then(fn, fn);
    tail = next.catch(() => undefined);
    return next;
  };
  const isPanel = (sender: chrome.runtime.MessageSender) => {
    return (
      sender.id === chrome.runtime.id && sender.url === chrome.runtime.getURL('sidepanel.html')
    );
  };
  const requireSnapshot = (state: CompanionState, id: unknown) => {
    if (
      !state.snapshot ||
      state.snapshot.id !== id ||
      state.sourceTabId === undefined ||
      !state.documentId
    )
      throw new Error('Snapshot changed. Review the current capture.');
    assertFresh(state.snapshot);
    return state.snapshot;
  };
  async function attachDashboard(state: CompanionState) {
    if (
      !state.snapshot ||
      state.dashboardTabId === undefined ||
      !state.bridgeId ||
      !state.dashboardOrigin
    )
      return;
    assertFresh(state.snapshot);
    const tab = await chrome.tabs.get(state.dashboardTabId);
    // Exact origin includes port even though Chrome's host grant does not.
    if (tab.url !== `${state.dashboardOrigin}${BRIDGE_PATH}`) return;
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: state.dashboardTabId },
      func: connectDashboard,
      args: [state.snapshot, state.bridgeId, `${state.dashboardOrigin}${BRIDGE_PATH}`],
      world: 'ISOLATED',
    });
    if (!result?.documentId || result.result !== true)
      throw new Error('Dashboard navigated before handoff. Review again.');
    await write({ ...state, dashboardDocumentId: result.documentId });
  }

  chrome.action.onClicked.addListener((tab) => {
    if (tab.id === undefined) return;
    // Opening must occur during the browser action gesture, before async IO.
    void chrome.sidePanel.open({ tabId: tab.id });
    void serialized(async () => {
      const state = await read();
      if (state.sourceTabId !== tab.id)
        await write({ sourceTabId: tab.id, dashboardOrigin: state.dashboardOrigin });
    });
  });
  chrome.tabs.onRemoved.addListener((id) => {
    void serialized(async () => {
      const state = await read();
      if (state.sourceTabId === id || state.dashboardTabId === id)
        await write({ dashboardOrigin: state.dashboardOrigin });
    });
  });
  chrome.tabs.onUpdated.addListener((id, change) => {
    if (change.status !== 'complete' && change.status !== 'loading' && !change.url) return;
    void serialized(async () => {
      const state = await read();
      if (
        state.sourceTabId === id &&
        state.snapshot &&
        (change.url || change.status === 'loading')
      ) {
        await write({
          sourceTabId: id,
          dashboardOrigin: state.dashboardOrigin,
          dashboardTabId: state.dashboardTabId,
        });
      } else if (state.dashboardTabId === id && change.status === 'complete') {
        await attachDashboard(state);
      }
    }).catch(() => {
      /* A navigated/closed/expired tab is not a delivery receipt. */
    });
  });

  chrome.runtime.onMessage.addListener((message: Record<string, unknown>, sender, respond) => {
    void serialized(async () => {
      const state = await read();
      if (message?.type === 'bridge:proposal') {
        if (
          sender.id !== chrome.runtime.id ||
          sender.tab?.id !== state.dashboardTabId ||
          sender.frameId !== 0 ||
          !state.dashboardDocumentId ||
          sender.documentId !== state.dashboardDocumentId ||
          sender.url !== `${state.dashboardOrigin}${BRIDGE_PATH}` ||
          message.bridgeId !== state.bridgeId ||
          !state.snapshot
        ) {
          throw new Error('Unrecognized dashboard handoff.');
        }
        assertFresh(state.snapshot);
        await write({ ...state, proposal: parseProposal(message.proposal, state.snapshot) });
        return 'Proposal ready in the extension panel. Nothing has been filled.';
      }
      if (!isPanel(sender)) throw new Error('Only the extension panel can request this action.');
      if (message.type === 'state') {
        if (state.snapshot) {
          try {
            assertFresh(state.snapshot);
          } catch {
            const cleared = {
              sourceTabId: state.sourceTabId,
              dashboardOrigin: state.dashboardOrigin,
              dashboardTabId: state.dashboardTabId,
            };
            await write(cleared);
            return cleared;
          }
        }
        return state;
      }
      if (message.type === 'clear') {
        await write({ sourceTabId: state.sourceTabId, dashboardOrigin: state.dashboardOrigin });
        return {};
      }
      if (message.type === 'capture') {
        if (
          state.sourceTabId === undefined ||
          !['selection', 'page'].includes(String(message.mode))
        )
          throw new Error('Click the extension icon on the page you want to share.');
        const [injected] = await chrome.scripting.executeScript({
          target: { tabId: state.sourceTabId },
          files: ['page-agent.js'],
          world: 'ISOLATED',
        });
        if (!injected?.documentId) throw new Error('Could not identify this document.');
        const result: Reply<unknown> = await chrome.tabs.sendMessage(
          state.sourceTabId,
          { type: 'page:capture', mode: message.mode },
          { documentId: injected.documentId }
        );
        if (!result.ok) throw new Error(result.error || 'Capture failed.');
        const snapshot = parseSnapshot(result.value);
        await write({
          sourceTabId: state.sourceTabId,
          documentId: injected.documentId,
          snapshot,
          dashboardOrigin: state.dashboardOrigin,
          dashboardTabId: state.dashboardTabId,
        });
        return snapshot;
      }
      if (message.type === 'share') {
        const snapshot = requireSnapshot(state, message.snapshotId);
        const origin = dashboardOrigin(String(message.origin));
        if (!(await chrome.permissions.contains({ origins: [dashboardPermission(origin)] })))
          throw new Error('Grant access to the dashboard origin first.');
        const next: CompanionState = {
          ...state,
          snapshot,
          dashboardOrigin: origin,
          bridgeId: crypto.randomUUID(),
          proposal: undefined,
          dashboardDocumentId: undefined,
        };
        let tab: chrome.tabs.Tab | undefined;
        if (state.dashboardTabId !== undefined) {
          try {
            const existing = await chrome.tabs.get(state.dashboardTabId);
            // Reuse the live dashboard without reload, preserving the human's
            // instruction. A new capture still needs a fresh dashboard review.
            if (existing.url === `${origin}${BRIDGE_PATH}`)
              tab = await chrome.tabs.update(existing.id!, { active: true });
          } catch {
            /* Closed tab: create a new handoff. */
          }
        }
        if (!tab) tab = await chrome.tabs.create({ url: `${origin}${BRIDGE_PATH}` });
        next.dashboardTabId = tab.id;
        await write(next);
        // onUpdated handles normal load; this handles an already-complete tab.
        if (tab.status === 'complete') await attachDashboard(next);
        return 'Opened Inkwell. Sign in if needed, then review and send from the dashboard.';
      }
      if (message.type === 'proposal') {
        const snapshot = requireSnapshot(state, message.snapshotId);
        await write({ ...state, proposal: parseProposal(message.proposal, snapshot) });
        return {};
      }
      if (message.type === 'apply') {
        requireSnapshot(state, message.snapshotId);
        if (!state.proposal || JSON.stringify(message.proposal) !== JSON.stringify(state.proposal))
          throw new Error('Proposal changed. Review it again.');
        // Consume extension-held intent before crossing the process boundary.
        // An ambiguous disconnect never causes an automatic retry.
        await write({ sourceTabId: state.sourceTabId, dashboardOrigin: state.dashboardOrigin });
        const result: Reply<unknown> = await chrome.tabs.sendMessage(
          state.sourceTabId!,
          { type: 'page:apply', proposal: state.proposal },
          { documentId: state.documentId! }
        );
        if (!result.ok)
          throw new Error(result.error || 'Fill failed; inspect the page before retrying.');
        return result.value;
      }
      throw new Error('Unsupported companion action.');
    }).then(
      (value) => respond({ ok: true, value }),
      (error) =>
        respond({
          ok: false,
          error: error instanceof Error ? error.message : 'Companion operation failed.',
        })
    );
    return true;
  });
});
