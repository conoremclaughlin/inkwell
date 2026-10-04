/**
 * The thread_message_reactions migration, run for real against a THROWAWAY
 * Postgres (20261004095944_thread_message_reactions.sql).
 *
 * What only a database can prove, with direct connections so the timing is
 * forced rather than hoped for: the guard trigger serialises one reactor's
 * writes on one message (a second insert waits on the first's lock, then
 * counts its row), and only that reactor's; the limit, the unique index,
 * the thread/workspace check, the composite keys, the checks and the cascade
 * hold for any writer, not just the API.
 *
 * Opt-in, and only ever against a disposable server, the same contract as
 * inkling-awakening-migration.pg.test.ts. It creates its own database on the
 * server named by REACTIONS_PG_TEST_ADMIN_URL, builds the minimal schema the
 * migration needs, applies the migration verbatim from the repository, and
 * drops the database at the end. Nothing else is consulted: no SUPABASE_URL,
 * no .env.local. For example, with a private Postgres 14 cluster:
 *
 *   initdb -D <scratch>/data -U postgres --auth=trust
 *   pg_ctl -D <scratch>/data -o "-p 55433 -c listen_addresses=127.0.0.1" start
 *   REACTIONS_PG_TEST_ADMIN_URL=postgresql://postgres@127.0.0.1:55433/postgres \
 *     npx vitest run src/data/thread-message-reactions-migration.pg.test.ts
 *
 * Without the variable the suite is skipped, so CI passes it by. The same
 * behaviour through PostgREST and the service is covered against the
 * integration stack in thread-reactions.integration.test.ts.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { Client } from 'pg';

// The real logger loads .env.local into the process. Nothing here may see
// the shared stack's settings, even unused.
vi.mock('../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const ADMIN_URL = process.env.REACTIONS_PG_TEST_ADMIN_URL;
const MIGRATION = path.resolve(
  __dirname,
  '../../../../supabase/migrations/20261004095944_thread_message_reactions.sql'
);
const LIMIT_TOKEN = 'reaction_limit_reached';
const SIX = ['❤️', '👍', '😂', '😮', '😢', '🙏'];

/** The shared local stacks' ports. This suite must never run there. */
const SHARED_PORTS = new Set(['54321', '54322', '55421', '55422']);
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

function disposableTarget(adminUrl: string): { admin: URL; port: string } {
  const admin = new URL(adminUrl);
  if (admin.protocol !== 'postgresql:' && admin.protocol !== 'postgres:') {
    throw new Error('REACTIONS_PG_TEST_ADMIN_URL must be a postgresql:// URL');
  }
  if (!LOOPBACK.has(admin.hostname)) {
    throw new Error('REACTIONS_PG_TEST_ADMIN_URL must name a loopback host');
  }
  if (!admin.port || SHARED_PORTS.has(admin.port)) {
    throw new Error(
      'REACTIONS_PG_TEST_ADMIN_URL needs an explicit port that is not a shared stack'
    );
  }
  if (admin.search) {
    throw new Error('REACTIONS_PG_TEST_ADMIN_URL must not carry query parameters');
  }
  return { admin, port: admin.port };
}

/** Just enough of the real schema for the migration's keys and trigger. */
const MINIMAL_SCHEMA = `
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE public.users (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
CREATE TABLE public.workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE
);
CREATE TABLE public.agent_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  workspace_id uuid REFERENCES public.workspaces(id) ON DELETE CASCADE,
  agent_id text NOT NULL,
  CONSTRAINT agent_identities_id_workspace_key UNIQUE (id, workspace_id)
);
CREATE TABLE public.inbox_threads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  thread_key text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT inbox_threads_id_workspace_key UNIQUE (id, workspace_id)
);
CREATE TABLE public.inbox_thread_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id uuid NOT NULL REFERENCES public.inbox_threads(id) ON DELETE CASCADE,
  content text NOT NULL,
  created_at timestamptz DEFAULT now()
);
`;

type PgError = Error & { code?: string };

