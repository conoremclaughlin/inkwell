/**
 * A spawn's preparation reads nothing from the process it runs in and never
 * blocks it, checked on the source.
 *
 * A host serving many sessions prepares every spawn through these files. So
 * they may not read the host's own env, cwd, home or temp directory (the
 * host answers for each session through BackendHost), may not block the
 * event loop with synchronous file IO or a synchronous child process, and
 * may not reach the CLI-only skill modules that do (skill-servers.ts,
 * skill-discovery.ts). The rules are checked over every providers file the
 * runner reaches, found by following imports, so a new file joins the
 * checked set without anyone listing it.
 *
 * The runner and runtime layers are outside this scope: they are shared with
 * the API and CLI, and runtime has its own host-free guard.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { dirname, join, relative, resolve } from 'path';
import { fileURLToPath } from 'url';
import ts from 'typescript';

const PROVIDERS_DIR = dirname(fileURLToPath(import.meta.url));

/** Where preparation starts, for every host. */
const ENTRY = join(PROVIDERS_DIR, 'backend-runner.ts');

/** Synchronous, CLI-side modules no preparation file may import. */
const CLI_ONLY_MODULES: ReadonlySet<string> = new Set([
  './skill-servers.js',
  './skill-discovery.js',
]);

/** The only members of `process` a preparation file may touch. */
const ALLOWED_PROCESS_MEMBERS: ReadonlySet<string> = new Set(['pid', 'stdout', 'stderr']);

/** Host modules, and the value imports each may give a preparation file. */
const HOST_MODULES: Record<string, ReadonlySet<string>> = {
  fs: new Set(['constants']),
  os: new Set(),
  child_process: new Set(),
};

interface Violation {
  line: number;
  what: string;
}

function hostModule(specifier: string): string | undefined {
  const bare = specifier.startsWith('node:') ? specifier.slice('node:'.length) : specifier;
  return bare in HOST_MODULES ? bare : undefined;
}

