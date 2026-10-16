/**
 * No table open to every role holds a client-role privilege, against the real
 * schema (20261016014728_revoke_client_roles_on_open_tables.sql).
 *
 * "Open" is what the catalog says: row level security disabled, or a
 * permissive policy reaching PUBLIC, anon or authenticated whose USING or
 * WITH CHECK is `true`. Supabase's default privileges grant anon and
 * authenticated full access to every new public table, so such a table with
 * those grants is readable and writable with the publishable key. This asks
 * the question of every public table, so a new open one fails here whatever
 * its name, and checks that the API's service role still reads the tables
 * the migration closed.
 *
 * Run via: yarn test:integration:db:local src/data/client-role-grants.integration.test.ts
 */

import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getDataComposer } from './composer';

const CLOSED_TABLES = [
  'agent_inbox_read_status',
  'approval_requests',
  'artifact_uri_aliases',
  'inbox_thread_messages',
  'inbox_thread_participants',
  'inbox_thread_read_status',
  'inbox_threads',
  'memory_embedding_chunks',
  'memory_recall_benchmark_case_results',
  'memory_recall_benchmark_metrics',
  'memory_recall_benchmark_runs',
  'observation_conflicts',
  'project_slug_aliases',
  'publication_operation_events',
  'publication_operations',
  'session_observe_grants',
  'studio_lease_events',
  'task_authority_holds',
  'task_edges',
  'task_gate_events',
  'task_graph_revisions',
  'task_groups',
];

const ANY_PRIVILEGE = 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER';

/** Every open public table, with whether each client role holds any privilege on it. */
const OPEN_TABLES_SQL = `
  SELECT c.relname AS name,
         has_table_privilege('anon', c.oid, '${ANY_PRIVILEGE}') AS anon,
         has_table_privilege('authenticated', c.oid, '${ANY_PRIVILEGE}') AS authenticated
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relkind IN ('r', 'p')
     AND (NOT c.relrowsecurity OR EXISTS (
           SELECT 1 FROM pg_policies p
            WHERE p.schemaname = 'public'
              AND p.tablename = c.relname
              AND p.permissive = 'PERMISSIVE'
              AND p.roles && ARRAY['public', 'anon', 'authenticated']::name[]
              AND (p.qual = 'true' OR p.with_check = 'true')))
   ORDER BY 1`;

interface OpenTable {
  name: string;
  anon: boolean;
  authenticated: boolean;
}

let db: Client;

beforeAll(async () => {
  const url = process.env.INTEGRATION_DB_URL;
  if (!url) throw new Error('INTEGRATION_DB_URL is required: run through the managed harness');
  const { Client: PgClient } = await import('pg');
  db = new PgClient({ connectionString: url });
  await db.connect();
});

afterAll(async () => {
  await db?.end();
});

describe('client-role grants on open tables', () => {
  it('no open public table grants anon or authenticated any privilege', async () => {
    const { rows } = await db.query<OpenTable>(OPEN_TABLES_SQL);
    expect(rows.filter((r) => r.anon || r.authenticated)).toEqual([]);
  });

  it('reads as open every table the migration closed, so the check above covers them', async () => {
    const { rows } = await db.query<OpenTable>(OPEN_TABLES_SQL);
    const open = new Set(rows.map((r) => r.name));
    expect(CLOSED_TABLES.filter((t) => !open.has(t))).toEqual([]);
  });

  it('leaves neither client role SELECT, INSERT, UPDATE or DELETE on any closed table', async () => {
    const { rows } = await db.query<{ name: string; role: string; privilege: string }>(
      `SELECT t AS name, r AS role, p AS privilege
         FROM unnest($1::text[]) t,
              unnest(ARRAY['anon', 'authenticated']) r,
              unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) p
        WHERE has_table_privilege(r, format('public.%I', t), p)`,
      [CLOSED_TABLES]
    );
    expect(rows).toEqual([]);
  });

  it('keeps the API service role reading every closed table', async () => {
    const supabase = (await getDataComposer()).getClient();
    const failures: string[] = [];
    for (const table of CLOSED_TABLES) {
      const { error } = await supabase.from(table).select('*', { head: true, count: 'exact' });
      if (error) failures.push(`${table}: ${error.message}`);
    }
    expect(failures).toEqual([]);
  });

  // The control: a new open table, made as any migration makes one, is
  // caught. Created and dropped inside a transaction that rolls back.
  it('catches a new table opened by a USING (true) policy, and one with RLS off', async () => {
    const policed = `zz_open_policy_${randomUUID().slice(0, 8)}`;
    const unpoliced = `zz_open_norls_${randomUUID().slice(0, 8)}`;
    await db.query('BEGIN');
    try {
      await db.query(`CREATE TABLE public.${policed} (id int)`);
      await db.query(`ALTER TABLE public.${policed} ENABLE ROW LEVEL SECURITY`);
      await db.query(`CREATE POLICY open_to_all ON public.${policed} FOR ALL USING (true)`);
      await db.query(`CREATE TABLE public.${unpoliced} (id int)`);
      // Default privileges are not in force for every connecting role, so the
      // grant they would make is made here explicitly.
      await db.query(`GRANT ALL ON public.${policed}, public.${unpoliced} TO anon, authenticated`);
      const { rows } = await db.query<OpenTable>(OPEN_TABLES_SQL);
      const flagged = rows.filter((r) => r.anon || r.authenticated).map((r) => r.name);
      expect(flagged.sort()).toEqual([policed, unpoliced].sort());
    } finally {
      await db.query('ROLLBACK');
    }
  });
});