describe.skipIf(!ADMIN_URL)('thread_message_reactions migration (throwaway Postgres)', () => {
  let admin: Client;
  let db: Client;
  let dbName: string;
  let dbUrl: string;
  let created = false;
  const extra: Client[] = [];

  beforeAll(async () => {
    const target = disposableTarget(ADMIN_URL!);
    dbName = `reactions_test_${process.pid}_${randomBytes(4).toString('hex')}`;
    admin = new Client({ connectionString: target.admin.toString() });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${dbName}"`);
    created = true;

    const url = new URL(target.admin.toString());
    url.pathname = `/${dbName}`;
    dbUrl = url.toString();
    db = new Client({ connectionString: dbUrl });
    await db.connect();

    // Prove the connection before any DDL: the database this run created, on
    // the port it was given. Nothing below runs anywhere else.
    const { rows } = await db.query(
      `SELECT current_database() AS db, current_setting('port') AS port`
    );
    expect(rows[0]).toEqual({ db: dbName, port: target.port });

    await inTransaction(db, MINIMAL_SCHEMA);
    await inTransaction(db, await readFile(MIGRATION, 'utf8'));
  }, 60_000);

  afterAll(async () => {
    for (const client of extra) await client.end().catch(() => {});
    await db?.end();
    // Only the database this run created is dropped.
    if (created) await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await admin?.end();
  });

  /** One migration file, applied the way db-migrate applies it: one transaction. */
  async function inTransaction(client: Client, sql: string): Promise<void> {
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }

  async function connection(): Promise<Client> {
    const client = new Client({ connectionString: dbUrl });
    await client.connect();
    extra.push(client);
    return client;
  }

  async function id(sql: string, params: unknown[] = []): Promise<string> {
    const { rows } = await db.query(sql, params);
    return rows[0].id as string;
  }

  interface World {
    workspaceId: string;
    threadId: string;
    messageId: string;
    sbId: string;
    otherSbId: string;
    userId: string;
  }

  /** A workspace with one thread and message, two SBs and a person. */
  async function world(): Promise<World> {
    const userId = await id(`INSERT INTO public.users DEFAULT VALUES RETURNING id`);
    const workspaceId = await id(
      `INSERT INTO public.workspaces (user_id) VALUES ($1) RETURNING id`,
      [userId]
    );
    const sb = () =>
      id(
        `INSERT INTO public.agent_identities (user_id, workspace_id, agent_id) VALUES ($1, $2, $3) RETURNING id`,
        [userId, workspaceId, `sb-${randomUUID()}`]
      );
    const threadId = await id(
      `INSERT INTO public.inbox_threads (workspace_id, thread_key) VALUES ($1, $2) RETURNING id`,
      [workspaceId, `thread:${randomUUID()}`]
    );
    const messageId = await message(threadId);
    return { workspaceId, threadId, messageId, sbId: await sb(), otherSbId: await sb(), userId };
  }

  function message(threadId: string): Promise<string> {
    return id(
      `INSERT INTO public.inbox_thread_messages (thread_id, content) VALUES ($1, 'react to me') RETURNING id`,
      [threadId]
    );
  }

  /** A reaction as any writer would insert it, with the message's thread and workspace. */
  function react(
    w: World,
    emoji: string,
    reactor: { sb?: string; user?: string } = { sb: w.sbId },
    client: Client = db,
    messageId = w.messageId
  ) {
    return client.query(
      `INSERT INTO public.thread_message_reactions
         (message_id, thread_id, workspace_id, reactor_sb_id, reactor_user_id, emoji)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [messageId, w.threadId, w.workspaceId, reactor.sb ?? null, reactor.user ?? null, emoji]
    );
  }

  async function refusal(promise: Promise<unknown>): Promise<{ code?: string; message: string }> {
    try {
      await promise;
    } catch (error) {
      return { code: (error as PgError).code, message: (error as Error).message };
    }
    throw new Error('expected the database to refuse the write');
  }

  async function count(messageId: string): Promise<number> {
    const { rows } = await db.query(
      `SELECT count(*)::int AS n FROM public.thread_message_reactions WHERE message_id = $1`,
      [messageId]
    );
    return rows[0].n as number;
  }

  /** Advisory locks some session is waiting for right now. */
  async function waitingOnAdvisoryLocks(observer: Client): Promise<number> {
    const { rows } = await observer.query(
      `SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`
    );
    return rows[0].n as number;
  }

  async function until(check: () => Promise<boolean>, ms = 3000): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (await check()) return true;
      await new Promise((r) => setTimeout(r, 25));
    }
    return false;
  }

  it('takes six emoji from one reactor and refuses a seventh with the limit token', async () => {
    const w = await world();
    for (const emoji of SIX) await react(w, emoji);
    const refused = await refusal(react(w, '🎉'));
    expect(refused.code).toBe('23514');
    expect(refused.message).toContain(LIMIT_TOKEN);
    expect(await count(w.messageId)).toBe(6);
  });

  it('refuses a re-add at six through the unique index, not the limit', async () => {
    const w = await world();
    for (const emoji of SIX) await react(w, emoji);
    const refused = await refusal(react(w, '😂'));
    expect(refused.code).toBe('23505');
    expect(refused.message).not.toContain(LIMIT_TOKEN);
  });

  it('counts each reactor separately, a person and an SB alike', async () => {
    const w = await world();
    for (const emoji of SIX) await react(w, emoji);
    await react(w, '🎉', { sb: w.otherSbId });
    await react(w, '🎉', { user: w.userId });
    expect(await count(w.messageId)).toBe(8);
  });

  it('makes a second insert by the same reactor wait for the first, then count its row', async () => {
    const w = await world();
    for (const emoji of SIX.slice(0, 5)) await react(w, emoji);
    const first = await connection();
    const second = await connection();
    const observer = await connection();

    await first.query('BEGIN');
    await react(w, SIX[5], { sb: w.sbId }, first);
    const late = react(w, '🎉', { sb: w.sbId }, second).then(
      () => ({ landed: true as const }),
      (error: PgError) => ({ landed: false as const, code: error.code, message: error.message })
    );
    // The second insert is blocked on the first's advisory lock, not racing it.
    expect(await until(async () => (await waitingOnAdvisoryLocks(observer)) === 1)).toBe(true);
    await first.query('COMMIT');

    const outcome = await late;
    expect(outcome.landed).toBe(false);
    expect(outcome).toMatchObject({ code: '23514' });
    expect((outcome as { message: string }).message).toContain(LIMIT_TOKEN);
    expect(await count(w.messageId)).toBe(6);
  });

  it('does not make another reactor wait behind that lock', async () => {
    const w = await world();
    const first = await connection();
    await first.query('BEGIN');
    try {
      await react(w, '❤️', { sb: w.sbId }, first);
      const other = await connection();
      // Would hang (and time out) if the lock were keyed on the message alone.
      await other.query(`SET statement_timeout = '2s'`);
      await react(w, '❤️', { sb: w.otherSbId }, other);
    } finally {
      await first.query('COMMIT');
    }
    expect(await count(w.messageId)).toBe(2);
  });

  it('refuses a thread or workspace that is not its message’s', async () => {
    const w = await world();
    const elsewhere = await id(
      `INSERT INTO public.inbox_threads (workspace_id, thread_key) VALUES ($1, 'thread:elsewhere') RETURNING id`,
      [w.workspaceId]
    );
    const wrongThread = await refusal(
      db.query(
        `INSERT INTO public.thread_message_reactions (message_id, thread_id, workspace_id, reactor_sb_id, emoji)
         VALUES ($1, $2, $3, $4, '👍')`,
        [w.messageId, elsewhere, w.workspaceId, w.sbId]
      )
    );
    expect(wrongThread.code).toBe('23514');
    expect(await count(w.messageId)).toBe(0);
  });

  it('refuses an SB from another workspace, even with this message’s thread and workspace', async () => {
    const w = await world();
    const foreign = await world();
    const refused = await refusal(react(w, '👍', { sb: foreign.sbId }));
    expect(refused.code).toBe('23503');
    expect(await count(w.messageId)).toBe(0);
  });

  it('refuses a message that does not exist as a foreign key violation', async () => {
    const w = await world();
    const refused = await refusal(react(w, '👍', { sb: w.sbId }, db, randomUUID()));
    expect(refused.code).toBe('23503');
  });

  it.each([
    ['no reactor', () => ({}), '👍'],
    ['two reactors', (w: World) => ({ sb: w.sbId, user: w.userId }), '👍'],
    ['an empty emoji', (w: World) => ({ sb: w.sbId }), ''],
    ['a 17-character emoji', (w: World) => ({ sb: w.sbId }), 'x'.repeat(17)],
  ])('refuses %s', async (_label, reactorOf, emoji) => {
    const w = await world();
    const refused = await refusal(react(w, emoji, reactorOf(w)));
    expect(refused.code).toBe('23514');
    expect(await count(w.messageId)).toBe(0);
  });

  it('holds the limit on an update that moves a reaction onto a full message', async () => {
    const w = await world();
    const otherMessage = await message(w.threadId);
    for (const emoji of SIX) await react(w, emoji);
    await react(w, '🎉', { sb: w.sbId }, db, otherMessage);
    const refused = await refusal(
      db.query(`UPDATE public.thread_message_reactions SET message_id = $1 WHERE message_id = $2`, [
        w.messageId,
        otherMessage,
      ])
    );
    expect(refused.code).toBe('23514');
    expect(refused.message).toContain(LIMIT_TOKEN);
  });

  it('deletes a message’s reactions with the message, and a thread’s with the thread', async () => {
    const w = await world();
    const keep = await message(w.threadId);
    await react(w, '👍');
    await react(w, '👍', { sb: w.sbId }, db, keep);
    await db.query(`DELETE FROM public.inbox_thread_messages WHERE id = $1`, [w.messageId]);
    expect(await count(w.messageId)).toBe(0);
    expect(await count(keep)).toBe(1);
    await db.query(`DELETE FROM public.inbox_threads WHERE id = $1`, [w.threadId]);
    expect(await count(keep)).toBe(0);
  });

  it('leaves the thread row alone: a reaction moves no recency', async () => {
    const w = await world();
    const before = await db.query(`SELECT updated_at FROM public.inbox_threads WHERE id = $1`, [
      w.threadId,
    ]);
    await react(w, '👍');
    const after = await db.query(`SELECT updated_at FROM public.inbox_threads WHERE id = $1`, [
      w.threadId,
    ]);
    expect(after.rows[0].updated_at).toEqual(before.rows[0].updated_at);
  });

  it('is server-only: row level security on, and no policy', async () => {
    const { rows } = await db.query(
      `SELECT c.relrowsecurity AS rls,
              (SELECT count(*)::int FROM pg_policies p WHERE p.tablename = c.relname) AS policies
         FROM pg_class c WHERE c.oid = 'public.thread_message_reactions'::regclass`
    );
    expect(rows[0]).toEqual({ rls: true, policies: 0 });
  });
});
