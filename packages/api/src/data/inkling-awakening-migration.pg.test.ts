/**
 * The self-serve awakening migration, run for real against a THROWAWAY
 * Postgres (20261002082853_inkling_self_serve_awakening.sql).
 *
 * What only a database can prove: the two partial unique indexes hold when
 * two retries race (the second waits on the first's uncommitted index entry,
 * then fails), the loser's redemption rolls back as a whole (its token stays
 * redeemable, no lineage row is stranded), and the function change keeps
 * every existing caller's meaning.
 *
 * Opt-in, and only ever against a disposable server, the same contract as
 * scripts/db-migrate.integration.test.sh. It creates its own database on the
 * server named by INKLING_PG_TEST_ADMIN_URL, builds the minimal schema the
 * two migrations need, applies the kindle migration and this one verbatim
 * from the repository, and drops the database at the end. Nothing else is
 * consulted: no SUPABASE_URL, no .env.local. For example, with a private
 * Postgres 14 cluster:
 *
 *   initdb -D <scratch>/data -U postgres --auth=trust
 *   pg_ctl -D <scratch>/data -o "-p 55433 -c listen_addresses=127.0.0.1" start
 *   INKLING_PG_TEST_ADMIN_URL=postgresql://postgres@127.0.0.1:55433/postgres \
 *     npx vitest run src/data/inkling-awakening-migration.pg.test.ts
 *
 * Without the variable the suite is skipped, so CI passes it by.
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

import { CLIENT_MESSAGE_INDEX, isClientMessageConflict } from '../services/send-receipt';

const ADMIN_URL = process.env.INKLING_PG_TEST_ADMIN_URL;
const MIGRATIONS_DIR = path.resolve(__dirname, '../../../../supabase/migrations');
const KINDLE_MIGRATION = '20260824085843_kindle_tables_and_atomic_redeem.sql';
const AWAKENING_MIGRATION = '20261002082853_inkling_self_serve_awakening.sql';

/** The shared local stack's ports. This suite must never run there. */
const SHARED_STACK_PORTS = new Set(['54321', '54322']);
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * The disposable target, or a reason to refuse. Only an explicit loopback
 * URL with an explicit port that is not the shared stack's is accepted, and
 * its database is replaced outright by the one this run creates.
 */
function disposableTarget(adminUrl: string): { admin: URL; port: string } {
  const admin = new URL(adminUrl);
  if (admin.protocol !== 'postgresql:' && admin.protocol !== 'postgres:') {
    throw new Error('INKLING_PG_TEST_ADMIN_URL must be a postgresql:// URL');
  }
  if (!LOOPBACK.has(admin.hostname)) {
    throw new Error('INKLING_PG_TEST_ADMIN_URL must name a loopback host');
  }
  if (!admin.port || SHARED_STACK_PORTS.has(admin.port)) {
    throw new Error(
      'INKLING_PG_TEST_ADMIN_URL needs an explicit port that is not the shared stack'
    );
  }
  if (admin.search) {
    throw new Error('INKLING_PG_TEST_ADMIN_URL must not carry query parameters');
  }
  return { admin, port: admin.port };
}

/**
 * Just enough of the real schema for the two migrations: the tables and
 * unique indexes they reference, the auth.jwt() their policies call, the
 * canonical updated_at trigger, and the roles the REVOKE and GRANT name.
 */
const MINIMAL_SCHEMA = `
CREATE EXTENSION IF NOT EXISTS pgcrypto;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
END $$;
CREATE SCHEMA auth;
CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT '{}'::jsonb $$;
CREATE FUNCTION public.update_updated_at_column() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

CREATE TABLE public.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text UNIQUE
);
CREATE TABLE public.workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id)
);
CREATE TABLE public.agent_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id),
  workspace_id uuid REFERENCES public.workspaces(id),
  agent_id text NOT NULL,
  name text NOT NULL,
  role text NOT NULL,
  description text,
  "values" jsonb DEFAULT '[]'::jsonb,
  metadata jsonb DEFAULT '{}'::jsonb,
  soul text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  CONSTRAINT agent_identities_user_workspace_agent_key UNIQUE (user_id, workspace_id, agent_id)
);
CREATE UNIQUE INDEX agent_identities_user_agent_null_workspace_key
  ON public.agent_identities (user_id, agent_id) WHERE workspace_id IS NULL;
CREATE UNIQUE INDEX agent_identities_workspace_agent_key
  ON public.agent_identities (workspace_id, agent_id) WHERE workspace_id IS NOT NULL;

CREATE TABLE public.inbox_threads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid()
);
CREATE TABLE public.inbox_thread_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id uuid NOT NULL REFERENCES public.inbox_threads(id),
  content text NOT NULL,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now()
);
`;

