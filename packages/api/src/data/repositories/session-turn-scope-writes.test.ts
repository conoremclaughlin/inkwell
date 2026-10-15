/**
 * sessions.turn_scope is written at insert and by no update
 * (ink://specs/inkling-multi-person-groups, Phase 2 gate 1).
 *
 * The MCP server refuses to authenticate by a marked session's context, so a
 * marked row must stay marked and an unmarked one stay unmarked. The
 * migration adds only the CHECK constraint: DB-level immutability needs a
 * trigger, and the Oct 4 rule keeps triggers for Conor to decide. So the
 * guarantee lives in the server's own code, and this file pins it:
 *
 * - every update or upsert chained onto from('sessions') in api source
 *   builds its payload from keys named in that source, and no key is
 *   turn_scope. A payload made any other way (a computed key, a spread of a
 *   caller's object, the payload handed to a function) fails the census;
 * - the builders that take a caller's object drop a turnScope or turn_scope
 *   smuggled into it;
 * - no migration but the marker's own names the column.
 *
 * Outside this bound: a service-role or raw SQL write, and a query builder
 * stored in a variable before .update is called on it (none exists today).
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, it, expect, vi } from 'vitest';

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
const FORBIDDEN = 'turn_scope';

interface SessionWrite {
  site: string;
  keys: string[];
  problems: string[];
}

type FunctionLike = ts.FunctionLikeDeclaration;

function unwrap(expression: ts.Expression): ts.Expression {
  let e = expression;
  while (
    ts.isParenthesizedExpression(e) ||
    ts.isAsExpression(e) ||
    ts.isNonNullExpression(e) ||
    ts.isSatisfiesExpression(e) ||
    ts.isTypeAssertionExpression(e)
  ) {
    e = e.expression;
  }
  return e;
}

/** Whether a call chain contains from('sessions'). */
function chainsFromSessions(expression: ts.Expression): boolean {
  let e: ts.Expression | undefined = expression;
  while (e) {
    e = unwrap(e);
    if (ts.isCallExpression(e)) {
      const callee = e.expression;
      const [first] = e.arguments;
      if (
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === 'from' &&
        first &&
        ts.isStringLiteralLike(first) &&
        first.text === 'sessions'
      ) {
        return true;
      }
      e = ts.isPropertyAccessExpression(callee) ? callee.expression : undefined;
    } else if (ts.isPropertyAccessExpression(e)) {
      e = e.expression;
    } else {
      e = undefined;
    }
  }
  return false;
}

function enclosingFunction(node: ts.Node): FunctionLike | undefined {
  let n: ts.Node | undefined = node.parent;
  while (n && !ts.isFunctionLike(n)) n = n.parent;
  return n as FunctionLike | undefined;
}

function findDeclaration(scope: ts.Node, name: string): ts.VariableDeclaration | undefined {
  let found: ts.VariableDeclaration | undefined;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name) {
      found = n;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(scope);
  return found;
}

function findMethod(node: ts.Node, name: string): ts.MethodDeclaration | undefined {
  let n: ts.Node | undefined = node;
  while (n && !ts.isClassLike(n)) n = n.parent;
  return (n as ts.ClassLikeDeclaration | undefined)?.members.find(
    (m): m is ts.MethodDeclaration =>
      ts.isMethodDeclaration(m) && ts.isIdentifier(m.name) && m.name.text === name
  );
}

/**
 * The keys a payload expression can carry, or what makes them unknowable.
 * Object literals give their named keys; a conditional gives both branches';
 * a spread is followed only into a literal or a conditional of literals; a
 * local variable gives its initializer's keys plus every `x.key =` written
 * to it in its function, and may otherwise only be read.
 */
function payloadKeys(expression: ts.Expression, out: SessionWrite, depth = 0): void {
  const e = unwrap(expression);
  if (depth > 4) {
    out.problems.push(`payload too indirect: ${e.getText()}`);
  } else if (ts.isObjectLiteralExpression(e)) {
    for (const property of e.properties) {
      if (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) {
        if (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name)) {
          out.keys.push(property.name.text);
        } else {
          out.problems.push(`computed key ${property.name.getText()}`);
        }
      } else if (ts.isSpreadAssignment(property)) {
        const spread = unwrap(property.expression);
        if (ts.isObjectLiteralExpression(spread) || ts.isConditionalExpression(spread)) {
          payloadKeys(spread, out, depth + 1);
        } else {
          out.problems.push(`spread of ${spread.getText()}`);
        }
      } else {
        out.problems.push(`unsupported member ${property.getText()}`);
      }
    }
  } else if (ts.isConditionalExpression(e)) {
    payloadKeys(e.whenTrue, out, depth + 1);
    payloadKeys(e.whenFalse, out, depth + 1);
  } else if (ts.isIdentifier(e)) {
    variableKeys(e, out, depth);
  } else {
    out.problems.push(`payload is ${ts.SyntaxKind[e.kind]}: ${e.getText()}`);
  }
}

