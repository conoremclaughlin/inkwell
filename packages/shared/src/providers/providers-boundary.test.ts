/**
 * The providers subpath's import closure, checked on its source.
 *
 * `@inklabs/shared/providers` is what both the CLI and a server host spawn a
 * provider turn through, so it must not reach either of them: no
 * `@inklabs/cli`, no api code, and not the `@inklabs/shared` root barrel,
 * which would drag in everything else the package carries. It is Node-only
 * by design (it spawns processes and reads config files), so Node built-ins
 * are allowed. Inside the package it may reach its own files and the two
 * layers it is built on: `../runner` (spawnBackend, the MCP config helpers)
 * and `../runtime` (token usage).
 *
 * The checker is a plain function, run against known answers first, as the
 * runtime boundary test does: a guard that reports nothing on the real tree
 * proves nothing unless it reports each violation it claims to catch.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { builtinModules } from 'module';
import { dirname, join, relative, resolve } from 'path';
import { fileURLToPath } from 'url';
import ts from 'typescript';

const PROVIDERS_DIR = dirname(fileURLToPath(import.meta.url));
const SHARED_SRC = resolve(PROVIDERS_DIR, '..');

/** Shared directories a providers file may import from, besides its own. */
const ALLOWED_SHARED_DIRS = ['providers', 'runner', 'runtime'].map((d) => join(SHARED_SRC, d));

const NODE_BUILTINS: ReadonlySet<string> = new Set(builtinModules);

function isNodeBuiltin(specifier: string): boolean {
  const bare = specifier.startsWith('node:') ? specifier.slice('node:'.length) : specifier;
  return NODE_BUILTINS.has(bare) || NODE_BUILTINS.has(bare.split('/')[0]);
}

/**
 * Whether a relative specifier names an existing non-test `.ts` file, by its
 * `.js` path, inside one of the allowed shared directories.
 */
function reachesAllowedFile(filePath: string, specifier: string): boolean {
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) return false;
  if (!specifier.endsWith('.js')) return false;
  const target = resolve(dirname(filePath), `${specifier.slice(0, -'.js'.length)}.ts`);
  if (target.endsWith('.test.ts') || !existsSync(target)) return false;
  return ALLOWED_SHARED_DIRS.some((dir) => dirname(target) === dir);
}

interface Violation {
  file: string;
  line: number;
  specifier: string;
}

function importViolations(filePath: string, sourceText: string): Violation[] {
  const source = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.ES2022, true);
  const file = relative(PROVIDERS_DIR, filePath);
  const violations: Violation[] = [];
  const check = (node: ts.Node, specifier: ts.Expression | undefined): void => {
    if (!specifier) return;
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    if (!ts.isStringLiteralLike(specifier)) {
      violations.push({ file, line, specifier: '<computed specifier>' });
      return;
    }
    const text = specifier.text;
    if (!isNodeBuiltin(text) && !reachesAllowedFile(filePath, text)) {
      violations.push({ file, line, specifier: text });
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      check(node, node.moduleSpecifier);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      check(node, node.moduleReference.expression);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      check(node, node.arguments[0]);
    } else if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'require'
    ) {
      check(node, node.arguments[0]);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      check(node, node.argument.literal);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return violations;
}

function providersSourceFiles(): string[] {
  return readdirSync(PROVIDERS_DIR)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => join(PROVIDERS_DIR, name))
    .sort();
}

/** The relative module specifiers a file imports, in every form the checker reads. */
function relativeSpecifiers(filePath: string, sourceText: string): string[] {
  const source = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.ES2022, true);
  const found: string[] = [];
  const take = (specifier: ts.Expression | undefined): void => {
    if (specifier && ts.isStringLiteralLike(specifier) && specifier.text.startsWith('.')) {
      found.push(specifier.text);
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      take(node.moduleSpecifier);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      take(node.moduleReference.expression);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    ) {
      take(node.arguments[0]);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      take(node.argument.literal);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/**
 * Every file the providers sources reach, following relative imports
 * transitively: the runner and runtime modules they use, and whatever those
 * import in turn. A rule checked only on the providers directory would admit
 * anything one hop away.
 */
function closureFiles(): string[] {
  const seen = new Set<string>();
  const queue = providersSourceFiles();
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const specifier of relativeSpecifiers(file, readFileSync(file, 'utf8'))) {
      const target = resolve(dirname(file), specifier.replace(/\.js$/, '.ts'));
      if (existsSync(target)) queue.push(target);
    }
  }
  return [...seen].sort();
}

