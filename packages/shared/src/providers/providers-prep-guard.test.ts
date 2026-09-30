/**
 * A spawn's preparation reads nothing from the process it runs in and never
 * blocks it, checked on the source.
 *
 * A host serving many sessions prepares every spawn through these files. So
 * they may not read the host's own env, cwd, home or temp directory (the
 * host answers for each session through BackendHost), may not block the
 * event loop with synchronous file IO or a synchronous child process, and
 * may not reach the CLI-only skill modules that do (skill-servers.ts,
 * skill-discovery.ts).
 *
 * The rules are checked over every file the runner reaches, found by
 * following static, re-exported and literal dynamic imports anywhere in
 * shared's source, so a new file joins the checked set without anyone
 * listing it. The rules fail closed where the source cannot be read: an
 * `import()` or `require()` of a computed name, `eval`, the `Function`
 * constructor and the global object are refused outright, and a relative
 * import the walk cannot follow is reported rather than skipped. What the
 * path is allowed to read from its host anyway is listed below as
 * exceptions, each with its reason, and an exception that no longer matches
 * anything fails too.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { basename, dirname, join, relative, resolve } from 'path';
import { fileURLToPath } from 'url';
import ts from 'typescript';

const PROVIDERS_DIR = dirname(fileURLToPath(import.meta.url));

/** The walk follows relative imports anywhere in shared's source. */
const SHARED_SRC = dirname(PROVIDERS_DIR);

/** Where preparation starts, for every host. */
const ENTRY = join(PROVIDERS_DIR, 'backend-runner.ts');

/** Synchronous, CLI-side modules no preparation file may import, by file name. */
const CLI_ONLY_MODULES: ReadonlySet<string> = new Set(['skill-servers.js', 'skill-discovery.js']);

/** The only members of `process` a preparation file may touch. */
const ALLOWED_PROCESS_MEMBERS: ReadonlySet<string> = new Set(['pid', 'stdout', 'stderr']);

/**
 * Host modules, and the value imports each may give a preparation file.
 * `vm`, `worker_threads` and `inspector` run source text this check cannot
 * read, as `eval` and `Function` do, so they give nothing.
 */
const HOST_MODULES: Record<string, ReadonlySet<string>> = {
  fs: new Set(['constants']),
  os: new Set(),
  child_process: new Set(),
  process: ALLOWED_PROCESS_MEMBERS,
  module: new Set(),
  vm: new Set(),
  worker_threads: new Set(),
  inspector: new Set(),
};

/**
 * Refused wherever they are referred to. The global object is one property
 * away from `process`; `eval`, `Function` and `require` run or load code this
 * check cannot read, and so does `module.require` (`module` is the CommonJS
 * free variable, which @types/node declares globally and the CJS build
 * provides). `window` and `self` are not globals in Node; the members below
 * are refused whatever they are read from.
 */
const REFUSED_NAMES: ReadonlySet<string> = new Set([
  'globalThis',
  'global',
  'eval',
  'Function',
  'require',
  'module',
  // Reads the host env through its parameter's default. The CLI host calls
  // it for its own chat process (cli-host.ts); no preparation file may.
  'sessionEnvHandoff',
]);

/** Members refused as `.name` whatever they are read from. */
const REFUSED_MEMBERS: ReadonlySet<string> = new Set(['process', 'require']);

/**
 * What the preparation path reads from its host anyway, keyed by
 * `<file> <enclosing function> <what>`.
 */
const HOST_BOUNDARY_EXCEPTIONS: ReadonlyArray<{ at: string; reason: string }> = [
  {
    at: 'runner/spawn-backend.ts (module) child_process.spawn',
    reason:
      'The one spawn the runner exists to make. It runs after preparation, with the env preparation produced.',
  },
  {
    at: 'runner/spawn-backend.ts buildCleanEnv process.env',
    reason:
      "The default parent env, for spawnBackend's callers outside this path (the API runners through resolveSpawnTarget, the CLI's backend-auth). startBackendTurn always passes its host's BackendHost.baseEnv as parentEnv, which backend-runner.concurrent.test proves; the default goes when those callers move onto the providers path.",
  },
  {
    at: 'runner/spawn-backend.ts sessionEnvHandoff process.env',
    reason:
      "The chat process's handoff of its own session to its child. Only the CLI host calls it; a preparation file that did is refused (REFUSED_NAMES).",
  },
];

