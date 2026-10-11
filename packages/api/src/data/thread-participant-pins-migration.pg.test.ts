/**
 * The thread participant pins migration, run for real against a THROWAWAY
 * Postgres (20261010203603_thread_participant_pins.sql).
 *
 * What only a database can prove: the column is a nullable boolean with no
 * default, a person's row takes each of the three states, an SB's row
 * refuses a pin from any writer (not just the API), and the file applies
 * twice without error, as the README asks of a migration.
 *
 * Opt-in, and only ever against a disposable server, the same contract as
 * thread-message-reactions-migration.pg.test.ts. It creates its own database
 * on the server named by PINS_PG_TEST_ADMIN_URL, builds the minimal schema the
 * migration needs, applies the migration verbatim from the repository, and
 * drops the database at the end. Nothing else is consulted: no SUPABASE_URL,
 * no .env.local. For example, with a private Postgres cluster:
 *
 *   initdb -D <scratch>/data -U postgres --auth=trust
 *   pg_ctl -D <scratch>/data -o "-p 55433 -c listen_addresses=127.0.0.1" start
 *   PINS_PG_TEST_ADMIN_URL=postgresql://postgres@127.0.0.1:55433/postgres \
 *     npx vitest run src/data/thread-participant-pins-migration.pg.test.ts
 *
 * Without the variable the suite is skipped, so CI passes it by.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { Client } from 'pg';

// The real logger loads .env.local into the process. Nothing here may see
// the shared stack's settings, even unused.
vi.mock('../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const ADMIN_URL = process.env.PINS_PG_TEST_ADMIN_URL;
const MIGRATION = path.resolve(
  __dirname,
  '../../../../supabase/migrations/20261010203603_thread_participant_pins.sql'
);

/** The shared local stacks' ports. This suite must never run there. */
const SHARED_PORTS = new Set(['54321', '54322', '55421', '55422']);
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

function disposableTarget(adminUrl: string): { admin: URL; port: string } {
  const admin = new URL(adminUrl);
  if (admin.protocol !== 'postgresql:' && admin.protocol !== 'postgres:') {
    throw new Error('PINS_PG_TEST_ADMIN_URL must be a postgresql:// URL');
  }
  if (!LOOPBACK.has(admin.hostname)) {
    throw new Error('PINS_PG_TEST_ADMIN_URL must name a loopback host');
  }
  if (!admin.port || SHARED_PORTS.has(admin.port)) {
    throw new Error('PINS_PG_TEST_ADMIN_URL needs an explicit port that is not a shared stack');
  }
  if (admin.search) {
    throw new Error('PINS_PG_TEST_ADMIN_URL must not carry query parameters');
  }
  return { admin, port: admin.port };
}

/** Just enough of the real participant table for the migration. */
const MINIMAL_SCHEMA = `
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE public.inbox_threads (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
CREATE TABLE public.inbox_thread_participants (
  thread_id uuid NOT NULL REFERENCES public.inbox_threads(id) ON DELETE CASCADE,
  sb_id uuid,
  user_id uuid,
  CONSTRAINT inbox_thread_participants_principal CHECK ((sb_id IS NOT NULL) <> (user_id IS NOT NULL))
);
`;

type PgError = Error & { code?: string; constraint?: string };

describe.skipIf(!ADMIN_URL)('thread participant pins migration (throwaway Postgres)', () => {
  let admin: Client;
  let db: Client;
  let dbName: string;
  let created = false;
  let migration: string;

  /** One migration file, applied the way db-migrate applies it: one transaction. */
  async function inTransaction(sql: string): Promise<void> {
    await db.query('BEGIN');
    try {
      await db.query(sql);
      await db.query('COMMIT');
    } catch (error) {
      await db.query('ROLLBACK');
      throw error;
    }
  }

  beforeAll(async () => {
    const target = disposableTarget(ADMIN_URL!);
    dbName = `pins_test_${process.pid}_${randomBytes(4).toString('hex')}`;
    admin = new Client({ connectionString: target.admin.toString() });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${dbName}"`);
    created = true;

    const url = new URL(target.admin.toString());
    url.pathname = `/${dbName}`;
    db = new Client({ connectionString: url.toString() });
    await db.connect();

    // Prove the connection before any DDL: the database this run created, on
    // the port it was given. Nothing below runs anywhere else.
    const { rows } = await db.query(
      `SELECT current_database() AS db, current_setting('port') AS port`
    );
    expect(rows[0]).toEqual({ db: dbName, port: target.port });

    migration = await readFile(MIGRATION, 'utf8');
    await inTransaction(MINIMAL_SCHEMA);
    await inTransaction(migration);
  }, 60_000);

  afterAll(async () => {
    await db?.end();
    // Only the database this run created is dropped.
    if (created) await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await admin?.end();
  });

  async function newThread(): Promise<string> {
    const { rows } = await db.query(`INSERT INTO public.inbox_threads DEFAULT VALUES RETURNING id`);
    return rows[0].id as string;
  }

  it('adds a nullable boolean with no default, commented', async () => {
    const { rows } = await db.query(
      `SELECT data_type, is_nullable, column_default,
              col_description('public.inbox_thread_participants'::regclass, ordinal_position) AS comment
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'inbox_thread_participants'
          AND column_name = 'pinned'`
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      data_type: 'boolean',
      is_nullable: 'YES',
      column_default: null,
    });
    expect(rows[0].comment).toMatch(/NULL no choice yet/);
  });

  it("takes each of the three states on a person's row", async () => {
    const threadId = await newThread();
    const { rows } = await db.query(
      `INSERT INTO public.inbox_thread_participants (thread_id, user_id) VALUES ($1, gen_random_uuid())
       RETURNING user_id, pinned`,
      [threadId]
    );
    expect(rows[0].pinned).toBeNull();
    for (const pinned of [true, false, null]) {
      const updated = await db.query(
        `UPDATE public.inbox_thread_participants SET pinned = $3
          WHERE thread_id = $1 AND user_id = $2 RETURNING pinned`,
        [threadId, rows[0].user_id, pinned]
      );
      expect(updated.rows).toEqual([{ pinned }]);
    }
  });

  it("refuses a pin on an SB's row from any writer", async () => {
    const threadId = await newThread();
    await db.query(
      `INSERT INTO public.inbox_thread_participants (thread_id, sb_id) VALUES ($1, gen_random_uuid())`,
      [threadId]
    );
    for (const pinned of [true, false]) {
      const failure = await db
        .query(`UPDATE public.inbox_thread_participants SET pinned = $2 WHERE thread_id = $1`, [
          threadId,
          pinned,
        ])
        .then(
          () => null,
          (error: PgError) => error
        );
      expect(failure?.code).toBe('23514');
      expect(failure?.constraint).toBe('inbox_thread_participants_pinned_person_only');
    }
  });

  it('applies a second time without error, leaving one constraint', async () => {
    await inTransaction(migration);
    const { rows } = await db.query(
      `SELECT count(*)::int AS n FROM pg_constraint
        WHERE conrelid = 'public.inbox_thread_participants'::regclass
          AND conname = 'inbox_thread_participants_pinned_person_only'`
    );
    expect(rows[0].n).toBe(1);
  });
});
