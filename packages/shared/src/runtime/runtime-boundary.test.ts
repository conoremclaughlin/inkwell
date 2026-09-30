/**
 * The runtime subpath's boundary, checked on its source.
 *
 * `@inklabs/shared/runtime` is imported by hosts other than the CLI, several
 * sessions to a process. Three things would make that unsafe, and the rules in
 * ./README.md forbid them: an import that drags in host I/O, a host global read
 * from inside the loop, and module-level state two sessions would share.
 *
 * An import-graph check alone cannot see the second: `process.env` and
 * `Buffer` are globals, never imported. So this walks the TypeScript AST of
 * every non-test file in this directory and checks all three. The imports arm
 * requires every specifier to name one of those files, which makes the check
 * transitive: every file it can reach is a file this test scans. A file that
 * sits in the directory but is not scanned, such as a test, does not count.
 *
 * The checker is a plain function so it can be run against known answers first.
 * A guard that reports nothing on the real tree proves nothing unless the same
 * guard is shown to report each violation it claims to catch, and to stay quiet
 * on the look-alikes it must not flag.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { dirname, join, relative, resolve } from 'path';
import { fileURLToPath } from 'url';
import ts from 'typescript';

const RUNTIME_DIR = dirname(fileURLToPath(import.meta.url));

/** The files this test scans, and so the only files an import may reach. */
const SCANNED = new Set(runtimeSourceFiles(RUNTIME_DIR));

/**
 * The declared types under which a module-level `new` is allowed. TypeScript's
 * read-only collection interfaces have no mutators, while `Readonly<Set<T>>`
 * keeps `add`, so the match is by exact name. A file that declares either name
 * itself would shadow the global interface, so that is refused too.
 */
const READ_ONLY_COLLECTIONS = new Set(['ReadonlySet', 'ReadonlyMap']);

/** Globals a host provides and a browser or edge runtime does not. */
const HOST_GLOBALS = new Set([
  'process',
  'Buffer',
  'require',
  'module',
  'exports',
  '__dirname',
  '__filename',
  'global',
  'globalThis',
  'console',
]);

interface Violation {
  file: string;
  line: number;
  kind: 'import' | 'global' | 'module-state';
  detail: string;
  /** Name of the nearest enclosing declaration, when there is one. */
  enclosing?: string;
}

/**
 * Deterministic Node primitives, not host I/O: Buffer measures the relay cap,
 * and createHash preserves persisted ledger references. Neither permits a
 * general Node import. A second use or a stale allowance is a violation.
 */
const ALLOWED: ReadonlyArray<Pick<Violation, 'file' | 'kind' | 'detail' | 'enclosing'>> = [
  { file: 'agent-loop.ts', kind: 'global', detail: 'Buffer', enclosing: 'utf8Bytes' },
  { file: 'entry-ref-hash.ts', kind: 'import', detail: 'node:crypto::{createHash}' },
  // `ROLES.map` and `RESULT_STATUSES.map` build the grammar's choice pieces
  // once, from string literals into plain objects: the same kind of value as
  // the array literals around them, which the module-state rule tolerates. A
  // `.map` in general is not admitted, since its callback runs at load time.
  { file: 'imitation-grammar.ts', kind: 'module-state', detail: 'load-time call: HEADER' },
  { file: 'imitation-grammar.ts', kind: 'module-state', detail: 'load-time call: RESULT_LINE' },
];

/** A position where an identifier names a property or member, not a binding. */
function isPropertyName(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return true;
  if (ts.isQualifiedName(parent) && parent.right === node) return true;
  if (
    (ts.isPropertyAssignment(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isMethodSignature(parent) ||
      ts.isGetAccessorDeclaration(parent) ||
      ts.isSetAccessorDeclaration(parent) ||
      ts.isEnumMember(parent)) &&
    parent.name === node
  ) {
    return true;
  }
  if (ts.isBindingElement(parent) && parent.propertyName === node) return true;
  return false;
}

function enclosingName(node: ts.Node): string | undefined {
  for (let current = node.parent; current; current = current.parent) {
    if (
      (ts.isVariableDeclaration(current) ||
        ts.isFunctionDeclaration(current) ||
        ts.isClassDeclaration(current) ||
        ts.isMethodDeclaration(current)) &&
      current.name &&
      ts.isIdentifier(current.name)
    ) {
      return current.name.text;
    }
  }
  return undefined;
}

/**
 * Whether a specifier names a scanned file: relative, spelled with the `.js`
 * extension the build emits, and backed by a `.ts` file this test reads. Being
 * inside the directory is not enough; a test file, a `.mts` file or a missing
 * file would be reachable and unchecked.
 */
function reachesScannedFile(filePath: string, specifier: string): boolean {
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) return false;
  if (!specifier.endsWith('.js')) return false;
  const target = resolve(dirname(filePath), `${specifier.slice(0, -'.js'.length)}.ts`);
  return SCANNED.has(target);
}

