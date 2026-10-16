/**
 * Every table the migrations leave open to every role has its client-role
 * privileges revoked (20261016014728_revoke_client_roles_on_open_tables.sql).
 *
 * "Open" is either of two shapes, read from the migration files in order:
 *
 * - a permissive policy reaching PUBLIC, anon or authenticated (no `TO`
 *   clause means PUBLIC) whose USING or WITH CHECK is `(true)`;
 * - a public table on which row level security is never enabled.
 *
 * Supabase's default privileges grant anon and authenticated full access to
 * every new public table, so an open table with those grants is readable and
 * writable with the publishable key, bypassing the API server. This pins that
 * every such table also carries `REVOKE ALL ... FROM anon, authenticated` (or
 * one REVOKE per role) after it opens, so a new one fails here before it ships.
 *
 * The reading is textual: statements are found by pattern, in file order,
 * dynamic SQL in EXECUTE strings included. A shape it does not model passes.
 * The database itself is checked in CI's DB job:
 * client-role-grants.integration.test.ts asks the catalog the same question.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations/', import.meta.url));
const CLIENT_ROLES = ['anon', 'authenticated'] as const;

interface TableState {
  rls: boolean;
  /** Open policies by name. */
  openPolicies: Set<string>;
  /** Client roles whose privileges a REVOKE removed, since the table last opened. */
  revoked: Set<string>;
}

