/**
 * inbox_threads.conversation_mode is written at creation and by nothing after
 * (ink://specs/inkling-multi-person-groups, D8; conversation-mode.ts).
 *
 * A mode is fixed when a conversation is made: turning a private one public
 * would republish it. Server code holds it fixed, and this file pins that:
 *
 * - every update or upsert chained onto the table in api source builds its
 *   payload from keys named in that source, and no key is conversation_mode;
 * - every insert does the same, and the one that names the column is
 *   findOrCreateThread's, the insert that creates a thread;
 * - no migration names the column but the one that adds it.
 *
 * Outside this census: a service-role or raw SQL write, and a query builder
 * stored in a variable before its write method is called. There is no
 * database guard: one would be a trigger, which needs Conor's OK (Oct 4).
 */

import { readFileSync, readdirSync } from 'node:fs';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { apiSourceFiles, tableWritesIn } from '../../test/write-census';

const API_SRC = fileURLToPath(new URL('../../', import.meta.url));
const MIGRATIONS = fileURLToPath(new URL('../../../../../supabase/migrations/', import.meta.url));
const COLUMN_MIGRATION = '20261016182006_inbox_threads_conversation_mode.sql';
const COLUMN = 'conversation_mode';

const threadWritesIn = (fileName: string, source: string) =>
  tableWritesIn(fileName, source, 'inbox_threads', ['update', 'upsert', 'insert']);

const census = apiSourceFiles(API_SRC).flatMap((path) =>
  threadWritesIn(relative(API_SRC, path), readFileSync(path, 'utf8'))
);
const updates = census.filter((w) => w.method !== 'insert');
const inserts = census.filter((w) => w.method === 'insert');

describe('every inbox_threads write builds its payload from named keys', () => {
  it('finds the writes it is meant to judge', () => {
    const files = new Set(updates.map((w) => w.site.split(':')[0]));
    for (const file of [
      'mcp/tools/inbox-handlers.ts',
      'mcp/tools/thread-handlers.ts',
      'services/studio-lease.service.ts',
      'services/trigger-failure-notice.ts',
    ]) {
      expect(files, file).toContain(file);
    }
    expect(updates.length).toBeGreaterThanOrEqual(4);
    expect(inserts.map((w) => w.site.split(':')[0])).toContain('mcp/tools/inbox-handlers.ts');
  });

  it('knows every key each one can write', () => {
    expect(census.filter((w) => w.problems.length > 0)).toEqual([]);
  });

  it('never updates conversation_mode', () => {
    expect(updates.filter((w) => w.keys.includes(COLUMN)).map((w) => w.site)).toEqual([]);
  });

  it('sets it in one insert: the one that creates a thread', () => {
    const naming = inserts.filter((w) => w.keys.includes(COLUMN));
    expect(naming).toHaveLength(1);
    const [site] = naming;
    const [file, line] = site.site.split(':');
    expect(file).toBe('mcp/tools/inbox-handlers.ts');
    const source = readFileSync(`${API_SRC}${file}`, 'utf8').split('\n');
    const opening = source
      .slice(0, Number(line))
      .reverse()
      .find((text) => /^export async function /.test(text));
    expect(opening).toMatch(/^export async function findOrCreateThread\(/);
  });
});

describe('the census catches what it is for (controls)', () => {
  const judge = (body: string) =>
    threadWritesIn('fixture.ts', `async function write(input: any, db: any) { ${body} }`);

  it('finds the column through from() and through the threadTable helper', () => {
    expect(
      judge(`await db.from('inbox_threads').update({ conversation_mode: 'public' });`)[0].keys
    ).toContain(COLUMN);
    expect(
      judge(
        `await threadTable(db, 'inbox_threads').update({ ...(input.a ? { conversation_mode: null } : {}) });`
      )[0].keys
    ).toContain(COLUMN);
    expect(
      judge(`await threadTable(db, 'inbox_threads').insert({ conversation_mode: 'private' });`)[0]
    ).toMatchObject({ method: 'insert', keys: [COLUMN] });
  });

  it.each([
    ['a spread of the caller’s object', `await db.from('inbox_threads').update({ ...input });`],
    ['a computed key', `await db.from('inbox_threads').update({ [input.k]: 1 });`],
    ['a parameter', `await threadTable(db, 'inbox_threads').upsert(input);`],
  ])('refuses %s', (_label, body) => {
    expect(judge(body)[0].problems.length).toBeGreaterThan(0);
  });

  it('judges only writes to inbox_threads', () => {
    expect(judge(`await db.from('inbox_thread_messages').update({ ...input });`)).toEqual([]);
    expect(judge(`await threadTable(db, 'inbox_thread_participants').insert(input);`)).toEqual([]);
  });
});

describe('no migration but the one that adds it names conversation_mode', () => {
  it('finds the column only where it is added', () => {
    const naming = readdirSync(MIGRATIONS).filter(
      (name) =>
        name.endsWith('.sql') && readFileSync(`${MIGRATIONS}${name}`, 'utf8').includes(COLUMN)
    );
    expect(naming).toEqual([COLUMN_MIGRATION]);
  });
});
