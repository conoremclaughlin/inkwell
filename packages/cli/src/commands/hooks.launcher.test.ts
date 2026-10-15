/**
 * `ink hooks install` writes one launcher spelling: `~/.local/bin/ink` when
 * that link exists, whoever runs the install. The main checkout and a studio
 * then carry the same command text, which Claude Code merges into one hook
 * instead of running two copies in parallel (see ink-launcher.ts in shared).
 *
 * Runs the built CLI (`yarn workspace @inklabs/cli build`) through node, the
 * way the server runs `ink init`, with a fixture HOME.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));
// A pinned git, not whichever one PATH or the parent environment names.
const git =
  ['/usr/bin/git', '/opt/homebrew/bin/git', '/usr/local/bin/git'].find((p) => existsSync(p)) ??
  'git';

let base: string;
let home: string;
let repo: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'ink-hook-launcher-')));
  home = join(base, 'home');
  repo = join(base, 'repo');
  mkdirSync(home, { recursive: true });
  mkdirSync(repo, { recursive: true });
  execFileSync(git, ['init', '-q', repo], { env: childEnv() });
});

/** A deliberate environment: no inherited GIT_DIR, git config or session context. */
function childEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
  };
}

/** `~/.local/bin/ink` as an executable wrapper around this build, the way the link really works. */
function installLink(): string {
  const wrapper = join(home, 'ink-wrapper');
  writeFileSync(wrapper, `#!/bin/sh\nexec '${process.execPath}' '${cli}' "$@"\n`, { mode: 0o755 });
  mkdirSync(join(home, '.local', 'bin'), { recursive: true });
  const link = join(home, '.local', 'bin', 'ink');
  symlinkSync(wrapper, link);
  return link;
}

afterEach(() => rmSync(base, { recursive: true, force: true }));

function install(): string[] {
  const run = spawnSync(process.execPath, [cli, 'hooks', 'install', '--backend', 'claude-code'], {
    cwd: repo,
    env: childEnv(),
    encoding: 'utf8',
  });
  expect(run.status).toBe(0);
  const settings = JSON.parse(readFileSync(join(repo, '.claude', 'settings.local.json'), 'utf8'));
  const commands: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    const record = node as Record<string, unknown>;
    if (typeof record.command === 'string') commands.push(record.command);
    Object.values(record).forEach(walk);
  };
  walk(settings.hooks);
  return commands;
}

describe('ink hooks install: one launcher spelling', () => {
  it('with ~/.local/bin/ink present, every hook starts with it, even when run as node cli.js', () => {
    installLink();
    const commands = install();
    expect(commands.length).toBeGreaterThanOrEqual(6);
    for (const command of commands) {
      expect(command.startsWith(`${join(home, '.local', 'bin', 'ink')} hooks `)).toBe(true);
    }
  });

  it('a later install rewrites hooks spelled with node cli.js to the link', () => {
    const before = install();
    expect(before.every((command) => command.includes('cli.js hooks '))).toBe(true);
    installLink();
    const after = install();
    for (const command of after) {
      expect(command.startsWith(`${join(home, '.local', 'bin', 'ink')} hooks `)).toBe(true);
    }
  });

  it.each([
    [
      'a dangling link',
      () => symlinkSync(join(home, 'missing', 'cli.js'), join(home, '.local', 'bin', 'ink')),
    ],
    ['a directory', () => mkdirSync(join(home, '.local', 'bin', 'ink'))],
    [
      'a file without execute permission',
      () => writeFileSync(join(home, '.local', 'bin', 'ink'), '#!/bin/sh\n', { mode: 0o644 }),
    ],
  ])('with %s at ~/.local/bin/ink, it keeps the working launcher (Lumen, #861)', (_name, plant) => {
    mkdirSync(join(home, '.local', 'bin'), { recursive: true });
    plant();
    const commands = install();
    for (const command of commands) expect(command).toContain('cli.js hooks ');
  });

  it('without the link, it keeps the launcher that ran it', () => {
    const commands = install();
    for (const command of commands) expect(command).toContain('cli.js hooks ');
  });
});