interface Violation {
  line: number;
  what: string;
  /** The enclosing named function, or `(module)`. */
  within: string;
}

function hostModule(specifier: string): string | undefined {
  const bare = specifier.startsWith('node:') ? specifier.slice('node:'.length) : specifier;
  return bare in HOST_MODULES ? bare : undefined;
}

function isCliOnly(specifier: string): boolean {
  return specifier.startsWith('.') && CLI_ONLY_MODULES.has(basename(specifier));
}

/** Whether `node` only names something here, rather than reading a value. */
function isNameOnly(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (ts.isTypeNode(parent) || ts.isQualifiedName(parent)) return true;
  // `{ process }` and `export { process }` read the binding they name, and
  // `const { process } = x` reads x.process.
  if (ts.isShorthandPropertyAssignment(parent) || ts.isExportSpecifier(parent)) return false;
  if (ts.isBindingElement(parent) && !parent.propertyName) return false;
  if (ts.isPropertyAccessExpression(parent)) return parent.name === node;
  return (parent as { name?: ts.Node }).name === node;
}

function enclosingName(node: ts.Node): string {
  for (let current = node.parent; current; current = current.parent) {
    if ((ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current)) && current.name) {
      return current.name.getText();
    }
    if (
      ts.isVariableDeclaration(current) &&
      ts.isIdentifier(current.name) &&
      current.initializer &&
      (ts.isArrowFunction(current.initializer) || ts.isFunctionExpression(current.initializer))
    ) {
      return current.name.text;
    }
  }
  return '(module)';
}

