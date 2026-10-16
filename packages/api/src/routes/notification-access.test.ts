/** Real Express routing, invented stores, and loopback only. No production auth, DB or model. */
import express from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createNotificationAccessAdminRouter,
  createNotificationIntakeRouter,
} from './notification-access';
import {
  NotificationAccessError,
  NotificationAccessStore,
  type NotificationWatcher,
} from '../services/notification-access/store';
import { accountGate, spaceGate } from '../services/account-deletion/gate';
import { FakePostgrest } from '../test/fake-postgrest';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const NOW = Date.parse('2026-01-10T12:00:00Z');
const watcher: NotificationWatcher = {
  id: id(1),
  owner_id: id(2),
  workspace_id: id(3),
  recipient_id: id(4),
  thread_id: id(5),
  signin_id: id(6),
  installation_id: id(7),
  selected_packages: ['com.example.messages'],
  clock_offset_ms: 0,
  status: 'active',
  active_since: new Date(NOW - 1000).toISOString(),
  expires_at: new Date(NOW + 86_400_000).toISOString(),
  created_at: new Date(NOW - 1000).toISOString(),
};
const event = {
  eventId: id(8),
  packageName: 'com.example.messages',
  title: 'Demo',
  text: 'Example preview',
  postedAt: NOW,
};
const deviceToken = `ink-na-${'1'.repeat(64)}`;
const consent = {
  installationId: id(7),
  recipientId: id(4),
  conversationId: 'inkling:chat:synthetic-notifications',
  deviceTime: NOW,
  refreshToken: 'synthetic-refresh',
  selectedPackages: watcher.selected_packages,
  rules: [],
  disclosureAccepted: true,
  permissionReported: 'granted',
};

const store = {
  create: vi.fn(),
  deviceAccess: vi.fn(),
  list: vi.fn(),
  revoke: vi.fn(),
  remove: vi.fn(),
  record: vi.fn(),
  events: vi.fn(),
  rules: vi.fn(),
  setRules: vi.fn(),
};
let configured = true;
let server: Server;
let origin: string;

beforeAll(async () => {
  const app = express();
  const deps = { store: async () => (configured ? store : null), now: () => NOW };
  app.use('/api/notification-access', createNotificationIntakeRouter(deps));
  app.use(express.json());
  // This is deliberately a stand-in for the existing admin middleware,
  // not evidence that the production admin token boundary was exercised.
  app.use(
    '/api/admin/notification-access',
    (req, _res, next) => {
      if (req.headers.authorization === 'Bearer synthetic-admin')
        Object.assign(req, { inkUserId: id(2), inkWorkspaceId: id(3) });
      next();
    },
    createNotificationAccessAdminRouter(deps)
  );
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No loopback listener');
  origin = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
});
beforeEach(() => {
  vi.resetAllMocks();
  configured = true;
  accountGate.forget(id(2));
  spaceGate.forget(id(3));
  store.deviceAccess.mockResolvedValue(watcher);
  store.record.mockResolvedValue({ inserted: true });
  store.create.mockResolvedValue({ watcher, deviceToken });
  store.list.mockResolvedValue([watcher]);
  store.events.mockResolvedValue([]);
  store.rules.mockResolvedValue({ revision: 0, rules: [] });
  store.setRules.mockResolvedValue({ revision: 1, rules: [] });
});

