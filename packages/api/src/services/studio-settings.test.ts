import path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, mkdir, writeFile, access, symlink } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { DEFAULT_CLAUDE_ALLOW_RULES, DEFAULT_CLAUDE_DENY_RULES } from '@inklabs/shared';
import { applyPermissionOverlay } from './studio-settings';

/** The settings file `ink init` writes: the defaults, as the CLI does (task c3b34be8). */
async function seedSettings(dir: string): Promise<void> {
  await mkdir(join(dir, '.claude'), { recursive: true });
  await writeFile(
    join(dir, '.claude', 'settings.local.json'),
    JSON.stringify(
      {
        permissions: {
          allow: [...DEFAULT_CLAUDE_ALLOW_RULES],
          deny: [...DEFAULT_CLAUDE_DENY_RULES],
        },
        enableAllProjectMcpServers: true,
      },
      null,
      2
    ) + '\n'
  );
}

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
    await seedSettings(tempDir);

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
    await seedSettings(tempDir);

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
