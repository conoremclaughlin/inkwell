/**
 * The per-launch settings artifact (design v5, phase A). Pinned here: the
 * rules are rendered absolute against the execution filesystem; each
 * launch gets its own file; authored policy on disk is kept at launch; an
 * unknown profile, a bad owner or an unreadable policy fails the launch;
 * the sources are recorded with precedence labelled documented, not
 * measured. Synthetic temp directories only, no Claude Code process.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/** An lstat failure other than absence, injected for one path. */
const fault = vi.hoisted(() => ({ lstatPath: '' }));
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return {
    ...actual,
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      if (fault.lstatPath && String(args[0]) === fault.lstatPath) {
        throw Object.assign(new Error('fixture: permission denied'), { code: 'EACCES' });
      }
      return actual.lstat(...args);
    },
  };
});
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import * as shared from '@inklabs/shared';
// Namespace import: against a tree without the module, each test fails on its own.
import * as launch from './launch-settings';

let root: string;
let worktree: string;
let mainRoot: string;
let out: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'launch-settings-'));
  mainRoot = join(root, 'repo');
  worktree = join(root, 'repo--alpha');
  out = join(root, 'run');
  mkdirSync(join(mainRoot, '.claude'), { recursive: true });
  mkdirSync(join(worktree, '.claude'), { recursive: true });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const request = (extra: Record<string, unknown> = {}) => ({
  worktreePath: worktree,
  studioWorktreePath: worktree,
  mainRoot,
  profile: 'builder',
  owner: 'wren',
  outputDir: out,
  userSettingsPath: join(root, 'user-settings.json'),
  ...extra,
});
const fileOf = (path: string) => JSON.parse(readFileSync(path, 'utf-8'));