/** The expression under any parentheses, type assertions, `!` and `satisfies`. */
function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

/**
 * Whether `child` runs when `parent` is called or constructed rather than when
 * the module loads: a function's parameters and body, and an instance field's
 * initializer. Names, decorators and static fields all run at load.
 */
function runsLater(parent: ts.Node, child: ts.Node): boolean {
  if (ts.isFunctionLike(parent)) {
    const body = 'body' in parent ? parent.body : undefined;
    return child === body || (parent.parameters as ReadonlyArray<ts.Node>).includes(child);
  }
  if (ts.isPropertyDeclaration(parent)) {
    const isStatic = parent.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword
    );
    return !isStatic && child === parent.initializer;
  }
  return false;
}

/** Whether an identifier is the name a declaration introduces. */
function isDeclaredName(node: ts.Identifier): boolean {
  const parent = node.parent;
  return (
    (ts.isTypeAliasDeclaration(parent) ||
      ts.isInterfaceDeclaration(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isEnumDeclaration(parent) ||
      ts.isModuleDeclaration(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isVariableDeclaration(parent) ||
      ts.isTypeParameterDeclaration(parent) ||
      ts.isImportClause(parent) ||
      ts.isImportSpecifier(parent) ||
      ts.isNamespaceImport(parent) ||
      ts.isImportEqualsDeclaration(parent)) &&
    parent.name === node
  );
}

function isReadOnlyCollection(type: ts.TypeNode | undefined): boolean {
  return (
    type !== undefined &&
    ts.isTypeReferenceNode(type) &&
    ts.isIdentifier(type.typeName) &&
    READ_ONLY_COLLECTIONS.has(type.typeName.text)
  );
}

/**
 * Load-time callees and template tags whose result can hold no shared mutable
 * state: a symbol, a raw string, and a frozen value. Freezing is shallow, so the
 * ARGUMENTS are still checked like any other load-time code:
 * `Object.freeze(new Map())` is refused for the Map. Matched on the callee as
 * written, never through a wrapper or an alias.
 */
const INERT_LOAD_TIME_CALLEES = new Set(['Object.freeze', 'Symbol', 'Symbol.for', 'String.raw']);

function calleeText(callee: ts.Expression): string | undefined {
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
    return `${callee.expression.text}.${callee.name.text}`;
  }
  return undefined;
}

/**
 * A call that runs when the module loads and could return an object every
 * session then shares. `new` is not the only way to make one: a factory call,
 * an immediately invoked function, a tagged template and an alias of a Node
 * factory all create it through a call, with any `new` hidden in a function
 * body the `new` arm rightly treats as running later. `import()` is left to the
 * imports arm, which already reports it.
 */
function isLoadTimeStatefulCall(node: ts.Node): boolean {
  let callee: ts.Expression;
  if (ts.isTaggedTemplateExpression(node)) callee = node.tag;
  else if (ts.isCallExpression(node)) callee = node.expression;
  else return false;
  if (callee.kind === ts.SyntaxKind.ImportKeyword) return false;
  const name = calleeText(callee);
  return name === undefined || !INERT_LOAD_TIME_CALLEES.has(name);
}

/**
 * Every boundary violation in one source file. `filePath` is where the file
 * lives (or would live) on disk; relative imports are resolved against it.
 */
function boundaryViolations(filePath: string, sourceText: string): Violation[] {
  const source = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.ES2022, true);
  const file = relative(RUNTIME_DIR, filePath);
  const violations: Violation[] = [];
  const lineOf = (node: ts.Node): number =>
    source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  /** Whether this file holds the one allowed `createHash` import. */
  let hashImported = false;

  const checkSpecifier = (node: ts.Node, specifier: ts.Expression | undefined): void => {
    if (!specifier) return;
    if (!ts.isStringLiteralLike(specifier)) {
      violations.push({ file, line: lineOf(node), kind: 'import', detail: '<computed specifier>' });
      return;
    }
    if (!reachesScannedFile(filePath, specifier.text)) {
      // Recognize only the exact named import; namespace/default/extra bindings,
      // re-exports and dynamic loads must not inherit the ledger's allowance.
      const clause = ts.isImportDeclaration(node) ? node.importClause : undefined;
      const bindings = clause?.namedBindings;
      const hashOnly =
        specifier.text === 'node:crypto' &&
        clause &&
        !clause.name &&
        !clause.isTypeOnly &&
        bindings &&
        ts.isNamedImports(bindings) &&
        bindings.elements.length === 1 &&
        bindings.elements[0].name.text === 'createHash' &&
        !bindings.elements[0].propertyName &&
        !bindings.elements[0].isTypeOnly;
      if (hashOnly) hashImported = true;
      violations.push({
        file,
        line: lineOf(node),
        kind: 'import',
        detail: hashOnly ? 'node:crypto::{createHash}' : specifier.text,
      });
    }
  };

  /**
   * The allowed `createHash` import is for calling it, so every reference must
   * be the callee of a direct call: exporting, aliasing, wrapping or passing
   * the binding hands the Node primitive to files the import rule never
   * admitted.
   */
  const checkHashBinding = (node: ts.Node): void => {
    if (
      ts.isIdentifier(node) &&
      node.text === 'createHash' &&
      !isPropertyName(node) &&
      !ts.isImportSpecifier(node.parent)
    ) {
      const parent = node.parent;
      if (!(ts.isCallExpression(parent) && parent.expression === node)) {
        violations.push({
          file,
          line: lineOf(node),
          kind: 'import',
          detail: 'node:crypto::createHash escapes its call site',
        });
      }
    }
    ts.forEachChild(node, checkHashBinding);
  };

  const reportState = (node: ts.Node, detail: string): void => {
    violations.push({ file, line: lineOf(node), kind: 'module-state', detail });
  };

  /** Load-time `new`s that a const declared as a read-only collection admits. */
  const admitted = new Set<ts.Node>();

  /**
   * Module state is whatever runs once, when the module loads, and so is shared
   * by every session in the process. That is anywhere outside a function body
   * or an instance field, however deeply nested or wrapped.
   */
  const checkLoadTime = (node: ts.Node): void => {
    if (ts.isVariableDeclarationList(node)) {
      const isConst = (node.flags & ts.NodeFlags.BlockScoped) === ts.NodeFlags.Const;
      for (const declaration of node.declarations) {
        const name = ts.isIdentifier(declaration.name) ? declaration.name.text : '<pattern>';
        if (!isConst) {
          reportState(declaration, `top-level let/var ${name}`);
          continue;
        }
        const init = declaration.initializer && unwrap(declaration.initializer);
        if (init && ts.isNewExpression(init) && isReadOnlyCollection(declaration.type)) {
          admitted.add(init);
        }
      }
    } else if (isLoadTimeStatefulCall(node)) {
      reportState(node, `load-time call: ${enclosingName(node) ?? '<module>'}`);
    } else if (ts.isNewExpression(node) && !admitted.has(node)) {
      reportState(node, `load-time new: ${enclosingName(node) ?? '<module>'}`);
    } else if (ts.isRegularExpressionLiteral(node)) {
      const flags = node.text.slice(node.text.lastIndexOf('/') + 1);
      if (/[gy]/.test(flags)) {
        reportState(node, `load-time stateful regex: ${enclosingName(node) ?? '<module>'}`);
      }
    }
  };

  const visit = (node: ts.Node, loadTime: boolean): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      checkSpecifier(node, node.moduleSpecifier);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      checkSpecifier(node, node.moduleReference.expression);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      checkSpecifier(node, node.arguments[0]);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      checkSpecifier(node, node.argument.literal);
    } else if (ts.isIdentifier(node) && HOST_GLOBALS.has(node.text) && !isPropertyName(node)) {
      violations.push({
        file,
        line: lineOf(node),
        kind: 'global',
        detail: node.text,
        enclosing: enclosingName(node),
      });
    }
    if (ts.isIdentifier(node) && READ_ONLY_COLLECTIONS.has(node.text) && isDeclaredName(node)) {
      reportState(node, `declares ${node.text}`);
    }
    if (loadTime) checkLoadTime(node);
    ts.forEachChild(node, (child) => visit(child, loadTime && !runsLater(node, child)));
  };
  visit(source, true);
  if (hashImported) checkHashBinding(source);

  return violations;
}

function runtimeSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...runtimeSourceFiles(path));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) files.push(path);
  }
  return files.sort();
}

/** Check a synthetic file as if it sat in this directory. */
function check(sourceText: string, name = 'synthetic.ts'): Violation[] {
  return boundaryViolations(join(RUNTIME_DIR, name), sourceText);
}

const kinds = (violations: Violation[]): string[] =>
  violations.map((violation) => `${violation.kind}:${violation.detail}`);

const moduleState = (violations: Violation[]): Violation[] =>
  violations.filter((violation) => violation.kind === 'module-state');

describe('runtime boundary checker, against known answers', () => {
  it('reports nothing for a file that keeps every rule', () => {
    const clean = [
      "import { fenceAfterLine } from './imitation-grammar.js';",
      "export { isImitationHeaderLine } from './imitation-grammar.js';",
      "import type { OpenFence } from './imitation-grammar.js';",
      'export const measure = (text: string): number => text.length;',
      "const TABLE: ReadonlySet<string> = new Set(['a']);",
      'const PATTERN = /^a/i;',
      "const ROLES = ['user', 'assistant'];",
      'export function run(): void { let local = 0; local += 1; }',
    ].join('\n');
    expect(check(clean)).toEqual([]);
  });

  it('stays quiet when a host global name is only a property or member name', () => {
    const lookalikes = [
      'export const a = (o: { process: number }) => o.process;',
      'export const b = { Buffer: 1, require: 2 };',
      'export interface C { global: string; module(): void }',
      'export class D { exports = 1; get process() { return 1; } }',
      'export enum E { require }',
      'export const f = ({ process: renamed }: { process: number }) => renamed;',
    ].join('\n');
    expect(check(lookalikes)).toEqual([]);
  });

  it.each([
    ["import fs from 'fs';", 'import:fs'],
    ["import { readFile } from 'node:fs/promises';", 'import:node:fs/promises'],
    ["import { spawnBackend } from '@inklabs/shared';", 'import:@inklabs/shared'],
    ["export * from '../runner/index.js';", 'import:../runner/index.js'],
    [
      "import type { InkContextToken } from '../runner/mcp-config.js';",
      'import:../runner/mcp-config.js',
    ],
    ["export const load = () => import('child_process');", 'import:child_process'],
    ["import os = require('os');", 'import:os'],
    ["export type T = import('../index.js').InkContextToken;", 'import:../index.js'],
  ])('reports an import that leaves the directory: %s', (source, expected) => {
    expect(kinds(check(source))).toContain(expected);
  });

  it.each([
    ["export { host } from './review-host-helper.test.js';", 'import:./review-host-helper.test.js'],
    ["export * from './agent-loop.test.js';", 'import:./agent-loop.test.js'],
    ["import { helper } from './helper.mjs';", 'import:./helper.mjs'],
    ["import { missing } from './missing.js';", 'import:./missing.js'],
    ["import { fenceAfterLine } from './imitation-grammar';", 'import:./imitation-grammar'],
  ])(
    'reports an import that stays in the directory but reaches no scanned file: %s',
    (source, expected) => {
      expect(kinds(check(source))).toContain(expected);
    }
  );

  it('reports a test file re-exported from the real index, though it exists here', () => {
    const index = join(RUNTIME_DIR, 'index.ts');
    expect(existsSync(join(RUNTIME_DIR, 'agent-loop.test.ts'))).toBe(true);
    const probe = `${readFileSync(index, 'utf8')}\nexport * from './agent-loop.test.js';\n`;
    expect(kinds(boundaryViolations(index, probe))).toEqual(['import:./agent-loop.test.js']);
  });

  it.each([
    ['export const home = process.env.HOME;', 'global:process'],
    ["export const size = Buffer.from('x').length;", 'global:Buffer'],
    ["export const os = require('os');", 'global:require'],
    ['export const here = __dirname;', 'global:__dirname'],
    ['export const f = globalThis.fetch;', 'global:globalThis'],
    ['export const shorthand = { process };', 'global:process'],
    ["console.warn('host output');", 'global:console'],
  ])('reports a host global: %s', (source, expected) => {
    expect(kinds(check(source))).toContain(expected);
  });

  it.each([
    ['let counter = 0;', 'module-state:top-level let/var counter'],
    ['var legacy = 1;', 'module-state:top-level let/var legacy'],
    ['export let exported = 0;', 'module-state:top-level let/var exported'],
    ['const cache = new Map<string, number>();', 'module-state:load-time new: cache'],
    ['const seen: Set<string> = new Set();', 'module-state:load-time new: seen'],
    ['const GLOBAL = /a/g;', 'module-state:load-time stateful regex: GLOBAL'],
    ['const STICKY = /a/y;', 'module-state:load-time stateful regex: STICKY'],
    ['type ReadonlySet<T> = Set<T>;', 'module-state:declares ReadonlySet'],
  ])('reports module-level state: %s', (source, expected) => {
    expect(kinds(check(source))).toContain(expected);
  });

  it.each([
    'const cache = (new Map<string, number>());',
    'const cache = new Map<string, number>() as Map<string, number>;',
    'const cache = <Map<string, number>>new Map();',
    'const cache = new Map<string, number>()!;',
    'const cache = new Map<string, number>() satisfies Map<string, number>;',
    'const matcher = (/x/g);',
    'const matcher = /x/y as RegExp;',
  ])('sees module-level state through a transparent wrapper: %s', (source) => {
    expect(moduleState(check(source))).toHaveLength(1);
  });

  it.each([
    'const TABLE = { cache: new Map<string, number>() };',
    'const PATTERNS = [/a/g];',
    'export class Registry { static cache = new Map<string, number>(); }',
    'export default new Map<string, number>();',
    "const TABLE: ReadonlyMap<string, Set<string>> = new Map([['a', new Set<string>()]]);",
  ])('sees module-level state nested anywhere it runs at load time: %s', (source) => {
    expect(moduleState(check(source))).toHaveLength(1);
  });

  it.each([
    'const cache: Readonly<Set<string>> = new Set();',
    'type ReadonlyCache = Map<string, number>;\nconst cache: ReadonlyCache = new Map();',
    'type ReadonlySet<T> = Set<T>;\nconst cache: ReadonlySet<string> = new Set();',
    'declare global { interface ReadonlySet<T> { add(value: T): this } }\nconst cache: ReadonlySet<string> = new Set();',
  ])('admits only an unshadowed ReadonlySet or ReadonlyMap: %s', (source) => {
    expect(moduleState(check(source))).toHaveLength(1);
  });

  it('stays quiet on allocations and regexes that run per call, and on the admitted tables', () => {
    const later = [
      'export function make(): Map<string, number> { return new Map(); }',
      'export const makeArrow = (): Map<string, number> => new Map();',
      'export function withDefault(seen = new Set<string>()): Set<string> { return seen; }',
      'export class Box { items = new Map<string, number>(); static make(): Box { return new Box(); } }',
      'export const scan = (text: string) => text.match(/a/g);',
      "const RAN: ReadonlySet<string> = (new Set(['executed']));",
      "const INDEX: ReadonlyMap<string, number> = new Map([['a', 1]]);",
    ].join('\n');
    expect(check(later)).toEqual([]);
  });

  it('records the enclosing declaration, which is what the allowlist matches on', () => {
    const [violation] = check(
      "const utf8Bytes = (text: string): number => Buffer.byteLength(text, 'utf8');",
      'agent-loop.ts'
    );
    expect(violation).toMatchObject({
      file: 'agent-loop.ts',
      kind: 'global',
      detail: 'Buffer',
      enclosing: 'utf8Bytes',
    });
  });

  it('recognizes only the exact hash import as the reviewed Node primitive', () => {
    const source = "import { createHash } from 'node:crypto';";
    const allowed = ALLOWED[1];
    expect(check(source, 'entry-ref-hash.ts')).toEqual([{ ...allowed, line: 1 }]);
    expect(check(source, 'another.ts')[0].file).not.toBe(allowed.file);
  });

  it.each([
    "import crypto from 'node:crypto';",
    "import * as crypto from 'node:crypto';",
    "import 'node:crypto';",
    "import { createHash, randomBytes } from 'node:crypto';",
    "import { randomBytes as createHash } from 'node:crypto';",
    "import { createHash as h } from 'node:crypto';",
    "import type { createHash } from 'node:crypto';",
    "export { createHash } from 'node:crypto';",
    "export * from 'node:crypto';",
    "const load = () => import('node:crypto');",
  ])('does not widen the hash allowance: %s', (source) => {
    expect(kinds(check(source, 'entry-ref-hash.ts'))).toContain('import:node:crypto');
  });

  it('refuses the bare crypto specifier, which could silently acquire a browser polyfill', () => {
    expect(kinds(check("import { createHash } from 'crypto';", 'entry-ref-hash.ts'))).toEqual([
      'import:crypto',
    ]);
  });

  it('refuses a shared hash accumulator but permits per-call hashing', () => {
    expect(kinds(check("const H = createHash('sha1');"))).toEqual([
      'module-state:load-time call: H',
    ]);
    expect(
      check("export const h = (s: string) => createHash('sha1').update(s).digest('hex');")
    ).toEqual([]);
  });

  // A `new` inside a function runs later, so a factory that returns one hides
  // it from the `new` arm; the state is created by the CALL, at load time.
  it.each([
    'function makeCache() { return new Map<string, number>(); }\nconst cache = makeCache();',
    'const cache = (() => new Map<string, number>())();',
    "const make = createHash;\nconst H = make('sha1');",
    "const H = (createHash)('sha1');",
    "const H = createHash.call(undefined, 'sha1');",
    'const tag = (_: TemplateStringsArray) => new Map<string, number>();\nconst T = tag`x`;',
    'export default makeRegistry();',
    'export class Registry { static instance = makeRegistry(); }',
    'const FROZEN = Object.freeze(new Map<string, number>());',
  ])('sees module-level state created by a load-time call: %s', (source) => {
    expect(moduleState(check(source))).toHaveLength(1);
  });

  it('admits only load-time calls that return no shared mutable object', () => {
    const inert = [
      "const FROZEN = Object.freeze(['a', 'b']);",
      "const KEY = Symbol('key');",
      "const SHARED_KEY = Symbol.for('ink.key');",
      'const DIGITS = String.raw`\\d+`;',
    ].join('\n');
    expect(check(inert)).toEqual([]);
  });

  it.each([
    "import { createHash } from 'node:crypto';\nexport { createHash };",
    "import { createHash } from 'node:crypto';\nexport { createHash as hash };",
    "import { createHash } from 'node:crypto';\nexport const hash = createHash;",
    "import { createHash } from 'node:crypto';\nexport const hash = (s: string) => (0, createHash)('sha1').update(s).digest('hex');",
    "import { createHash } from 'node:crypto';\nexport const run = (f: (a: string) => unknown) => f;\nexport const leak = () => run(createHash);",
  ])('keeps the allowed createHash binding at its call sites: %s', (source) => {
    expect(kinds(check(source, 'entry-ref-hash.ts'))).toContain(
      'import:node:crypto::createHash escapes its call site'
    );
  });

  it('stays quiet on the one sanctioned shape: direct per-call use of createHash', () => {
    const source = [
      "import { createHash } from 'node:crypto';",
      'export function entryRefHash(role: string, content: string): string {',
      "  return 'sha1:' + createHash('sha1').update(`${role}|${content}`).digest('hex');",
      '}',
    ].join('\n');
    expect(check(source, 'entry-ref-hash.ts')).toEqual([{ ...ALLOWED[1], line: 1 }]);
  });
});

