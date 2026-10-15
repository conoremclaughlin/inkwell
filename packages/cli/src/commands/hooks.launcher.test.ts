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
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));

let base: string;
let home: string;
let repo: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'ink-hook-launcher-')));
  home = join(base, 'home');
  repo = join(base, 'repo');
  mkdirSync(home, { recursive: true });
  mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q', repo]);
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

function install(): string[] {
  const run = spawnSync(process.execPath, [cli, 'hooks', 'install', '--backend', 'claude-code'], {
    cwd: repo,
    env: { PATH: process.env.PATH, HOME: home },
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
    mkdirSync(join(home, '.local', 'bin'), { recursive: true });
    symlinkSync(cli, join(home, '.local', 'bin', 'ink'));
    const commands = install();
    expect(commands.length).toBeGreaterThanOrEqual(6);
    for (const command of commands) {
      expect(command.startsWith(`${join(home, '.local', 'bin', 'ink')} hooks `)).toBe(true);
    }
  });

  it('a later install rewrites hooks spelled with node cli.js to the link', () => {
    const before = install();
    expect(before.every((command) => command.includes('cli.js hooks '))).toBe(true);
    mkdirSync(join(home, '.local', 'bin'), { recursive: true });
    symlinkSync(cli, join(home, '.local', 'bin', 'ink'));
    const after = install();
    for (const command of after) {
      expect(command.startsWith(`${join(home, '.local', 'bin', 'ink')} hooks `)).toBe(true);
    }
  });

  it('without the link, it keeps the launcher that ran it', () => {
    const commands = install();
    for (const command of commands) expect(command).toContain('cli.js hooks ');
  });
});
