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
 * requires every specifier to stay inside this directory, which makes the
 * check transitive: every file it can reach is a file this test scans.
 *
 * The checker is a plain function so it can be run against known answers first.
 * A guard that reports nothing on the real tree proves nothing unless the same
 * guard is shown to report each violation it claims to catch, and to stay quiet
 * on the look-alikes it must not flag.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { dirname, join, relative, resolve, sep } from 'path';
import { fileURLToPath } from 'url';
import ts from 'typescript';

const RUNTIME_DIR = dirname(fileURLToPath(import.meta.url));

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
 * The one sanctioned host global: `Buffer.byteLength` counts UTF-8 bytes for
 * the relay cap. It makes the runtime Node-compatible rather than
 * browser-native, which is the documented ceiling. A second use is a
 * violation, and so is this entry once the use is gone.
 */
const ALLOWED: ReadonlyArray<Pick<Violation, 'file' | 'kind' | 'detail' | 'enclosing'>> = [
  { file: 'agent-loop.ts', kind: 'global', detail: 'Buffer', enclosing: 'utf8Bytes' },
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

function specifierStaysInside(filePath: string, specifier: string): boolean {
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) return false;
  const target = resolve(dirname(filePath), specifier);
  return target.startsWith(RUNTIME_DIR + sep);
}

function hasModifier(flags: ts.NodeFlags, flag: ts.NodeFlags): boolean {
  return (flags & flag) !== 0;
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

  const checkSpecifier = (node: ts.Node, specifier: ts.Expression | undefined): void => {
    if (!specifier) return;
    if (!ts.isStringLiteralLike(specifier)) {
      violations.push({ file, line: lineOf(node), kind: 'import', detail: '<computed specifier>' });
      return;
    }
    if (!specifierStaysInside(filePath, specifier.text)) {
      violations.push({ file, line: lineOf(node), kind: 'import', detail: specifier.text });
    }
  };

  const visit = (node: ts.Node): void => {
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
    ts.forEachChild(node, visit);
  };
  visit(source);

  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    const listFlags = statement.declarationList.flags;
    const isConst = hasModifier(listFlags, ts.NodeFlags.Const);
    for (const declaration of statement.declarationList.declarations) {
      const name = ts.isIdentifier(declaration.name) ? declaration.name.text : '<pattern>';
      const report = (detail: string): void => {
        violations.push({ file, line: lineOf(declaration), kind: 'module-state', detail });
      };
      if (!isConst) {
        report(`top-level let/var ${name}`);
        continue;
      }
      const init = declaration.initializer;
      if (!init) continue;
      if (ts.isNewExpression(init)) {
        const type = declaration.type;
        const readonlyTyped =
          type !== undefined &&
          ts.isTypeReferenceNode(type) &&
          ts.isIdentifier(type.typeName) &&
          type.typeName.text.startsWith('Readonly');
        if (!readonlyTyped) report(`top-level new without a Readonly type: ${name}`);
      }
      if (ts.isRegularExpressionLiteral(init)) {
        const flags = init.text.slice(init.text.lastIndexOf('/') + 1);
        if (/[gy]/.test(flags)) report(`top-level stateful regex: ${name}`);
      }
    }
  }

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
    ['export const home = process.env.HOME;', 'global:process'],
    ["export const size = Buffer.from('x').length;", 'global:Buffer'],
    ["export const os = require('os');", 'global:require'],
    ['export const here = __dirname;', 'global:__dirname'],
    ['export const f = globalThis.fetch;', 'global:globalThis'],
    ['export const shorthand = { process };', 'global:process'],
  ])('reports a host global: %s', (source, expected) => {
    expect(kinds(check(source))).toContain(expected);
  });

  it.each([
    ['let counter = 0;', 'module-state:top-level let/var counter'],
    ['var legacy = 1;', 'module-state:top-level let/var legacy'],
    ['export let exported = 0;', 'module-state:top-level let/var exported'],
    [
      'const cache = new Map<string, number>();',
      'module-state:top-level new without a Readonly type: cache',
    ],
    [
      'const seen: Set<string> = new Set();',
      'module-state:top-level new without a Readonly type: seen',
    ],
    ['const GLOBAL = /a/g;', 'module-state:top-level stateful regex: GLOBAL'],
    ['const STICKY = /a/y;', 'module-state:top-level stateful regex: STICKY'],
  ])('reports module-level state: %s', (source, expected) => {
    expect(kinds(check(source))).toContain(expected);
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
      expect.arrayContaining(['agent-loop.ts', 'imitation-grammar.ts', 'index.ts'])
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
