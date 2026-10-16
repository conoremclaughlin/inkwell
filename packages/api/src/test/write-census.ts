/**
 * A census of the writes api source makes to one table: every update, upsert
 * or insert chained onto that table, with the keys its payload can carry.
 *
 * A column held fixed in server code (sessions.turn_scope,
 * inbox_threads.conversation_mode) is pinned by asserting that no write in
 * the census names it, or only the one that is allowed to. That only means
 * something when every key a payload can carry is known, so the census also
 * reports, as a problem, any payload whose keys it cannot read: a computed
 * key, a spread of a caller's object, a payload handed to a function, or one
 * that comes from a call.
 *
 * A write is "chained onto the table" when its call chain starts at
 * `.from('<table>')` or at `threadTable(client, '<table>')`, the inbox
 * helper. Outside the census: a service-role or raw SQL write, and a query
 * builder stored in a variable before the write method is called on it.
 */

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

export interface TableWrite {
  site: string;
  method: string;
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

/** Whether this call names the table: `.from('<table>')` or `threadTable(_, '<table>')`. */
function namesTable(call: ts.CallExpression, table: string): boolean {
  const callee = call.expression;
  const [first, second] = call.arguments;
  if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'from') {
    return !!first && ts.isStringLiteralLike(first) && first.text === table;
  }
  if (ts.isIdentifier(callee) && callee.text === 'threadTable') {
    return !!second && ts.isStringLiteralLike(second) && second.text === table;
  }
  return false;
}

/** Whether a call chain starts at the table. */
export function chainsFromTable(expression: ts.Expression, table: string): boolean {
  let e: ts.Expression | undefined = expression;
  while (e) {
    e = unwrap(e);
    if (ts.isCallExpression(e)) {
      if (namesTable(e, table)) return true;
      const callee = e.expression;
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
function payloadKeys(expression: ts.Expression, out: TableWrite, table: string, depth = 0): void {
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
          payloadKeys(spread, out, table, depth + 1);
        } else {
          out.problems.push(`spread of ${spread.getText()}`);
        }
      } else {
        out.problems.push(`unsupported member ${property.getText()}`);
      }
    }
  } else if (ts.isConditionalExpression(e)) {
    payloadKeys(e.whenTrue, out, table, depth + 1);
    payloadKeys(e.whenFalse, out, table, depth + 1);
  } else if (ts.isIdentifier(e)) {
    variableKeys(e, out, table, depth);
  } else {
    out.problems.push(`payload is ${ts.SyntaxKind[e.kind]}: ${e.getText()}`);
  }
}

function variableKeys(identifier: ts.Identifier, out: TableWrite, table: string, depth: number) {
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
      variableKeys(returnedVariable, out, table, depth + 1);
    } else {
      out.problems.push(
        `${name} comes from ${init.expression.name.text}, which returns no variable`
      );
    }
  } else {
    payloadKeys(init, out, table, depth + 1);
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
      } else if (ts.isCallExpression(user) && chainsFromTable(user.expression, table)) {
        // The write itself.
      } else {
        out.problems.push(`${name} used as ${user.getText().slice(0, 80)}`);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(fn);
}

/** Every write in one source file chained onto the table, by the methods named. */
export function tableWritesIn(
  fileName: string,
  source: string,
  table: string,
  methods: readonly string[] = ['update', 'upsert']
): TableWrite[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const writes: TableWrite[] = [];
  const visit = (n: ts.Node): void => {
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      methods.includes(n.expression.name.text) &&
      chainsFromTable(n.expression.expression, table)
    ) {
      const line = sf.getLineAndCharacterOfPosition(n.getStart()).line + 1;
      const write: TableWrite = {
        site: `${fileName}:${line}`,
        method: n.expression.name.text,
        keys: [],
        problems: [],
      };
      const [payload] = n.arguments;
      if (payload) payloadKeys(payload, write, table);
      else write.problems.push('no payload');
      writes.push(write);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return writes;
}

/**
 * Every api source file under `root` (packages/api/src) the census reads: no
 * tests, test support or declarations, and nothing under src/test.
 */
export function apiSourceFiles(root: string, dir = root): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      return path === join(root, 'test') ? [] : apiSourceFiles(root, path);
    }
    return /\.ts$/.test(name) && !/\.(test|test-support|d)\.ts$/.test(name) ? [path] : [];
  });
}