function prepViolations(fileName: string, text: string): Violation[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.ES2022, true);
  const found: Violation[] = [];
  const add = (node: ts.Node, what: string) =>
    found.push({
      line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      what,
      within: enclosingName(node),
    });

  /** Records a CLI-only import; returns the host module the specifier names, if any. */
  const checkSpecifier = (node: ts.Node, specifier: string): string | undefined => {
    if (isCliOnly(specifier)) add(node, `imports ${specifier}`);
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
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      const host = checkSpecifier(node, node.moduleReference.expression.text);
      if (host && !node.isTypeOnly) add(node, `import-equals of ${host}`);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    ) {
      const [arg] = node.arguments;
      if (arg && ts.isStringLiteralLike(arg)) {
        const host = checkSpecifier(node, arg.text);
        if (host) add(node, `dynamic import of ${host}`);
      } else {
        add(node, 'import() with a non-literal specifier');
      }
    } else if (
      ts.isElementAccessExpression(node) &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      REFUSED_MEMBERS.has(node.argumentExpression.text)
    ) {
      // The computed twin of `.process` and `.require`.
      add(node, `['${node.argumentExpression.text}']`);
    } else if (ts.isIdentifier(node)) {
      const parent = node.parent;
      if (
        REFUSED_MEMBERS.has(node.text) &&
        ts.isPropertyAccessExpression(parent) &&
        parent.name === node
      ) {
        // Read from anything: the global object, an alias of it, or a
        // `window` that is not one.
        add(node, `.${node.text}`);
      } else if (!isNameOnly(node)) {
        if (node.text === 'process') {
          // Any use of `process` other than an allowed member: env, cwd,
          // destructuring, aliasing and passing it along are all refused.
          const allowedMember =
            ts.isPropertyAccessExpression(parent) &&
            parent.expression === node &&
            ALLOWED_PROCESS_MEMBERS.has(parent.name.text);
          if (!allowedMember) {
            const member = ts.isPropertyAccessExpression(parent) ? `.${parent.name.text}` : '';
            add(node, `process${member}`);
          }
        } else if (REFUSED_NAMES.has(node.text)) {
          add(node, node.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** Every relative specifier in a file, from each import form the walk follows. */
function relativeSpecifiers(source: ts.SourceFile): string[] {
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    let specifier: string | undefined;
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifier = node.moduleSpecifier.text;
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      specifier = node.moduleReference.expression.text;
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require')) &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      specifier = node.arguments[0].text;
    }
    if (specifier?.startsWith('.')) specifiers.push(specifier);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return specifiers;
}

interface Walk {
  /** Every file reached, absolute. */
  files: string[];
  /** Relative imports the walk could not follow: missing, or outside `root`. */
  unfollowed: string[];
}

/** Every file `entry` reaches through relative imports within `root`. */
function preparationWalk(entry: string, root: string): Walk {
  const seen = new Set<string>();
  const unfollowed: string[] = [];
  const queue = [entry];
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
    for (const specifier of relativeSpecifiers(source)) {
      const target = resolve(dirname(file), specifier.replace(/\.js$/, '.ts'));
      const from = relative(root, file);
      if (relative(root, target).startsWith('..')) {
        unfollowed.push(`${from} -> ${specifier} (outside the walk)`);
      } else if (!existsSync(target)) {
        unfollowed.push(`${from} -> ${specifier} (no such source file)`);
      } else {
        queue.push(target);
      }
    }
  }
  return { files: [...seen].sort(), unfollowed };
}

/** `<file> <within> <what>` for each violation in `files`, with its line. */
function violationsIn(files: string[], root: string): Array<{ at: string; line: number }> {
  return files.flatMap((file) =>
    prepViolations(file, readFileSync(file, 'utf8')).map((v) => ({
      at: `${relative(root, file)} ${v.within} ${v.what}`,
      line: v.line,
    }))
  );
}

const check = (text: string) => prepViolations('synthetic.ts', text).map((v) => v.what);

describe('preparation guard, against known answers', () => {
  it('admits async fs, fs constants, output streams and the pid', () => {
    const clean = [
      "import { mkdir, open, type FileHandle } from 'fs/promises';",
      "import { constants as fsConstants } from 'fs';",
      "import type { Stats } from 'fs';",
      "import { join } from 'path';",
      "import { pid } from 'process';",
      "void import('./lazy.js');",
      'process.stdout.write("x");',
      'process.stderr.write("x");',
      'const name = `f-${process.pid}`;',
      'const config = { process: 1 };',
      'interface Shape { process: number }',
      'const window = { contextTokens: 1 };',
      'let callback: Function | undefined;',
      'type Env = typeof process.env;',
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
    ['const bag = { process };', 'process'],
    ['const { process: proc } = holder;', 'process'],
    ['const { process } = holder;', 'process'],
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
    [
      "import { discoverSkillMcpServers } from '../providers/skill-servers.js';",
      'imports ../providers/skill-servers.js',
    ],
    // Reaching `process` without naming it as a bare identifier (Myra, #701).
    ['globalThis.process.env.HOME;', 'globalThis'],
    ['global.process.env.HOME;', 'global'],
    ["globalThis['process'].env;", 'globalThis'],
    ['const g = globalThis; g.process.env;', 'globalThis'],
    ['window.process.env;', '.process'],
    ["holder['process'].env;", "['process']"],
    ["import { env } from 'process';", 'process.env'],
    ["import { cwd } from 'node:process';", 'process.cwd'],
    ["import proc from 'process'; proc.env;", 'default import of process'],
    [
      "import { createRequire } from 'module'; createRequire(import.meta.url)('fs');",
      'module.createRequire',
    ],
    ["const name = 'fs'; void import(name);", 'import() with a non-literal specifier'],
    ["import fs = require('fs');", 'import-equals of fs'],
    ["const name = 'fs'; require(name);", 'require'],
    ["eval('process.env');", 'eval'],
    ["new Function('return process')();", 'Function'],
    // The CommonJS free variable, typed globally by @types/node (Myra, #701).
    ["module.require('fs');", 'module'],
    ["const m = module; m.require('fs');", 'module'],
    ["holder.require('fs');", '.require'],
    // Code the check cannot read, and the computed twin of `.require` (Myra, ade5865f).
    ["import { runInThisContext } from 'node:vm';", 'vm.runInThisContext'],
    ["import vm from 'vm';", 'default import of vm'],
    ["import { Worker } from 'node:worker_threads';", 'worker_threads.Worker'],
    ["const m = import('node:inspector');", 'dynamic import of inspector'],
    ["holder['require']('fs');", "['require']"],
    ['holder[`require`]("fs");', "['require']"],
    [
      "import { sessionEnvHandoff } from '../runner/spawn-backend.js'; sessionEnvHandoff();",
      'sessionEnvHandoff',
    ],
  ])('refuses %s', (text, expected) => {
    expect(check(text)).toContain(expected);
  });

  it('follows literal dynamic imports and crosses directories, and reports what it cannot follow', () => {
    // A planted tree: the entry reaches one file only through `import()`
    // and another in a sibling directory, and names one that does not exist.
    const root = mkdtempSync(join(tmpdir(), 'prep-walk-'));
    try {
      mkdirSync(join(root, 'providers'));
      mkdirSync(join(root, 'runner'));
      const entry = join(root, 'providers', 'entry.ts');
      writeFileSync(
        entry,
        [
          "import { r } from '../runner/sync.js';",
          "void import('./lazy.js');",
          "void import('./missing.js');",
          'export const read = r;',
        ].join('\n')
      );
      writeFileSync(join(root, 'providers', 'lazy.ts'), 'export const home = process.env.HOME;');
      writeFileSync(
        join(root, 'runner', 'sync.ts'),
        "import { readFileSync } from 'fs';\nexport const r = readFileSync;"
      );

      const walk = preparationWalk(entry, root);
      expect(walk.files.map((file) => relative(root, file))).toEqual([
        'providers/entry.ts',
        'providers/lazy.ts',
        'runner/sync.ts',
      ]);
      expect(walk.unfollowed).toEqual(['providers/entry.ts -> ./missing.js (no such source file)']);
      expect(violationsIn(walk.files, root).map((v) => v.at)).toEqual([
        'providers/lazy.ts (module) process.env',
        'runner/sync.ts (module) fs.readFileSync',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('the preparation path', () => {
  const walk = preparationWalk(ENTRY, SHARED_SRC);

  it('is found by following imports from the runner, into the runner layer', () => {
    const names = walk.files.map((file) => relative(SHARED_SRC, file));
    // Known members, so a walker that stopped early would fail here.
    expect(names).toEqual(
      expect.arrayContaining([
        'providers/backend-runner.ts',
        'providers/registry.ts',
        'providers/claude.ts',
        'providers/codex.ts',
        'providers/gemini.ts',
        'providers/identity-prompt.ts',
        'providers/skill-mcp.ts',
        'providers/turn-owner.ts',
        'runner/spawn-backend.ts',
        'runner/mcp-config.ts',
      ])
    );
    expect(names).not.toContain('providers/skill-servers.ts');
    expect(names).not.toContain('providers/skill-discovery.ts');
    expect(names).not.toContain('runner/mcp-config-file.ts');
    expect(walk.unfollowed).toEqual([]);
  });

  it('reads nothing from the host process and never blocks it, beyond the listed exceptions', () => {
    const excepted = new Set(HOST_BOUNDARY_EXCEPTIONS.map((exception) => exception.at));
    const found = violationsIn(walk.files, SHARED_SRC);
    expect(found.filter((v) => !excepted.has(v.at)).map((v) => `${v.at} (line ${v.line})`)).toEqual(
      []
    );
    // A stale exception would excuse whatever next lands in its place.
    const matched = new Set(found.map((v) => v.at));
    expect([...excepted].filter((at) => !matched.has(at))).toEqual([]);
  });
});