describe('rules are rendered absolute against the execution filesystem', () => {
  it('Read(*) and Edit(/**) become //worktree/**; ~/ scratch, Bash and MCP rules are unchanged', async () => {
    const result = await launch.prepareLaunchSettings(request());
    const { allow, deny } = fileOf(result.hostPath).permissions;
    expect(allow).toContain(`Read(/${worktree}/**)`);
    expect(allow).toContain(`Edit(/${worktree}/**)`);
    expect(allow).not.toContain('Read(*)');
    expect(allow).not.toContain('Edit(/**)');
    expect(allow).toContain('Edit(~/.ink/files/wren-scratch/**)');
    expect(allow).toContain('Bash(*)');
    expect(allow).toContain('mcp__github__pull_request_read');
    expect(deny).toEqual(shared.studioPermissionRules('builder', 'wren').deny);
    // Every path rule left in the file is absolute or home-anchored.
    for (const rule of allow.filter((r: string) => /^(Read|Edit)\(/.test(r))) {
      expect(rule, rule).toMatch(/^(Read|Edit)\((\/\/|~\/)/);
    }
  });

  it('inside a container the root is /studio, and --settings names the mounted path', async () => {
    const result = await launch.prepareLaunchSettings(
      request({
        executionRoot: '/studio',
        processPathFor: (p: string) => `/run/ink/${p.split('/').pop()}`,
      })
    );
    expect(fileOf(result.hostPath).permissions.allow).toContain('Edit(//studio/**)');
    expect(JSON.stringify(fileOf(result.hostPath))).not.toContain(worktree);
    expect(result.processPath).toBe(`/run/ink/claude-settings-${result.launchId}.json`);
    expect(result.hostPath.startsWith(out)).toBe(true);
  });

  it('renderAbsoluteRule: each path form, and an unplaceable one refused', () => {
    expect(launch.renderAbsoluteRule('Read(*)', '/w')).toBe('Read(//w/**)');
    expect(launch.renderAbsoluteRule('Edit(/**)', '/w')).toBe('Edit(//w/**)');
    expect(launch.renderAbsoluteRule('Edit(/src/**)', '/w')).toBe('Edit(//w/src/**)');
    expect(launch.renderAbsoluteRule('Edit(~/x/**)', '/w')).toBe('Edit(~/x/**)');
    expect(launch.renderAbsoluteRule('Read(//etc/x)', '/w')).toBe('Read(//etc/x)');
    expect(launch.renderAbsoluteRule('Bash(git push *)', '/w')).toBe('Bash(git push *)');
    expect(() => launch.renderAbsoluteRule('Edit(src/**)', '/w')).toThrow();
  });
});

describe('each launch has its own file', () => {
  it('two concurrent launches write two files, and one cleanup leaves the other', async () => {
    const [a, b] = await Promise.all([
      launch.prepareLaunchSettings(request({ profile: 'builder' })),
      launch.prepareLaunchSettings(request({ profile: 'reviewer' })),
    ]);
    expect(a.hostPath).not.toBe(b.hostPath);
    expect(fileOf(a.hostPath).permissions.allow).toContain(`Edit(/${worktree}/**)`);
    expect(fileOf(b.hostPath).permissions.allow).not.toContain(`Edit(/${worktree}/**)`);
    await a.cleanup();
    expect(existsSync(a.hostPath)).toBe(false);
    expect(existsSync(b.hostPath)).toBe(true);
  });

  it('a launch id already used is refused, never written over', async () => {
    await launch.prepareLaunchSettings(request({ launchId: 'fixed' }));
    await expect(launch.prepareLaunchSettings(request({ launchId: 'fixed' }))).rejects.toThrow();
  });
});

describe('authored policy on disk is kept at launch', () => {
  const authored: Array<[string, Record<string, unknown>]> = [
    ['empty', {}],
    ['deny-only', { deny: ['Bash(git push *)'] }],
    ['ask-only', { ask: ['Bash(*)'] }],
    ['mode-only', { defaultMode: 'plan' }],
  ];
  for (const [name, permissions] of authored) {
    it(`${name}: the launch file carries no permissions, and the disk file is untouched`, async () => {
      const content = JSON.stringify({ permissions });
      writeFileSync(join(worktree, '.claude', 'settings.local.json'), content);
      const result = await launch.prepareLaunchSettings(request());
      expect(result.delivered).toBe('authored-on-disk');
      expect(fileOf(result.hostPath)).toEqual({});
      expect(readFileSync(join(worktree, '.claude', 'settings.local.json'), 'utf-8')).toBe(content);
    });
  }

  it('a reviewer always gets the reviewer profile: the checkout under review cannot suppress it', async () => {
    // A PR can track .claude/settings.local.json; whatever it holds counts as
    // "authored", and the reviewer's denies would never arrive. Deny wins
    // across sources, so delivering them only adds restrictions (review
    // 44db8c0c, P2 3).
    for (const permissions of [{}, { allow: ['Bash(*)'] }, { defaultMode: 'bypassPermissions' }]) {
      writeFileSync(
        join(worktree, '.claude', 'settings.local.json'),
        JSON.stringify({ permissions })
      );
      const result = await launch.prepareLaunchSettings(request({ profile: 'reviewer' }));
      expect(result.delivered, JSON.stringify(permissions)).toBe('profile');
      expect(fileOf(result.hostPath).permissions.deny).toEqual(
        shared.studioPermissionRules('reviewer', 'wren').deny
      );
    }
  });

  it('the generated profile on disk, or no permissions key, is delivered at launch', async () => {
    for (const content of [
      JSON.stringify({ permissions: shared.studioPermissionRules('builder', 'wren') }),
      JSON.stringify({ hooks: {} }),
    ]) {
      writeFileSync(join(worktree, '.claude', 'settings.local.json'), content);
      const result = await launch.prepareLaunchSettings(request());
      expect(result.delivered, content).toBe('profile');
    }
  });
});

describe('the launch fails closed, never falling back to builder', () => {
  const failures: Array<[string, Record<string, unknown>, (() => void)?]> = [
    ['unknown profile', { profile: 'admin' }],
    ['no profile', { profile: undefined }],
    ['owner that widens a scratch rule', { owner: '*' }],
    ['no owner', { owner: undefined }],
    ['relative execution root', { executionRoot: 'studio' }],
    ['unnormalized execution root', { executionRoot: '/studio/../etc' }],
    ['filesystem root', { executionRoot: '/' }],
    // The launch must run in the studio's own worktree: a fallback directory
    // would be granted the studio's profile (review 44db8c0c, P2 2).
    [
      'a working directory that is not the studio worktree',
      { studioWorktreePath: '/elsewhere/repo--x' },
    ],
    ['no studio worktree to compare with', { studioWorktreePath: undefined }],
    [
      'unparseable worktree settings',
      {},
      () => writeFileSync(join(worktree, '.claude', 'settings.local.json'), '{ "permissions": '),
    ],
    [
      'non-object permissions on disk',
      {},
      () =>
        writeFileSync(
          join(worktree, '.claude', 'settings.local.json'),
          JSON.stringify({ permissions: ['Bash(*)'] })
        ),
    ],
  ];
  for (const [name, extra, arrange] of failures) {
    it(`${name}: throws LaunchSettingsError and writes no file`, async () => {
      arrange?.();
      await expect(launch.prepareLaunchSettings(request(extra))).rejects.toBeInstanceOf(
        launch.LaunchSettingsError
      );
      expect(existsSync(out) ? readdirSync(out) : []).toEqual([]);
    });
  }
});

describe('the worktree settings are read only as a regular file in a real directory (review 44db8c0c, P3)', () => {
  // A checkout under review can ship a link: to a FIFO it would hang the
  // launch, to /dev/zero it would read without end. A directory stands in
  // for "not a regular file", so a broken guard fails here instead of hanging.
  const outside = () => {
    const dir = join(root, 'outside');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'settings.local.json'), JSON.stringify({ permissions: {} }));
    return dir;
  };
  const refusals: Array<[string, () => void]> = [
    [
      'settings.local.json is a symlink',
      () =>
        symlinkSync(
          join(outside(), 'settings.local.json'),
          join(worktree, '.claude', 'settings.local.json')
        ),
    ],
    [
      '.claude is a symlink',
      () => {
        rmSync(join(worktree, '.claude'), { recursive: true, force: true });
        symlinkSync(outside(), join(worktree, '.claude'));
      },
    ],
    [
      'settings.local.json is not a regular file',
      () => mkdirSync(join(worktree, '.claude', 'settings.local.json')),
    ],
  ];
  for (const [name, arrange] of refusals) {
    it(`${name}: refused, and no file written`, async () => {
      arrange();
      await expect(launch.prepareLaunchSettings(request())).rejects.toBeInstanceOf(
        launch.LaunchSettingsError
      );
      expect(existsSync(out) ? readdirSync(out) : []).toEqual([]);
    });
  }

  it('only absence counts as absent: an lstat error on .claude or the file refuses (Lumen d74ce85d, P2 2)', async () => {
    // EACCES must not read as "no authored policy" and let a builder
    // artifact be generated over policy nobody could see.
    writeFileSync(
      join(worktree, '.claude', 'settings.local.json'),
      JSON.stringify({ permissions: {} })
    );
    try {
      for (const path of [
        join(worktree, '.claude'),
        join(worktree, '.claude', 'settings.local.json'),
      ]) {
        fault.lstatPath = path;
        await expect(launch.prepareLaunchSettings(request()), path).rejects.toBeInstanceOf(
          launch.LaunchSettingsError
        );
        expect(existsSync(out) ? readdirSync(out) : [], path).toEqual([]);
      }
    } finally {
      fault.lstatPath = '';
    }
  });

  it('a worktree path with a glob metacharacter is refused: it would widen the rendered rules', async () => {
    for (const name of ['repo--a[1]', 'repo--a*', 'repo--a?', 'repo--{a,b}']) {
      const odd = join(root, name);
      mkdirSync(join(odd, '.claude'), { recursive: true });
      await expect(
        launch.prepareLaunchSettings(request({ worktreePath: odd, studioWorktreePath: odd })),
        name
      ).rejects.toBeInstanceOf(launch.LaunchSettingsError);
    }
  });
});