function prepViolations(fileName: string, text: string): Violation[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.ES2022, true);
  const found: Violation[] = [];
  const add = (node: ts.Node, what: string) =>
    found.push({
      line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      what,
    });

  /** Records a CLI-only import; returns the host module the specifier names, if any. */
  const checkSpecifier = (node: ts.Node, specifier: string): string | undefined => {
    if (CLI_ONLY_MODULES.has(specifier)) add(node, `imports ${specifier}`);
    return hostModule(specifier);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const typeOnly = Boolean(clause?.isTypeOnly);
      const host = checkSpecifier(node, node.moduleSpecifier.text);
      if (host && !typeOnly && clause) {
        const allowed = HOST_MODULES[host]!;
        if (clause.name) add(node, `default import of ${host}`);
        const bindings = clause.namedBindings;
        if (bindings && ts.isNamespaceImport(bindings)) add(node, `namespace import of ${host}`);
        if (bindings && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) {
            const name = (element.propertyName ?? element.name).text;
            if (!element.isTypeOnly && !allowed.has(name)) add(element, `${host}.${name}`);
          }
        }
      }
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const host = checkSpecifier(node, node.moduleSpecifier.text);
      if (host && !node.isTypeOnly) add(node, `re-export from ${host}`);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    ) {
      const [arg] = node.arguments;
      if (arg && ts.isStringLiteralLike(arg)) {
        if (CLI_ONLY_MODULES.has(arg.text)) add(node, `imports ${arg.text}`);
        const host = hostModule(arg.text);
        if (host) add(node, `dynamic import of ${host}`);
      }
    } else if (ts.isIdentifier(node) && node.text === 'process') {
      // Any use of `process` other than an allowed member: env, cwd,
      // destructuring, aliasing and passing it along are all refused.
      const parent = node.parent;
      const allowedMember =
        ts.isPropertyAccessExpression(parent) &&
        parent.expression === node &&
        ALLOWED_PROCESS_MEMBERS.has(parent.name.text);
      const isDeclarationName =
        (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
        (ts.isPropertyAssignment(parent) && parent.name === node) ||
        ts.isPropertySignature(parent);
      if (!allowedMember && !isDeclarationName) {
        const member = ts.isPropertyAccessExpression(parent) ? `.${parent.name.text}` : '';
        add(node, `process${member}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** Every providers file the runner reaches through relative imports. */
function preparationFiles(): string[] {
  const seen = new Set<string>();
  const queue = [ENTRY];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.ES2022,
      true
    );
    const visit = (node: ts.Node): void => {
      let specifier: string | undefined;
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        specifier = node.moduleSpecifier.text;
      }
      if (specifier?.startsWith('./')) {
        const target = resolve(dirname(file), specifier.replace(/\.js$/, '.ts'));
        if (existsSync(target) && dirname(target) === PROVIDERS_DIR) queue.push(target);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return [...seen].sort();
}

const check = (text: string) => prepViolations('synthetic.ts', text).map((v) => v.what);

describe('preparation guard, against known answers', () => {
  it('admits async fs, fs constants, output streams and the pid', () => {
    const clean = [
      "import { mkdir, open, type FileHandle } from 'fs/promises';",
      "import { constants as fsConstants } from 'fs';",
      "import type { Stats } from 'fs';",
      "import { join } from 'path';",
      'process.stdout.write("x");',
      'process.stderr.write("x");',
      'const name = `f-${process.pid}`;',
      'const config = { process: 1 };',
    ].join('\n');
    expect(check(clean)).toEqual([]);
  });

  it.each([
    ['process.env.HOME;', 'process.env'],
    ["process['env'];", 'process'],
    ['process.cwd();', 'process.cwd'],
    ['const { env } = process;', 'process'],
    ['const p = process; p.env;', 'process'],
    ['read(process);', 'process'],
    ["import { homedir } from 'os';", 'os.homedir'],
    ["import { tmpdir } from 'node:os';", 'os.tmpdir'],
    ["import * as os from 'os';", 'namespace import of os'],
    ["import os from 'os';", 'default import of os'],
    ["import { readFileSync } from 'fs';", 'fs.readFileSync'],
    ["import { existsSync as exists } from 'node:fs';", 'fs.existsSync'],
    ["import { readFile } from 'fs';", 'fs.readFile'],
    ["import { execFileSync } from 'child_process';", 'child_process.execFileSync'],
    ["import { spawn } from 'child_process';", 'child_process.spawn'],
    ["export { readFileSync } from 'fs';", 're-export from fs'],
    ["const fs = require('fs');", 'dynamic import of fs'],
    ["const m = import('os');", 'dynamic import of os'],
    ["import { discoverSkillMcpServers } from './skill-servers.js';", 'imports ./skill-servers.js'],
    ["import { discoverSkills } from './skill-discovery.js';", 'imports ./skill-discovery.js'],
    ["export * from './skill-servers.js';", 'imports ./skill-servers.js'],
  ])('refuses %s', (text, expected) => {
    expect(check(text)).toContain(expected);
  });
});

describe('the preparation path', () => {
  const files = preparationFiles();

  it('is found by following imports from the runner', () => {
    const names = files.map((file) => relative(PROVIDERS_DIR, file));
    // Known members, so a walker that stopped early would fail here.
    expect(names).toEqual(
      expect.arrayContaining([
        'backend-runner.ts',
        'registry.ts',
        'claude.ts',
        'codex.ts',
        'gemini.ts',
        'identity-prompt.ts',
        'skill-mcp.ts',
        'turn-owner.ts',
      ])
    );
    expect(names).not.toContain('skill-servers.ts');
    expect(names).not.toContain('skill-discovery.ts');
  });

  it('reads nothing from the host process and never blocks it', () => {
    const found = files.flatMap((file) =>
      prepViolations(file, readFileSync(file, 'utf8')).map(
        (v) => `${relative(PROVIDERS_DIR, file)}:${v.line} ${v.what}`
      )
    );
    expect(found).toEqual([]);
  });
});
