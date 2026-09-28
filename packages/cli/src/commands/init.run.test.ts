/**
 * `ink init` as the completion and repair routine (task c3b34be8): in a
 * linked worktree it runs completeStudio with root sync and studio setup on
 * by default and the two flags turning them off; in the main worktree it
 * installs hooks and backend config and nothing else; a partial studio is
 * made whole by a second run. Placement is detected from git, pinned here
 * with a real repository and a real linked worktree.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { auditStudio } from '@inklabs/shared';
import { detectWorktree, runInit, studioNameFromPath } from './init.js';
import type { StepResult } from '../lib/studio-complete.js';

let root: string;
let main: string;
let studio: string;

const STUDIO_ID = '191b7705-85bd-4c76-b622-43f655bf7fd6';
const git = (args: string[], cwd: string) =>
  execFileSync('git', args, {
    cwd,
    stdio: 'ignore',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' },
  });

const readJson = (p: string) => JSON.parse(readFileSync(p, 'utf-8')) as Record<string, unknown>;
const stubs = () => ({
  register: vi.fn(async () => STUDIO_ID),
  syncSkills: vi.fn(
    async (): Promise<StepResult> => ({
      label: 'skills sync',
      status: 'skipped',
      detail: 'stubbed',
    })
  ),
});

beforeEach(() => {
  // git reports physical paths; on macOS the temp dir is a symlink (/var -> /private/var).
  root = realpathSync(mkdtempSync(join(tmpdir(), 'init-run-')));
  main = join(root, 'repo');
  studio = join(root, 'repo--alpha');
  mkdirSync(main);
  git(['init', '-q', '-b', 'main'], main);
  git(
    [
      '-c',
      'user.name=fixture',
      '-c',
      'user.email=fixture@example.com',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'root',
    ],
    main
  );
  writeFileSync(
    join(main, '.mcp.json'),
    JSON.stringify({ mcpServers: { inkwell: { type: 'http', url: 'http://localhost:3001/mcp' } } })
  );
  writeFileSync(join(main, '.env.local'), 'SUPABASE_URL=http://127.0.0.1:54321\n');
  mkdirSync(join(main, '.claude'));
  writeFileSync(
    join(main, '.claude', 'settings.local.json'),
    JSON.stringify({ permissions: { allow: ['Bash(git *)'], deny: [] } })
  );
  git(['worktree', 'add', '-q', '-b', 'wren/feat/alpha', studio], main);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('detectWorktree', () => {
  it('tells the main worktree from a linked one and names the main root and branch', () => {
    const atMain = detectWorktree(main);
    expect(atMain.linked).toBe(false);
    expect(atMain.mainRoot).toBeNull();
    expect(atMain.branch).toBe('main');
    const atStudio = detectWorktree(studio);
    expect(atStudio.linked).toBe(true);
    expect(atStudio.mainRoot).toBe(main);
    expect(atStudio.branch).toBe('wren/feat/alpha');
    // Outside a repository there is nothing to place.
    expect(detectWorktree(root)).toEqual({ toplevel: null, mainRoot: null, linked: false });
  });

  it('reads the studio name from the folder suffix', () => {
    expect(studioNameFromPath('/x/repo--alpha')).toBe('alpha');
    expect(studioNameFromPath('/x/repo--wren-review')).toBe('wren-review');
    expect(studioNameFromPath('/x/repo')).toBeUndefined();
  });
});

describe('runInit in a linked worktree', () => {
  it('completes the studio by default: root sync, identity with the branch, registration, hooks', async () => {
    const deps = stubs();
    const report = await runInit(studio, { agent: 'wren', purpose: 'alpha work' }, deps);

    expect(report.linked).toBe(true);
    expect(report.audit.complete, report.audit.missing.join(',')).toBe(true);
    expect(readJson(join(studio, '.mcp.json'))).toEqual(readJson(join(main, '.mcp.json')));
    expect(existsSync(join(studio, '.env.local'))).toBe(true);
    expect(readJson(join(studio, '.ink', 'identity.json'))).toMatchObject({
      sbSlug: 'wren',
      studio: 'alpha',
      branch: 'wren/feat/alpha',
      studioId: STUDIO_ID,
      description: 'alpha work',
    });
    expect(deps.register).toHaveBeenCalledWith(
      expect.objectContaining({
        sbSlug: 'wren',
        repoRoot: main,
        slug: 'alpha',
        purpose: 'alpha work',
      })
    );
    const settings = readJson(join(studio, '.claude', 'settings.local.json')) as {
      permissions: { allow: string[] };
    };
    expect(settings.permissions.allow).toEqual(['Bash(git *)']);
  });

  it('--no-root-sync and --no-studio-setup turn the two switches off', async () => {
    const deps = stubs();
    const report = await runInit(
      studio,
      { agent: 'wren', rootSync: false, studioSetup: false },
      deps
    );
    expect(existsSync(join(studio, '.env.local'))).toBe(false);
    expect(existsSync(join(studio, '.ink', 'identity.json'))).toBe(false);
    expect(deps.register).not.toHaveBeenCalled();
    const mcp = readJson(join(studio, '.mcp.json')) as { mcpServers: Record<string, unknown> };
    expect(mcp.mcpServers).toHaveProperty('inkwell');
    expect(report.audit.missing).toEqual(['identity', 'studio-id']);
  });

  it('a known studio id is recorded without a registration call', async () => {
    const deps = stubs();
    await runInit(studio, { agent: 'wren', studioId: STUDIO_ID }, deps);
    expect(deps.register).not.toHaveBeenCalled();
    expect(readJson(join(studio, '.ink', 'identity.json')).studioId).toBe(STUDIO_ID);
  });

  it('repairs a partial studio: a bare worktree with only hooks becomes complete on the next run', async () => {
    // The shape a server-created studio had before this task: settings with
    // hooks and permissions, no identity, no Codex/Gemini hooks.
    mkdirSync(join(studio, '.claude'), { recursive: true });
    writeFileSync(
      join(studio, '.claude', 'settings.local.json'),
      JSON.stringify({ permissions: { allow: ['Bash(*)'] }, hooks: {} })
    );
    expect(auditStudio(studio, { linked: true }).complete).toBe(false);
    const deps = stubs();
    const report = await runInit(studio, { agent: 'wren' }, deps);
    expect(report.audit.complete, report.audit.missing.join(',')).toBe(true);
    // The permissions it had are kept, not replaced by the main worktree's.
    const settings = readJson(join(studio, '.claude', 'settings.local.json')) as {
      permissions: { allow: string[] };
    };
    expect(settings.permissions.allow).toEqual(['Bash(*)']);
  });

  it('takes the SB from an existing identity when no --agent is given', async () => {
    mkdirSync(join(studio, '.ink'), { recursive: true });
    writeFileSync(
      join(studio, '.ink', 'identity.json'),
      JSON.stringify({ sbSlug: 'lumen', studio: 'alpha' })
    );
    const deps = stubs();
    await runInit(studio, {}, deps);
    expect(readJson(join(studio, '.ink', 'identity.json')).sbSlug).toBe('lumen');
    expect(deps.register).toHaveBeenCalledWith(expect.objectContaining({ sbSlug: 'lumen' }));
  });
});

describe('runInit from inside a package directory (Lumen, PR #692 round 1)', () => {
  it('completes the worktree root, not the directory it was run from', async () => {
    const nested = join(studio, 'packages', 'api');
    mkdirSync(nested, { recursive: true });
    const deps = stubs();
    const report = await runInit(nested, { agent: 'wren' }, deps);
    expect(report.worktreePath).toBe(studio);
    expect(report.audit.complete, report.audit.missing.join(',')).toBe(true);
    expect(existsSync(join(studio, '.ink', 'identity.json'))).toBe(true);
    expect(existsSync(join(nested, '.ink'))).toBe(false);
    expect(existsSync(join(nested, '.mcp.json'))).toBe(false);
  });
});

describe('runInit in the main worktree', () => {
  it('installs hooks and backend config and leaves identity, registration and permissions alone', async () => {
    rmSync(join(main, '.claude'), { recursive: true, force: true });
    const deps = stubs();
    const report = await runInit(main, { agent: 'wren' }, deps);
    expect(report.linked).toBe(false);
    expect(report.audit.complete).toBe(true);
    expect(existsSync(join(main, '.ink', 'identity.json'))).toBe(false);
    expect(deps.register).not.toHaveBeenCalled();
    const settings = readJson(join(main, '.claude', 'settings.local.json'));
    expect(settings.permissions).toBeUndefined();
    expect(JSON.stringify(settings.hooks)).toContain('hooks on-stop --backend claude-code');
    expect(existsSync(join(main, '.codex', 'config.toml'))).toBe(true);
    expect(existsSync(join(main, '.gemini', 'settings.json'))).toBe(true);
  });
});