describe('@inklabs/shared/runtime keeps its boundary', () => {
  const files = runtimeSourceFiles(RUNTIME_DIR);
  const found = files.flatMap((path) => boundaryViolations(path, readFileSync(path, 'utf8')));
  const isAllowed = (violation: Violation): boolean =>
    ALLOWED.some(
      (allowed) =>
        allowed.file === violation.file &&
        allowed.kind === violation.kind &&
        allowed.detail === violation.detail &&
        allowed.enclosing === violation.enclosing
    );

  it('scans the files the subpath ships', () => {
    const names = files.map((path) => relative(RUNTIME_DIR, path));
    expect(names).toEqual(
      expect.arrayContaining([
        'agent-loop.ts',
        'imitation-grammar.ts',
        'index.ts',
        'context-ledger.ts',
        'hook-registry.ts',
        'builtin-hooks.ts',
        'entry-ref-hash.ts',
      ])
    );
  });

  it('has no violation outside the allowlist', () => {
    expect(found.filter((violation) => !isAllowed(violation))).toEqual([]);
  });

  it('uses each allowlisted exception exactly once, so a stale entry fails too', () => {
    for (const allowed of ALLOWED) {
      const uses = found.filter(
        (violation) =>
          violation.file === allowed.file &&
          violation.kind === allowed.kind &&
          violation.detail === allowed.detail &&
          violation.enclosing === allowed.enclosing
      );
      expect(uses, `${allowed.file} ${allowed.detail} in ${allowed.enclosing}`).toHaveLength(1);
    }
  });
});