async function postEvent(body: unknown = event, token = deviceToken) {
  return fetch(`${origin}/api/notification-access/events`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(
      body && typeof body === 'object' && !Array.isArray(body) ? { deviceTime: NOW, ...body } : body
    ),
  });
}
async function admin(path: string, method = 'GET', body?: unknown, auth = 'synthetic-admin') {
  return fetch(`${origin}/api/admin/notification-access${path}`, {
    method,
    headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe('post-only device intake', () => {
  describe('request clock recovery', () => {
    it.each([600_000, -600_000, 8 * 86_400_000, -8 * 86_400_000])(
      'requests clock recovery after correcting consent offset %s, without writing an event',
      async (clockOffsetMs) => {
        store.deviceAccess.mockResolvedValue({
          ...watcher,
          clock_offset_ms: clockOffsetMs,
          active_since: new Date(NOW - 86_400_000).toISOString(),
        });
        const result = await postEvent({ ...event, deviceTime: NOW });
        expect(result.status).toBe(409);
        expect(await result.json()).toEqual({ error: 'clock_resync_required' });
        expect(store.record).not.toHaveBeenCalled();
      }
    );
    it.each([-600_000, 600_000])(
      'accepts a still-skewed clock and strips the send-time sample for offset %s',
      async (clockOffsetMs) => {
        store.deviceAccess.mockResolvedValue({ ...watcher, clock_offset_ms: clockOffsetMs });
        const source = { ...event, postedAt: NOW - clockOffsetMs };
        const result = await postEvent({ ...source, deviceTime: NOW - clockOffsetMs });
        expect(result.status).toBe(202);
        expect(store.record.mock.calls[0][1]).toEqual(source);
      }
    );
    it('does not interpret queue age or a fresh retry sample as a clock change', async () => {
      store.deviceAccess.mockResolvedValue({
        ...watcher,
        active_since: new Date(NOW - 7_200_000).toISOString(),
      });
      const queued = { ...event, postedAt: NOW - 3_600_000 };
      expect((await postEvent({ ...queued, deviceTime: NOW })).status).toBe(202);
      expect((await postEvent({ ...queued, deviceTime: NOW + 1000 })).status).toBe(202);
      expect(store.record.mock.calls.map((call) => call[1])).toEqual([queued, queued]);
    });
    it.each([-300_001, -300_000, 300_000, 300_001])(
      'uses a two-sided inclusive five-minute tolerance for send-time drift %s',
      async (drift) => {
        const result = await postEvent({ ...event, deviceTime: NOW + drift });
        const corrected = Math.abs(drift) > 300_000;
        expect(result.status).toBe(corrected ? 409 : 202);
        if (corrected) {
          expect(await result.json()).toEqual({ error: 'clock_resync_required' });
          expect(store.record).not.toHaveBeenCalled();
        }
      }
    );
    it.each([undefined, null, -1, 1.5, '1800000000000', 8_640_000_000_000_001])(
      'requires a bounded epoch-ms send-time sample: %s',
      async (deviceTime) => {
        expect((await postEvent({ ...event, deviceTime })).status).toBe(422);
        expect(store.record).not.toHaveBeenCalled();
      }
    );
    it('accepts new events after recovery issues a fresh zero-offset grant', async () => {
      store.deviceAccess.mockResolvedValue({ ...watcher, clock_offset_ms: 0 });
      expect((await postEvent({ ...event, deviceTime: NOW })).status).toBe(202);
      expect(store.record).toHaveBeenCalledWith(watcher, event);
    });
  });
  it('accepts an app label and calibrates a slow device without an admin or workspace header', async () => {
    store.deviceAccess.mockResolvedValue({
      ...watcher,
      clock_offset_ms: 90_000,
      active_since: new Date(NOW).toISOString(),
    });
    const labeled = { ...event, postedAt: NOW - 90_000, appLabel: 'Demo app' };
    expect((await postEvent(labeled)).status).toBe(202);
    expect(store.record.mock.calls[0][1]).toEqual(labeled);
    expect((await postEvent({ ...labeled, postedAt: labeled.postedAt - 1 })).status).toBe(422);
  });
  it.each(['title', 'text'] as const)(
    'returns terminal 422 for unrepresentable %s before storage',
    async (field) => {
      for (const value of ['a\u0000b', 'a\ud83d', '\ude00b']) {
        const response = await postEvent({ ...event, [field]: value });
        expect(response.status).toBe(422);
        expect(await response.json()).toEqual({ error: 'event_refused' });
      }
      expect(store.record).not.toHaveBeenCalled();
    }
  );
  it('accepts a valid event and gives an identical acknowledgement on duplicate', async () => {
    const first = await postEvent();
    expect(first.status).toBe(202);
    expect(await first.json()).toEqual({ accepted: true });
    expect(first.headers.get('cache-control')).toBe('no-store');
    expect(store.deviceAccess.mock.calls[0][0]).toMatch(/^[0-9a-f]{64}$/);
    expect(store.deviceAccess.mock.calls[0][0]).not.toBe(deviceToken);
    expect(store.record).toHaveBeenCalledWith(watcher, event);
    store.record.mockResolvedValue({ inserted: false });
    const second = await postEvent();
    expect(second.status).toBe(202);
    expect(await second.json()).toEqual({ accepted: true });
  });

  it.each(['synthetic-admin', 'synthetic.jwt.token', 'ink-na-short', ''])(
    'refuses a foreign token before looking up a grant: %s',
    async (token) => {
      expect((await postEvent(event, token)).status).toBe(401);
      expect(store.deviceAccess).not.toHaveBeenCalled();
      expect(store.record).not.toHaveBeenCalled();
    }
  );

  it('authenticates before JSON parsing and gives no grant detail', async () => {
    store.deviceAccess.mockResolvedValue(null);
    const result = await fetch(`${origin}/api/notification-access/events`, {
      method: 'POST',
      headers: { authorization: `Bearer ${deviceToken}`, 'content-type': 'application/json' },
      body: '{synthetic malformed body',
    });
    expect(result.status).toBe(401);
    expect(await result.json()).toEqual({ error: 'access_inactive' });
    expect(store.record).not.toHaveBeenCalled();
  });

  it.each([
    ['GET', '/events'],
    ['POST', '/watchers'],
    ['DELETE', '/events'],
    ['GET', '/events/other'],
  ])('denies routes outside the post-only allowlist: %s %s', async (method, path) => {
    const result = await fetch(`${origin}/api/notification-access${path}`, {
      method,
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    expect(result.status).toBe(404);
    expect(store.deviceAccess).not.toHaveBeenCalled();
  });

  it.each([
    { ...event, packageName: 'com.example.other' },
    { ...event, ownerId: id(20) },
    { ...event, destination: 'synthetic-group' },
    { ...event, postedAt: NOW - 2000 },
    { ...event, text: 'x'.repeat(8193) },
  ])('drops invalid, unselected and pre-consent events without storing them', async (body) => {
    const result = await postEvent(body);
    expect(result.status).toBe(422);
    expect(await result.json()).toEqual({ error: 'event_refused' });
    expect(store.record).not.toHaveBeenCalled();
  });

  it('bounds raw JSON and strips malformed body errors', async () => {
    expect((await postEvent({ ...event, text: 'x'.repeat(50 * 1024) })).status).toBe(413);
    const result = await fetch(`${origin}/api/notification-access/events`, {
      method: 'POST',
      headers: { authorization: `Bearer ${deviceToken}`, 'content-type': 'application/json' },
      body: '{synthetic private preview',
    });
    expect(result.status).toBe(400);
    expect(await result.text()).toBe('{"error":"invalid_request"}');
    expect(store.record).not.toHaveBeenCalled();
  });

  it.each([
    ['access_inactive', 401],
    ['event_conflict', 409],
    ['rate_limited', 429],
    ['unavailable', 503],
  ] as const)('preserves database race outcomes: %s', async (code, status) => {
    store.record.mockRejectedValue(new NotificationAccessError(code));
    const result = await postEvent();
    expect(result.status).toBe(status);
    expect(await result.json()).toEqual({ error: code });
    if (status === 429) expect(result.headers.get('retry-after')).toBe('60');
  });

  it('never reflects a thrown notification or query in a response', async () => {
    store.record.mockRejectedValue(new Error('synthetic confidential preview'));
    const result = await postEvent();
    expect(result.status).toBe(503);
    expect(await result.text()).not.toContain('confidential');
  });

  it.each(['account', 'space'])('refuses a closed %s gate before writing', async (kind) => {
    (kind === 'account' ? accountGate : spaceGate).close(kind === 'account' ? id(2) : id(3));
    expect((await postEvent()).status).toBe(401);
    expect(store.record).not.toHaveBeenCalled();
    expect(accountGate.inFlightCount(id(2))).toBe(0);
    expect(spaceGate.inFlightCount(id(3))).toBe(0);
  });

  it('holds both deletion gates until the write settles, including failure', async () => {
    store.record.mockImplementation(async () => {
      expect(accountGate.inFlightCount(id(2))).toBe(1);
      expect(spaceGate.inFlightCount(id(3))).toBe(1);
      throw new Error('synthetic write error');
    });
    expect((await postEvent()).status).toBe(503);
    expect(accountGate.inFlightCount(id(2))).toBe(0);
    expect(spaceGate.inFlightCount(id(3))).toBe(0);
  });
});

describe('owner-only mutable rules', () => {
  it('returns 409 for inactive rule state without invalidating the owner sign-in', async () => {
    const db = new FakePostgrest();
    db.seed('sb_notification_watchers', { ...watcher, status: 'revoked' });
    const realStore = new NotificationAccessStore(db as unknown as SupabaseClient);
    store.setRules.mockImplementation(realStore.setRules.bind(realStore));
    const response = await admin(`/watchers/${id(1)}/rules`, 'PUT', { rules: [] });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'grant_inactive' });
    expect((await admin('/watchers')).status).toBe(200);
    // Missing owner authentication is still 401, independent of the grant state.
    expect((await admin(`/watchers/${id(1)}/rules`, 'PUT', { rules: [] }, '')).status).toBe(401);
  });
  it('reads and writes through the signed owner scope', async () => {
    const resource = `/watchers/${id(1)}/rules`;
    expect(await (await admin(resource)).json()).toEqual({ revision: 0, rules: [] });
    expect(await (await admin(resource, 'PUT', { rules: [] })).json()).toEqual({
      revision: 1,
      rules: [],
    });
    expect(store.setRules).toHaveBeenCalledWith(
      { ownerId: id(2), workspaceId: id(3) },
      id(1),
      { rules: [] },
      NOW
    );
  });
  it('refuses device credentials and does not add a device self-revoke surface', async () => {
    expect(
      (await admin(`/watchers/${id(1)}/rules`, 'PUT', { rules: [] }, deviceToken)).status
    ).toBe(401);
    const response = await fetch(`${origin}/api/notification-access/revoke`, {
      method: 'POST',
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    expect(response.status).toBe(404);
    expect(store.setRules).not.toHaveBeenCalled();
  });
  it('rejects authority injection before calling storage', async () => {
    expect(
      (await admin(`/watchers/${id(1)}/rules`, 'PUT', { rules: [], ownerId: id(99) })).status
    ).toBe(422);
    expect(store.setRules).not.toHaveBeenCalled();
  });
});

describe('owner management surface', () => {
  describe.each(['account', 'space'])('closed %s gate', (kind) => {
    it.each([
      ['/watchers', 'GET', undefined, 'list'],
      ['/watchers', 'POST', consent, 'create'],
      [`/watchers/${id(1)}/revoke`, 'POST', undefined, 'revoke'],
      [`/watchers/${id(1)}`, 'DELETE', undefined, 'remove'],
      [`/watchers/${id(1)}/events`, 'GET', undefined, 'events'],
      [`/watchers/${id(1)}/rules`, 'GET', undefined, 'rules'],
      [`/watchers/${id(1)}/rules`, 'PUT', { rules: [] }, 'setRules'],
    ] as const)('preserves the owner login for %s %s', async (path, method, body, operation) => {
      (kind === 'account' ? accountGate : spaceGate).close(kind === 'account' ? id(2) : id(3));
      const response = await admin(path, method, body);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: 'target_refused' });
      expect(store[operation]).not.toHaveBeenCalled();
      expect(accountGate.inFlightCount(id(2))).toBe(0);
      expect(spaceGate.inFlightCount(id(3))).toBe(0);
      expect((await admin(path, method, body, '')).status).toBe(401);
    });
  });
  it.each([
    ['23503', 403, 'target_refused'],
    ['NPA02', 401, 'access_inactive'],
  ] as const)(
    'maps create write refusal %s through the real store',
    async (code, status, error) => {
      const db = new FakePostgrest();
      db.seed('mcp_tokens', {
        id: watcher.signin_id,
        user_id: watcher.owner_id,
        client_id: 'mobile',
        refresh_token: consent.refreshToken,
        expires_at: watcher.expires_at,
      });
      db.seed('agent_identities', {
        id: watcher.recipient_id,
        user_id: watcher.owner_id,
        workspace_id: watcher.workspace_id,
      });
      db.seed('inbox_threads', {
        id: watcher.thread_id,
        thread_key: consent.conversationId,
        workspace_id: watcher.workspace_id,
        metadata: { inklingConversation: true },
      });
      db.seed('inbox_thread_participants', {
        thread_id: watcher.thread_id,
        user_id: watcher.owner_id,
        sb_id: null,
      });
      db.seed('inbox_thread_participants', {
        thread_id: watcher.thread_id,
        user_id: null,
        sb_id: watcher.recipient_id,
      });
      const from = db.from.bind(db);
      const refusedWrite = vi.fn().mockResolvedValue({
        data: null,
        error: { code, message: 'synthetic confidential database detail' },
      });
      vi.spyOn(db, 'from').mockImplementation((table) => {
        const query = from(table);
        if (table === 'sb_notification_watchers') query.single = refusedWrite;
        return query;
      });
      const realStore = new NotificationAccessStore(db as unknown as SupabaseClient);
      store.create.mockImplementation(realStore.create.bind(realStore));
      const response = await admin('/watchers', 'POST', consent);
      expect(refusedWrite).toHaveBeenCalledOnce();
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ error });
      expect((await admin('/watchers')).status).toBe(200);
    }
  );
  it('reports grant capacity as a conflict, not a transient retry', async () => {
    store.create.mockRejectedValue(new NotificationAccessError('grant_limit'));
    const response = await admin('/watchers', 'POST', consent);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'grant_limit' });
    expect(response.headers.get('retry-after')).toBeNull();
  });
  it('requires the existing signed-in owner scope, never the device token', async () => {
    expect((await admin('/watchers', 'GET', undefined, deviceToken)).status).toBe(401);
    expect(store.list).not.toHaveBeenCalled();
  });

  it('creates with server-authenticated owner/workspace, and returns the device secret once', async () => {
    const result = await admin('/watchers', 'POST', consent);
    expect(result.status).toBe(201);
    const body = await result.json();
    expect(body.deviceToken).toBe(deviceToken);
    expect(body.watcher).not.toHaveProperty('signin_id');
    expect(body.watcher).not.toHaveProperty('token_digest');
    expect(store.create).toHaveBeenCalledWith({ ownerId: id(2), workspaceId: id(3) }, consent, NOW);
    const listing = await admin('/watchers');
    expect(await listing.text()).not.toContain(deviceToken);
  });

  it.each([
    { ...consent, ownerId: id(20) },
    { ...consent, workspaceId: id(21) },
    { ...consent, deviceTime: undefined },
    { ...consent, deviceTime: -1 },
    { ...consent, clockOffsetMs: 90_000 },
    { ...consent, rules: [{ packageName: 'com.example.messages', match: { kind: 'all' } }] },
    { ...consent, disclosureAccepted: false },
    { ...consent, permissionReported: 'denied' },
    { ...consent, rules: [{ packageName: 'com.example.other', match: { kind: 'all' } }] },
  ])('refuses authority injection, missing consent and an unselected rule', async (body) => {
    expect((await admin('/watchers', 'POST', body)).status).toBe(422);
    expect(store.create).not.toHaveBeenCalled();
  });

  it('scopes revoke, delete and history to the signed-in person and workspace', async () => {
    expect((await admin(`/watchers/${id(1)}/revoke`, 'POST')).status).toBe(204);
    expect((await admin(`/watchers/${id(1)}`, 'DELETE')).status).toBe(204);
    expect((await admin(`/watchers/${id(1)}/events`)).status).toBe(200);
    const scope = { ownerId: id(2), workspaceId: id(3) };
    expect(store.revoke).toHaveBeenCalledWith(scope, id(1));
    expect(store.remove).toHaveBeenCalledWith(scope, id(1));
    expect(store.events).toHaveBeenCalledWith(scope, id(1), NOW);
  });

  it('reports expiry without claiming current OS permission', async () => {
    store.list.mockResolvedValue([{ ...watcher, expires_at: new Date(NOW).toISOString() }]);
    const response = await admin('/watchers');
    expect((await response.json()).watchers[0].status).toBe('expired');
  });

  it('fails closed when there is no configured backing store', async () => {
    configured = false;
    expect((await admin('/watchers')).status).toBe(503);
    expect((await postEvent()).status).toBe(503);
  });
});
