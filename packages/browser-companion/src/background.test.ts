// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import background from './entrypoints/background';
import type { CompanionState } from './state';
import type { BrowserSnapshot, FillProposal } from './protocol';

type Handler = (
  message: Record<string, unknown>,
  sender: chrome.runtime.MessageSender,
  respond: (value: unknown) => void
) => void;
const extensionId = 'a'.repeat(32);
let handler: Handler;
let removed: (id: number) => void;
let updated: (id: number, change: chrome.tabs.OnUpdatedInfo) => void;
let stored: CompanionState;
let fake: ReturnType<typeof makeChrome>;
const snapshot = (): BrowserSnapshot => ({
  version: 1,
  id: '00000000-0000-4000-8000-000000000001',
  capturedAt: Date.now(),
  url: 'https://fixture.test/form',
  title: 'Fixture',
  mode: 'page',
  text: 'Synthetic',
  truncated: false,
  fields: [{ id: 'f0', label: 'Topic', kind: 'text' }],
});
const proposal = (): FillProposal => ({
  version: 1,
  snapshotId: stored.snapshot!.id,
  changes: [{ fieldId: 'f0', value: 'Draft' }],
});
const panel = () => ({ id: extensionId, url: `chrome-extension://${extensionId}/sidepanel.html` });
const bridge = () => ({
  id: extensionId,
  tab: { id: 2 } as chrome.tabs.Tab,
  frameId: 0,
  documentId: 'dashboard-doc',
  url: 'http://localhost:3002/browser-companion',
});
function makeChrome() {
  return {
    runtime: {
      id: extensionId,
      getURL: (path: string) => `chrome-extension://${extensionId}/${path.replace(/^\//, '')}`,
      onMessage: {
        addListener: (fn: Handler) => {
          handler = fn;
        },
      },
    },
    storage: {
      session: {
        get: vi.fn(async () => ({ companion: stored })),
        set: vi.fn(async ({ companion }: { companion: CompanionState }) => {
          stored = companion;
        }),
      },
    },
    action: { onClicked: { addListener: vi.fn() } },
    sidePanel: { open: vi.fn() },
    tabs: {
      get: vi.fn(async () => ({ id: 2, url: 'http://localhost:3002/browser-companion' })),
      create: vi.fn(async () => ({ id: 2, status: 'complete' })),
      update: vi.fn(async () => ({ id: 2, status: 'complete' })),
      sendMessage: vi.fn(async () => ({ ok: true, value: { applied: 1 } })),
      onRemoved: {
        addListener: (fn: typeof removed) => {
          removed = fn;
        },
      },
      onUpdated: {
        addListener: (fn: typeof updated) => {
          updated = fn;
        },
      },
    },
    scripting: {
      executeScript: vi.fn(async (_options: unknown) => [
        { documentId: 'dashboard-doc', result: true },
      ]),
    },
    permissions: { contains: vi.fn(async () => true) },
  };
}
async function request(
  message: Record<string, unknown>,
  sender: chrome.runtime.MessageSender = panel()
): Promise<{ ok: boolean; value?: unknown; error?: string }> {
  return new Promise((resolve) => handler(message, sender, resolve as (value: unknown) => void));
}
beforeEach(() => {
  stored = {
    sourceTabId: 1,
    documentId: 'source-doc',
    snapshot: snapshot(),
    dashboardOrigin: 'http://localhost:3002',
    dashboardTabId: 2,
    dashboardDocumentId: 'dashboard-doc',
    bridgeId: 'synthetic-bridge',
  };
  fake = makeChrome();
  vi.stubGlobal('chrome', fake);
  background.main();
});
describe('privileged companion message boundaries (all browser IO mocked)', () => {
  it('rejects website requests to capture/apply/read or share', async () => {
    for (const type of ['capture', 'apply', 'state', 'share'])
      expect(
        (await request({ type }, { id: extensionId, url: 'https://fixture.test/form' })).ok
      ).toBe(false);
    expect(fake.scripting.executeScript).not.toHaveBeenCalled();
    expect(fake.tabs.sendMessage).not.toHaveBeenCalled();
  });
  it.each(['nonce', 'tab', 'frame', 'document', 'origin', 'port', 'path', 'extension'])(
    'rejects a mismatched dashboard %s',
    async (mismatch) => {
      const sender = bridge();
      let bridgeId = stored.bridgeId;
      if (mismatch === 'nonce') bridgeId = 'wrong';
      if (mismatch === 'tab') sender.tab.id = 3;
      if (mismatch === 'frame') sender.frameId = 1;
      if (mismatch === 'document') sender.documentId = 'old-doc';
      if (mismatch === 'origin') sender.url = 'https://elsewhere.test/browser-companion';
      if (mismatch === 'port') sender.url = 'http://localhost:3001/browser-companion';
      if (mismatch === 'path') sender.url += '/other';
      if (mismatch === 'extension') sender.id = 'b'.repeat(32);
      expect(
        (await request({ type: 'bridge:proposal', bridgeId, proposal: proposal() }, sender)).ok
      ).toBe(false);
      expect(stored.proposal).toBeUndefined();
    }
  );
  it('a valid dashboard can stage a proposal but cannot apply it', async () => {
    const value = proposal();
    expect(
      (
        await request(
          { type: 'bridge:proposal', bridgeId: stored.bridgeId, proposal: value },
          bridge()
        )
      ).ok
    ).toBe(true);
    expect(stored.proposal).toEqual(value);
    expect(fake.tabs.sendMessage).not.toHaveBeenCalled();
    expect(
      (await request({ type: 'apply', snapshotId: stored.snapshot!.id, proposal: value }, bridge()))
        .ok
    ).toBe(false);
  });
  it('checks exact reviewed proposal then consumes intent before the document-bound write', async () => {
    stored.proposal = proposal();
    const message = { type: 'apply', snapshotId: stored.snapshot!.id, proposal: stored.proposal };
    fake.tabs.sendMessage.mockImplementationOnce(async () => {
      expect(stored.snapshot).toBeUndefined();
      return { ok: true, value: { applied: 1 } };
    });
    expect((await request(message)).ok).toBe(true);
    expect(fake.tabs.sendMessage).toHaveBeenCalledWith(
      1,
      { type: 'page:apply', proposal: message.proposal },
      { documentId: 'source-doc' }
    );
    expect((await request(message)).ok).toBe(false);
    expect(fake.tabs.sendMessage).toHaveBeenCalledTimes(1);
  });
  it('a changed proposal cannot race past the reviewed confirmation', async () => {
    stored.proposal = proposal();
    const reviewed = structuredClone(stored.proposal);
    stored.proposal.changes[0]!.value = 'Changed later';
    expect(
      (await request({ type: 'apply', snapshotId: stored.snapshot!.id, proposal: reviewed })).ok
    ).toBe(false);
    expect(fake.tabs.sendMessage).not.toHaveBeenCalled();
  });
  it('never retries after an ambiguous document disconnect', async () => {
    stored.proposal = proposal();
    const message = { type: 'apply', snapshotId: stored.snapshot!.id, proposal: stored.proposal };
    fake.tabs.sendMessage.mockRejectedValueOnce(new Error('document disconnected'));
    expect((await request(message)).ok).toBe(false);
    expect((await request(message)).ok).toBe(false);
    expect(fake.tabs.sendMessage).toHaveBeenCalledTimes(1);
  });
  it('expires action state and explicitly clears on source reload or tab closure', async () => {
    stored.snapshot!.capturedAt -= 600_001;
    await request({ type: 'state' });
    expect(stored.snapshot).toBeUndefined();
    stored.snapshot = snapshot();
    updated(1, { status: 'loading' });
    await request({ type: 'state' });
    expect(stored.snapshot).toBeUndefined();
    stored.snapshot = snapshot();
    removed(1);
    await request({ type: 'state' });
    expect(stored.sourceTabId).toBeUndefined();
  });
  it('requires an explicit dashboard host grant and checks the precise navigation destination', async () => {
    const message = {
      type: 'share',
      snapshotId: stored.snapshot!.id,
      origin: 'http://localhost:3002',
    };
    fake.permissions.contains.mockResolvedValueOnce(false);
    expect((await request(message)).ok).toBe(false);
    expect(fake.tabs.create).not.toHaveBeenCalled();
    fake.tabs.get.mockResolvedValue({ id: 2, url: 'http://localhost:3001/browser-companion' });
    expect((await request(message)).ok).toBe(true);
    expect(fake.scripting.executeScript).not.toHaveBeenCalled();
    expect(fake.permissions.contains).toHaveBeenCalledWith({ origins: ['http://localhost/*'] });
  });
  it('sends only the approved snapshot into the bound dashboard document', async () => {
    const approved = stored.snapshot;
    expect(
      (await request({ type: 'share', snapshotId: approved!.id, origin: 'http://localhost:3002' }))
        .ok
    ).toBe(true);
    expect(fake.scripting.executeScript.mock.calls[0]?.[0]).toMatchObject({
      target: { tabId: 2 },
      args: [approved, expect.any(String), 'http://localhost:3002/browser-companion'],
      world: 'ISOLATED',
    });
    expect(stored.dashboardDocumentId).toBe('dashboard-doc');
  });
  it('expiry keeps the dashboard tab for instruction-preserving recapture without keeping authority', async () => {
    stored.snapshot!.capturedAt -= 600_001;
    stored.proposal = proposal();
    await request({ type: 'state' });
    expect(stored.dashboardTabId).toBe(2);
    expect(stored.proposal).toBeUndefined();
    expect(stored.dashboardDocumentId).toBeUndefined();
    expect(stored.bridgeId).toBeUndefined();
    stored.snapshot = snapshot();
    stored.documentId = 'recaptured-doc';
    expect(
      (
        await request({
          type: 'share',
          snapshotId: stored.snapshot.id,
          origin: 'http://localhost:3002',
        })
      ).ok
    ).toBe(true);
    expect(fake.tabs.update).toHaveBeenCalledWith(2, { active: true });
    expect(fake.tabs.create).not.toHaveBeenCalled();
  });
  it('worker reinitialization reads retained session state rather than losing the proposal', async () => {
    stored.proposal = proposal();
    const before = structuredClone(stored);
    background.main();
    const result = await request({ type: 'state' });
    expect(result.value).toEqual(before);
  });
});
