/** Real PostgREST request generation with an invented, in-process fetch. No network or SQL execution. */
import { createClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it } from 'vitest';
import { NotificationAccessStore, assertNotificationTarget } from './store';
import { FakePostgrest } from '../../test/fake-postgrest';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const NOW = Date.parse('2026-01-10T12:00:00Z');
const iso = (offset: number) => new Date(NOW + offset).toISOString();
const scope = { ownerId: id(1), workspaceId: id(2) };
const input = {
  installationId: id(6),
  recipientId: id(3),
  conversationId: 'inkling:chat:synthetic-notifications',
  deviceTime: NOW,
  refreshToken: 'synthetic-refresh',
  selectedPackages: ['com.example.messages'],
  rules: [],
  disclosureAccepted: true as const,
  permissionReported: 'granted' as const,
};
const watcher = {
  id: id(7),
  owner_id: id(1),
  workspace_id: id(2),
  recipient_id: id(3),
  thread_id: id(4),
  signin_id: id(5),
  installation_id: id(6),
  selected_packages: input.selectedPackages,
  clock_offset_ms: 0,
  status: 'active' as const,
  active_since: iso(-1000),
  expires_at: iso(100000),
  created_at: iso(-1000),
  token_digest: 'a'.repeat(64),
};
type Row = Record<string, unknown>;
let tables: Record<string, Row[]>;
let calls: Array<{ table: string; method: string; query: URLSearchParams; body?: Row }>;
let fault: { table: string; code: string } | null;
let store: NotificationAccessStore;
let db: ReturnType<typeof createClient>;

beforeEach(() => {
  tables = {
    agent_identities: [{ id: id(3), user_id: id(1), workspace_id: id(2) }],
    inbox_threads: [
      {
        id: id(4),
        thread_key: input.conversationId,
        workspace_id: id(2),
        metadata: { inklingConversation: true },
      },
    ],
    inbox_thread_participants: [
      { thread_id: id(4), user_id: id(1), sb_id: null },
      { thread_id: id(4), sb_id: id(3), user_id: null },
    ],
    mcp_tokens: [
      {
        id: id(5),
        user_id: id(1),
        client_id: 'mobile',
        refresh_token: 'synthetic-refresh',
        expires_at: iso(100000),
      },
    ],
    sb_notification_watchers: [{ ...watcher }],
    sb_notification_events: [],
    sb_notification_rule_versions: [],
  };
  calls = [];
  fault = null;
  const fetcher: typeof fetch = async (request, init) => {
    const url = new URL(
      typeof request === 'string' || request instanceof URL ? request : request.url
    );
    if (url.origin !== 'https://database.example.test' || !url.pathname.startsWith('/rest/v1/'))
      throw new Error('Unexpected endpoint');
    const table = url.pathname.slice('/rest/v1/'.length);
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Row) : undefined;
    calls.push({ table, method, query: url.searchParams, body });
    if (fault?.table === table)
      return new Response(
        JSON.stringify({ code: fault.code, message: 'synthetic confidential database detail' }),
        { status: 400 }
      );
    const all = tables[table];
    if (!all) throw new Error('Unexpected table');
    let rows = all.filter((row) =>
      [...url.searchParams].every(([column, filter]) => {
        if (['select', 'order', 'limit'].includes(column)) return true;
        const dot = filter.indexOf('.');
        const op = filter.slice(0, dot),
          value = filter.slice(dot + 1);
        if (op === 'eq') return String(row[column]) === value;
        if (op === 'gt') return row[column] != null && String(row[column]) > value;
        if (op === 'lte') return row[column] != null && String(row[column]) <= value;
        if (op === 'in') return value.slice(1, -1).split(',').includes(String(row[column]));
        throw new Error(`Unsupported fake filter ${op}`);
      })
    );
    if (method === 'POST') {
      if (!body) throw new Error('Missing insert body');
      // Defaults only: this fake deliberately does not model the SQL guards.
      const inserted = {
        id: id(90),
        active_since: iso(0),
        created_at: iso(0),
        status: 'active',
        clock_offset_ms: 0,
        revision: all.length + 1,
        ...body,
      };
      all.push(inserted);
      rows = [inserted];
    } else if (method === 'PATCH') {
      rows.forEach((row) => Object.assign(row, body));
    } else if (method === 'DELETE') {
      tables[table] = all.filter((row) => !rows.includes(row));
    }
    const order = url.searchParams.get('order');
    if (order === 'revision.desc')
      rows = [...rows].sort((a, b) => Number(b.revision) - Number(a.revision));
    if (url.searchParams.has('limit')) rows = rows.slice(0, Number(url.searchParams.get('limit')));
    const columns = url.searchParams.get('select')?.split(',');
    const projected = columns
      ? rows.map((row) => Object.fromEntries(columns.map((key) => [key, row[key]])))
      : rows;
    const singular = new Headers(init?.headers).get('accept')?.includes('vnd.pgrst.object');
    return new Response(JSON.stringify(singular ? projected[0] : projected), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  db = createClient('https://database.example.test', 'synthetic-test-key', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: fetcher },
  });
  store = new NotificationAccessStore(db);
});

