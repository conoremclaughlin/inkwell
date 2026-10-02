/**
 * The server's studio completion (task c3b34be8): it runs this checkout's
 * `ink init --json` inside the worktree with the studio row it holds, reads
 * the checklist back, and never throws. Pinned with a stub CLI reached
 * through INK_CLI_PATH, so no real CLI, server or git is involved.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

vi.mock('../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import { completeStudioViaCli, ensureStudioComplete, isLinkedWorktree } from './studio-complete';

let root: string;
let worktree: string;
let cliPath: string;

const STUDIO_ID = '191b7705-85bd-4c76-b622-43f655bf7fd6';

/**
 * A stub `ink`: records argv and cwd, prints a report, exits by the
 * INK_STUB_COMPLETE switch — the shape of the real `init --json`.
 */
function writeStubCli(dir: string): string {
  const path = join(dir, 'cli.js');
  writeFileSync(
    path,
    [
      "const fs = require('fs');",
      'fs.writeFileSync(process.env.INK_STUB_LOG, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));',
      "const complete = process.env.INK_STUB_COMPLETE !== '0';",
      "const missing = complete ? [] : ['identity', 'studio-id'];",
      'process.stdout.write(JSON.stringify({ steps: [], audit: { complete, missing } }));',
      'process.exit(complete ? 0 : 1);',
    ].join('\n')
  );
  return path;
}