describe('the effective sources are recorded, precedence labelled documented, not measured', () => {
  it('root plus worktree: both local files are listed, with whether each is present', async () => {
    writeFileSync(join(mainRoot, '.claude', 'settings.local.json'), '{}');
    const result = await launch.prepareLaunchSettings(request());
    expect(result.sources.map((s) => [s.scope, s.path, s.present])).toEqual([
      ['user', join(root, 'user-settings.json'), false],
      ['project', join(worktree, '.claude', 'settings.json'), false],
      ['local (main checkout)', join(mainRoot, '.claude', 'settings.local.json'), true],
      ['local (worktree)', join(worktree, '.claude', 'settings.local.json'), false],
      ['command line', result.processPath, true],
    ]);
  });

  it('a user-level broad allow is recorded as a source the launch file does not remove', async () => {
    writeFileSync(
      join(root, 'user-settings.json'),
      JSON.stringify({ permissions: { allow: ['Bash(*)', 'mcp__github__*'] } })
    );
    const result = await launch.prepareLaunchSettings(request());
    expect(result.sources[0]).toMatchObject({ scope: 'user', present: true });
    // The launch file adds rules; it says nothing that removes the user's.
    expect(JSON.stringify(fileOf(result.hostPath))).not.toContain('mcp__github__*');
    expect(result.precedence).toMatch(/^documented, not measured/);
  });

  it('a studio that is not a linked worktree lists no main-checkout file', async () => {
    const result = await launch.prepareLaunchSettings(request({ mainRoot: null }));
    expect(result.sources.map((s) => s.scope)).not.toContain('local (main checkout)');
  });
});
