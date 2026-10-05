/**
 * completeStudio's Claude permissions step (design v3 items 3–5, push per
 * v4). Pinned here: only an absent settings file, or one with no
 * `permissions` key, gets a profile; every authored permissions object is
 * kept byte for byte; a malformed file fails closed in the permissions
 * step AND the Claude hook step (whose installer used to replace it); the
 * main worktree's rules are copied only on an explicit opt-in; the profile
 * comes from the caller (the studio's record), never from the checkout.
 *
 * Synthetic temp directories only.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
// A namespace import: against a tree without the profiles, each test that
// needs one fails on its own instead of the file failing to load.
import * as shared from '@inklabs/shared';
import { completeStudio, type StepResult } from './studio-complete.js';

let root: string;
let main: string;
let studio: string;

const STUDIO_ID = '191b7705-85bd-4c76-b622-43f655bf7fd6';
/** The main worktree's lane rules: an absolute path into it, and a commit deny. */
const LANE_RULES = {
  allow: ['Edit(//repo/packages/**)', 'Bash(git status)'],
  deny: ['Bash(git commit *)'],
};

const settingsPath = () => join(studio, '.claude', 'settings.local.json');
const readSettings = () =>
  JSON.parse(readFileSync(settingsPath(), 'utf-8')) as Record<string, unknown>;
const writeSettings = (content: string) => {
  mkdirSync(join(studio, '.claude'), { recursive: true });
  writeFileSync(settingsPath(), content);
};
const step = (steps: StepResult[], label: string) => steps.find((s) => s.label === label);
const profile = (name: 'builder' | 'reviewer', sbSlug = 'wren') =>
  shared.studioPermissionRules(name, sbSlug);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'studio-perms-'));
  main = join(root, 'repo');
  studio = join(root, 'repo--alpha');
  mkdirSync(join(main, '.claude'), { recursive: true });
  mkdirSync(studio);
  writeFileSync(
    join(main, '.mcp.json'),
    JSON.stringify({ mcpServers: { inkwell: { type: 'http', url: 'http://localhost:3001/mcp' } } })
  );
  writeFileSync(
    join(main, '.claude', 'settings.local.json'),
    JSON.stringify({ permissions: LANE_RULES })
  );
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const options = (extra: Record<string, unknown> = {}) => ({
  sbSlug: 'wren',
  // What every creator passes; the no-profile cases override it.
  permissionProfile: 'builder',
  mainRoot: main,
  studioName: 'alpha',
  branch: 'wren/feat/alpha',
  studioId: STUDIO_ID,
  register: vi.fn(async () => STUDIO_ID),
  syncSkills: vi.fn(
    async (): Promise<StepResult> => ({ label: 'skills sync', status: 'skipped', detail: 'stub' })
  ),
  ...extra,
});

describe('only a file with no permissions gets a profile', () => {
  it('an absent settings file gets the builder profile, not the main worktree lane rules', async () => {
    const report = await completeStudio(studio, options());
    expect(readSettings().permissions).toEqual(profile('builder'));
    expect(JSON.stringify(readSettings())).not.toContain('//repo/packages');
    expect(step(report.steps, 'permissions')).toMatchObject({
      status: 'created',
      detail: 'builder profile',
    });
    expect(report.audit.complete, report.audit.missing.join(',')).toBe(true);
  });

  it('a file with hooks and no permissions key gets the profile, and keeps its other keys', async () => {
    writeSettings(JSON.stringify({ hooks: {}, model: 'kept' }));
    await completeStudio(studio, options());
    expect(readSettings().permissions).toEqual(profile('builder'));
    expect(readSettings().model).toBe('kept');
  });

  it('a second run keeps the profile it wrote: exists, byte for byte', async () => {
    await completeStudio(studio, options());
    const before = readFileSync(settingsPath(), 'utf-8');
    const again = await completeStudio(studio, options());
    expect(step(again.steps, 'permissions')?.status).toBe('exists');
    expect(readFileSync(settingsPath(), 'utf-8')).toBe(before);
  });
});