type Row = Record<string, unknown>;
type PgError = Error & { code?: string; constraint?: string };

describe.skipIf(!ADMIN_URL)('inkling self-serve awakening migration (throwaway Postgres)', () => {
  let admin: Client;
  let db: Client;
  let dbName: string;
  let dbUrl: string;
  let created = false;

  beforeAll(async () => {
    const target = disposableTarget(ADMIN_URL!);
    dbName = `inkling_awaken_test_${process.pid}_${randomBytes(4).toString('hex')}`;
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
    const where = await one<{ db: string; port: string }>(
      `SELECT current_database() AS db, current_setting('port') AS port`
    );
    expect(where).toEqual({ db: dbName, port: target.port });

    await inTransaction(db, MINIMAL_SCHEMA);
    await inTransaction(db, await readFile(path.join(MIGRATIONS_DIR, KINDLE_MIGRATION), 'utf8'));
    await inTransaction(db, await readFile(path.join(MIGRATIONS_DIR, AWAKENING_MIGRATION), 'utf8'));
  }, 60_000);

  afterAll(async () => {
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

  async function one<T = Row>(sql: string, params: unknown[] = [], client = db): Promise<T> {
    const { rows } = await client.query(sql, params);
    return rows[0] as T;
  }

  async function person(): Promise<{ userId: string; workspaceId: string }> {
    const user = await one<{ id: string }>(
      `INSERT INTO public.users (email) VALUES ($1) RETURNING id`,
      [`person-${randomUUID()}@inkling.test`]
    );
    const ws = await one<{ id: string }>(
      `INSERT INTO public.workspaces (user_id) VALUES ($1) RETURNING id`,
      [user.id]
    );
    return { userId: user.id, workspaceId: ws.id };
  }

  /** A parentless token the person minted for themselves, as the awaken route does. */
  async function ownToken(userId: string): Promise<string> {
    const row = await one<{ token: string }>(
      `INSERT INTO public.kindle_tokens (creator_user_id, creator_agent_id, value_seed)
       VALUES ($1, NULL, '{}'::jsonb) RETURNING token`,
      [userId]
    );
    return row.token;
  }

  function identity(awakenRequestId: string): Record<string, unknown> {
    return {
      name: 'Unnamed inkling',
      role: 'Inkling',
      soul: 'test soul',
      values: [],
      metadata: { prototype: true, client: 'inkling-mobile', awakenRequestId, named: false },
    };
  }

  /** The call PostgREST makes: named arguments, the method only when given. */
  const REDEEM_SELF_SERVE = `SELECT * FROM public.redeem_kindle_token(
      p_token => $1, p_new_user_id => $2, p_workspace_id => $3, p_identity => $4::jsonb,
      p_kindle_method => 'self_serve')`;
  const REDEEM_DEFAULT = `SELECT * FROM public.redeem_kindle_token(
      p_token => $1, p_new_user_id => $2, p_workspace_id => $3, p_identity => $4::jsonb)`;

  async function tokenStatus(token: string): Promise<string> {
    return (
      await one<{ status: string }>(`SELECT status FROM public.kindle_tokens WHERE token = $1`, [
        token,
      ])
    ).status;
  }

  async function countIdentities(userId: string, awakenRequestId: string): Promise<number> {
    const r = await one<{ n: string }>(
      `SELECT count(*) AS n FROM public.agent_identities
       WHERE user_id = $1 AND metadata->>'awakenRequestId' = $2`,
      [userId, awakenRequestId]
    );
    return Number(r.n);
  }

  async function countLineages(userId: string): Promise<number> {
    const r = await one<{ n: string }>(
      `SELECT count(*) AS n FROM public.kindle_lineage WHERE child_user_id = $1`,
      [userId]
    );
    return Number(r.n);
  }

  /** Resolves once `pid` is blocked on a lock, so a race is a race and not a sequence. */
  async function waitUntilBlocked(pid: number): Promise<void> {
    for (let i = 0; i < 200; i++) {
      const r = await one<{ wait_event_type: string | null }>(
        `SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1`,
        [pid],
        admin
      );
      if (r?.wait_event_type === 'Lock') return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`backend ${pid} never blocked on a lock`);
  }

  interface Racer {
    client: Client;
    /** Read before the race: a client's queries queue, so a blocked one can't be asked. */
    pid: number;
  }

  async function raceClients(): Promise<[Racer, Racer]> {
    const racers: Racer[] = [];
    for (let i = 0; i < 2; i++) {
      const client = new Client({ connectionString: dbUrl });
      await client.connect();
      const { pid } = await one<{ pid: number }>(`SELECT pg_backend_pid() AS pid`, [], client);
      racers.push({ client, pid });
    }
    return [racers[0], racers[1]];
  }

  describe('redeem_kindle_token', () => {
    it('a self-serve awakening is complete at creation, parentless, and not onboarding', async () => {
      const { userId, workspaceId } = await person();
      const requestId = randomUUID();
      const lineage = await one(REDEEM_SELF_SERVE, [
        await ownToken(userId),
        userId,
        workspaceId,
        JSON.stringify(identity(requestId)),
      ]);

      expect(lineage).toMatchObject({
        kindle_method: 'self_serve',
        onboarding_status: 'complete',
        parent_agent_id: null,
        parent_user_id: null,
        facilitator_user_id: userId,
        child_user_id: userId,
      });
      expect(lineage.completed_at).toBeInstanceOf(Date);

      const row = await one<{
        workspace_id: string;
        agent_id: string;
        name: string;
        metadata: Row;
      }>(
        `SELECT workspace_id, agent_id, name, metadata FROM public.agent_identities WHERE id = $1`,
        [lineage.child_sb_id]
      );
      expect(row.workspace_id).toBe(workspaceId);
      expect(row.agent_id).toBe(lineage.child_agent_id);
      expect(row.name).toBe('Unnamed inkling');
      expect(row.metadata).toEqual({
        prototype: true,
        client: 'inkling-mobile',
        awakenRequestId: requestId,
        named: false,
        kindleId: lineage.id,
        onboarding: false,
      });
    });

    it('a call without the method still means a referral, exactly as before', async () => {
      const { userId, workspaceId } = await person();
      const inviter = await person();
      const token = (
        await one<{ token: string }>(
          `INSERT INTO public.kindle_tokens (creator_user_id, creator_agent_id)
           VALUES ($1, 'myra') RETURNING token`,
          [inviter.userId]
        )
      ).token;
      const lineage = await one(REDEEM_DEFAULT, [
        token,
        userId,
        workspaceId,
        JSON.stringify({ name: 'New SB', metadata: {} }),
      ]);

      expect(lineage).toMatchObject({
        kindle_method: 'referral',
        onboarding_status: 'values_interview',
        completed_at: null,
        parent_agent_id: 'myra',
        parent_user_id: inviter.userId,
        facilitator_user_id: inviter.userId,
      });
      const row = await one<{ metadata: Row }>(
        `SELECT metadata FROM public.agent_identities WHERE id = $1`,
        [lineage.child_sb_id]
      );
      expect(row.metadata).toMatchObject({ onboarding: true, kindleId: lineage.id });
    });

    it("a self-serve awakening refuses someone else's invite, and leaves it redeemable", async () => {
      const { userId, workspaceId } = await person();
      const inviter = await person();
      const invite = (
        await one<{ token: string }>(
          `INSERT INTO public.kindle_tokens (creator_user_id, creator_agent_id)
           VALUES ($1, 'myra') RETURNING token`,
          [inviter.userId]
        )
      ).token;

      await expect(
        db.query(REDEEM_SELF_SERVE, [
          invite,
          userId,
          workspaceId,
          JSON.stringify(identity(randomUUID())),
        ])
      ).rejects.toThrow(/own parentless token/);
      expect(await tokenStatus(invite)).toBe('active');
      expect(await countLineages(userId)).toBe(0);
    });

    it('an unknown method is refused before the token is touched', async () => {
      const { userId, workspaceId } = await person();
      const token = await ownToken(userId);
      await expect(
        db.query(
          `SELECT * FROM public.redeem_kindle_token(p_token => $1, p_new_user_id => $2,
             p_workspace_id => $3, p_identity => '{}'::jsonb, p_kindle_method => 'organic')`,
          [token, userId, workspaceId]
        )
      ).rejects.toThrow(/unsupported kindle method/);
      expect(await tokenStatus(token)).toBe('active');
    });

    it('an explicit NULL method means referral, as an omitted one does', async () => {
      const { userId, workspaceId } = await person();
      const inviter = await person();
      const token = (
        await one<{ token: string }>(
          `INSERT INTO public.kindle_tokens (creator_user_id, creator_agent_id)
           VALUES ($1, 'myra') RETURNING token`,
          [inviter.userId]
        )
      ).token;
      const lineage = await one(
        `SELECT * FROM public.redeem_kindle_token(p_token => $1, p_new_user_id => $2,
           p_workspace_id => $3, p_identity => '{}'::jsonb, p_kindle_method => NULL)`,
        [token, userId, workspaceId]
      );
      expect(lineage).toMatchObject({
        kindle_method: 'referral',
        onboarding_status: 'values_interview',
      });
    });

    it('a second redemption for the same awakening request fails whole: no identity, no lineage, token intact', async () => {
      const { userId, workspaceId } = await person();
      const requestId = randomUUID();
      await db.query(REDEEM_SELF_SERVE, [
        await ownToken(userId),
        userId,
        workspaceId,
        JSON.stringify(identity(requestId)),
      ]);

      const second = await ownToken(userId);
      const error = await db
        .query(REDEEM_SELF_SERVE, [
          second,
          userId,
          workspaceId,
          JSON.stringify(identity(requestId)),
        ])
        .then(
          () => null,
          (e: PgError) => e
        );
      expect(error?.code).toBe('23505');
      expect(error?.constraint).toBe('agent_identities_user_awaken_request_key');
      expect(await tokenStatus(second)).toBe('active');
      expect(await countIdentities(userId, requestId)).toBe(1);
      expect(await countLineages(userId)).toBe(1);
    });

    it('two racing redemptions of one awakening request: the second waits, then rolls back whole', async () => {
      const { userId, workspaceId } = await person();
      const requestId = randomUUID();
      const [first, second] = [await ownToken(userId), await ownToken(userId)];
      const [a, b] = await raceClients();
      try {
        await a.client.query('BEGIN');
        await b.client.query('BEGIN');
        await a.client.query(REDEEM_SELF_SERVE, [
          first,
          userId,
          workspaceId,
          JSON.stringify(identity(requestId)),
        ]);

        const pending = b.client
          .query(REDEEM_SELF_SERVE, [
            second,
            userId,
            workspaceId,
            JSON.stringify(identity(requestId)),
          ])
          .then(
            () => null,
            (e: PgError) => e
          );
        // B is genuinely concurrent: it is parked on A's uncommitted index entry.
        await waitUntilBlocked(b.pid);
        await a.client.query('COMMIT');

        const error = await pending;
        expect(error?.code).toBe('23505');
        expect(error?.constraint).toBe('agent_identities_user_awaken_request_key');
        await b.client.query('ROLLBACK');
      } finally {
        await a.client.end();
        await b.client.end();
      }

      expect(await countIdentities(userId, requestId)).toBe(1);
      expect(await countLineages(userId)).toBe(1);
      expect(await tokenStatus(first)).toBe('used');
      expect(await tokenStatus(second)).toBe('active');
    }, 20_000);

    it('the awakening request id is per person: two people may use the same one', async () => {
      const requestId = randomUUID();
      for (let i = 0; i < 2; i++) {
        const { userId, workspaceId } = await person();
        await db.query(REDEEM_SELF_SERVE, [
          await ownToken(userId),
          userId,
          workspaceId,
          JSON.stringify(identity(requestId)),
        ]);
        expect(await countIdentities(userId, requestId)).toBe(1);
      }
    });

    it('stays service-role only, with one signature', async () => {
      const signatures = await db.query(
        `SELECT pg_get_function_identity_arguments(p.oid) AS args
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'redeem_kindle_token'`
      );
      expect(signatures.rows).toEqual([
        {
          args: 'p_token text, p_new_user_id uuid, p_workspace_id uuid, p_identity jsonb, p_kindle_method text',
        },
      ]);
      const fn = 'public.redeem_kindle_token(text, uuid, uuid, jsonb, text)';
      const grants = await one<Record<string, boolean>>(
        `SELECT has_function_privilege('anon', $1, 'EXECUTE') AS anon,
                has_function_privilege('authenticated', $1, 'EXECUTE') AS authenticated,
                has_function_privilege('service_role', $1, 'EXECUTE') AS service_role`,
        [fn]
      );
      expect(grants).toEqual({ anon: false, authenticated: false, service_role: true });
    });
  });

  describe("the code's lookups can use the partial indexes", () => {
    /** The plan for `sql` with sequential scans priced out, so any usable index shows. */
    async function planFor(sql: string): Promise<string> {
      await db.query('BEGIN');
      try {
        await db.query('SET LOCAL enable_seqscan = off');
        const { rows } = await db.query(`EXPLAIN ${sql}`);
        return rows.map((r: Row) => String(r['QUERY PLAN'])).join('\n');
      } finally {
        await db.query('ROLLBACK');
      }
    }

    it('the awakening request lookup (InklingService.findByAwakenRequest)', async () => {
      const plan = await planFor(
        `SELECT id FROM public.agent_identities
         WHERE user_id = '${randomUUID()}' AND metadata->>'awakenRequestId' = '${randomUUID()}'`
      );
      expect(plan).toContain('agent_identities_user_awaken_request_key');
    });

    it('the client message lookup (lookUpClientMessage)', async () => {
      const plan = await planFor(
        `SELECT id FROM public.inbox_thread_messages
         WHERE thread_id = '${randomUUID()}' AND metadata->>'clientMessageId' = '${randomUUID()}'`
      );
      expect(plan).toContain('inbox_thread_messages_thread_client_message_key');
    });
  });

  describe('inbox_thread_messages client message ids', () => {
    async function thread(): Promise<string> {
      return (
        await one<{ id: string }>(`INSERT INTO public.inbox_threads DEFAULT VALUES RETURNING id`)
      ).id;
    }
    const INSERT = `INSERT INTO public.inbox_thread_messages (thread_id, content, metadata)
                    VALUES ($1, $2, $3::jsonb) RETURNING id`;

    it('one message per client message id per thread; other threads and id-less messages are unaffected', async () => {
      const [t1, t2] = [await thread(), await thread()];
      const clientMessageId = randomUUID();
      const meta = JSON.stringify({ clientMessageId });

      await db.query(INSERT, [t1, 'hello', meta]);
      const error = await db.query(INSERT, [t1, 'hello', meta]).then(
        () => null,
        (e: PgError) => e
      );
      expect(error?.code).toBe('23505');
      expect(error?.constraint).toBe(CLIENT_MESSAGE_INDEX);
      // The routes recognise a lost race by this wording, carried through
      // the send handler's "Failed to send thread message: <message>".
      expect(
        isClientMessageConflict(new Error(`Failed to send thread message: ${error?.message}`))
      ).toBe(true);

      await expect(db.query(INSERT, [t2, 'hello', meta])).resolves.toBeTruthy();
      await db.query(INSERT, [t1, 'no id', '{}']);
      await expect(db.query(INSERT, [t1, 'no id', '{}'])).resolves.toBeTruthy();
    });

    it('two racing stores of one client message id: the second waits, then fails', async () => {
      const t = await thread();
      const meta = JSON.stringify({ clientMessageId: randomUUID() });
      const [a, b] = await raceClients();
      try {
        await a.client.query('BEGIN');
        await b.client.query('BEGIN');
        await a.client.query(INSERT, [t, 'retry me', meta]);
        const pending = b.client.query(INSERT, [t, 'retry me', meta]).then(
          () => null,
          (e: PgError) => e
        );
        await waitUntilBlocked(b.pid);
        await a.client.query('COMMIT');
        const error = await pending;
        expect(error?.code).toBe('23505');
        expect(error?.constraint).toBe('inbox_thread_messages_thread_client_message_key');
        await b.client.query('ROLLBACK');
      } finally {
        await a.client.end();
        await b.client.end();
      }
      const n = await one<{ n: string }>(
        `SELECT count(*) AS n FROM public.inbox_thread_messages WHERE thread_id = $1`,
        [t]
      );
      expect(Number(n.n)).toBe(1);
    }, 20_000);
  });
});