function variableKeys(identifier: ts.Identifier, out: SessionWrite, depth: number): void {
  const name = identifier.text;
  const fn = enclosingFunction(identifier);
  const declaration = fn && findDeclaration(fn, name);
  if (!fn || !declaration?.initializer) {
    out.problems.push(`no local declaration for ${name}`);
    return;
  }

  const init = unwrap(declaration.initializer);
  if (
    ts.isCallExpression(init) &&
    ts.isPropertyAccessExpression(init.expression) &&
    init.expression.expression.kind === ts.SyntaxKind.ThisKeyword
  ) {
    // A payload built by a method of the same class: the keys are the ones
    // that method's returned variable gets.
    const method = findMethod(init, init.expression.name.text);
    const returned = method?.body?.statements.find(ts.isReturnStatement)?.expression;
    const returnedVariable = returned && unwrap(returned);
    if (returnedVariable && ts.isIdentifier(returnedVariable)) {
      variableKeys(returnedVariable, out, depth + 1);
    } else {
      out.problems.push(
        `${name} comes from ${init.expression.name.text}, which returns no variable`
      );
    }
  } else {
    payloadKeys(init, out, depth + 1);
  }

  const visit = (n: ts.Node): void => {
    if (ts.isIdentifier(n) && n.text === name && n !== declaration.name) {
      const parent = n.parent;
      let use: ts.Node = n;
      while (
        ts.isParenthesizedExpression(use.parent) ||
        ts.isAsExpression(use.parent) ||
        ts.isNonNullExpression(use.parent) ||
        ts.isSatisfiesExpression(use.parent)
      ) {
        use = use.parent;
      }
      const user = use.parent;
      const isPropertyName =
        (ts.isPropertyAccessExpression(parent) && parent.name === n) ||
        (ts.isPropertyAssignment(parent) && parent.name === n);
      if (isPropertyName) {
        // `other.name` or `{ name: ... }`: not this variable.
      } else if (ts.isPropertyAccessExpression(user) && user.expression === use) {
        const assignment = user.parent;
        if (
          ts.isBinaryExpression(assignment) &&
          assignment.left === user &&
          assignment.operatorToken.kind === ts.SyntaxKind.EqualsToken
        ) {
          out.keys.push(user.name.text);
        }
        // Otherwise a read of one field.
      } else if (ts.isShorthandPropertyAssignment(user) || ts.isReturnStatement(user)) {
        // Logged, or returned to the caller that writes it.
      } else if (
        ts.isCallExpression(user) &&
        user.expression.getText() === 'Object.keys' &&
        user.arguments[0] === use
      ) {
        // Counted.
      } else if (ts.isCallExpression(user) && chainsFromSessions(user.expression)) {
        // The write itself.
      } else {
        out.problems.push(`${name} used as ${user.getText().slice(0, 80)}`);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(fn);
}

function sessionWritesIn(fileName: string, source: string): SessionWrite[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const writes: SessionWrite[] = [];
  const visit = (n: ts.Node): void => {
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      ['update', 'upsert'].includes(n.expression.name.text) &&
      chainsFromSessions(n.expression.expression)
    ) {
      const line = sf.getLineAndCharacterOfPosition(n.getStart()).line + 1;
      const write: SessionWrite = { site: `${fileName}:${line}`, keys: [], problems: [] };
      const [payload] = n.arguments;
      if (payload) payloadKeys(payload, write);
      else write.problems.push('no payload');
      writes.push(write);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return writes;
}

function apiSourceFiles(dir = API_SRC): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      return path === join(API_SRC, 'test') ? [] : apiSourceFiles(path);
    }
    return /\.ts$/.test(name) && !/\.(test|test-support|d)\.ts$/.test(name) ? [path] : [];
  });
}

const census = apiSourceFiles().flatMap((path) =>
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
    expect(built).toEqual({ site: 'fixture.ts:1', keys: ['lifecycle'], problems: [] });
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

describe('no migration but the marker names turn_scope', () => {
  it('finds the column only where it is added', () => {
    const naming = readdirSync(MIGRATIONS).filter(
      (name) =>
        name.endsWith('.sql') && readFileSync(join(MIGRATIONS, name), 'utf8').includes(FORBIDDEN)
    );
    expect(naming).toEqual([MARKER_MIGRATION]);
  });
});
