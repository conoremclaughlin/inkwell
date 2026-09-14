import path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, mkdir, writeFile, access, symlink } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { ensureStudioSettings, applyPermissionOverlay } from './studio-settings';

describe('ensureStudioSettings', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'studio-settings-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('generates settings in an empty worktree', async () => {
    const wrote = await ensureStudioSettings(tempDir);
    expect(wrote).toBe(true);

    const raw = await readFile(join(tempDir, '.claude', 'settings.local.json'), 'utf-8');
    const settings = JSON.parse(raw);

    expect(settings.permissions.allow).toContain('mcp__inkwell__*');
    expect(settings.permissions.allow).toContain('Bash(*)');
    expect(settings.permissions.deny).toContain('Bash(rm -rf *)');
    expect(settings.enableAllProjectMcpServers).toBe(true);
    expect(settings.hooks).toBeDefined();
    expect(settings.hooks.PreCompact).toBeDefined();
    expect(settings.hooks.PreToolUse).toBeDefined();
    expect(settings.hooks.Stop).toBeDefined();
  });

  it('skips generation when permissions already exist', async () => {
    await mkdir(join(tempDir, '.claude'), { recursive: true });
    const existing = {
      permissions: { allow: ['mcp__inkwell__*'], deny: [] },
      hooks: { custom: true },
    };
    await writeFile(join(tempDir, '.claude', 'settings.local.json'), JSON.stringify(existing));

    const wrote = await ensureStudioSettings(tempDir);
    expect(wrote).toBe(false);

    // Verify original file unchanged
    const raw = await readFile(join(tempDir, '.claude', 'settings.local.json'), 'utf-8');
    const settings = JSON.parse(raw);
    expect(settings.permissions.allow).toEqual(['mcp__inkwell__*']);
    expect(settings.hooks).toEqual({ custom: true });
  });

  it('preserves existing non-permission settings', async () => {
    await mkdir(join(tempDir, '.claude'), { recursive: true });
    const existing = {
      enabledMcpjsonServers: ['supabase', 'inkstand'],
      hooks: { PreCompact: [{ custom: true }] },
    };
    await writeFile(join(tempDir, '.claude', 'settings.local.json'), JSON.stringify(existing));

    const wrote = await ensureStudioSettings(tempDir);
    expect(wrote).toBe(true);

    const raw = await readFile(join(tempDir, '.claude', 'settings.local.json'), 'utf-8');
    const settings = JSON.parse(raw);

    // New permissions added
    expect(settings.permissions.allow).toContain('mcp__inkwell__*');
    // Existing settings preserved
    expect(settings.enabledMcpjsonServers).toEqual(['supabase', 'inkstand']);
    // Existing hooks preserved (not overwritten with generated ones)
    expect(settings.hooks).toEqual({ PreCompact: [{ custom: true }] });
  });

  it('creates .claude directory if missing', async () => {
    await ensureStudioSettings(tempDir);
    const raw = await readFile(join(tempDir, '.claude', 'settings.local.json'), 'utf-8');
    expect(JSON.parse(raw)).toBeDefined();
  });
});

describe('applyPermissionOverlay', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'overlay-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('merges overlay rules into existing settings', async () => {
    // Set up base settings
    await ensureStudioSettings(tempDir);

    const restore = await applyPermissionOverlay(tempDir, {
      allow: ['mcp__custom_server__*', 'Bash(docker *)'],
    });

    const raw = await readFile(join(tempDir, '.claude', 'settings.local.json'), 'utf-8');
    const settings = JSON.parse(raw);

    // Original rules still present
    expect(settings.permissions.allow).toContain('mcp__inkwell__*');
    expect(settings.permissions.allow).toContain('Bash(*)');
    // Overlay rules added
    expect(settings.permissions.allow).toContain('mcp__custom_server__*');
    expect(settings.permissions.allow).toContain('Bash(docker *)');

    // Restore original
    await restore();

    const restored = JSON.parse(
      await readFile(join(tempDir, '.claude', 'settings.local.json'), 'utf-8')
    );
    expect(restored.permissions.allow).not.toContain('mcp__custom_server__*');
    expect(restored.permissions.allow).not.toContain('Bash(docker *)');
  });

  it('deduplicates overlay rules', async () => {
    await ensureStudioSettings(tempDir);

    await applyPermissionOverlay(tempDir, {
      allow: ['mcp__inkwell__*', 'Bash(*)'], // already in defaults
    });

    const raw = await readFile(join(tempDir, '.claude', 'settings.local.json'), 'utf-8');
    const settings = JSON.parse(raw);

    // No duplicates
    const mcpCount = settings.permissions.allow.filter(
      (r: string) => r === 'mcp__inkwell__*'
    ).length;
    expect(mcpCount).toBe(1);
  });

  it('works on an empty worktree', async () => {
    const restore = await applyPermissionOverlay(tempDir, {
      allow: ['mcp__playwright__*'],
      deny: ['Bash(rm -rf /)'],
    });

    const raw = await readFile(join(tempDir, '.claude', 'settings.local.json'), 'utf-8');
    const settings = JSON.parse(raw);

    expect(settings.permissions.allow).toEqual(['mcp__playwright__*']);
    expect(settings.permissions.deny).toEqual(['Bash(rm -rf /)']);

    // Restore removes the file (original was null)
    await restore();

    await expect(access(join(tempDir, '.claude', 'settings.local.json'))).rejects.toThrow();
  });
});

/**
 * A checkout can ship `.claude` — or the settings file itself — as a symlink
 * pointing anywhere. The settings writer used to merge-and-write through it,
 * landing outside the worktree (Lumen, PR #604 round 2). lstat sees the link.
 */
describe('ensureStudioSettings — never writes through a symlink', () => {
  async function scratch() {
    const root = await mkdtemp(path.join(tmpdir(), 'studio-settings-'));
    const worktree = path.join(root, 'worktree');
    const outside = path.join(root, 'outside');
    await mkdir(worktree);
    await mkdir(outside);
    return { root, worktree, outside };
  }

  it('writes settings into a plain checkout', async () => {
    const { root, worktree } = await scratch();
    try {
      expect(await ensureStudioSettings(worktree)).toBe(true);
      const settings = JSON.parse(
        await readFile(path.join(worktree, '.claude', 'settings.local.json'), 'utf8')
      );
      expect(settings.permissions.allow.length).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses when .claude is a symlink to a directory outside the checkout', async () => {
    const { root, worktree, outside } = await scratch();
    try {
      await symlink(outside, path.join(worktree, '.claude'));
      expect(await ensureStudioSettings(worktree)).toBe(false);
      await expect(access(path.join(outside, 'settings.local.json'))).rejects.toBeDefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses when the settings file itself is a symlink, and leaves the link target untouched', async () => {
    const { root, worktree, outside } = await scratch();
    try {
      await mkdir(path.join(worktree, '.claude'));
      const marker = path.join(outside, 'marker.json');
      await writeFile(marker, '{"marker":true}\n');
      await symlink(marker, path.join(worktree, '.claude', 'settings.local.json'));
      expect(await ensureStudioSettings(worktree)).toBe(false);
      expect(await readFile(marker, 'utf8')).toBe('{"marker":true}\n');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
