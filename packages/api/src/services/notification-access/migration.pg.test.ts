/**
 * Opt-in native PostgreSQL fixture, not Supabase or the application database.
 * The launcher supplies NOTIFICATION_PG_TEST_ROOT containing data/, socket/,
 * and a fixture marker. Before any write, the test verifies the connected
 * server's data_directory is that fixture. The migration is applied verbatim
 * over a minimal dependency schema: this is not a full-stack migration test.
 * No child processes are spawned here and no ambient DB settings are read.
 */
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { Client } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const ROOT = process.env.NOTIFICATION_PG_TEST_ROOT;
const DATABASE = 'notification_access_fixture';
const MIGRATION = path.resolve(
  __dirname,
  '../../../../../supabase/migrations/20261016082259_notification_access.sql'
);
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const BASE = `
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE TABLE public.users (id uuid PRIMARY KEY);
CREATE TABLE public.workspaces (id uuid PRIMARY KEY);
CREATE TABLE public.agent_identities (id uuid PRIMARY KEY, user_id uuid, workspace_id uuid);
CREATE TABLE public.inbox_threads (id uuid PRIMARY KEY, workspace_id uuid, metadata jsonb);
CREATE TABLE public.mcp_tokens (id uuid PRIMARY KEY, user_id uuid, client_id text, expires_at timestamptz);
CREATE FUNCTION public.update_updated_at_column() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;
INSERT INTO public.users VALUES ('${id(1)}'), ('${id(9)}');
INSERT INTO public.workspaces VALUES ('${id(2)}');
INSERT INTO public.agent_identities VALUES ('${id(3)}', '${id(1)}', '${id(2)}');
INSERT INTO public.inbox_threads VALUES ('${id(4)}', '${id(2)}', '{"inklingConversation":true}');
-- Model the existing server writer's owner/token access: these row locks
-- require UPDATE and SELECT. This fixture is not the deployed ACL baseline.
GRANT SELECT, UPDATE ON public.mcp_tokens, public.users TO service_role;
GRANT SELECT ON public.agent_identities, public.inbox_threads TO service_role;
`;

