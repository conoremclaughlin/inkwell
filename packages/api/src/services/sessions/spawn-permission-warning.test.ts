import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { LaunchSettings } from './launch-settings.js';
vi.mock('../../utils/logger.js', () => ({ logger: { warn: vi.fn() } }));
import {
  collectSpawnPermissions,
  inspectSpawnPermissions,
  readPermissionSource,
  SPAWN_STANDARD_ALLOW_RULES,
  warnBeforeClaudeSpawn,
} from './spawn-permission-warning.js';

const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'spawn-permission-test-'));
  roots.push(root);
  return {
    workingDirectory: join(root, 'checkout'),
    mainRoot: join(root, 'main'),
    home: join(root, 'home'),
    managedSettingsPath: join(root, 'managed.json'),
  };
}
async function settings(path: string, permissions: unknown) {
  await mkdir(join(path, '.claude'), { recursive: true });
  const file = join(path, '.claude', 'settings.local.json');
  await writeFile(file, JSON.stringify({ permissions }));
  return file;
}

describe('read-only spawn permission inspection', () => {
  it('warns for a main checkout without settings, without creating any', async () => {
    const input = await fixture();
    input.mainRoot = input.workingDirectory;
    const report = await inspectSpawnPermissions(input);
    expect(report?.missingRules).toEqual(SPAWN_STANDARD_ALLOW_RULES);
    expect(report?.workingDirectory).toBe(input.workingDirectory);
    expect(report?.fix).toContain('preserving all ask/deny');
    await expect(
      readFile(join(input.workingDirectory, '.claude/settings.local.json'))
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('combines user, project, main-local, worktree-local and managed lists', async () => {
    const input = await fixture();
    await settings(input.home, {});
    await writeFile(
      join(input.home, '.claude/settings.json'),
      JSON.stringify({ permissions: { allow: ['Bash'] } })
    );
    await settings(input.workingDirectory, { allow: ['mcp__playwright__*'] });
    await writeFile(
      join(input.workingDirectory, '.claude/settings.json'),
      JSON.stringify({ permissions: { allow: ['WebFetch'] } })
    );
    await settings(input.mainRoot, { allow: ['mcp__inkwell__*'] });
    await writeFile(
      input.managedSettingsPath,
      JSON.stringify({ permissions: { allow: ['WebSearch'] } })
    );
    expect(await inspectSpawnPermissions(input)).toBeUndefined();
  });
  it('reads explicit config-dir instead of the ordinary home configuration', async () => {
    const input = await fixture();
    const configDir = join(input.home, 'custom-config');
    await mkdir(configDir, { recursive: true });
    await writeFile(
      join(configDir, 'settings.json'),
      JSON.stringify({ permissions: { allow: SPAWN_STANDARD_ALLOW_RULES } })
    );
    expect(await inspectSpawnPermissions({ ...input, configDir })).toBeUndefined();
  });
  it('counts actual launch allows but keeps stored restrictions separate and private', async () => {
    const input = await fixture();
    const local = await settings(input.workingDirectory, {
      ask: ['mcp__inkwell__*'],
      deny: ['Bash(rm -rf *)'],
    });
    const before = await readFile(local, 'utf8');
    const launchSettings = {
      hostPath: '/synthetic/launch.json',
      settings: { permissions: { allow: [...SPAWN_STANDARD_ALLOW_RULES], deny: [] } },
    } as unknown as LaunchSettings;
    const warning = await inspectSpawnPermissions({ ...input, launchSettings });
    expect(warning?.missingRules).toEqual([]);
    expect(warning?.restrictedRules).toEqual(['ask: mcp__inkwell__* (full)']);
    expect(JSON.stringify(warning)).not.toContain('rm -rf');
    expect(await readFile(local, 'utf8')).toBe(before);
  });
  it('accepts launch asks for the upcoming automated policy without treating them as missing', async () => {
    const input = await fixture();
    const launchSettings = {
      hostPath: '/synthetic/launch.json',
      settings: {
        permissions: {
          allow: [...SPAWN_STANDARD_ALLOW_RULES],
          ask: ['mcp__playwright__*'],
          deny: [],
        },
      },
    } as unknown as LaunchSettings;
    const warning = await inspectSpawnPermissions({ ...input, launchSettings });
    expect(warning?.missingRules).toEqual([]);
    expect(warning?.restrictedRules).toEqual(['ask: mcp__playwright__* (full)']);
  });
  it.each(['{bad-json', '[]', '{"permissions":null}', '{"permissions":{"allow":[7]}}'])(
    'reports malformed settings without exposing their contents',
    async (raw) => {
      const input = await fixture();
      const file = await settings(input.workingDirectory, {});
      await writeFile(file, raw);
      expect((await readPermissionSource(file)).source.state).toBe('unverified');
      expect((await inspectSpawnPermissions(input))?.sources).toContainEqual({
        path: file,
        state: 'unverified',
      });
    }
  );
  it('refuses oversized files and symlinks rather than following or reporting contents', async () => {
    const input = await fixture();
    const file = await settings(input.workingDirectory, {});
    await writeFile(file, 'x'.repeat(256 * 1024 + 1));
    expect((await readPermissionSource(file)).source.state).toBe('unverified');
    const link = join(input.workingDirectory, '.claude', 'linked.json');
    await symlink(file, link);
    expect((await readPermissionSource(link)).source.state).toBe('unverified');
  });
  it.each([
    { allowManagedPermissionRulesOnly: true, permissions: { allow: SPAWN_STANDARD_ALLOW_RULES } },
    { permissions: { allowManagedPermissionRulesOnly: true, allow: SPAWN_STANDARD_ALLOW_RULES } },
  ])('reports managed-only policy as unverified, even with observed allows', async (managed) => {
    const input = await fixture();
    await settings(input.workingDirectory, { allow: SPAWN_STANDARD_ALLOW_RULES });
    await writeFile(input.managedSettingsPath, JSON.stringify(managed));
    const result = await readPermissionSource(input.managedSettingsPath);
    expect(result.source.state).toBe('unverified');
    expect(result.rules.allow).toEqual([]);
    expect((await inspectSpawnPermissions(input))?.sources).toContainEqual({
      path: input.managedSettingsPath,
      state: 'unverified',
    });
  });
  it('never reads host settings as a container policy', async () => {
    const result = await collectSpawnPermissions({
      workingDirectory: '/synthetic',
      container: true,
    });
    expect(result.sources).toEqual([]);
    expect(result.limitations[0]).toContain('not container policy');
    expect(
      (await inspectSpawnPermissions({ workingDirectory: '/synthetic', container: true }))
        ?.missingRules
    ).toEqual([]);
  });
  it('does not expose arbitrary command text in a shadowing ask', async () => {
    const input = await fixture();
    await settings(input.workingDirectory, {
      allow: SPAWN_STANDARD_ALLOW_RULES,
      ask: ['Bash(echo fixture-private-value)'],
    });
    const report = await inspectSpawnPermissions(input);
    expect(report?.restrictedRules).toContain('ask: Bash(*) (partial)');
    expect(JSON.stringify(report)).not.toContain('fixture-private-value');
  });
  it('bounds a hung notification and aborts it without throwing into the turn', async () => {
    const input = await fixture();
    let signal: AbortSignal | undefined;
    const notify = vi.fn(async (_warning, abort: AbortSignal) => {
      signal = abort;
      await new Promise<void>(() => {});
    });
    await warnBeforeClaudeSpawn(input, notify, 100);
    expect(notify).toHaveBeenCalledOnce();
    expect(signal?.aborted).toBe(true);
  });
  it('contains a rejected notification', async () => {
    const input = await fixture();
    await expect(
      warnBeforeClaudeSpawn(input, async () => {
        throw new Error('fixture');
      })
    ).resolves.toBeUndefined();
  });
});
