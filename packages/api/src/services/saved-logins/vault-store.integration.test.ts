/**
 * The Supabase Vault saved-login store against a real database: Vault's own
 * encryption, the function that writes a secret, the opened view, the foreign
 * keys and the triggers
 * (supabase/migrations/20261008004326_saved_logins_vault.sql).
 *
 * routes/admin-vault.test.ts drives the routes over a fake that keeps values
 * as given. That proves what the server sends and how it reads each answer,
 * and nothing about the SQL. The properties that live in the database live
 * here:
 *
 *   - a value is encrypted at rest, and never written in the clear, not even
 *     to a dead row version (the placeholder in create_saved_login_secret);
 *   - a row can't point at a missing secret, and a secret a row points at
 *     can't be deleted;
 *   - a login's secrets go with it, on delete and on edit, and every secret a
 *     person owns goes with them, even one made while they were being deleted;
 *   - listing decrypts only what may be listed;
 *   - only the service role can reach any of it;
 *   - no decrypted value lands in any table.
 *
 * Every secret is fake and starts with FAKE-PW-, so a search of the stack's
 * logs for that prefix after a run finds any that leaked there.
 *
 * Run via: yarn test:integration:db:local
 */
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getDataComposer, type DataComposer } from '../../data/composer';
import { deleteAllSavedLogins, savedLoginStore } from './index';
import type { Client, SavedLoginStore } from './store';

const DB_URL = process.env.INTEGRATION_DB_URL;
const RUN = randomUUID().slice(0, 8);
const PASSWORD = `FAKE-PW-${RUN}-password`;

