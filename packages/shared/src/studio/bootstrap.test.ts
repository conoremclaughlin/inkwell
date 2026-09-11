import { describe, it, expect } from 'vitest';
import { access, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'fs/promises';
import path from 'path';
import { tmpdir } from 'os';
import { copyBootstrapFiles } from './bootstrap';
import { syncMcpConfig } from './mcp-config-sync';

/**
 * `existsSync` follows links, so a dangling symlink at the target used to read
 * as "missing" — and `cpSync` then wrote THROUGH it to wherever it pointed,
 * outside the studio (Lumen, PR #604 round 2). Any entry at the target, link
 * or not, means leave it alone.
 */
describe('copyBootstrapFiles — never writes through a link', () => {
  async function scratch() {
    const root = await mkdtemp(path.join(tmpdir(), 'bootstrap-copy-'));
    const source = path.join(root, 'source');
    const studio = path.join(root, 'studio');
    const outside = path.join(root, 'outside');
    await mkdir(source);
    await mkdir(studio);
    await mkdir(outside);
    await writeFile(path.join(source, '.mcp.json'), '{"mcpServers":{"trusted":{}}}\n');
    return { root, source, studio, outside };
  }

  it('copies into an empty studio', async () => {
    const { root, source, studio } = await scratch();
    try {
      expect(copyBootstrapFiles(source, studio)).toEqual(['.mcp.json']);
      expect(await readFile(path.join(studio, '.mcp.json'), 'utf8')).toContain('trusted');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('leaves a dangling symlink alone instead of writing through it', async () => {
    const { root, source, studio, outside } = await scratch();
    try {
      const target = path.join(outside, 'planted.json');
      await symlink(target, path.join(studio, '.mcp.json'));
      expect(copyBootstrapFiles(source, studio)).toEqual([]);
      // Nothing landed where the link pointed, and the link is still a link.
      await expect(access(target)).rejects.toBeDefined();
      expect((await lstat(path.join(studio, '.mcp.json'))).isSymbolicLink()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('leaves a live symlink and its target alone too', async () => {
    const { root, source, studio, outside } = await scratch();
    try {
      const target = path.join(outside, 'existing.json');
      await writeFile(target, '{"marker":true}\n');
      await symlink(target, path.join(studio, '.mcp.json'));
      expect(copyBootstrapFiles(source, studio)).toEqual([]);
      expect(await readFile(target, 'utf8')).toBe('{"marker":true}\n');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('syncMcpConfig — generated per-backend config is never written through a link', () => {
  it('skips a backend whose directory is a symlink, and still writes the other', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'mcp-sync-'));
    const studio = path.join(root, 'studio');
    const outside = path.join(root, 'outside');
    await mkdir(studio);
    await mkdir(outside);
    try {
      await writeFile(
        path.join(studio, '.mcp.json'),
        JSON.stringify({
          mcpServers: { inkwell: { type: 'http', url: 'http://localhost:3001/mcp' } },
        })
      );
      await symlink(outside, path.join(studio, '.codex'));
      const result = syncMcpConfig(studio);
      expect(result).toEqual({ codex: false, gemini: true });
      await expect(access(path.join(outside, 'config.toml'))).rejects.toBeDefined();
      await expect(access(path.join(studio, '.gemini', 'settings.json'))).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('skips a backend whose final file is a symlink, leaving the link target untouched', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'mcp-sync-'));
    const studio = path.join(root, 'studio');
    const outside = path.join(root, 'outside');
    await mkdir(path.join(studio, '.gemini'), { recursive: true });
    await mkdir(outside);
    try {
      await writeFile(
        path.join(studio, '.mcp.json'),
        JSON.stringify({
          mcpServers: { inkwell: { type: 'http', url: 'http://localhost:3001/mcp' } },
        })
      );
      const marker = path.join(outside, 'marker.json');
      await writeFile(marker, '{"marker":true}\n');
      await symlink(marker, path.join(studio, '.gemini', 'settings.json'));
      const result = syncMcpConfig(studio);
      expect(result).toEqual({ codex: true, gemini: false });
      expect(await readFile(marker, 'utf8')).toBe('{"marker":true}\n');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not append through a symlinked .gitignore', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'mcp-sync-'));
    const studio = path.join(root, 'studio');
    const outside = path.join(root, 'outside');
    await mkdir(studio);
    await mkdir(outside);
    try {
      await writeFile(
        path.join(studio, '.mcp.json'),
        JSON.stringify({
          mcpServers: { inkwell: { type: 'http', url: 'http://localhost:3001/mcp' } },
        })
      );
      const target = path.join(outside, 'gitignore-target');
      await writeFile(target, 'node_modules\n');
      await symlink(target, path.join(studio, '.gitignore'));
      expect(syncMcpConfig(studio)).toEqual({ codex: true, gemini: true });
      // The outside file was not appended to.
      expect(await readFile(target, 'utf8')).toBe('node_modules\n');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