describe('an authored permissions object is kept exactly as written', () => {
  const authored: Array<[string, Record<string, unknown>]> = [
    ['empty', {}],
    ['defaultMode only', { defaultMode: 'plan' }],
    ['allow only', { allow: ['Bash(ls)'] }],
    ['deny only', { deny: ['Bash(git push *)'] }],
    ['ask only', { ask: ['Bash(*)'] }],
    ['empty allow', { allow: [] }],
  ];
  for (const [name, permissions] of authored) {
    it(`${name}: untouched, reported exists, and the studio is complete`, async () => {
      const content = JSON.stringify({ permissions, hooks: {} }, null, 2) + '\n';
      writeSettings(content);
      const report = await completeStudio(studio, options());
      expect(readSettings().permissions).toEqual(permissions);
      expect(step(report.steps, 'permissions')).toMatchObject({ status: 'exists' });
      expect(step(report.steps, 'permissions')?.detail).toContain('kept as authored');
      expect(report.audit.complete, report.audit.missing.join(',')).toBe(true);
    });
  }

  it('an authored object is kept even when inheritance is asked for', async () => {
    writeSettings(JSON.stringify({ permissions: { deny: ['Bash(x)'] } }));
    await completeStudio(studio, options({ inheritPermissions: true }));
    expect(readSettings().permissions).toEqual({ deny: ['Bash(x)'] });
  });
});

describe('a malformed settings file fails closed', () => {
  it('unparseable: permissions and the Claude hook step both fail, and the bytes are unchanged', async () => {
    const content = '{ "permissions": { "deny": ["Bash(x)"] }, ';
    writeSettings(content);
    const report = await completeStudio(studio, options());
    expect(readFileSync(settingsPath(), 'utf-8')).toBe(content);
    expect(step(report.steps, 'permissions')?.status).toBe('failed');
    expect(step(report.steps, 'hooks (claude-code)')?.status).toBe('failed');
    expect(report.audit.complete).toBe(false);
  });

  it('a file whose root is not a JSON object is left byte for byte, by both steps', async () => {
    writeSettings('[1, 2]');
    const report = await completeStudio(studio, options());
    expect(readFileSync(settingsPath(), 'utf-8')).toBe('[1, 2]');
    expect(step(report.steps, 'permissions')?.status).toBe('failed');
    expect(step(report.steps, 'hooks (claude-code)')?.status).toBe('failed');
  });

  it('a permissions value that is not an object fails the step and is never replaced', async () => {
    writeSettings(JSON.stringify({ permissions: ['Bash(*)'] }));
    const report = await completeStudio(studio, options());
    expect(step(report.steps, 'permissions')?.status).toBe('failed');
    // The file parses, so the hook step may add hooks; the value stays.
    expect(readSettings().permissions).toEqual(['Bash(*)']);
  });

  it('the main worktree: a malformed file is not replaced by the hook installer either', async () => {
    const content = '{ not json';
    writeFileSync(join(main, '.claude', 'settings.local.json'), content);
    const report = await completeStudio(main, options({ mainRoot: null }));
    expect(readFileSync(join(main, '.claude', 'settings.local.json'), 'utf-8')).toBe(content);
    expect(step(report.steps, 'hooks (claude-code)')?.status).toBe('failed');
  });
});

describe("the main worktree's rules are copied only on an explicit opt-in", () => {
  it('inheritPermissions: true copies them, and says so', async () => {
    const report = await completeStudio(studio, options({ inheritPermissions: true }));
    expect(readSettings().permissions).toEqual(LANE_RULES);
    expect(step(report.steps, 'permissions')?.detail).toBe('copied from the main worktree');
  });

  it('root sync alone does not copy them (the old default)', async () => {
    await completeStudio(studio, options({ rootSync: true }));
    expect(readSettings().permissions).not.toEqual(LANE_RULES);
  });

  it('opted in, with nothing to copy, the profile is written and the report says why', async () => {
    rmSync(join(main, '.claude', 'settings.local.json'));
    const report = await completeStudio(studio, options({ inheritPermissions: true }));
    expect(readSettings().permissions).toEqual(profile('builder'));
    expect(step(report.steps, 'permissions')?.detail).toContain('no permissions to copy');
  });
});