describe('private notification target', () => {
  it('requires the actual private owner-and-recipient participant pair', async () => {
    await expect(assertNotificationTarget(db, scope, id(3), input.conversationId)).resolves.toBe(
      id(4)
    );
    await expect(assertNotificationTarget(db, scope, id(3), id(4))).rejects.toMatchObject({
      code: 'target_refused',
    });
  });
  it.each([
    'unmarked',
    'string-mark',
    'shared',
    'other-person',
    'other-sb',
    'no-owner',
    'extra-member',
    'foreign-workspace',
    'foreign-owner',
  ])('refuses %s', async (variant) => {
    if (variant === 'unmarked') tables.inbox_threads[0].metadata = {};
    if (variant === 'string-mark')
      tables.inbox_threads[0].metadata = { inklingConversation: 'true' };
    if (variant === 'shared')
      tables.inbox_threads[0].metadata = { inklingConversation: true, inklingShared: true };
    if (variant === 'other-person') tables.inbox_thread_participants[0].user_id = id(30);
    if (variant === 'other-sb') tables.inbox_thread_participants[1].sb_id = id(31);
    if (variant === 'no-owner') tables.inbox_thread_participants.shift();
    if (variant === 'extra-member')
      tables.inbox_thread_participants.push({ thread_id: id(4), user_id: id(32), sb_id: null });
    if (variant === 'foreign-workspace') tables.inbox_threads[0].workspace_id = id(33);
    if (variant === 'foreign-owner') tables.agent_identities[0].user_id = id(34);
    await expect(
      assertNotificationTarget(db, scope, id(3), input.conversationId)
    ).rejects.toMatchObject({
      code: 'target_refused',
    });
  });
  it.each(['agent_identities', 'inbox_threads', 'inbox_thread_participants'])(
    'refuses unreadable %s',
    async (table) => {
      fault = { table, code: 'synthetic_failure' };
      await expect(
        assertNotificationTarget(db, scope, id(3), input.conversationId)
      ).rejects.toMatchObject({
        code: 'unavailable',
        message: 'unavailable',
      });
    }
  );
});

