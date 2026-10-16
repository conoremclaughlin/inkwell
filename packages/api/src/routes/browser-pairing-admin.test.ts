import { afterAll, beforeAll, beforeEach, describe, it, expect, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
const mocks = vi.hoisted(() => ({ create: vi.fn(), recipients: vi.fn() }));
vi.mock('../services/browser-companion-grant.service', () => ({
  BrowserCompanionGrantService: class {
    createPairingCode = mocks.create;
  },
}));
vi.mock('../services/browser-chat-recipient', async (original) => ({
  ...(await original<object>()),
  browserChatRecipients: mocks.recipients,
}));
import { createBrowserPairingAdminRouter } from './browser-pairing-admin';
const recipientId = '55555555-5555-4555-8555-555555555555';
const offer = { installationId: 'fixture-installation', installationCommitment: 'a'.repeat(64) };
let server: Server;
let base: string;
beforeAll(async () => {
  const app = express();
  app.use(express.json(), (req, _res, next) => {
    Object.assign(req, { inkUserId: 'fixture-user', inkWorkspaceId: 'fixture-workspace' });
    next();
  });
  app.use(createBrowserPairingAdminRouter(async () => ({ getClient: () => ({}) }) as never));
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture listener');
  base = `http://127.0.0.1:${address.port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
beforeEach(() => {
  vi.clearAllMocks();
  mocks.create.mockResolvedValue({
    grantId: 'fixture-grant',
    pairingCode: 'ABCDEFGHJKLM',
    pairingCodeExpiresAt: '2099-01-01T00:00:00Z',
  });
  mocks.recipients.mockResolvedValue([
    { id: recipientId, displayName: 'River', sbSlug: 'fixture-companion' },
  ]);
});
const post = (body: unknown) =>
  fetch(base + '/pairing-code', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
describe('authenticated pairing recipient consent', () => {
  it('requires an explicit literal consent when selecting an ordinary recipient', async () => {
    for (const consent of [undefined, false, 'true']) {
      expect((await post({ ...offer, recipientId, fullToolsApproved: consent })).status).toBe(400);
    }
    expect(mocks.create).not.toHaveBeenCalled();
    const response = await post({ ...offer, recipientId, fullToolsApproved: true });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ recipientId, pairingCode: 'ABCD-EFGH-JKLM' });
    expect(mocks.create).toHaveBeenCalledWith({
      ...offer,
      recipientId,
      userId: 'fixture-user',
      workspaceId: 'fixture-workspace',
    });
  });
  it('keeps old pairing input app-only and refuses caller scope/routing fields', async () => {
    expect((await post(offer)).status).toBe(200);
    expect(mocks.create.mock.calls[0][0]).not.toHaveProperty('recipientId');
    for (const field of ['userId', 'workspaceId', 'recipientSessionId', 'threadKey']) {
      expect((await post({ ...offer, [field]: 'invented' })).status).toBe(400);
    }
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });
  it('lists only server-scoped public recipient choices', async () => {
    const response = await fetch(base + '/recipients');
    expect(await response.json()).toEqual({ recipients: [{ id: recipientId, name: 'River' }] });
    expect(mocks.recipients).toHaveBeenCalledWith(
      {},
      { userId: 'fixture-user', workspaceId: 'fixture-workspace' }
    );
  });
});