/** A table name as written, unquoted and without its `public.` schema; null for another schema. */
function tableName(raw: string): string | null {
  const parts = raw.replace(/"/g, '').split('.');
  if (parts.length === 2 && parts[0].toLowerCase() !== 'public') return null;
  return parts[parts.length - 1].toLowerCase();
}

function roleList(raw: string): string[] {
  return raw
    .split(',')
    .map((r) => r.trim().replace(/"/g, '').toLowerCase())
    .filter(Boolean);
}

const STATEMENTS: Array<{ kind: string; pattern: RegExp }> = [
  {
    kind: 'create-table',
    pattern:
      /\bCREATE\s+(?:UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?((?:"?\w+"?\.)?"?\w+"?)\s*\(/gi,
  },
  {
    kind: 'drop-table',
    pattern:
      /\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?((?:(?:"?\w+"?\.)?"?\w+"?\s*,\s*)*(?:"?\w+"?\.)?"?\w+"?)/gi,
  },
  {
    kind: 'rename-table',
    pattern:
      /\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?((?:"?\w+"?\.)?"?\w+"?)\s+RENAME\s+TO\s+("?\w+"?)/gi,
  },
  {
    kind: 'rls',
    pattern:
      /\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?((?:"?\w+"?\.)?"?\w+"?)\s+(ENABLE|DISABLE)\s+ROW\s+LEVEL\s+SECURITY/gi,
  },
  {
    kind: 'create-policy',
    pattern: /\bCREATE\s+POLICY\s+("(?:[^"]|"")+"|\w+)\s+ON\s+((?:"?\w+"?\.)?"?\w+"?)([\s\S]*?);/gi,
  },
  {
    kind: 'drop-policy',
    pattern:
      /\bDROP\s+POLICY\s+(?:IF\s+EXISTS\s+)?("(?:[^"]|"")+"|\w+)\s+ON\s+((?:"?\w+"?\.)?"?\w+"?)/gi,
  },
  {
    kind: 'revoke',
    pattern:
      /\bREVOKE\s+ALL(?:\s+PRIVILEGES)?\s+ON\s+(?:TABLE\s+)?((?:(?:"?\w+"?\.)?"?\w+"?\s*,\s*)*(?:"?\w+"?\.)?"?\w+"?)\s+FROM\s+([\w\s,"]+?)\s*(?:;|CASCADE|RESTRICT|')/gi,
  },
  {
    kind: 'grant',
    pattern:
      /\bGRANT\s+[\w\s,]+?\s+ON\s+(?:TABLE\s+)?((?:(?:"?\w+"?\.)?"?\w+"?\s*,\s*)*(?:"?\w+"?\.)?"?\w+"?)\s+TO\s+([\w\s,"]+?)\s*(?:;|WITH|')/gi,
  },
];

/** Reads SQL files in order and answers which public tables are open and unrevoked. */
function openUnrevokedTables(files: Array<{ name: string; sql: string }>): {
  open: string[];
  unrevoked: string[];
} {
  const tables = new Map<string, TableState>();
  const state = (name: string): TableState => {
    let s = tables.get(name);
    if (!s) {
      s = { rls: false, openPolicies: new Set(), revoked: new Set() };
      tables.set(name, s);
    }
    return s;
  };
  const isOpen = (s: TableState) => !s.rls || s.openPolicies.size > 0;

  for (const file of [...files].sort((a, b) => a.name.localeCompare(b.name))) {
    // Line comments only: a statement in a comment is not run.
    const sql = file.sql.replace(/--[^\n]*/g, '');
    const found: Array<{ index: number; kind: string; m: RegExpExecArray }> = [];
    for (const { kind, pattern } of STATEMENTS) {
      pattern.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = pattern.exec(sql))) found.push({ index: m.index, kind, m });
    }
    found.sort((a, b) => a.index - b.index);

    for (const { kind, m } of found) {
      if (kind === 'create-table') {
        const name = tableName(m[1]);
        if (name && !tables.has(name)) state(name);
      } else if (kind === 'drop-table') {
        for (const raw of m[1].split(',')) {
          const name = tableName(raw.trim());
          if (name) tables.delete(name);
        }
      } else if (kind === 'rename-table') {
        const from = tableName(m[1]);
        const to = tableName(m[2]);
        if (from && to && tables.has(from)) {
          tables.set(to, tables.get(from)!);
          tables.delete(from);
        }
      } else if (kind === 'rls') {
        const name = tableName(m[1]);
        if (name && tables.has(name)) {
          const s = state(name);
          const wasOpen = isOpen(s);
          s.rls = m[2].toUpperCase() === 'ENABLE';
          if (!wasOpen && isOpen(s)) s.revoked.clear();
        }
      } else if (kind === 'create-policy') {
        const name = tableName(m[2]);
        if (!name || !tables.has(name)) continue;
        const body = m[3];
        if (/\bAS\s+RESTRICTIVE\b/i.test(body)) continue;
        const to = /\bTO\s+([\w\s,"]+?)(?=\s+(?:USING|WITH\s+CHECK)\b|\s*$|')/i.exec(body);
        const roles = to ? roleList(to[1]) : ['public'];
        const reaches = roles.some((r) => r === 'public' || r === 'anon' || r === 'authenticated');
        const permitsAll = /\b(?:USING|WITH\s+CHECK)\s*\(\s*true\s*\)/i.test(body);
        if (reaches && permitsAll) {
          const s = state(name);
          const wasOpen = isOpen(s);
          s.openPolicies.add(m[1].toLowerCase());
          if (!wasOpen) s.revoked.clear();
        }
      } else if (kind === 'drop-policy') {
        const name = tableName(m[2]);
        if (name && tables.has(name)) state(name).openPolicies.delete(m[1].toLowerCase());
      } else if (kind === 'revoke' || kind === 'grant') {
        const roles = roleList(m[2]);
        for (const raw of m[1].split(',')) {
          const name = tableName(raw.trim());
          if (!name || !tables.has(name)) continue;
          const s = state(name);
          for (const role of CLIENT_ROLES) {
            if (!roles.includes(role) && !roles.includes('public')) continue;
            if (kind === 'revoke') s.revoked.add(role);
            else s.revoked.delete(role);
          }
        }
      }
    }
  }

  const open = [...tables].filter(([, s]) => isOpen(s)).map(([name]) => name);
  const unrevoked = [...tables]
    .filter(([, s]) => isOpen(s) && !CLIENT_ROLES.every((r) => s.revoked.has(r)))
    .map(([name]) => name);
  return { open: open.sort(), unrevoked: unrevoked.sort() };
}

const migrationFiles = readdirSync(MIGRATIONS)
  .filter((name) => name.endsWith('.sql'))
  .map((name) => ({ name, sql: readFileSync(`${MIGRATIONS}${name}`, 'utf8') }));

/** The tables 20261016014728 revokes: what the catalog reported open on Oct 15, 2026. */
const REVOKED_OPEN_TABLES = [
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

describe('the migrations leave no open table with client-role privileges', () => {
  const result = openUnrevokedTables(migrationFiles);

  it('reads every table the catalog found open, and only those', () => {
    expect(result.open).toEqual(REVOKED_OPEN_TABLES);
  });

  it('finds every one of them revoked from anon and authenticated', () => {
    expect(result.unrevoked).toEqual([]);
  });
});

describe('the reading catches what it is for (controls)', () => {
  const read = (...sql: string[]) =>
    openUnrevokedTables(sql.map((text, i) => ({ name: `${1000 + i}_fixture.sql`, sql: text })));

  it('flags a permissive policy with no TO clause until both client roles are revoked', () => {
    const table =
      'CREATE TABLE public.notes (id int); ALTER TABLE public.notes ENABLE ROW LEVEL SECURITY;';
    const policy = 'CREATE POLICY notes_service ON public.notes FOR ALL USING (true);';
    expect(read(table, policy).unrevoked).toEqual(['notes']);
    expect(read(table, policy, 'REVOKE ALL ON TABLE public.notes FROM anon;').unrevoked).toEqual([
      'notes',
    ]);
    expect(
      read(table, policy, 'REVOKE ALL ON TABLE public.notes FROM anon, authenticated;').unrevoked
    ).toEqual([]);
  });

  it('flags a table whose row level security is never enabled', () => {
    expect(read('CREATE TABLE IF NOT EXISTS notes (id int);').unrevoked).toEqual(['notes']);
  });

  it('reads a WITH CHECK (true), a quoted name and a TO naming a client role as open', () => {
    const table = 'CREATE TABLE notes (id int); ALTER TABLE notes ENABLE ROW LEVEL SECURITY;';
    expect(
      read(table, 'CREATE POLICY "Anyone may write" ON notes FOR INSERT TO anon WITH CHECK (true);')
        .open
    ).toEqual(['notes']);
  });

  it('leaves a policy for the service role, or a real predicate, closed', () => {
    const table = 'CREATE TABLE notes (id int); ALTER TABLE notes ENABLE ROW LEVEL SECURITY;';
    expect(
      read(table, 'CREATE POLICY s ON notes FOR ALL TO service_role USING (true);').open
    ).toEqual([]);
    expect(
      read(table, 'CREATE POLICY own ON notes FOR SELECT USING (auth.uid() = owner_id);').open
    ).toEqual([]);
  });

  it('follows a dropped policy, a dropped table, a rename and a later grant', () => {
    const table = 'CREATE TABLE notes (id int); ALTER TABLE notes ENABLE ROW LEVEL SECURITY;';
    const policy = 'CREATE POLICY p ON notes USING (true);';
    expect(read(table, policy, 'DROP POLICY IF EXISTS p ON notes;').open).toEqual([]);
    expect(read(table, policy, 'DROP TABLE IF EXISTS public.notes;').open).toEqual([]);
    expect(read(table, policy, "EXECUTE 'ALTER TABLE public.notes RENAME TO memos';").open).toEqual(
      ['memos']
    );
    expect(
      read(
        table,
        policy,
        'REVOKE ALL ON TABLE notes FROM anon, authenticated;',
        'GRANT SELECT ON TABLE notes TO authenticated;'
      ).unrevoked
    ).toEqual(['notes']);
  });

  it('ignores a statement in a comment', () => {
    expect(read('-- CREATE TABLE notes (id int);').open).toEqual([]);
  });
});
