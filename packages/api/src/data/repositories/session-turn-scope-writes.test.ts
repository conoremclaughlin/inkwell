/**
 * sessions.turn_scope is written at insert and by no update
 * (ink://specs/inkling-multi-person-groups, Phase 2 gate 1).
 *
 * The MCP server refuses to authenticate by a marked session's context, so a
 * marked row must stay marked and an unmarked one stay unmarked. Server code
 * never writes the column after insert, and this file pins that:
 *
 * - every update or upsert chained onto from('sessions') in api source
 *   builds its payload from keys named in that source, and no key is
 *   turn_scope. A payload made any other way (a computed key, a spread of a
 *   caller's object, the payload handed to a function) fails the census;
 * - the builders that take a caller's object drop a turnScope or turn_scope
 *   smuggled into it;
 * - no migration names the column but the marker's own and the trigger's.
 *
 * Outside this census: a service-role or raw SQL write, and a query builder
 * stored in a variable before .update is called on it (none exists today).
 * The database trigger session_turn_scope_immutable is the floor under it:
 * any update that changes the column is refused, whoever writes it
 * (approved by Conor, Oct 15, 2026, as defense in depth).
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi } from 'vitest';
import { apiSourceFiles, tableWritesIn } from '../../test/write-census';

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { MemoryRepository } from './memory-repository';
import { SessionRepository } from '../../services/sessions/session-repository';

const API_SRC = fileURLToPath(new URL('../../', import.meta.url));
const MIGRATIONS = fileURLToPath(new URL('../../../../../supabase/migrations/', import.meta.url));
const MARKER_MIGRATION = '20261015070518_sessions_turn_scope_marker.sql';
const TRIGGER_MIGRATION = '20261015203541_sessions_turn_scope_immutable.sql';
const FORBIDDEN = 'turn_scope';

const sessionWritesIn = (fileName: string, source: string) =>
  tableWritesIn(fileName, source, 'sessions');

const census = apiSourceFiles(API_SRC).flatMap((path) =>
  sessionWritesIn(relative(API_SRC, path), readFileSync(path, 'utf8'))
);

describe('every session update builds its payload from named keys', () => {
  it('finds the update paths it is meant to judge', () => {
    const files = new Set(census.map((w) => w.site.split(':')[0]));
    for (const file of [
      'data/repositories/memory-repository.ts',
      'services/sessions/session-repository.ts',
      'routes/hook-lifecycle.ts',
      'services/sessions/interrupt-active-runs.ts',
      'services/sessions/move-session.ts',
    ]) {
      expect(files, file).toContain(file);
    }
    expect(census.length).toBeGreaterThanOrEqual(14);
  });

  it('knows every key each one can write', () => {
    expect(census.filter((w) => w.problems.length > 0)).toEqual([]);
  });

  it('never writes turn_scope', () => {
    expect(census.filter((w) => w.keys.includes(FORBIDDEN)).map((w) => w.site)).toEqual([]);
  });
});

describe('the census catches what it is for (controls)', () => {
  const judge = (body: string) =>
    sessionWritesIn(
      'fixture.ts',
      `class Fixture { async write(input: any, db: any) { ${body} } payload(input: any) { const built: any = {}; built.lifecycle = 'idle'; return built; } }`
    );

  it('reads named keys from literals, conditionals, assignments and a builder method', () => {
    const [write] = judge(
      `const p: any = { status: 'x', ...(input.a ? { lifecycle: 'y' } : {}) }; p.alias = 'k'; (p as any).cli_poll_at = null; await db.from('sessions').update(p).eq('id', 1);`
    );
    expect(write.problems).toEqual([]);
    expect(write.keys.sort()).toEqual(['alias', 'cli_poll_at', 'lifecycle', 'status']);
    const [built] = judge(
      `const p = this.payload(input); await db.from('sessions').update(p).eq('id', 1);`
    );
    expect(built).toEqual({
      site: 'fixture.ts:1',
      method: 'update',
      keys: ['lifecycle'],
      problems: [],
    });
  });

  it('finds turn_scope however it is named in the source', () => {
    expect(judge(`await db.from('sessions').update({ turn_scope: null });`)[0].keys).toContain(
      FORBIDDEN
    );
    const [assigned] = judge(
      `const p: any = {}; p.turn_scope = input.turnScope; await db.from('sessions').update(p);`
    );
    expect(assigned.keys).toContain(FORBIDDEN);
  });

  it.each([
    ['a spread of the caller’s object', `await db.from('sessions').update({ ...input });`],
    ['a computed key', `await db.from('sessions').update({ [input.k]: 1 });`],
    [
      'a payload handed to a function',
      `const p: any = {}; Object.assign(p, input); await db.from('sessions').update(p);`,
    ],
    ['an element write', `const p: any = {}; p[input.k] = 1; await db.from('sessions').upsert(p);`],
    ['a payload from a call', `await db.from('sessions').update(build(input));`],
    ['a parameter', `await db.from('sessions').update(input);`],
  ])('refuses %s', (_label, body) => {
    const [write] = judge(body);
    expect(write.problems.length).toBeGreaterThan(0);
  });

  it('judges only writes to sessions', () => {
    expect(judge(`await db.from('threads').update({ ...input });`)).toEqual([]);
  });
});

describe('the builders that take a caller’s object drop a smuggled turn_scope', () => {
  const ROW = {
    id: 'session-1',
    user_id: 'user-1',
    agent_id: 'fixture-sb',
    metadata: {},
    started_at: '2026-10-15T00:00:00.000Z',
    turn_epoch: 'epoch-1',
    turn_scope: null,
  };
  const smuggled = { turnScope: 'space-turn', turn_scope: 'space-turn' };

  function recordingClient() {
    const writes: Record<string, unknown>[] = [];
    const chain: Record<string | symbol, unknown> = new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === 'then') {
            return (resolve: (v: unknown) => unknown) => resolve({ data: [ROW], error: null });
          }
          if (prop === 'single' || prop === 'maybeSingle') {
            return async () => ({ data: ROW, error: null });
          }
          if (prop === 'update' || prop === 'upsert') {
            return (payload: Record<string, unknown>) => {
              writes.push(payload);
              return chain;
            };
          }
          return () => chain;
        },
      }
    );
    return { client: { from: () => chain }, writes };
  }

  it('MemoryRepository.updateSession', async () => {
    const { client, writes } = recordingClient();
    await new MemoryRepository(client as never).updateSession('session-1', {
      currentPhase: 'reviewing',
      ...smuggled,
    } as never);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ current_phase: 'reviewing' });
    expect(Object.keys(writes[0])).not.toContain(FORBIDDEN);
    expect(Object.keys(writes[0])).not.toContain('turnScope');
  });

  it('SessionRepository.update and updateIfTurnEpoch', async () => {
    const { client, writes } = recordingClient();
    const repository = new SessionRepository(client as never);
    await repository.update('session-1', { lifecycle: 'idle', ...smuggled } as never);
    await repository.updateIfTurnEpoch('session-1', 'epoch-1', {
      lifecycle: 'idle',
      ...smuggled,
    } as never);
    expect(writes).toHaveLength(2);
    for (const write of writes) {
      expect(write).toMatchObject({ lifecycle: 'idle' });
      expect(Object.keys(write)).not.toContain(FORBIDDEN);
      expect(Object.keys(write)).not.toContain('turnScope');
    }
  });
});

describe('no migration but the marker and its trigger names turn_scope', () => {
  it('finds the column only where it is added and where it is held fixed', () => {
    const naming = readdirSync(MIGRATIONS).filter(
      (name) =>
        name.endsWith('.sql') && readFileSync(join(MIGRATIONS, name), 'utf8').includes(FORBIDDEN)
    );
    expect(naming.sort()).toEqual([MARKER_MIGRATION, TRIGGER_MIGRATION]);
  });
});