beforeEach(() => {
  // The child reports its physical cwd; on macOS the temp dir is a symlink.
  root = realpathSync(mkdtempSync(join(tmpdir(), 'studio-complete-api-')));
  worktree = join(root, 'repo--alpha');
  mkdirSync(worktree);
  cliPath = writeStubCli(root);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const env = (extra: Record<string, string> = {}) => ({
  INK_CLI_PATH: cliPath,
  INK_STUB_LOG: join(root, 'stub.log'),
  ...extra,
});
const stubCall = () =>
  JSON.parse(readFileSync(join(root, 'stub.log'), 'utf-8')) as { argv: string[]; cwd: string };

describe('completeStudioViaCli', () => {
  it('runs init --json in the worktree with the agent and the studio row it already holds', async () => {
    const result = await completeStudioViaCli(worktree, {
      sbSlug: 'wren',
      studioId: STUDIO_ID,
      purpose: 'alpha work',
      env: env(),
    });
    expect(result).toEqual({ ok: true, complete: true, missing: [] });
    const call = stubCall();
    expect(call.cwd).toBe(worktree);
    expect(call.argv).toEqual([
      'init',
      '--json',
      '--agent',
      'wren',
      '--studio-id',
      STUDIO_ID,
      '--purpose',
      'alpha work',
      // No profile given: the server says so, and init never guesses one.
      '--no-permissions',
    ]);
  });

  it("passes the owner's backend through as --backend when it is known", async () => {
    await completeStudioViaCli(worktree, {
      sbSlug: 'lumen',
      studioId: STUDIO_ID,
      backend: 'codex',
      env: env(),
    });
    expect(stubCall().argv).toEqual([
      'init',
      '--json',
      '--agent',
      'lumen',
      '--studio-id',
      STUDIO_ID,
      '--backend',
      'codex',
      '--no-permissions',
    ]);
  });

  it('passes the two switches through only when they are off', async () => {
    await completeStudioViaCli(worktree, {
      sbSlug: 'wren',
      rootSync: false,
      studioSetup: false,
      env: env(),
    });
    expect(stubCall().argv).toEqual([
      'init',
      '--json',
      '--agent',
      'wren',
      '--no-root-sync',
      '--no-studio-setup',
      '--no-permissions',
    ]);
  });

  it('an incomplete checklist is reported, not thrown: exit 1 with a report is still a run', async () => {
    const result = await completeStudioViaCli(worktree, {
      sbSlug: 'wren',
      env: env({ INK_STUB_COMPLETE: '0' }),
    });
    expect(result.ok).toBe(true);
    expect(result.complete).toBe(false);
    expect(result.missing).toEqual(['identity', 'studio-id']);
  });

  it('with no CLI build and no override, it reports the checklist as it stands and names the fix', async () => {
    // The override names nothing, and the resolver's own search starts in a
    // directory with no checkout — whether or not THIS checkout has a build.
    const result = await completeStudioViaCli(worktree, {
      sbSlug: 'wren',
      env: { INK_CLI_PATH: join(root, 'does-not-exist.js') },
      cliStartDir: root,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no ink CLI build/);
    expect(result.complete).toBe(false);
    expect(result.missing).toContain('identity');
  });

  it('a CLI that prints no report is a failed run, with the checklist read directly', async () => {
    writeFileSync(cliPath, "process.stdout.write('not json'); process.exit(2);");
    const result = await completeStudioViaCli(worktree, { sbSlug: 'wren', env: env() });
    expect(result.ok).toBe(false);
    expect(result.complete).toBe(false);
    expect(result.error).toBeTruthy();
  });
});

describe('ensureStudioComplete', () => {
  it('a complete linked studio never runs the CLI', async () => {
    // A linked worktree: `.git` is a file. Seed a complete studio.
    writeFileSync(join(worktree, '.git'), 'gitdir: /elsewhere/.git/worktrees/alpha\n');
    seedComplete(worktree);
    const result = await ensureStudioComplete(worktree, { sbSlug: 'wren', env: env() });
    expect(result).toEqual({ ok: true, complete: true, missing: [] });
    expect(() => stubCall()).toThrow();
  });

  it('an incomplete linked studio runs the CLI', async () => {
    writeFileSync(join(worktree, '.git'), 'gitdir: /elsewhere/.git/worktrees/alpha\n');
    const result = await ensureStudioComplete(worktree, {
      sbSlug: 'wren',
      studioId: STUDIO_ID,
      env: env(),
    });
    expect(result.ok).toBe(true);
    expect(stubCall().argv).toContain('--studio-id');
  });

  it("an incomplete studio is completed for its row's owner, not for the SB spawned into it", async () => {
    // Myra spawned into a studio Lumen owns: the identity file must say lumen.
    writeFileSync(join(worktree, '.git'), 'gitdir: /elsewhere/.git/worktrees/alpha\n');
    const owner = vi.fn(async () => 'lumen');
    const result = await ensureStudioComplete(worktree, {
      sbSlug: 'myra',
      studioId: STUDIO_ID,
      owner,
      env: env(),
    });
    expect(result.ok).toBe(true);
    expect(owner).toHaveBeenCalledTimes(1);
    const argv = stubCall().argv;
    expect(argv.slice(argv.indexOf('--agent'), argv.indexOf('--agent') + 2)).toEqual([
      '--agent',
      'lumen',
    ]);
  });

  it('the owner lookup is not paid for a complete studio, and an unknown owner falls back to the SB', async () => {
    writeFileSync(join(worktree, '.git'), 'gitdir: /elsewhere/.git/worktrees/alpha\n');
    seedComplete(worktree);
    const owner = vi.fn(async () => 'lumen');
    await ensureStudioComplete(worktree, { sbSlug: 'myra', owner, env: env() });
    expect(owner).not.toHaveBeenCalled();

    rmSync(join(worktree, '.ink'), { recursive: true, force: true });
    const unknown = vi.fn(async () => null);
    await ensureStudioComplete(worktree, { sbSlug: 'myra', owner: unknown, env: env() });
    expect(unknown).toHaveBeenCalledTimes(1);
    expect(stubCall().argv).toContain('myra');
  });

  it('a lookup that throws is no answer: the routine runs with studio setup off, and no owner is written (Lumen, #699 P1)', async () => {
    // A guess here would be durable — completeStudio keeps an owner it finds —
    // so a database that cannot be reached must not turn the spawning SB into
    // the studio's owner.
    writeFileSync(join(worktree, '.git'), 'gitdir: /elsewhere/.git/worktrees/alpha\n');
    const failing = vi.fn(async () => {
      throw new Error('db down');
    });
    const result = await ensureStudioComplete(worktree, {
      sbSlug: 'myra',
      studioId: STUDIO_ID,
      owner: failing,
      env: env(),
    });
    expect(result.ok).toBe(true);
    expect(failing).toHaveBeenCalledTimes(1);
    expect(stubCall().argv).toContain('--no-studio-setup');
  });

  it('the main worktree is reported, never rewritten', async () => {
    mkdirSync(join(worktree, '.git'));
    expect(await isLinkedWorktree(worktree)).toBe(false);
    const result = await ensureStudioComplete(worktree, { sbSlug: 'wren', env: env() });
    expect(result.ok).toBe(true);
    expect(result.complete).toBe(false);
    expect(() => stubCall()).toThrow();
  });
});

describe('the permission profile reaches ink init (design v3, items 3 and 5)', () => {
  const linkedWorktree = () =>
    writeFileSync(join(worktree, '.git'), 'gitdir: /elsewhere/.git/worktrees/alpha\n');

  it('a creator passes the profile it read from the row; inheritance is never passed', async () => {
    await completeStudioViaCli(worktree, {
      sbSlug: 'lumen',
      studioId: STUDIO_ID,
      permissionProfile: 'reviewer',
      env: env(),
    });
    const argv = stubCall().argv;
    expect(
      argv.slice(argv.indexOf('--permission-profile'), argv.indexOf('--permission-profile') + 2)
    ).toEqual(['--permission-profile', 'reviewer']);
    expect(argv).not.toContain('--inherit-claude-permissions');
    expect(argv).not.toContain('--no-permissions');
  });

  it('writePermissions: false passes --no-permissions', async () => {
    await completeStudioViaCli(worktree, { sbSlug: 'wren', writePermissions: false, env: env() });
    expect(stubCall().argv).toContain('--no-permissions');
  });

  it('the pre-spawn repair asks for the profile only when incomplete, and passes what the row says', async () => {
    linkedWorktree();
    seedComplete(worktree);
    const profile = vi.fn(async () => 'reviewer' as const);
    await ensureStudioComplete(worktree, { sbSlug: 'lumen', profile, env: env() });
    expect(profile).not.toHaveBeenCalled();

    rmSync(join(worktree, '.claude'), { recursive: true, force: true });
    await ensureStudioComplete(worktree, {
      sbSlug: 'lumen',
      studioId: STUDIO_ID,
      profile,
      env: env(),
    });
    expect(profile).toHaveBeenCalledTimes(1);
    const argv = stubCall().argv;
    expect(argv).toContain('--permission-profile');
    expect(argv[argv.indexOf('--permission-profile') + 1]).toBe('reviewer');
  });

  it('a profile lookup that throws writes no permissions rather than guessing a profile', async () => {
    linkedWorktree();
    const profile = vi.fn(async () => {
      throw new Error('db down');
    });
    const result = await ensureStudioComplete(worktree, {
      sbSlug: 'lumen',
      studioId: STUDIO_ID,
      profile,
      env: env(),
    });
    expect(result.ok).toBe(true);
    const argv = stubCall().argv;
    expect(argv).toContain('--no-permissions');
    expect(argv).not.toContain('--permission-profile');
  });

  it('an owner lookup that throws leaves permissions alone too: they name the owner', async () => {
    linkedWorktree();
    await ensureStudioComplete(worktree, {
      sbSlug: 'myra',
      studioId: STUDIO_ID,
      owner: async () => {
        throw new Error('db down');
      },
      profile: async () => 'builder' as const,
      env: env(),
    });
    const argv = stubCall().argv;
    expect(argv).toContain('--no-studio-setup');
    expect(argv).toContain('--no-permissions');
  });
});

function seedComplete(dir: string) {
  const INK = 'node /repo/packages/cli/dist/cli.js';
  const cmd = (name: string, backend: string) => ({
    hooks: [{ type: 'command', command: `${INK} hooks ${name} --backend ${backend}` }],
  });
  mkdirSync(join(dir, '.ink'), { recursive: true });
  mkdirSync(join(dir, '.claude'), { recursive: true });
  mkdirSync(join(dir, '.codex'), { recursive: true });
  mkdirSync(join(dir, '.gemini'), { recursive: true });
  writeFileSync(
    join(dir, '.mcp.json'),
    JSON.stringify({ mcpServers: { inkwell: { type: 'http', url: 'x' } } })
  );
  writeFileSync(
    join(dir, '.ink', 'identity.json'),
    JSON.stringify({ sbSlug: 'wren', studioId: STUDIO_ID })
  );
  writeFileSync(
    join(dir, '.claude', 'settings.local.json'),
    JSON.stringify({
      permissions: { allow: ['Bash(*)'] },
      hooks: {
        PreCompact: [cmd('pre-compact', 'claude-code')],
        SessionStart: [cmd('post-compact', 'claude-code'), cmd('on-session-start', 'claude-code')],
        PreToolUse: [cmd('on-tool-approval', 'claude-code')],
        UserPromptSubmit: [cmd('on-prompt', 'claude-code')],
        Stop: [cmd('on-stop', 'claude-code')],
      },
    })
  );
  writeFileSync(
    join(dir, '.codex', 'config.toml'),
    [
      '[mcp_servers.inkwell]',
      'url = "x"',
      '[hooks]',
      `session_start = "${INK} hooks on-session-start --backend codex"`,
      `session_end = "${INK} hooks on-stop --backend codex"`,
      `user_prompt = "${INK} hooks on-prompt --backend codex"`,
      '',
    ].join('\n')
  );
  writeFileSync(
    join(dir, '.gemini', 'settings.json'),
    JSON.stringify({
      mcpServers: { inkwell: { url: 'x' } },
      hooks: {
        SessionStart: [cmd('on-session-start', 'gemini')],
        BeforeAgent: [cmd('on-prompt', 'gemini')],
        AfterAgent: [cmd('on-stop', 'gemini')],
      },
    })
  );
}