describe.skipIf(!ROOT)('notification migration (verified disposable PostgreSQL)', () => {
  let root: string;
  let admin: Client;
  let db: Client;
  let created = false;
  const clients: Client[] = [];
  const backendIds = new WeakMap<Client, number>();
  const connect = async (database: string): Promise<Client> => {
    const client = new Client({
      host: path.join(root, 'socket'),
      port: 55443,
      user: 'postgres',
      password: 'synthetic-unused',
      database,
      connectionTimeoutMillis: 2000,
    });
    await client.connect();
    const { rows } = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    backendIds.set(client, rows[0].pid);
    return client;
  };
  const second = async (): Promise<Client> => {
    const client = await connect(DATABASE);
    clients.push(client);
    return client;
  };

  beforeAll(async () => {
    root = await realpath(ROOT!);
    if (!path.basename(root).startsWith('notification-access-pg.'))
      throw new Error('Not a notification fixture directory');
    const info = await stat(root);
    if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)
      throw new Error('Fixture must be an owner-private directory');
    if (
      (await readFile(path.join(root, 'fixture-marker'), 'utf8')).trim() !==
      'notification-access-disposable'
    )
      throw new Error('Missing fixture marker');
    admin = await connect('postgres');
    const proof = await admin.query<{ data: string; listeners: string }>(
      "SELECT current_setting('data_directory') AS data, current_setting('listen_addresses') AS listeners"
    );
    if (
      (await realpath(proof.rows[0].data)) !== (await realpath(path.join(root, 'data'))) ||
      proof.rows[0].listeners !== ''
    )
      throw new Error('Not the isolated socket-only fixture server');
    await admin.query(`CREATE DATABASE ${DATABASE}`);
    created = true;
    db = await connect(DATABASE);
    await db.query(BASE);
    await db.query('BEGIN');
    try {
      await db.query(await readFile(MIGRATION, 'utf8'));
      await db.query('COMMIT');
    } catch (error) {
      await db.query('ROLLBACK');
      throw error;
    }
  });
  afterAll(async () => {
    await Promise.all(clients.map((client) => client.end()));
    await db?.end();
    if (created) await admin.query(`DROP DATABASE ${DATABASE}`);
    await admin?.end();
  });
  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.end()));
  });
  beforeEach(async () => {
    await db.query('TRUNCATE public.sb_notification_watchers CASCADE');
    await db.query('DELETE FROM public.mcp_tokens');
    await db.query(
      "INSERT INTO public.mcp_tokens VALUES ($1, $2, 'mobile', clock_timestamp() + interval '1 day')",
      [id(5), id(1)]
    );
    await createWatcher();
  });

  const WATCHER_INSERT = `INSERT INTO public.sb_notification_watchers
      (id, owner_id, workspace_id, recipient_id, thread_id, signin_id, installation_id, selected_packages, device_time_ms, token_digest, expires_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, ARRAY['com.example.messages'], floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint + $9::bigint, $8, clock_timestamp() + interval '2 days') RETURNING *`;
  async function createWatcher(
    owner = id(1),
    sequence = 7,
    signin = id(5),
    connection = db,
    deviceSkew = 0
  ) {
    return connection.query(WATCHER_INSERT, [
      id(sequence),
      owner,
      id(2),
      id(3),
      id(4),
      signin,
      id(sequence + 1000),
      sequence.toString(16).padStart(64, '0'),
      deviceSkew,
    ]);
  }

  const INSERT = `INSERT INTO public.sb_notification_events
    (watcher_id, event_id, package_name, title, text, device_posted_at_ms, fingerprint)
    VALUES ($1, $2, $3, 'Demo', 'Synthetic preview', $4::bigint, $5) RETURNING *`;
  const RULE_INSERT = `INSERT INTO public.sb_notification_rule_versions (watcher_id, actor_id, rules)
    VALUES ($1, $2, $3::jsonb) RETURNING revision, rules`;
  const RULES = JSON.stringify([{ packageName: 'com.example.messages', match: { kind: 'all' } }]);
  async function eventArgs(eventId = id(8)) {
    const { rows } = await db.query<{ at: string }>(
      'SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint - clock_offset_ms AS at FROM sb_notification_watchers WHERE id = $1',
      [id(7)]
    );
    return [id(7), eventId, 'com.example.messages', rows[0].at, 'b'.repeat(64)];
  }
  async function assertWaiting(client: Client, query = INSERT) {
    // A real lock wait, not a timer assumed to mean the other transaction ran.
    await vi.waitFor(
      async () => {
        const result = await admin.query(
          'SELECT wait_event_type FROM pg_stat_activity WHERE datname = $1 AND pid = $2 AND query = $3',
          [DATABASE, backendIds.get(client), query]
        );
        expect(result.rows.some((row) => row.wait_event_type === 'Lock')).toBe(true);
      },
      { timeout: 2000, interval: 20 }
    );
  }

  it('keeps grants and events closed to client roles', async () => {
    const result =
      await db.query(`SELECT r, t, has_table_privilege(r, t, 'SELECT,INSERT,UPDATE,DELETE') AS allowed
      FROM unnest(ARRAY['anon','authenticated']) r, unnest(ARRAY['sb_notification_watchers','sb_notification_events','sb_notification_rule_versions']) t`);
    expect(result.rows.every((row) => row.allowed === false)).toBe(true);
    const role = await db.query(
      "SELECT has_table_privilege('service_role','sb_notification_events','INSERT') AS allowed"
    );
    expect(role.rows[0].allowed).toBe(true);
  });

  it('caps a grant at sign-in expiry and refuses cross-owner binding', async () => {
    const times = await db.query(
      'SELECT w.expires_at = t.expires_at AS same FROM sb_notification_watchers w JOIN mcp_tokens t ON t.id = w.signin_id'
    );
    expect(times.rows[0].same).toBe(true);
    await db.query('DELETE FROM sb_notification_watchers');
    await expect(createWatcher(id(9))).rejects.toMatchObject({ code: 'NPA02' });
  });

  it('executes intake under the service role while refusing an authenticated client', async () => {
    const args = await eventArgs();
    await db.query('SET ROLE authenticated');
    try {
      await expect(db.query('SELECT * FROM sb_notification_events')).rejects.toMatchObject({
        code: '42501',
      });
      await expect(db.query(INSERT, args)).rejects.toMatchObject({ code: '42501' });
    } finally {
      await db.query('RESET ROLE');
    }
    await db.query('SET ROLE service_role');
    try {
      expect((await db.query(INSERT, args)).rowCount).toBe(1);
      expect((await createWatcher(id(1), 20)).rowCount).toBe(1);
      expect((await db.query(RULE_INSERT, [id(7), id(1), RULES])).rows[0].revision).toBe(1);
      await expect(
        db.query("UPDATE sb_notification_rule_versions SET rules = '[]'")
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await db.query('RESET ROLE');
    }
  });

  it('never mutates selection or reactivates revoked consent', async () => {
    await expect(
      db.query('UPDATE sb_notification_watchers SET clock_offset_ms = clock_offset_ms + 1')
    ).rejects.toMatchObject({ code: 'NPA01' });
    await expect(
      db.query('UPDATE sb_notification_watchers SET device_time_ms = device_time_ms + 1')
    ).rejects.toMatchObject({ code: 'NPA01' });
    await expect(
      db.query("UPDATE sb_notification_watchers SET selected_packages = ARRAY['com.example.other']")
    ).rejects.toMatchObject({ code: 'NPA01' });
    await db.query("UPDATE sb_notification_watchers SET status = 'revoked'");
    await expect(
      db.query("UPDATE sb_notification_watchers SET status = 'active'")
    ).rejects.toMatchObject({ code: 'NPA01' });
  });

  it('bounds outstanding active grants and frees capacity on revoke', async () => {
    for (let sequence = 20; sequence < 29; sequence++) await createWatcher(id(1), sequence);
    await expect(createWatcher(id(1), 40)).rejects.toMatchObject({ code: 'NPA08' });
    await db.query("UPDATE sb_notification_watchers SET status = 'revoked' WHERE id = $1", [id(7)]);
    expect((await createWatcher(id(1), 40)).rowCount).toBe(1);
    expect(
      (await db.query("SELECT * FROM sb_notification_watchers WHERE status = 'active'")).rowCount
    ).toBe(10);
  });

  it('serializes grant capacity across different sign-ins for the same owner', async () => {
    for (let sequence = 20; sequence < 28; sequence++) await createWatcher(id(1), sequence);
    await db.query(
      "INSERT INTO mcp_tokens VALUES ($1, $2, 'mobile', clock_timestamp() + interval '1 day')",
      [id(50), id(1)]
    );
    const writer = await second();
    await db.query('BEGIN');
    await createWatcher(id(1), 40);
    let settled = false;
    const pending = createWatcher(id(1), 41, id(50), writer).then(
      () => {
        settled = true;
        return { accepted: true };
      },
      (error: { code: string }) => {
        settled = true;
        return { code: error.code };
      }
    );
    try {
      // An old implementation can complete instead of waiting: let the
      // outcome assertion expose its extra grant, not a lock-wait timeout.
      await vi.waitFor(async () => {
        const state = await admin.query(
          'SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1 AND query = $2',
          [backendIds.get(writer), WATCHER_INSERT]
        );
        expect(settled || state.rows.some((row) => row.wait_event_type === 'Lock')).toBe(true);
      });
    } finally {
      await db.query('COMMIT');
    }
    expect(await pending).toEqual({ code: 'NPA08' });
    expect(
      (await db.query("SELECT * FROM sb_notification_watchers WHERE status = 'active'")).rowCount
    ).toBe(10);
  });

  it('sets retention from posting/receipt and ignores retry without charging again', async () => {
    const args = await eventArgs();
    const first = await db.query(INSERT, args);
    expect(first.rowCount).toBe(1);
    expect((await db.query(INSERT, args)).rowCount).toBe(0);
    const stats =
      await db.query(`SELECT w.minute_count, w.day_count, extract(epoch FROM e.expires_at - LEAST(e.posted_at,e.received_at)) AS seconds
      FROM sb_notification_watchers w JOIN sb_notification_events e ON e.watcher_id = w.id`);
    expect(stats.rows).toEqual([{ minute_count: 1, day_count: 1, seconds: '604800.000000' }]);
    await expect(db.query(INSERT, [...args.slice(0, 4), 'c'.repeat(64)])).rejects.toMatchObject({
      code: 'NPA06',
    });
  });

  it('refuses unselected apps, pre-consent content and future content', async () => {
    const args = await eventArgs();
    await expect(
      db.query(INSERT, [args[0], args[1], 'com.example.other', args[3], args[4]])
    ).rejects.toMatchObject({ code: 'NPA05' });
    await expect(
      db.query(INSERT, [args[0], args[1], args[2], Date.parse('2000-01-01T00:00:00Z'), args[4]])
    ).rejects.toMatchObject({ code: 'NPA05' });
    await expect(
      db.query(INSERT, [args[0], args[1], args[2], Date.parse('2100-01-01T00:00:00Z'), args[4]])
    ).rejects.toMatchObject({ code: 'NPA05' });
  });

  it.each(['minute_count', 'day_count'])(
    'enforces %s quota without storing an event',
    async (column) => {
      await db.query(`UPDATE sb_notification_watchers SET ${column} = $1`, [
        column === 'minute_count' ? 600 : 10000,
      ]);
      await expect(db.query(INSERT, await eventArgs())).rejects.toMatchObject({ code: 'NPA07' });
      expect((await db.query('SELECT * FROM sb_notification_events')).rowCount).toBe(0);
    }
  );

  it('serializes concurrent identical retries to one event and one quota charge', async () => {
    const writer = await second();
    const args = await eventArgs();
    await db.query('BEGIN');
    await db.query(INSERT, args);
    const pending = writer.query(INSERT, args).then(
      (result) => ({ count: result.rowCount }),
      (error: unknown) => ({ error })
    );
    try {
      await assertWaiting(writer);
    } finally {
      await db.query('COMMIT');
    }
    expect(await pending).toEqual({ count: 0 });
    expect(
      (await db.query('SELECT minute_count FROM sb_notification_watchers')).rows[0].minute_count
    ).toBe(1);
  });

  it.each(['revoke', 'logout'])(
    'does not insert after a concurrent %s commits',
    async (operation) => {
      const writer = await second();
      const args = await eventArgs();
      await db.query('BEGIN');
      await db.query(
        operation === 'revoke'
          ? "UPDATE sb_notification_watchers SET status = 'revoked'"
          : 'DELETE FROM mcp_tokens'
      );
      const pending = writer.query(INSERT, args).then(
        () => null,
        (error: unknown) => error
      );
      try {
        await assertWaiting(writer);
      } finally {
        await db.query('COMMIT');
      }
      expect(await pending).toMatchObject({ code: 'NPA02' });
      expect((await db.query('SELECT * FROM sb_notification_events')).rowCount).toBe(0);
    }
  );

  it.each(['watcher', 'signin'])(
    'deletes retained event bytes with %s deletion',
    async (target) => {
      await db.query(INSERT, await eventArgs());
      await db.query(RULE_INSERT, [id(7), id(1), RULES]);
      await db.query(
        target === 'watcher' ? 'DELETE FROM sb_notification_watchers' : 'DELETE FROM mcp_tokens'
      );
      expect((await db.query('SELECT * FROM sb_notification_watchers')).rowCount).toBe(0);
      expect((await db.query('SELECT * FROM sb_notification_events')).rowCount).toBe(0);
      expect((await db.query('SELECT * FROM sb_notification_rule_versions')).rowCount).toBe(0);
    }
  );

  it.each([-90_000, 90_000])(
    'calibrates device skew %s without extending retention or admitting old consent',
    async (skew) => {
      await db.query('DELETE FROM sb_notification_watchers');
      const grant = (await createWatcher(id(1), 7, id(5), db, skew)).rows[0];
      expect(Math.abs(Number(grant.clock_offset_ms) + skew)).toBeLessThan(20);
      const args = await eventArgs();
      const result = await db.query(INSERT, args);
      expect(result.rowCount).toBe(1);
      const retained = (
        await db.query(
          `SELECT extract(epoch FROM (expires_at - received_at)) <= 604800 AS bounded,
      extract(epoch FROM posted_at) * 1000 = device_posted_at_ms + $1::bigint AS calibrated
      FROM sb_notification_events`,
          [grant.clock_offset_ms]
        )
      ).rows[0];
      expect(retained).toEqual({ bounded: true, calibrated: true });
      await expect(
        db.query(INSERT, [id(7), id(80), args[2], Number(grant.device_time_ms) - 1, args[4]])
      ).rejects.toMatchObject({ code: 'NPA05' });
    }
  );

  it('keeps rules separate, logs every version and refuses unselected apps or a foreign actor', async () => {
    const before = (await db.query('SELECT * FROM sb_notification_watchers')).rows[0];
    expect((await db.query('SELECT * FROM sb_notification_rule_versions')).rowCount).toBe(0);
    expect((await db.query(RULE_INSERT, [id(7), id(1), RULES])).rows[0].revision).toBe(1);
    expect((await db.query(RULE_INSERT, [id(7), id(1), '[]'])).rows[0].revision).toBe(2);
    expect((await db.query('SELECT * FROM sb_notification_watchers')).rows[0]).toEqual(before);
    await expect(db.query(RULE_INSERT, [id(7), id(9), RULES])).rejects.toMatchObject({
      code: 'NPA02',
    });
    await expect(
      db.query(RULE_INSERT, [
        id(7),
        id(1),
        RULES.replace('com.example.messages', 'com.example.other'),
      ])
    ).rejects.toMatchObject({ code: 'NPA04' });
    expect(
      (await db.query('SELECT revision FROM sb_notification_rule_versions ORDER BY revision')).rows
    ).toEqual([{ revision: 1 }, { revision: 2 }]);
  });

  it('serializes simultaneous rule edits into distinct logged revisions', async () => {
    const writer = await second();
    await db.query('BEGIN');
    await db.query(RULE_INSERT, [id(7), id(1), RULES]);
    const pending = writer.query(RULE_INSERT, [id(7), id(1), '[]']).then(
      (result) => ({ revision: result.rows[0].revision }),
      (error: unknown) => ({ error })
    );
    try {
      await assertWaiting(writer, RULE_INSERT);
    } finally {
      await db.query('COMMIT');
    }
    expect(await pending).toEqual({ revision: 2 });
  });

  it('does not take an owner-row lock after the sign-in and grant for a rule edit', async () => {
    const deleter = await second();
    await db.query('BEGIN');
    await db.query(RULE_INSERT, [id(7), id(1), RULES]);
    try {
      // Account deletion must be able to acquire its first lock. A redundant
      // actor -> users FK would acquire KEY SHARE late and invert this order.
      expect(
        (await deleter.query('SELECT id FROM users WHERE id = $1 FOR UPDATE NOWAIT', [id(1)]))
          .rowCount
      ).toBe(1);
    } finally {
      await db.query('ROLLBACK');
    }
  });

  it.each(['revoke', 'logout'])('refuses a rule change after concurrent %s', async (operation) => {
    const writer = await second();
    await db.query('BEGIN');
    await db.query(
      operation === 'revoke'
        ? "UPDATE sb_notification_watchers SET status = 'revoked'"
        : 'DELETE FROM mcp_tokens'
    );
    const pending = writer.query(RULE_INSERT, [id(7), id(1), RULES]).then(
      () => null,
      (error: unknown) => error
    );
    try {
      await assertWaiting(writer, RULE_INSERT);
    } finally {
      await db.query('COMMIT');
    }
    expect(await pending).toMatchObject({ code: 'NPA02' });
    expect((await db.query('SELECT * FROM sb_notification_rule_versions')).rowCount).toBe(0);
  });
});
