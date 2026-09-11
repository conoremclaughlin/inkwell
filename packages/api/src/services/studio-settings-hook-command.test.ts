/**
 * Generated studio hooks reach `ink` through this checkout's own CLI build,
 * never through the global ~/.ink/bin/ink link (AGENTS.md, "The Global ink
 * CLI Link"). The resolver itself is covered in ink-cli.test.ts; these tests
 * pin what ends up written into .claude/settings.local.json.
 */

import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const resolveInkCliMock = vi.fn();
vi.mock('./ink-cli', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./ink-cli')>()),
  resolveInkCli: (...a: unknown[]) => resolveInkCliMock(...a),
}));
vi.mock('../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { ensureStudioSettings } from './studio-settings';

interface HookEntry {
  hooks?: Array<{ type: string; command: string }>;
}

function hookCommands(hooks: Record<string, HookEntry[]>): string[] {
  return Object.values(hooks).flatMap((entries) =>
    entries.flatMap((entry) => (entry.hooks ?? []).map((h) => h.command))
  );
}

async function generate(worktree: string): Promise<string[]> {
  expect(await ensureStudioSettings(worktree)).toBe(true);
  const settings = JSON.parse(
    await readFile(join(worktree, '.claude', 'settings.local.json'), 'utf-8')
  );
  return hookCommands(settings.hooks);
}

let worktree: string;

beforeEach(async () => {
  worktree = await mkdtemp(join(tmpdir(), 'studio-hooks-'));
  resolveInkCliMock.mockReset();
});

afterEach(async () => {
  await rm(worktree, { recursive: true, force: true });
});

describe('ensureStudioSettings — hook command', () => {
  it("runs every generated hook through node against this checkout's CLI build", async () => {
    resolveInkCliMock.mockReturnValue({
      path: '/srv/checkout/packages/cli/dist/cli.js',
      source: 'checkout',
      script: true,
    });

    const commands = await generate(worktree);

    expect(commands).toHaveLength(6);
    for (const command of commands) {
      expect(command).toMatch(
        /^node \/srv\/checkout\/packages\/cli\/dist\/cli\.js hooks [a-z-]+ --backend claude-code$/
      );
    }
    expect(commands.map((c) => c.split(' hooks ')[1].split(' ')[0]).sort()).toEqual([
      'on-prompt',
      'on-session-start',
      'on-stop',
      'on-tool-approval',
      'post-compact',
      'pre-compact',
    ]);
  });

  it('quotes a checkout path that contains whitespace', async () => {
    resolveInkCliMock.mockReturnValue({
      path: '/Users/o b/ink/packages/cli/dist/cli.js',
      source: 'checkout',
      script: true,
    });

    const commands = await generate(worktree);

    for (const command of commands) {
      expect(command.startsWith('node "/Users/o b/ink/packages/cli/dist/cli.js" hooks ')).toBe(
        true
      );
    }
  });

  it('falls back to bare `ink` on PATH only when this checkout has no build', async () => {
    resolveInkCliMock.mockReturnValue(null);

    const commands = await generate(worktree);

    expect(commands).toHaveLength(6);
    for (const command of commands) {
      expect(command).toMatch(/^ink hooks [a-z-]+ --backend claude-code$/);
      expect(command).not.toContain('.local/bin');
      expect(command).not.toContain('.ink/bin');
    }
  });
});
