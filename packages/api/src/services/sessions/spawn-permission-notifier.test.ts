import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataComposer } from '../../data/composer.js';
const mocks = vi.hoisted(() => ({ send: vi.fn(), resolve: vi.fn() }));
vi.mock('../../mcp/tools/inbox-handlers.js', () => ({ handleSendToInbox: mocks.send }));
vi.mock('../principals.js', () => ({
  SYSTEM_PRINCIPAL: { kind: 'system' },
  resolveSbInWorkspace: mocks.resolve,
}));
vi.mock('../../utils/logger.js', () => ({ logger: { warn: vi.fn() } }));
import { createSpawnPermissionNotifier } from './spawn-permission-notifier.js';
import type { SpawnPermissionWarning } from './spawn-permission-warning.js';
const session = { userId: 'fixture-user', sbId: 'fixture-sb', id: 'fixture-session' };
const warning: SpawnPermissionWarning = {
  workingDirectory: '/synthetic/checkout',
  missingRules: ['mcp__playwright__*'],
  restrictedRules: [],
  sources: [],
  limitations: ['Static inspection only.'],
  fix: 'Operator review required.',
};
const ok = () => ({ content: [{ type: 'text', text: JSON.stringify({ success: true }) }] });
function setup(workspace: string | null = 'fixture-space') {
  const query = { select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn() };
  query.select.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  query.maybeSingle.mockResolvedValue({ data: { workspace_id: workspace }, error: null });
  const from = vi.fn(() => query);
  const composer = { getClient: () => ({ from }) } as unknown as DataComposer;
  return { notify: createSpawnPermissionNotifier(composer), query };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.send.mockResolvedValue(ok());
  mocks.resolve.mockImplementation(async (_client, workspaceId) => ({
    userId: session.userId,
    workspaceId,
  }));
});
describe('spawn permission warning delivery', () => {
  it('addresses only the launching identity owner/workspace, as the system', async () => {
    const { notify, query } = setup();
    await notify(session, warning, new AbortController().signal);
    expect(query.eq).toHaveBeenCalledWith('id', session.sbId);
    expect(query.eq).toHaveBeenCalledWith('user_id', session.userId);
    expect(mocks.resolve).toHaveBeenCalledWith(expect.anything(), 'fixture-space', 'myra');
    expect(mocks.send).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: session.userId,
        recipientSlug: 'myra',
        threadKey: 'ops:spawn-permissions',
        trigger: true,
        content: expect.stringContaining('mcp__playwright__*'),
      }),
      expect.anything(),
      { sender: { principal: { kind: 'system' }, workspaceId: 'fixture-space' } }
    );
  });
  it('fails closed on recipient scope, never guessing another workspace', async () => {
    const { notify } = setup(null);
    await expect(notify(session, warning, new AbortController().signal)).rejects.toThrow('scope');
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it('does not send without a triage identity', async () => {
    mocks.resolve.mockRejectedValue(new Error('No triage identity'));
    await expect(setup().notify(session, warning, new AbortController().signal)).rejects.toThrow(
      'triage'
    );
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it.each([
    { userId: 'fixture-other-user', workspaceId: 'fixture-space' },
    { userId: session.userId, workspaceId: null },
    { userId: session.userId, workspaceId: 'fixture-other-space' },
  ])('refuses a triage identity outside the exact owner/workspace', async (recipient) => {
    mocks.resolve.mockResolvedValue(recipient);
    await expect(setup().notify(session, warning, new AbortController().signal)).rejects.toThrow(
      'triage'
    );
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it('deduplicates confirmed delivery independently of ephemeral launch paths', async () => {
    const { notify } = setup();
    const signal = new AbortController().signal;
    await notify(
      session,
      { ...warning, sources: [{ path: '/tmp/launch-one.json', state: 'read' }] },
      signal
    );
    await notify(
      session,
      { ...warning, sources: [{ path: '/tmp/launch-two.json', state: 'read' }] },
      signal
    );
    expect(mocks.send).toHaveBeenCalledTimes(1);
    mocks.resolve.mockResolvedValueOnce({
      userId: 'fixture-other-user',
      workspaceId: 'fixture-space',
    });
    await notify({ ...session, userId: 'fixture-other-user' }, warning, signal);
    expect(mocks.send).toHaveBeenCalledTimes(2);
    await notify(session, { ...warning, missingRules: ['mcp__inkwell__*'] }, signal);
    expect(mocks.send).toHaveBeenCalledTimes(3);
  });
  it('retries rejected or unsuccessful delivery rather than caching failure', async () => {
    const { notify } = setup();
    const signal = new AbortController().signal;
    mocks.send.mockRejectedValueOnce(new Error('fixture network failure'));
    await expect(notify(session, warning, signal)).rejects.toThrow();
    mocks.send.mockResolvedValueOnce({ content: [{ type: 'text', text: '{"success":false}' }] });
    await expect(notify(session, warning, signal)).rejects.toThrow();
    await notify(session, warning, signal);
    expect(mocks.send).toHaveBeenCalledTimes(3);
  });
  it('never starts a send after the deadline during scope lookup', async () => {
    const { notify, query } = setup();
    const control = new AbortController();
    query.maybeSingle.mockImplementation(async () => {
      control.abort();
      return { data: { workspace_id: 'fixture-space' }, error: null };
    });
    await notify(session, warning, control.signal);
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it('coalesces concurrent warnings and expires the delivery cache', async () => {
    const { notify } = setup();
    const signal = new AbortController().signal;
    let release!: () => void;
    mocks.send.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return ok();
    });
    const first = notify(session, warning, signal);
    await vi.waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(1));
    await notify(session, warning, signal);
    release();
    await first;
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3_600_001);
    await notify(session, warning, signal);
    expect(mocks.send).toHaveBeenCalledTimes(2);
    now.mockRestore();
  });
  it('a late abandoned send cannot remove a newer in-flight attempt', async () => {
    const { notify } = setup();
    const firstControl = new AbortController();
    let rejectFirst!: (reason: Error) => void;
    let releaseSecond!: () => void;
    mocks.send
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectFirst = reject;
          })
      )
      .mockImplementationOnce(async () => {
        await new Promise<void>((resolve) => {
          releaseSecond = resolve;
        });
        return ok();
      });
    const first = notify(session, warning, firstControl.signal);
    const firstRejected = expect(first).rejects.toThrow('late');
    await vi.waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(1));
    firstControl.abort();
    const second = notify(session, warning, new AbortController().signal);
    await vi.waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(2));
    rejectFirst(new Error('late failure'));
    await firstRejected;
    await notify(session, warning, new AbortController().signal);
    expect(mocks.send).toHaveBeenCalledTimes(2);
    releaseSecond();
    await second;
  });
});