const check = (text: string) => importViolations(join(PROVIDERS_DIR, 'synthetic.ts'), text);
const specifiers = (text: string) => check(text).map((v) => v.specifier);

describe('providers import checker, against known answers', () => {
  it('admits Node built-ins, its own files, and the runner and runtime layers', () => {
    const clean = [
      "import { mkdirSync } from 'fs';",
      "import { join } from 'node:path';",
      "import { spawn } from 'child_process';",
      "import type { BackendConfig } from './types.js';",
      "export * from './registry.js';",
      "import { spawnBackend } from '../runner/spawn-backend.js';",
      "import { extractBackendTokenUsage } from '../runtime/token-usage.js';",
    ].join('\n');
    expect(check(clean)).toEqual([]);
  });

  it.each([
    ["import { runChat } from '@inklabs/cli';", '@inklabs/cli'],
    ["import { x } from '@inklabs/shared';", '@inklabs/shared'],
    ["import { x } from '@inklabs/shared/runtime';", '@inklabs/shared/runtime'],
    [
      "import { x } from '../../../api/src/services/sessions/session-service.js';",
      '../../../api/src/services/sessions/session-service.js',
    ],
    ["import { x } from '../../../cli/src/commands/chat.js';", '../../../cli/src/commands/chat.js'],
    ["import { x } from '../index.js';", '../index.js'],
    ["import { x } from '../studio/checklist.js';", '../studio/checklist.js'],
    ["import chalk from 'chalk';", 'chalk'],
    ["export * from './backend-runner.test.js';", './backend-runner.test.js'],
    ["import { x } from './missing.js';", './missing.js'],
    ["import { x } from './registry';", './registry'],
    ["const m = () => import('@inklabs/cli');", '@inklabs/cli'],
    ["const m = require('@inklabs/api');", '@inklabs/api'],
    ["export type T = import('@inklabs/cli').X;", '@inklabs/cli'],
  ])('refuses an import outside the closure: %s', (source, expected) => {
    expect(specifiers(source)).toContain(expected);
  });
});

describe('@inklabs/shared/providers keeps its closure', () => {
  const files = providersSourceFiles();

  it('scans the files the subpath ships', () => {
    const names = files.map((path) => relative(PROVIDERS_DIR, path));
    expect(names).toEqual(
      expect.arrayContaining([
        'index.ts',
        'backend-runner.ts',
        'claude.ts',
        'codex.ts',
        'gemini.ts',
        'registry.ts',
        'skill-mcp.ts',
      ])
    );
  });

  it('imports nothing outside Node, its own files and the runner and runtime layers', () => {
    const found = files.flatMap((path) => importViolations(path, readFileSync(path, 'utf8')));
    expect(found).toEqual([]);
  });

  // The same rule over everything reachable, not only the first hop (Myra,
  // P2a review): a runner or runtime module the providers use is shipped
  // with them, and so is whatever it imports.
  it('reaches nothing outside Node and those three layers, however many hops away', () => {
    const closure = closureFiles();
    const reached = closure.map((path) => relative(SHARED_SRC, path));
    // Known members, so a walker that stopped at the first hop would fail here.
    expect(reached).toEqual(
      expect.arrayContaining([
        'providers/backend-runner.ts',
        'runner/spawn-backend.ts',
        'runner/mcp-config.ts',
        'runtime/token-usage.ts',
      ])
    );
    const found = closure.flatMap((path) => importViolations(path, readFileSync(path, 'utf8')));
    expect(found).toEqual([]);
  });
});
