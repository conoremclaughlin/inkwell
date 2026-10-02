/**
 * The runner delivers a studio's profile with `claude --settings`, in a
 * file of the launch's own (design v5, phase A). Only binary resolution is
 * stubbed, as in claude-runner.spawn-env.test.ts: a fake `claude` records
 * its argv and the settings file's contents while it runs, so what is
 * pinned is what a real spawn would receive. No model, no real Claude.
 */
import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  chmodSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const fixtures = mkdtempSync(join(tmpdir(), 'claude-fake-launch-'));
const hoisted = vi.hoisted(() => ({ binary: '' }));

vi.mock('./resolve-binary.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./resolve-binary.js')>();
  return { ...actual, resolveBinaryPath: () => Promise.resolve(hoisted.binary) };
});

import { ClaudeRunner } from './claude-runner.js';
import type { ClaudeRunnerConfig } from './types.js';

afterAll(() => rmSync(fixtures, { recursive: true, force: true }));

/** A fake claude that records argv and the --settings file it was given, under its cwd. */
function writeFake(): void {
  const fake = join(fixtures, 'claude-fake.mjs');
  writeFileSync(
    fake,
    [
      '#!/usr/bin/env node',
      "import { readFileSync, writeFileSync } from 'fs';",
      'const argv = process.argv.slice(2);',
      "const i = argv.indexOf('--settings');",
      'const settings = i === -1 ? null : JSON.parse(readFileSync(argv[i + 1], "utf-8"));',
      "writeFileSync(process.cwd() + '/spawned.json', JSON.stringify({ argv, settings }));",
      `process.stdout.write(${JSON.stringify(
        JSON.stringify({ type: 'result', subtype: 'success', result: 'ok', session_id: 's' }) + '\n'
      )});`,
    ].join('\n'),
    { mode: 0o755 }
  );
  chmodSync(fake, 0o755);
  hoisted.binary = fake;
}

let n = 0;
function studio(): string {
  const dir = join(fixtures, `repo--s${++n}`);
  mkdirSync(join(dir, '.claude'), { recursive: true });
  return dir;
}

const config = (worktree: string, extra: Partial<ClaudeRunnerConfig> = {}): ClaudeRunnerConfig => ({
  workingDirectory: worktree,
  mcpConfigPath: join(fixtures, '.mcp.json'),
  launchPermissions: {
    profile: 'builder',
    owner: 'wren',
    mainRoot: join(fixtures, 'repo'),
    worktreePath: worktree,
  },
  ...extra,
});
const spawned = (worktree: string) =>
  JSON.parse(readFileSync(join(worktree, 'spawned.json'), 'utf-8')) as {
    argv: string[];
    settings: { permissions?: { allow: string[]; deny: string[] } } | null;
  };

beforeEach(() => writeFake());

describe('ClaudeRunner delivers the studio profile at launch', () => {
  it('passes --settings with a file of absolute rules, and removes the file after the run', async () => {
    const worktree = studio();
    const result = await new ClaudeRunner().run('hello', { config: config(worktree) });
    expect(result.success).toBe(true);
    const { argv, settings } = spawned(worktree);
    const path = argv[argv.indexOf('--settings') + 1];
    expect(argv).toContain('--settings');
    expect(settings?.permissions?.allow).toContain(`Edit(/${worktree}/**)`);
    expect(settings?.permissions?.allow).not.toContain('Edit(/**)');
    // Removed on exit, asynchronously, as the overlay is restored.
    await vi.waitFor(() => expect(existsSync(path)).toBe(false));
  });

  it('an invalid profile refuses the launch: no process, success false, the reason named', async () => {
    const worktree = studio();
    const result = await new ClaudeRunner().run('hello', {
      config: config(worktree, {
        launchPermissions: {
          profile: 'admin',
          owner: 'wren',
          mainRoot: null,
          worktreePath: worktree,
        },
      }),
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/^Launch refused: unknown permission profile/);
    expect(existsSync(join(worktree, 'spawned.json'))).toBe(false);
  });

  it("a launch that would run outside the studio's worktree is refused (a fallback directory)", async () => {
    // resolveWorkingDirectory falls back to the server's checkout when the
    // studio's worktree is missing; the studio's profile must not be granted
    // there (review 44db8c0c, P2 2).
    const fallback = studio();
    const result = await new ClaudeRunner().run('hello', {
      config: config(fallback, {
        launchPermissions: {
          profile: 'builder',
          owner: 'wren',
          mainRoot: null,
          worktreePath: join(fixtures, 'repo--gone'),
        },
      }),
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/^Launch refused: .*not the studio's worktree/);
    expect(existsSync(join(fallback, 'spawned.json'))).toBe(false);
  });

  it('an unreadable worktree policy refuses the launch too', async () => {
    const worktree = studio();
    writeFileSync(join(worktree, '.claude', 'settings.local.json'), '{ "permissions": ');
    const result = await new ClaudeRunner().run('hello', { config: config(worktree) });
    expect(result.success).toBe(false);
    expect(existsSync(join(worktree, 'spawned.json'))).toBe(false);
  });

  it('two concurrent launches are given two different files', async () => {
    const [a, b] = [studio(), studio()];
    await Promise.all([
      new ClaudeRunner().run('hello', { config: config(a) }),
      new ClaudeRunner().run('hello', {
        config: config(b, {
          launchPermissions: {
            profile: 'reviewer',
            owner: 'lumen',
            mainRoot: null,
            worktreePath: b,
          },
        }),
      }),
    ]);
    const pathOf = (w: string) => spawned(w).argv[spawned(w).argv.indexOf('--settings') + 1];
    expect(pathOf(a)).not.toBe(pathOf(b));
    expect(spawned(a).settings?.permissions?.allow).toContain(`Edit(/${a}/**)`);
    expect(spawned(b).settings?.permissions?.allow).toContain(
      'Edit(~/.ink/files/lumen-scratch/**)'
    );
    expect(spawned(b).settings?.permissions?.allow).not.toContain(`Edit(/${b}/**)`);
  });

  it('control: a launch without a studio profile gets no --settings', async () => {
    const worktree = studio();
    await new ClaudeRunner().run('hello', {
      config: config(worktree, { launchPermissions: undefined }),
    });
    expect(spawned(worktree).argv).not.toContain('--settings');
  });
});