describe('the profile is the caller’s, from the studio record, never the checkout’s', () => {
  it('permissionProfile reviewer writes the reviewer rules', async () => {
    await completeStudio(studio, options({ permissionProfile: 'reviewer' }));
    expect(readSettings().permissions).toEqual(profile('reviewer'));
  });

  it("a checkout that declares itself a reviewer (identity role, ROLE.md) still gets the caller's builder", async () => {
    mkdirSync(join(studio, '.ink'), { recursive: true });
    writeFileSync(
      join(studio, '.ink', 'identity.json'),
      JSON.stringify({ sbSlug: 'wren', role: 'reviewer', studioId: STUDIO_ID })
    );
    writeFileSync(join(studio, '.ink', 'ROLE.md'), '# reviewer\n');
    await completeStudio(studio, options());
    expect(readSettings().permissions).toEqual(profile('builder'));
  });

  it("a checkout that declares itself a builder still gets the caller's reviewer", async () => {
    mkdirSync(join(studio, '.ink'), { recursive: true });
    writeFileSync(
      join(studio, '.ink', 'identity.json'),
      JSON.stringify({ sbSlug: 'wren', role: 'builder', studioId: STUDIO_ID })
    );
    await completeStudio(studio, options({ permissionProfile: 'reviewer' }));
    expect(readSettings().permissions).toEqual(profile('reviewer'));
  });

  it("the scratch paths name the caller's owner, never identity.json (a PR could plant one)", async () => {
    mkdirSync(join(studio, '.ink'), { recursive: true });
    writeFileSync(
      join(studio, '.ink', 'identity.json'),
      JSON.stringify({ sbSlug: 'lumen', studioId: STUDIO_ID })
    );
    await completeStudio(studio, options({ sbSlug: 'wren' }));
    expect(readSettings().permissions).toEqual(profile('builder', 'wren'));
  });

  it('permissionOwner names the owner when the caller is another SB', async () => {
    await completeStudio(studio, options({ sbSlug: 'myra', permissionOwner: 'lumen' }));
    expect(readSettings().permissions).toEqual(profile('builder', 'lumen'));
  });

  it('an owner that would widen a scratch rule fails the step and writes nothing', async () => {
    const report = await completeStudio(studio, options({ permissionOwner: '*' }));
    expect(step(report.steps, 'permissions')?.status).toBe('failed');
    expect(existsSync(settingsPath()) ? readSettings().permissions : undefined).toBeUndefined();
  });

  it('permissions: false writes none, says why, and the checklist names the gap', async () => {
    const report = await completeStudio(studio, options({ permissions: false }));
    expect(existsSync(settingsPath()) ? readSettings().permissions : undefined).toBeUndefined();
    expect(step(report.steps, 'permissions')?.status).toBe('skipped');
    expect(report.audit.missing).toEqual(['claude-permissions']);
  });
});

describe('no profile is no permissions, never a default builder (review 4177f7fe, P2 1)', () => {
  it('no profile and no lookup: nothing written, the step says why', async () => {
    const report = await completeStudio(studio, options({ permissionProfile: undefined }));
    expect(existsSync(settingsPath()) ? readSettings().permissions : undefined).toBeUndefined();
    expect(step(report.steps, 'permissions')).toMatchObject({ status: 'skipped' });
    expect(step(report.steps, 'permissions')?.detail).toContain('no permission profile');
  });

  it("a lookup that finds the row supplies the profile and the row's owner", async () => {
    const lookupPermissions = vi.fn(async () => ({ profile: 'reviewer' as const, owner: 'lumen' }));
    await completeStudio(studio, options({ permissionProfile: undefined, lookupPermissions }));
    expect(lookupPermissions).toHaveBeenCalledTimes(1);
    expect(readSettings().permissions).toEqual(profile('reviewer', 'lumen'));
  });

  it('a lookup that finds no row, or fails, is no profile', async () => {
    for (const lookupPermissions of [
      vi.fn(async () => undefined),
      vi.fn(async () => {
        throw new Error('server down');
      }),
    ]) {
      const report = await completeStudio(
        studio,
        options({ permissionProfile: undefined, lookupPermissions })
      );
      expect(step(report.steps, 'permissions')?.status).toBe('skipped');
    }
    expect(existsSync(settingsPath()) ? readSettings().permissions : undefined).toBeUndefined();
  });

  it('the lookup is not paid when a profile was given or the policy is authored', async () => {
    const lookupPermissions = vi.fn(async () => ({ profile: 'reviewer' as const }));
    await completeStudio(studio, options({ lookupPermissions }));
    writeSettings(JSON.stringify({ permissions: {} }));
    await completeStudio(studio, options({ permissionProfile: undefined, lookupPermissions }));
    expect(lookupPermissions).not.toHaveBeenCalled();
  });
});
