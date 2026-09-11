import { describe, it, expect, vi } from 'vitest';
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'fs/promises';
import path from 'path';
import { tmpdir } from 'os';
import { ensureStudioSettings } from './studio-settings';

vi.mock('../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

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
