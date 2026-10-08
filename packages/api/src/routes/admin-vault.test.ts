/**
 * Saved logins through the real routes, over the in-memory FakePostgrest,
 * once for each store (services/saved-logins). For Supabase Vault the fake
 * stands in for the database's half: create_saved_login_secret keeps the value
 * as given, and the decrypted view is a plain table. That proves what the
 * server sends and how it reads each answer, not the SQL; Vault's encryption,
 * the foreign keys and the trigger are proved against a real database in
 * services/saved-logins/vault-store.integration.test.ts.
 *
 * The people, sites and secrets are invented. The sealing key is a fresh
 * random one per test.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { FakePostgrest, type Row } from '../test/fake-postgrest';

let db: FakePostgrest;

vi.mock('../data/composer', () => ({
  getDataComposer: vi.fn(async () => ({ getClient: () => db })),
}));
vi.mock('../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { vaultRouter } from './admin-vault';
import { logger } from '../utils/logger';
import { MAX_LISTED, bindingFor } from '../services/saved-logins/store';
import { open, seal, sealingKeyFrom } from '../services/saved-logins/sealing';

type Handler = (req: Request, res: Response) => Promise<void>;
/* eslint-disable @typescript-eslint/no-explicit-any */
function route(method: 'get' | 'post' | 'patch' | 'delete', path: string): Handler {
  const layer = (vaultRouter as any).stack.find(
    (entry: any) => entry.route?.path === path && entry.route?.methods?.[method]
  );
  if (!layer) throw new Error(`Route ${method.toUpperCase()} ${path} not found`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const ADA = '11111111-1111-4111-8111-111111111111';
const SAM = '22222222-2222-4222-8222-222222222222';
// Fake secrets. Each is distinctive, so finding it anywhere it shouldn't be is unambiguous.
const PASSWORD = 'correct horse battery staple FAKE-7Q2';
// RFC 6238's SHA-1 secret, "12345678901234567890", in base32.
const SETUP_KEY = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const SECRETS = 'saved_login_vault_secrets';

async function call(
  handler: Handler,
  { as = ADA, params = {}, body = {} }: { as?: string; params?: Row; body?: Row } = {}
): Promise<{ status: number; body: Row; headers: Record<string, string> }> {
  const answer = { status: 200, body: {} as Row, headers: {} as Record<string, string> };
  const res = {
    status(n: number) {
      answer.status = n;
      return res;
    },
    json(r: Row) {
      answer.body = r;
      return res;
    },
    setHeader(name: string, value: string) {
      answer.headers[name.toLowerCase()] = value;
    },
  };
  await handler({ body, params, inkUserId: as } as unknown as Request, res as unknown as Response);
  return answer;
}

const list = route('get', '/logins');
const create = route('post', '/logins');
const read = route('get', '/logins/:id');
const update = route('patch', '/logins/:id');
const remove = route('delete', '/logins/:id');
const reveal = route('post', '/logins/:id/reveal');
const code = route('post', '/logins/:id/code');

async function saveOne(body: Row = {}, as = ADA): Promise<string> {
  const res = await call(create, {
    as,
    body: {
      name: 'Example Mail',
      url: 'https://mail.example.test',
      username: 'ada@example.test',
      password: PASSWORD,
      authenticator: SETUP_KEY,
      ...body,
    },
  });
  expect(res.status).toBe(201);
  return (res.body.login as Row).id as string;
}

/** The fake's stand-in for create_saved_login_secret and the decrypted view. */
function installFakeVault() {
  db.rpcHandlers.create_saved_login_secret = (args) => {
    const row = db.seed(SECRETS, { owner_tag: `saved_login:${args.p_owner}`, value: args.p_value });
    return { data: row.id, error: null };
  };
}

/** Runs `before` as the next update of `table` is about to be sent. */
function beforeUpdate(table: string, before: () => void) {
  const real = db.from.bind(db);
  db.from = (name: string) => {
    const query = real(name);
    if (name === table) {
      const send = query.update.bind(query);
      query.update = (patch: Row) => {
        before();
        return send(patch);
      };
    }
    return query;
  };
}

interface StoreCase {
  kind: 'supabase-vault' | 'sealed';
  table: 'saved_logins' | 'saved_logins_sealed';
  use(): void;
  /** One login's stored state: its row, and what its halves are kept as. */
  snapshot(id: string): unknown;
  /** Makes every stored half refuse to open, as a wrong key or a misplaced secret would. */
  spoil(): void;
  /** Gives login `to` the stored secret half of login `from`. */
  copySecret(from: string, to: string): void;
}

const STORES: StoreCase[] = [
  {
    kind: 'supabase-vault',
    table: 'saved_logins',
    use() {
      vi.stubEnv('SAVED_LOGINS_STORE', '');
      installFakeVault();
    },
    snapshot(id) {
      const row = db.rows('saved_logins').find((r) => r.id === id)!;
      const value = (secretId: unknown) => db.rows(SECRETS).find((s) => s.id === secretId)?.value;
      return [
        row.item_secret_id,
        row.secret_secret_id,
        row.revision,
        value(row.item_secret_id),
        value(row.secret_secret_id),
      ];
    },
    spoil() {
      for (const secret of db.rows(SECRETS)) {
        secret.value = JSON.stringify({
          for: bindingFor(ADA, randomUUID(), 'secret'),
          value: { password: 'elsewhere', authenticator: null },
        });
      }
    },
    copySecret(from, to) {
      const rows = db.rows('saved_logins');
      rows.find((r) => r.id === to)!.secret_secret_id = rows.find(
        (r) => r.id === from
      )!.secret_secret_id;
    },
  },
  {
    kind: 'sealed',
    table: 'saved_logins_sealed',
    use() {
      vi.stubEnv('SAVED_LOGINS_STORE', 'sealed');
      vi.stubEnv('SAVED_LOGINS_SEALING_KEY', randomBytes(32).toString('base64'));
    },
    snapshot(id) {
      const row = db.rows('saved_logins_sealed').find((r) => r.id === id)!;
      return [row.item_sealed, row.secret_sealed, row.revision];
    },
    spoil() {
      vi.stubEnv('SAVED_LOGINS_SEALING_KEY', randomBytes(32).toString('base64'));
    },
    copySecret(from, to) {
      const rows = db.rows('saved_logins_sealed');
      rows.find((r) => r.id === to)!.secret_sealed = rows.find((r) => r.id === from)!.secret_sealed;
    },
  },
];

beforeEach(() => {
  db = new FakePostgrest();
  for (const level of ['info', 'warn', 'error', 'debug'] as const) {
    vi.mocked(logger[level]).mockClear();
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

/** Every argument any logger level was given, as text. */
function logged(): string {
  return JSON.stringify(
    (['info', 'warn', 'error', 'debug'] as const).map(
      (level) => vi.mocked(logger[level]).mock.calls
    )
  );
}

describe.each(STORES)('with the $kind store', (store) => {
  beforeEach(() => store.use());

  describe('saving a login', () => {
    it('answers with what was saved, never the secrets', async () => {
      const res = await call(create, {
        body: { name: '  Example Mail ', username: 'ada', password: PASSWORD },
      });
      expect(res.body.login).toMatchObject({
        name: 'Example Mail',
        url: null,
        username: 'ada',
        hasPassword: true,
        hasAuthenticator: false,
        revision: 1,
      });
      expect(JSON.stringify(res.body)).not.toContain(PASSWORD);
    });

    it('keeps a password exactly as typed, spaces included', async () => {
      const id = await saveOne({ password: '  spaced  ' });
      expect((await call(reveal, { params: { id } })).body).toEqual({ password: '  spaced  ' });
    });

    it('refuses a missing name, overlong fields and a setup key that isn’t one, storing nothing', async () => {
      for (const body of [
        {},
        { name: '   ' },
        { name: 'x'.repeat(121) },
        { name: 'ok', password: 'p'.repeat(1025) },
        { name: 'ok', username: 7 },
        { name: 'ok', authenticator: 'not a key' },
      ]) {
        const res = await call(create, { body });
        expect(res).toMatchObject({ status: 400, body: { code: 'invalid_login' } });
      }
      expect(db.rows(store.table)).toHaveLength(0);
      expect(db.rows(SECRETS)).toHaveLength(0);
    });
  });

  describe('listing', () => {
    it('lists the person’s own logins by name, without secrets or whether they have them', async () => {
      // Six names, so ids (random) almost never come back in name order by chance.
      for (const name of ['zeta', 'Alpha', 'delta', 'Bravo', 'echo', 'charlie']) {
        await saveOne({ name });
      }
      await saveOne({ name: 'Sam’s bank' }, SAM);
      const res = await call(list);
      expect((res.body.logins as Row[]).map((l) => l.name)).toEqual([
        'Alpha',
        'Bravo',
        'charlie',
        'delta',
        'echo',
        'zeta',
      ]);
      expect(Object.keys((res.body.logins as Row[])[0]!).sort()).toEqual(
        ['createdAt', 'id', 'name', 'revision', 'updatedAt', 'url', 'username'].sort()
      );
      expect(JSON.stringify(res.body)).not.toContain(PASSWORD);
    });

    it('lists every login, however low the server caps a page', async () => {
      for (const name of ['gamma', 'Alpha', 'beta']) await saveOne({ name });
      db.maxRows = 1;
      const res = await call(list);
      expect((res.body.logins as Row[]).map((l) => l.name)).toEqual(['Alpha', 'beta', 'gamma']);
    });

    it('refuses to list rather than answer with only some', async () => {
      for (let i = 0; i <= MAX_LISTED; i++) {
        db.seed(store.table, {
          id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
          user_id: ADA,
          item_sealed: 'v1.x',
          secret_sealed: 'v1.x',
          item_secret_id: randomUUID(),
          secret_secret_id: randomUUID(),
          revision: 1,
        });
      }
      expect(await call(list)).toMatchObject({ status: 500, body: { code: 'too_many_logins' } });
    });

    it('reads one login with whether it has each secret', async () => {
      const id = await saveOne({ authenticator: null });
      const res = await call(read, { params: { id } });
      expect(res.body.login).toMatchObject({ hasPassword: true, hasAuthenticator: false });
      expect(JSON.stringify(res.body)).not.toContain(PASSWORD);
    });
  });

  describe('the secrets', () => {
    it('reveals the password, marked not to be stored', async () => {
      const id = await saveOne();
      const res = await call(reveal, { params: { id } });
      expect(res.body).toEqual({ password: PASSWORD });
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('gives the authenticator’s current code, never its setup key', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(59_000);
      const id = await saveOne();
      const res = await call(code, { params: { id } });
      expect(res.body).toEqual({ code: '287082', secondsRemaining: 1, period: 30 });
      expect(res.headers['cache-control']).toBe('no-store');
      for (const handler of [list, read]) {
        const answer = await call(handler, { params: { id } });
        expect(JSON.stringify(answer.body)).not.toContain(SETUP_KEY);
      }
    });

    it('says when a login has no authenticator', async () => {
      const id = await saveOne({ authenticator: undefined });
      expect(await call(code, { params: { id } })).toMatchObject({
        status: 404,
        body: { code: 'no_authenticator' },
      });
    });
  });

  describe('editing and deleting', () => {
    it('changes only the fields sent, and clears a field sent as null', async () => {
      const id = await saveOne();
      const res = await call(update, {
        params: { id },
        body: { username: 'ada.l@example.test', authenticator: null, ifRevision: 1 },
      });
      expect(res.body.login).toMatchObject({
        name: 'Example Mail',
        username: 'ada.l@example.test',
        hasPassword: true,
        hasAuthenticator: false,
        revision: 2,
      });
      expect((await call(reveal, { params: { id } })).body).toEqual({ password: PASSWORD });
      expect(
        (await call(update, { params: { id }, body: { password: 'new one', ifRevision: 2 } }))
          .status
      ).toBe(200);
      expect((await call(reveal, { params: { id } })).body).toEqual({ password: 'new one' });
      expect(
        (await call(update, { params: { id }, body: { name: '', ifRevision: 3 } })).status
      ).toBe(400);
    });

    it('deletes a login', async () => {
      const id = await saveOne();
      expect((await call(remove, { params: { id } })).body).toEqual({ deleted: true });
      expect(db.rows(store.table)).toHaveLength(0);
      expect((await call(remove, { params: { id } })).status).toBe(404);
    });
  });

  describe('nothing is overwritten unseen', () => {
    it('requires the revision an edit was made from', async () => {
      const id = await saveOne();
      const before = store.snapshot(id);
      const res = await call(update, { params: { id }, body: { username: 'no revision' } });
      expect(res).toMatchObject({ status: 400, body: { code: 'revision_required' } });
      expect(store.snapshot(id)).toEqual(before);
    });

    it('refuses a malformed setup key on edit, and leaves the login as it was', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(59_000);
      const id = await saveOne();
      const before = store.snapshot(id);
      for (const authenticator of ['A'.repeat(17), `otpauth://totp/x?secret=${'A'.repeat(17)}`]) {
        const res = await call(update, { params: { id }, body: { authenticator, ifRevision: 1 } });
        expect(res).toMatchObject({ status: 400, body: { code: 'invalid_login' } });
      }
      expect(store.snapshot(id)).toEqual(before);
      expect((await call(code, { params: { id } })).body).toMatchObject({ code: '287082' });
    });

    it('refuses an edit made from an older copy', async () => {
      const id = await saveOne();
      const opened = ((await call(read, { params: { id } })).body.login as Row).revision;
      await call(update, { params: { id }, body: { username: 'first edit', ifRevision: opened } });
      const before = store.snapshot(id);
      const stale = await call(update, {
        params: { id },
        body: { username: 'second edit', ifRevision: opened },
      });
      expect(stale).toMatchObject({ status: 409, body: { code: 'login_changed' } });
      expect(store.snapshot(id)).toEqual(before);
      const current = ((await call(read, { params: { id } })).body.login as Row).revision;
      const fresh = await call(update, {
        params: { id },
        body: { username: 'second edit', ifRevision: current },
      });
      expect(fresh.body.login).toMatchObject({ username: 'second edit', revision: 3 });
    });

    it('refuses an edit that loses a race with another write', async () => {
      const id = await saveOne();
      const secretsBefore = db.rows(SECRETS).length;
      // The other write lands between this edit's read and its write.
      beforeUpdate(store.table, () => {
        db.rows(store.table)[0]!.revision = 7;
      });
      const res = await call(update, { params: { id }, body: { password: 'lost', ifRevision: 1 } });
      expect(res).toMatchObject({ status: 409, body: { code: 'login_changed' } });
      db.from = FakePostgrest.prototype.from.bind(db);
      expect((await call(reveal, { params: { id } })).body).toEqual({ password: PASSWORD });
      // What the losing edit made for Vault is deleted again.
      expect(db.rows(SECRETS)).toHaveLength(secretsBefore);
    });

    it('when a half won’t open, refuses and writes nothing', async () => {
      const id = await saveOne();
      const before = store.snapshot(id);
      store.spoil();
      const spoiled = store.snapshot(id);
      for (const [handler, body] of [
        [update, { username: 'x', ifRevision: 1 }],
        [reveal, {}],
        [code, {}],
        [read, {}],
        [list, {}],
      ] as const) {
        const res = await call(handler, { params: { id }, body });
        expect(res.status).toBe(500);
        expect(JSON.stringify(res.body)).not.toContain(PASSWORD);
      }
      expect(store.snapshot(id)).toEqual(store.kind === 'sealed' ? before : spoiled);
    });

    it('when the write fails, changes nothing', async () => {
      const id = await saveOne();
      const before = store.snapshot(id);
      const secretsBefore = db.rows(SECRETS).length;
      beforeUpdate(store.table, () => {
        throw new Error('connection lost');
      });
      const res = await call(update, {
        params: { id },
        body: { password: 'never saved', ifRevision: 1 },
      });
      expect(res).toEqual({
        status: 500,
        body: { error: 'Failed to update the login' },
        headers: {},
      });
      db.from = FakePostgrest.prototype.from.bind(db);
      expect(store.snapshot(id)).toEqual(before);
      expect(db.rows(SECRETS)).toHaveLength(secretsBefore);
    });
  });

  describe('another person', () => {
    it('can’t read, reveal, change or delete someone else’s login', async () => {
      const id = await saveOne();
      for (const [handler, body] of [
        [read, {}],
        [reveal, {}],
        [code, {}],
        [update, { password: 'stolen', ifRevision: 1 }],
        [remove, {}],
      ] as const) {
        const res = await call(handler, { as: SAM, params: { id }, body });
        expect(res).toMatchObject({ status: 404, body: { code: 'login_not_found' } });
      }
      expect((await call(reveal, { params: { id } })).body).toEqual({ password: PASSWORD });
    });

    it('can’t open a secret half taken from someone else’s login', async () => {
      const theirs = await saveOne({}, SAM);
      const mine = await saveOne();
      store.copySecret(mine, theirs);
      const res = await call(reveal, { as: SAM, params: { id: theirs } });
      expect(res.status).toBe(500);
      expect(JSON.stringify(res.body)).not.toContain(PASSWORD);
    });
  });

  describe('where a value can go', () => {
    it('only reveal and code answer with a secret, and nothing is logged', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(59_000);
      const answers: Row[] = [];
      const created = await call(create, {
        body: { name: 'Example Mail', password: PASSWORD, authenticator: SETUP_KEY },
      });
      answers.push(created.body);
      const id = (created.body.login as Row).id as string;
      answers.push((await call(list)).body);
      answers.push((await call(read, { params: { id } })).body);
      answers.push(
        (await call(update, { params: { id }, body: { username: 'ada', ifRevision: 1 } })).body
      );
      expect((await call(reveal, { params: { id } })).body).toEqual({ password: PASSWORD });
      expect((await call(code, { params: { id } })).body).toMatchObject({ code: '287082' });
      answers.push((await call(remove, { params: { id } })).body);
      for (const secret of [PASSWORD, SETUP_KEY]) {
        expect(JSON.stringify(answers)).not.toContain(secret);
        expect(logged()).not.toContain(secret);
      }
    });

    it('touches only its own tables: no activity, audit or other row', async () => {
      const id = await saveOne();
      await call(update, { params: { id }, body: { password: 'changed', ifRevision: 1 } });
      await call(reveal, { params: { id } });
      await call(remove, { params: { id } });
      const touched = new Set(db.log.map((entry) => entry.table));
      const own =
        store.kind === 'sealed'
          ? ['saved_logins_sealed']
          : ['saved_logins', SECRETS, 'create_saved_login_secret'];
      expect([...touched].sort()).toEqual(own.sort());
    });

    it('a failure answers and logs without the value, whatever the database said', async () => {
      // A database error that repeats what it was sent: the worst case.
      const echo = () => {
        throw new Error(`boom: ${PASSWORD} ${SETUP_KEY}`);
      };
      db.from = echo as unknown as typeof db.from;
      db.rpc = echo as unknown as typeof db.rpc;
      const id = randomUUID();
      for (const [handler, body] of [
        [create, { name: 'x', password: PASSWORD, authenticator: SETUP_KEY }],
        [list, {}],
        [read, {}],
        [update, { password: PASSWORD, ifRevision: 1 }],
        [reveal, {}],
        [code, {}],
        [remove, {}],
      ] as const) {
        const res = await call(handler, { params: { id }, body });
        expect(res.status).toBe(500);
        expect(Object.keys(res.body)).toEqual(['error']);
        expect(JSON.stringify(res.body)).not.toContain(PASSWORD);
      }
      expect(vi.mocked(logger.error).mock.calls.length).toBeGreaterThan(0);
      expect(logged()).not.toContain(PASSWORD);
      expect(logged()).not.toContain(SETUP_KEY);
    });

    it('a half that opens but won’t parse fails without quoting it', async () => {
      const id = await saveOne();
      if (store.kind === 'sealed') {
        // Sealed correctly, but not JSON: what a wrong format would decrypt to.
        const key = sealingKeyFrom()!;
        db.rows('saved_logins_sealed')[0]!.secret_sealed = seal(
          key,
          `{"password":"${PASSWORD}"`,
          bindingFor(ADA, id, 'secret')
        );
        expect(() =>
          open(
            key,
            db.rows('saved_logins_sealed')[0]!.secret_sealed as string,
            bindingFor(ADA, id, 'secret')
          )
        ).not.toThrow();
      } else {
        const row = db.rows('saved_logins')[0]!;
        db.rows(SECRETS).find((s) => s.id === row.secret_secret_id)!.value =
          `{"for":"${bindingFor(ADA, id, 'secret')}","value":{"password":"${PASSWORD}"`;
      }
      const res = await call(reveal, { params: { id } });
      expect(res).toEqual({
        status: 500,
        body: { error: 'Failed to show the password' },
        headers: {},
      });
      expect(logged()).not.toContain(PASSWORD);
    });
  });
});

describe('which store', () => {
  it('is unavailable with an unknown store, and stores nothing', async () => {
    vi.stubEnv('SAVED_LOGINS_STORE', 'plaintext');
    installFakeVault();
    for (const handler of [list, create]) {
      const res = await call(handler, { body: { name: 'x', password: PASSWORD } });
      expect(res).toMatchObject({ status: 503, body: { code: 'vault_unavailable' } });
    }
    expect(db.log).toEqual([]);
  });

  it('is unavailable as the sealed store without a key, and stores nothing unencrypted', async () => {
    vi.stubEnv('SAVED_LOGINS_STORE', 'sealed');
    vi.stubEnv('SAVED_LOGINS_SEALING_KEY', '');
    for (const handler of [list, create]) {
      const res = await call(handler, { body: { name: 'x', password: PASSWORD } });
      expect(res).toMatchObject({ status: 503, body: { code: 'vault_unavailable' } });
    }
    expect(db.log).toEqual([]);
  });

  it('keeps each store’s logins apart: switching moves nothing', async () => {
    vi.stubEnv('SAVED_LOGINS_STORE', '');
    vi.stubEnv('SAVED_LOGINS_SEALING_KEY', randomBytes(32).toString('base64'));
    installFakeVault();
    await saveOne({ name: 'In Vault' });
    vi.stubEnv('SAVED_LOGINS_STORE', 'sealed');
    expect((await call(list)).body).toEqual({ logins: [] });
    await saveOne({ name: 'Sealed' });
    vi.stubEnv('SAVED_LOGINS_STORE', 'supabase-vault');
    expect(((await call(list)).body.logins as Row[]).map((l) => l.name)).toEqual(['In Vault']);
  });
});

describe('the Supabase Vault store', () => {
  beforeEach(() => STORES[0]!.use());

  it('keeps no value in its table, only which secrets are whose', async () => {
    const id = await saveOne();
    const [row] = db.rows('saved_logins');
    expect(Object.keys(row!).sort()).toEqual(
      ['created_at', 'id', 'item_secret_id', 'revision', 'secret_secret_id', 'user_id'].sort()
    );
    const stored = JSON.stringify(row);
    for (const plain of [PASSWORD, SETUP_KEY, 'ada@example.test', 'Example Mail', 'mail.example']) {
      expect(stored).not.toContain(plain);
    }
    // Each half names its owner, its login and which half it is.
    const secrets = db.rows(SECRETS);
    expect(secrets.map((s) => s.owner_tag)).toEqual([`saved_login:${ADA}`, `saved_login:${ADA}`]);
    const item = JSON.parse(secrets.find((s) => s.id === row!.item_secret_id)!.value as string);
    expect(item).toEqual({
      for: bindingFor(ADA, id, 'item'),
      value: {
        name: 'Example Mail',
        url: 'https://mail.example.test',
        username: 'ada@example.test',
      },
    });
    const secret = JSON.parse(secrets.find((s) => s.id === row!.secret_secret_id)!.value as string);
    expect(secret.for).toBe(bindingFor(ADA, id, 'secret'));
  });

  it('an edit makes new secrets and points the row at them in one write', async () => {
    const id = await saveOne();
    const [before] = db.rows('saved_logins').map((r) => ({ ...r }));
    const writes = db.log.length;
    await call(update, { params: { id }, body: { password: 'new one', ifRevision: 1 } });
    const after = db.rows('saved_logins')[0]!;
    expect(after.item_secret_id).not.toBe(before!.item_secret_id);
    expect(after.secret_secret_id).not.toBe(before!.secret_secret_id);
    expect(after.revision).toBe(2);
    const updates = db.log.slice(writes).filter((e) => e.op === 'update');
    expect(updates).toHaveLength(1);
    expect(updates[0]!.filters).toEqual([`id=${id}`, `user_id=${ADA}`, 'revision=1']);
  });

  it('when the second secret can’t be made, deletes the first and saves nothing', async () => {
    let made = 0;
    const real = db.rpcHandlers.create_saved_login_secret!;
    db.rpcHandlers.create_saved_login_secret = (args, fake) => {
      made += 1;
      if (made === 2) return { data: null, error: { message: 'vault is down' } };
      return real(args, fake);
    };
    const res = await call(create, { body: { name: 'x', password: PASSWORD } });
    expect(res.status).toBe(500);
    expect(db.rows('saved_logins')).toHaveLength(0);
    expect(db.rows(SECRETS)).toHaveLength(0);
  });

  it('when the row can’t be written, deletes the secrets made for it', async () => {
    const real = db.from.bind(db);
    db.from = (name: string) => {
      const query = real(name);
      if (name === 'saved_logins') {
        query.insert = () => {
          throw new Error('connection lost');
        };
      }
      return query;
    };
    const res = await call(create, { body: { name: 'x', password: PASSWORD } });
    expect(res.status).toBe(500);
    expect(db.rows(SECRETS)).toHaveLength(0);
  });

  it('keeps secrets it couldn’t delete, logging only how many', async () => {
    const real = db.from.bind(db);
    db.from = (name: string) => {
      const query = real(name);
      if (name === 'saved_logins') {
        query.insert = () => {
          throw new Error('connection lost');
        };
      }
      if (name === SECRETS) {
        query.delete = () => {
          throw new Error(`refused: ${PASSWORD}`);
        };
      }
      return query;
    };
    const res = await call(create, { body: { name: 'x', password: PASSWORD } });
    expect(res.status).toBe(500);
    expect(db.rows(SECRETS)).toHaveLength(2);
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      'Saved logins: kept secrets from a write that did not land',
      { count: 2, reason: 'Error' }
    );
    expect(logged()).not.toContain(PASSWORD);
  });

  it('reads many secrets a bounded number at a time', async () => {
    for (let i = 0; i < 230; i++) await saveOne({ name: `site ${String(i).padStart(3, '0')}` });
    db.maxInList = 100;
    const res = await call(list);
    expect(res.status).toBe(200);
    expect((res.body.logins as Row[]).length).toBe(230);
  });
});
