/**
 * The calendar sharing migration, run for real against a THROWAWAY Postgres
 * (20261016075003_workspace_members_calendar_share.sql).
 *
 * What only a database can prove: every member, existing ones included,
 * starts at 'none'; the column takes 'none' and 'busy' and refuses anything
 * else from any writer, NULL included; and the file applies twice without
 * error, as the README asks of a migration.
 *
 * Opt-in, and only ever against a disposable server, the same contract as
 * thread-participant-pins-migration.pg.test.ts. It creates its own database on
 * the server named by CALENDAR_SHARE_PG_TEST_ADMIN_URL, builds the minimal
 * schema the migration needs, applies the migration verbatim from the
 * repository, and drops the database at the end. For example:
 *
 *   initdb -D <scratch>/data -U postgres --auth=trust
 *   pg_ctl -D <scratch>/data -o "-p 55433 -c listen_addresses=127.0.0.1" start
 *   CALENDAR_SHARE_PG_TEST_ADMIN_URL=postgresql://postgres@127.0.0.1:55433/postgres \
 *     npx vitest run src/data/workspace-members-calendar-share-migration.pg.test.ts
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

const ADMIN_URL = process.env.CALENDAR_SHARE_PG_TEST_ADMIN_URL;
const MIGRATION = path.resolve(
  __dirname,
  '../../../../supabase/migrations/20261016075003_workspace_members_calendar_share.sql'
);

/** The shared local stacks' ports. This suite must never run there. */
const SHARED_PORTS = new Set(['54321', '54322', '55421', '55422']);
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

function disposableTarget(adminUrl: string): { admin: URL; port: string } {
  const admin = new URL(adminUrl);
  if (admin.protocol !== 'postgresql:' && admin.protocol !== 'postgres:') {
    throw new Error('CALENDAR_SHARE_PG_TEST_ADMIN_URL must be a postgresql:// URL');
  }
  if (!LOOPBACK.has(admin.hostname)) {
    throw new Error('CALENDAR_SHARE_PG_TEST_ADMIN_URL must name a loopback host');
  }
  if (!admin.port || SHARED_PORTS.has(admin.port)) {
    throw new Error(
      'CALENDAR_SHARE_PG_TEST_ADMIN_URL needs an explicit port that is not a shared stack'
    );
  }
  if (admin.search) {
    throw new Error('CALENDAR_SHARE_PG_TEST_ADMIN_URL must not carry query parameters');
  }
  return { admin, port: admin.port };
}

/** Just enough of the real membership table for the migration. */
const MINIMAL_SCHEMA = `
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE public.workspace_members (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL,
  role text NOT NULL DEFAULT 'member',
  created_at timestamptz DEFAULT now(),
  PRIMARY KEY (id)
);
`;

type PgError = Error & { code?: string; constraint?: string };

describe.skipIf(!ADMIN_URL)(
  'workspace_members.calendar_share migration (throwaway Postgres)',
  () => {
    let admin: Client;
    let db: Client;
    let dbName: string;
    let created = false;
    let migration: string;
    let existingMember: string;

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
      dbName = `calendar_share_test_${process.pid}_${randomBytes(4).toString('hex')}`;
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
      const member = await db.query(
        `INSERT INTO public.workspace_members (workspace_id, user_id, role)
       VALUES (gen_random_uuid(), gen_random_uuid(), 'member') RETURNING id`
      );
      existingMember = member.rows[0].id as string;
      await inTransaction(migration);
    }, 60_000);

    afterAll(async () => {
      await db?.end();
      // Only the database this run created is dropped.
      if (created) await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      await admin?.end();
    });

    async function newMember(): Promise<string> {
      const { rows } = await db.query(
        `INSERT INTO public.workspace_members (workspace_id, user_id)
       VALUES (gen_random_uuid(), gen_random_uuid()) RETURNING id, calendar_share`
      );
      expect(rows[0].calendar_share).toBe('none');
      return rows[0].id as string;
    }

    it("adds a not-null text column defaulting to 'none', existing members included", async () => {
      const { rows } = await db.query(
        `SELECT data_type, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'workspace_members'
          AND column_name = 'calendar_share'`
      );
      expect(rows).toEqual([
        { data_type: 'text', is_nullable: 'NO', column_default: "'none'::text" },
      ]);
      const existing = await db.query(
        `SELECT calendar_share FROM public.workspace_members WHERE id = $1`,
        [existingMember]
      );
      expect(existing.rows).toEqual([{ calendar_share: 'none' }]);
    });

    it("takes 'none' and 'busy'", async () => {
      const id = await newMember();
      for (const level of ['busy', 'none']) {
        const { rows } = await db.query(
          `UPDATE public.workspace_members SET calendar_share = $2 WHERE id = $1 RETURNING calendar_share`,
          [id, level]
        );
        expect(rows).toEqual([{ calendar_share: level }]);
      }
    });

    it('refuses any other level from any writer, NULL included', async () => {
      const id = await newMember();
      for (const level of ['details', 'BUSY', '', 'busy ']) {
        const failure = await db
          .query(`UPDATE public.workspace_members SET calendar_share = $2 WHERE id = $1`, [
            id,
            level,
          ])
          .then(
            () => null,
            (error: PgError) => error
          );
        expect(failure?.code).toBe('23514');
        expect(failure?.constraint).toBe('workspace_members_calendar_share_check');
      }
      const nullFailure = await db
        .query(`UPDATE public.workspace_members SET calendar_share = NULL WHERE id = $1`, [id])
        .then(
          () => null,
          (error: PgError) => error
        );
      expect(nullFailure?.code).toBe('23502');
    });

    it('applies a second time without error, leaving one constraint', async () => {
      await inTransaction(migration);
      const { rows } = await db.query(
        `SELECT count(*)::int AS n FROM pg_constraint
        WHERE conrelid = 'public.workspace_members'::regclass
          AND conname = 'workspace_members_calendar_share_check'`
      );
      expect(rows[0].n).toBe(1);
    });
  }
);