describe('sign-in and grant binding', () => {
  it('reports exhausted grant capacity without exposing a database error', async () => {
    fault = { table: 'sb_notification_watchers', code: 'NPA08' };
    await expect(store.create(scope, input, NOW)).rejects.toMatchObject({
      code: 'grant_limit',
      message: 'grant_limit',
    });
  });
  it('stores a digest and the sign-in row, never another copy of its secret', async () => {
    const created = await store.create(scope, input, NOW);
    expect(created.deviceToken).toMatch(/^ink-na-[0-9a-f]{64}$/);
    const written = calls.find(
      (call) => call.table === 'sb_notification_watchers' && call.method === 'POST'
    )!.body!;
    expect(written.signin_id).toBe(id(5));
    expect(written.thread_id).toBe(id(4));
    expect(written.device_time_ms).toBe(NOW);
    expect(written).not.toHaveProperty('rules');
    expect(written.token_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(written)).not.toContain('synthetic-refresh');
    expect(JSON.stringify(written)).not.toContain(created.deviceToken);
    expect(created.watcher).not.toHaveProperty('token_digest');
  });
  it.each(['owner', 'client', 'expiry', 'missing'])(
    'refuses a mismatched or ended sign-in: %s',
    async (kind) => {
      if (kind === 'owner') tables.mcp_tokens[0].user_id = id(99);
      if (kind === 'client') tables.mcp_tokens[0].client_id = 'synthetic-other-client';
      if (kind === 'expiry') tables.mcp_tokens[0].expires_at = iso(0);
      if (kind === 'missing') tables.mcp_tokens = [];
      await expect(store.create(scope, input, NOW)).rejects.toMatchObject({
        code: 'access_inactive',
      });
      expect(calls.some((call) => call.method === 'POST')).toBe(false);
    }
  );
  it('rejects unknown create fields even when called outside a router', async () => {
    await expect(
      store.create(scope, { ...input, ownerId: id(99) } as typeof input, NOW)
    ).rejects.toMatchObject({ code: 'invalid_request' });
    expect(calls).toHaveLength(0);
  });
  it('resolves only a live grant and its own live mobile sign-in', async () => {
    expect((await store.deviceAccess('a'.repeat(64), NOW))?.id).toBe(id(7));
    tables.mcp_tokens[0].user_id = id(99);
    expect(await store.deviceAccess('a'.repeat(64), NOW)).toBeNull();
  });
  it.each(['revoked', 'paused', 'expired', 'signout', 'sign-in-expired'])(
    'refuses device authority after %s',
    async (kind) => {
      if (kind === 'revoked' || kind === 'paused') tables.sb_notification_watchers[0].status = kind;
      if (kind === 'expired') tables.sb_notification_watchers[0].expires_at = iso(0);
      if (kind === 'signout') tables.mcp_tokens = [];
      if (kind === 'sign-in-expired') tables.mcp_tokens[0].expires_at = iso(0);
      expect(await store.deviceAccess('a'.repeat(64), NOW)).toBeNull();
    }
  );
  it('does not query a malformed digest', async () => {
    expect(await store.deviceAccess('synthetic', NOW)).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe('separate mutable owner rules', () => {
  const rules = [{ packageName: 'com.example.messages', match: { kind: 'all' } }];
  it('starts empty and appends a new version without rotating device consent', async () => {
    expect(await store.rules(scope, id(7))).toEqual({ revision: 0, rules: [] });
    expect(await store.setRules(scope, id(7), { rules }, NOW)).toEqual({ revision: 1, rules });
    expect(await store.setRules(scope, id(7), { rules: [] }, NOW)).toEqual({
      revision: 2,
      rules: [],
    });
    expect(await store.rules(scope, id(7))).toEqual({ revision: 2, rules: [] });
    expect(tables.sb_notification_rule_versions).toHaveLength(2);
    expect(tables.sb_notification_watchers[0]).toEqual(watcher);
    expect(
      calls
        .filter((call) => call.table === 'sb_notification_rule_versions' && call.method === 'POST')
        .every((call) => call.body?.actor_id === scope.ownerId)
    ).toBe(true);
  });
  it('cannot read or edit another owner or workspace', async () => {
    for (const other of [
      { ...scope, ownerId: id(98) },
      { ...scope, workspaceId: id(99) },
    ]) {
      await expect(store.rules(other, id(7))).rejects.toMatchObject({ code: 'not_found' });
      await expect(store.setRules(other, id(7), { rules }, NOW)).rejects.toMatchObject({
        code: 'not_found',
      });
    }
    expect(tables.sb_notification_rule_versions).toHaveLength(0);
  });
  it('refuses unselected apps, code, destination and client-supplied revision', async () => {
    for (const raw of [
      { rules: [{ ...rules[0], packageName: 'com.example.other' }] },
      { rules: [{ ...rules[0], source: 'synthetic-code' }] },
      { rules, destination: 'synthetic-target' },
      { rules, revision: 2 },
    ])
      await expect(store.setRules(scope, id(7), raw, NOW)).rejects.toMatchObject({
        code: 'invalid_request',
      });
    expect(tables.sb_notification_rule_versions).toHaveLength(0);
  });
  it('refuses inactive grants and newly shared conversations', async () => {
    tables.sb_notification_watchers[0].status = 'revoked';
    await expect(store.setRules(scope, id(7), { rules }, NOW)).rejects.toMatchObject({
      code: 'grant_inactive',
    });
    tables.sb_notification_watchers[0].status = 'active';
    tables.inbox_threads[0].metadata = { inklingConversation: true, inklingShared: true };
    await expect(store.setRules(scope, id(7), { rules }, NOW)).rejects.toMatchObject({
      code: 'target_refused',
    });
  });
  it.each(['revoked', 'paused', 'expired'])(
    'reports an owner rule edit on a %s grant as resource state, not authentication',
    async (state) => {
      if (state === 'expired') tables.sb_notification_watchers[0].expires_at = iso(0);
      else tables.sb_notification_watchers[0].status = state;
      await expect(store.setRules(scope, id(7), { rules }, NOW)).rejects.toMatchObject({
        code: 'grant_inactive',
      });
      expect(tables.sb_notification_rule_versions).toHaveLength(0);
    }
  );
  it.each(['NPA02', '23503'])(
    'maps a rule-write revocation/deletion race (%s) to grant state',
    async (code) => {
      fault = { table: 'sb_notification_rule_versions', code };
      await expect(store.setRules(scope, id(7), { rules }, NOW)).rejects.toMatchObject({
        code: 'grant_inactive',
      });
    }
  );
  it('keeps app label and raw device time while the database owns calibration', async () => {
    await store.record(watcher, {
      eventId: id(8),
      packageName: 'com.example.messages',
      appLabel: 'Demo app',
      title: '',
      text: '',
      postedAt: NOW - 90_000,
    });
    const written = calls.find(
      (call) => call.table === 'sb_notification_events' && call.method === 'POST'
    )!.body!;
    expect(written.app_label).toBe('Demo app');
    expect(written.device_posted_at_ms).toBe(NOW - 90_000);
    expect(written).not.toHaveProperty('posted_at');
  });
});

describe('owner reads, mutation scope and retention', () => {
  it('purges a full backlog through bounded PostgREST in-lists', async () => {
    const fake = new FakePostgrest();
    fake.maxInList = 50;
    for (let index = 0; index < 501; index++)
      fake.seed('sb_notification_events', { id: id(index + 100), expires_at: iso(0) });
    fake.seed('sb_notification_events', { id: id(999), expires_at: iso(1) });
    const bounded = new NotificationAccessStore(fake as unknown as typeof db);
    expect(await bounded.purgeExpired(NOW)).toBe(500);
    expect(fake.rows('sb_notification_events')).toHaveLength(2);
    expect(await bounded.purgeExpired(NOW)).toBe(1);
    expect(fake.rows('sb_notification_events').map((row) => row.id)).toEqual([id(999)]);
    expect(fake.log.filter((entry) => entry.op === 'delete')).toHaveLength(11);
  });

  it('keeps older active grants visible ahead of a long revoked history', async () => {
    const fake = new FakePostgrest();
    fake.seed('sb_notification_watchers', watcher);
    for (let index = 0; index < 101; index++)
      fake.seed('sb_notification_watchers', {
        ...watcher,
        id: id(index + 100),
        status: 'revoked',
        created_at: iso(index),
      });
    const rows = await new NotificationAccessStore(fake as unknown as typeof db).list(scope);
    expect(rows).toHaveLength(100);
    expect(rows[0].id).toBe(watcher.id);
    expect(rows.filter((row) => row.status === 'active')).toHaveLength(1);
  });
  it('lists only this owner in this workspace, without credential material', async () => {
    tables.sb_notification_watchers.push(
      { ...watcher, id: id(8), owner_id: id(20) },
      { ...watcher, id: id(9), workspace_id: id(21) }
    );
    const rows = await store.list(scope);
    expect(rows.map((row) => row.id)).toEqual([id(7)]);
    expect(JSON.stringify(rows)).not.toContain('token_digest');
    expect(await store.find({ ...scope, ownerId: id(20) }, id(7))).toBeNull();
  });
  it('cannot revoke or remove another owner’s or workspace’s grant', async () => {
    await store.revoke({ ...scope, ownerId: id(20) }, id(7));
    await store.remove({ ...scope, workspaceId: id(21) }, id(7));
    expect(tables.sb_notification_watchers[0].status).toBe('active');
    await store.revoke(scope, id(7));
    expect(tables.sb_notification_watchers[0].status).toBe('revoked');
    await store.remove(scope, id(7));
    expect(tables.sb_notification_watchers).toHaveLength(0);
  });
  it('filters expired events even before a cleanup worker runs', async () => {
    tables.sb_notification_events = [
      { id: id(10), watcher_id: id(7), expires_at: iso(0) },
      { id: id(11), watcher_id: id(7), expires_at: iso(1) },
      { id: id(12), watcher_id: id(99), expires_at: iso(1) },
    ];
    expect(await store.events(scope, id(7), NOW)).toMatchObject([{ id: id(11) }]);
    await expect(store.events({ ...scope, ownerId: id(99) }, id(7), NOW)).rejects.toMatchObject({
      code: 'not_found',
    });
  });
  it('purges a bounded batch and keeps unexpired content', async () => {
    tables.sb_notification_events = Array.from({ length: 501 }, (_, index) => ({
      id: id(index + 100),
      watcher_id: id(7),
      expires_at: iso(0),
    }));
    tables.sb_notification_events.push({ id: id(999), watcher_id: id(7), expires_at: iso(1) });
    expect(await store.purgeExpired(NOW)).toBe(500);
    expect(tables.sb_notification_events).toHaveLength(2);
    expect(await store.purgeExpired(NOW)).toBe(1);
    expect(tables.sb_notification_events[0].id).toBe(id(999));
  });
  it.each([
    ['NPA02', 'access_inactive'],
    ['NPA05', 'event_refused'],
    ['NPA06', 'event_conflict'],
    ['NPA07', 'rate_limited'],
    ['22P05', 'event_refused'],
    ['22P02', 'event_refused'],
    ['other', 'unavailable'],
  ])('maps database code %s without reflecting query details', async (code, expected) => {
    fault = { table: 'sb_notification_events', code };
    await expect(
      store.record(watcher, {
        eventId: id(8),
        packageName: 'com.example.messages',
        title: '',
        text: 'Synthetic',
        postedAt: NOW,
      })
    ).rejects.toMatchObject({ code: expected, message: expected });
  });
});