describe('saved logins in Supabase Vault', () => {
  let composer: DataComposer;
  let db: Client;
  let store: SavedLoginStore;
  const ada = randomUUID();
  const sam = randomUUID();

  async function pg(user = 'postgres') {
    const { Client: Pg } = await import('pg');
    const url = new URL(DB_URL!);
    url.username = user;
    const client = new Pg({ connectionString: url.toString() });
    await client.connect();
    return client;
  }

  /** Every Vault secret the person still has, counted in vault.secrets itself. */
  async function vaultSecretsOf(userId: string): Promise<number> {
    const client = await pg();
    try {
      const { rows } = await client.query(
        'SELECT count(*)::int AS n FROM vault.secrets WHERE description = $1',
        [`saved_login:${userId}`]
      );
      return (rows[0] as { n: number }).n;
    } finally {
      await client.end();
    }
  }

  /** The secret ids saved_login_secrets says the person owns. */
  async function owned(userId: string): Promise<string[]> {
    const { data, error } = await db
      .from('saved_login_secrets')
      .select('secret_id')
      .eq('user_id', userId);
    if (error) throw new Error(error.message);
    return (data ?? []).map((row) => row.secret_id);
  }

  async function row(id: string) {
    const { data, error } = await db.from('saved_logins').select('*').eq('id', id).maybeSingle();
    if (error) throw new Error(error.message);
    return data as { item_secret_id: string; secret_secret_id: string; revision: number } | null;
  }

  async function person(label: string): Promise<string> {
    const id = randomUUID();
    const { error } = await db
      .from('users')
      .insert({ id, email: `saved-logins-${label}-${RUN}@example.test` });
    if (error) throw new Error(error.message);
    return id;
  }

  const item = {
    name: 'Example Mail',
    url: 'https://mail.example.test',
    username: 'ada@example.test',
  };
  const secret = { password: PASSWORD, authenticator: null };

  beforeAll(async () => {
    composer = await getDataComposer();
    db = composer.getClient();
    store = savedLoginStore(async () => db, { SAVED_LOGINS_STORE: 'supabase-vault' })!;
    const { error } = await db.from('users').insert([
      { id: ada, email: `saved-logins-ada-${RUN}@example.test` },
      { id: sam, email: `saved-logins-sam-${RUN}@example.test` },
    ]);
    if (error) throw new Error(error.message);
  });

  afterAll(async () => {
    if (!db) return;
    await db.from('users').delete().in('id', [ada, sam]);
  });

  it('saves, lists, opens, edits and deletes a login', async () => {
    const saved = await store.create(ada, item, secret);
    expect(saved.revision).toBe(1);
    expect(saved.createdAt).toBeTruthy();
    expect((await store.list(ada))!.map((l) => l.item)).toEqual([item]);
    expect((await store.open(ada, saved.id, ['secret']))!.secret).toEqual(secret);

    const before = (await row(saved.id))!;
    const edited = await store.replace(
      ada,
      saved.id,
      1,
      { ...item, username: 'ada.l' },
      { password: `${PASSWORD}-2`, authenticator: null }
    );
    expect(edited!.revision).toBe(2);
    const opened = (await store.open(ada, saved.id, ['item', 'secret']))!;
    expect(opened.item!.username).toBe('ada.l');
    expect(opened.secret!.password).toBe(`${PASSWORD}-2`);
    // The edit deleted the secrets it replaced, in the same statement.
    const ids = await owned(ada);
    expect(ids).not.toContain(before.item_secret_id);
    expect(ids).not.toContain(before.secret_secret_id);
    expect(ids).toHaveLength(2);
    expect(await vaultSecretsOf(ada)).toBe(2);

    expect(await store.remove(ada, saved.id)).toBe(true);
    expect(await row(saved.id)).toBeNull();
    expect(await owned(ada)).toEqual([]);
    expect(await vaultSecretsOf(ada)).toBe(0);
  });

  it('refuses an edit from an old revision, and two edits from one revision land once', async () => {
    const saved = await store.create(ada, item, secret);
    const results = await Promise.all(
      [1, 2].map((n) =>
        store.replace(ada, saved.id, 1, item, { password: `${PASSWORD}-${n}`, authenticator: null })
      )
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await store.replace(ada, saved.id, 1, item, secret)).toBeNull();
    // The losing edit's secrets were deleted again: only the row's two remain.
    expect(await owned(ada)).toHaveLength(2);
    expect(await vaultSecretsOf(ada)).toBe(2);
    await store.remove(ada, saved.id);
  });

  it('reads and lists while the login is being edited see one version or the other, never a gap', async () => {
    // Each edit deletes the secrets the login pointed at. A read that took
    // the row in one statement and its secrets in another could land in
    // between and find them gone (PR #782 review, P2).
    const saved = await store.create(ada, item, { password: `${PASSWORD}-0`, authenticator: null });
    const seen = new Set<string>();
    for (let revision = 1; revision <= 12; revision++) {
      const [edited, ...reads] = await Promise.all([
        store.replace(ada, saved.id, revision, item, {
          password: `${PASSWORD}-${revision}`,
          authenticator: null,
        }),
        store.open(ada, saved.id, ['item', 'secret']),
        store.open(ada, saved.id, ['secret']),
        store.list(ada),
        store.open(ada, saved.id, ['secret']),
      ]);
      expect(edited?.revision).toBe(revision + 1);
      for (const read of reads) {
        if (Array.isArray(read)) {
          expect(read.map((l) => l.item)).toEqual([item]);
        } else {
          expect([`${PASSWORD}-${revision - 1}`, `${PASSWORD}-${revision}`]).toContain(
            read!.secret!.password
          );
          seen.add(read!.secret!.password!);
        }
      }
    }
    expect(seen.size).toBeGreaterThan(1);
    expect(await owned(ada)).toHaveLength(2);
    await store.remove(ada, saved.id);
  });

  it('keeps every value encrypted at rest', async () => {
    const saved = await store.create(ada, item, { password: PASSWORD, authenticator: null });
    const client = await pg();
    try {
      const { rows } = await client.query(
        'SELECT secret FROM vault.secrets WHERE description = $1',
        [`saved_login:${ada}`]
      );
      expect(rows).toHaveLength(2);
      for (const { secret: stored } of rows as Array<{ secret: string }>) {
        expect(stored).not.toContain(PASSWORD);
        expect(Buffer.from(stored, 'base64').toString('latin1')).not.toContain(PASSWORD);
        expect(stored).not.toContain('Example Mail');
      }
      // The view the server reads decrypts them.
      expect((await store.open(ada, saved.id, ['secret']))!.secret!.password).toBe(PASSWORD);
    } finally {
      await client.end();
      await store.remove(ada, saved.id);
    }
  });

  it('never writes a value in the clear, not even to a row version it replaces', async () => {
    // Inside one transaction, rolled back: a row version this transaction
    // replaced can't be pruned before the pages are read.
    const admin = await pg('supabase_admin');
    const value = `FAKE-PW-${RUN}-heap`;
    const control = `FAKE-PW-${RUN}-control`;
    const pages = async (text: string): Promise<number> => {
      const { rows } = await admin.query(
        `SELECT count(*)::int AS n
           FROM generate_series(0, pg_relation_size('vault.secrets') / current_setting('block_size')::int - 1) AS page,
                LATERAL heap_page_items(get_raw_page('vault.secrets', page::int)) AS item
          WHERE position(convert_to($1, 'utf8') IN item.t_data) > 0`,
        [text]
      );
      return (rows[0] as { n: number }).n;
    };
    try {
      await admin.query('BEGIN');
      await admin.query('CREATE EXTENSION IF NOT EXISTS pageinspect');
      await admin.query('SET LOCAL ROLE service_role');
      await admin.query('SELECT public.create_saved_login_secret($1, $2)', [ada, value]);
      await admin.query('RESET ROLE');
      // The control: Vault's own create_secret, which writes its argument
      // before encrypting it, is found by the same search.
      await admin.query('SELECT vault.create_secret($1)', [control]);
      expect(await pages(control)).toBeGreaterThan(0);
      expect(await pages(value)).toBe(0);
    } finally {
      await admin.query('ROLLBACK');
      await admin.end();
    }
  });

  it('listing decrypts only what may be listed', async () => {
    const client = await pg();
    const decrypts = async (columns: string) => {
      const { rows } = await client.query(
        `EXPLAIN (VERBOSE, COSTS OFF) SELECT ${columns} FROM public.saved_logins_opened WHERE user_id = $1`,
        [ada]
      );
      const plan = (rows as Array<{ 'QUERY PLAN': string }>).map((r) => r['QUERY PLAN']).join('\n');
      return plan.split('_crypto_aead_det_decrypt').length - 1;
    };
    try {
      expect(await decrypts('id, revision, item_value')).toBe(1);
      expect(await decrypts('id, item_value, secret_value')).toBe(2);
      expect(await decrypts('id, revision')).toBe(0);
    } finally {
      await client.end();
    }
  });

  it('a row can’t point at a missing secret, and a secret a row points at can’t be deleted', async () => {
    const saved = await store.create(ada, item, secret);
    const kept = (await row(saved.id))!;
    const { error: deleteError } = await db
      .from('saved_login_secrets')
      .delete()
      .eq('secret_id', kept.secret_secret_id)
      .eq('user_id', ada);
    expect(deleteError?.code).toBe('23503');
    expect((await store.open(ada, saved.id, ['secret']))!.secret).toEqual(secret);
    const { error: insertError } = await db.from('saved_logins').insert({
      id: randomUUID(),
      user_id: ada,
      item_secret_id: randomUUID(),
      secret_secret_id: randomUUID(),
    });
    expect(insertError?.code).toBe('23503');
    await store.remove(ada, saved.id);
  });

  it('refuses a secret that belongs to another login, even the same person’s', async () => {
    const first = await store.create(ada, item, secret);
    const second = await store.create(ada, { ...item, name: 'Other' }, secret);
    const other = (await row(second.id))!;
    // Point the first login's secret half at the second login's item half.
    const { error } = await db
      .from('saved_logins')
      .update({ secret_secret_id: other.item_secret_id })
      .eq('id', first.id);
    expect(error).toBeNull();
    await expect(store.open(ada, first.id, ['secret'])).rejects.toThrow(
      'A saved-login secret belongs to another login'
    );
    // Both rows now point at one secret, so neither can go alone: deleting
    // one would delete what the other points at, and the foreign key refuses.
    await expect(store.remove(ada, first.id)).rejects.toThrow();
    const { error: bothError } = await db
      .from('saved_logins')
      .delete()
      .in('id', [first.id, second.id]);
    expect(bothError).toBeNull();
    expect(await owned(ada)).toEqual([]);
    expect(await vaultSecretsOf(ada)).toBe(0);
  });

  it('a person’s logins and every secret they own go with them', async () => {
    const gone = await person('gone');
    await store.create(gone, item, secret);
    await store.create(gone, { ...item, name: 'Second' }, secret);
    // A leftover: a secret made for a write that never landed.
    const { error: rpcError } = await db.rpc('create_saved_login_secret', {
      p_owner: gone,
      p_value: `FAKE-PW-${RUN}-leftover`,
    });
    expect(rpcError).toBeNull();
    expect(await owned(gone)).toHaveLength(5);
    expect(await vaultSecretsOf(gone)).toBe(5);

    const { error } = await db.from('users').delete().eq('id', gone);
    expect(error).toBeNull();
    const { data: rows } = await db.from('saved_logins').select('id').eq('user_id', gone);
    expect(rows).toEqual([]);
    expect(await owned(gone)).toEqual([]);
    expect(await vaultSecretsOf(gone)).toBe(0);
  });

  it('deleteAllSavedLogins removes them, leftovers included, and keeps the person', async () => {
    const kept = await person('kept');
    await store.create(kept, item, secret);
    await db.rpc('create_saved_login_secret', { p_owner: kept, p_value: `FAKE-PW-${RUN}-left` });
    await deleteAllSavedLogins(db, kept);
    expect(await owned(kept)).toEqual([]);
    expect(await vaultSecretsOf(kept)).toBe(0);
    const { data } = await db.from('users').select('id').eq('id', kept);
    expect(data).toHaveLength(1);
    await db.from('users').delete().eq('id', kept);
  });

  describe('a write racing the person’s deletion (PR #782 review)', () => {
    it('no secret can be made for a person already deleted', async () => {
      const late = await person('late');
      await db.from('users').delete().eq('id', late);
      const { error } = await db.rpc('create_saved_login_secret', {
        p_owner: late,
        p_value: `FAKE-PW-${RUN}-late`,
      });
      expect(error?.code).toBe('23503');
      expect(await vaultSecretsOf(late)).toBe(0);
    });

    it('a secret made while the person is being deleted goes with them', async () => {
      const racing = await person('racing');
      const writer = await pg();
      const deleter = await pg();
      try {
        await writer.query('BEGIN');
        await writer.query('SET LOCAL ROLE service_role');
        await writer.query('SELECT public.create_saved_login_secret($1, $2)', [
          racing,
          `FAKE-PW-${RUN}-racing`,
        ]);
        // The deletion starts while the write is still open, and waits for it.
        let deleted = false;
        const deletion = deleter
          .query('DELETE FROM public.users WHERE id = $1', [racing])
          .then(() => {
            deleted = true;
          });
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(deleted).toBe(false);
        await writer.query('COMMIT');
        await deletion;
        expect(deleted).toBe(true);
        expect(await owned(racing)).toEqual([]);
        expect(await vaultSecretsOf(racing)).toBe(0);
      } finally {
        await writer.end();
        await deleter.end();
      }
    });

    it('a login whose person is deleted between its two secrets leaves nothing', async () => {
      const between = await person('between');
      let calls = 0;
      const racingDb = new Proxy(db, {
        get(target, key, receiver) {
          if (key !== 'rpc') return Reflect.get(target, key, receiver);
          return async (...args: Parameters<Client['rpc']>) => {
            calls += 1;
            const answer = await target.rpc(...args);
            // After the first half lands, the person is deleted.
            if (calls === 1) await target.from('users').delete().eq('id', between);
            return answer;
          };
        },
      }) as Client;
      const racingStore = savedLoginStore(async () => racingDb, {
        SAVED_LOGINS_STORE: 'supabase-vault',
      })!;
      await expect(racingStore.create(between, item, secret)).rejects.toThrow();
      expect(calls).toBe(2);
      expect(await owned(between)).toEqual([]);
      expect(await vaultSecretsOf(between)).toBe(0);
    });
  });

  it('nothing reaches the anon role: not the tables, the view or the function', async () => {
    const anon = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const saved = await store.create(ada, item, secret);
    const answers = [
      await anon.from('saved_logins').select('*'),
      await anon.from('saved_login_secrets').select('*'),
      await anon.from('saved_logins_opened').select('*'),
      await anon.rpc('create_saved_login_secret', { p_owner: ada, p_value: PASSWORD }),
    ];
    for (const answer of answers) {
      expect(answer.error).not.toBeNull();
      expect(JSON.stringify(answer)).not.toContain(PASSWORD);
    }
    const client = await pg();
    try {
      for (const role of ['anon', 'authenticated']) {
        for (const sql of [
          'SELECT count(*) FROM public.saved_logins',
          'SELECT count(*) FROM public.saved_login_secrets',
          'SELECT count(*) FROM public.saved_logins_opened',
          "SELECT public.create_saved_login_secret(gen_random_uuid(), 'x')",
        ]) {
          await client.query('BEGIN');
          await client.query(`SET LOCAL ROLE ${role}`);
          await expect(client.query(sql)).rejects.toThrow(/permission denied/);
          await client.query('ROLLBACK');
        }
      }
    } finally {
      await client.end();
      await store.remove(ada, saved.id);
    }
  });

  it('no decrypted value lands in any table', async () => {
    const saved = await store.create(sam, item, { password: PASSWORD, authenticator: null });
    await store.replace(sam, saved.id, 1, item, { password: PASSWORD, authenticator: null });
    await store.open(sam, saved.id, ['item', 'secret']);
    // As the superuser, so no table is skipped for want of a grant.
    const client = await pg('supabase_admin');
    try {
      const { rows: tables } = await client.query(
        `SELECT table_schema, table_name FROM information_schema.tables
          WHERE table_type = 'BASE TABLE'
            AND table_schema NOT IN ('pg_catalog', 'information_schema', 'pg_toast')`
      );
      const schemas = new Set(
        (tables as Array<{ table_schema: string }>).map((t) => t.table_schema)
      );
      for (const schema of ['public', 'vault', 'auth', 'storage'])
        expect(schemas).toContain(schema);
      const found: string[] = [];
      for (const { table_schema: schema, table_name: name } of tables as Array<{
        table_schema: string;
        table_name: string;
      }>) {
        const { rows } = await client.query(
          `SELECT count(*)::int AS n FROM "${schema}"."${name}" AS t WHERE t::text LIKE $1`,
          [`%FAKE-PW-${RUN}%`]
        );
        if ((rows[0] as { n: number }).n > 0) found.push(`${schema}.${name}`);
      }
      expect(found).toEqual([]);
    } finally {
      await client.end();
      await store.remove(sam, saved.id);
    }
  });
});
