/**
 * The server's studio settings generator and the CLI's `ink hooks install`
 * are two writers of the same hook lines. What the server writes must read as
 * Inkwell-managed to the CLI, or the next `ink hooks install` in a
 * server-provisioned studio reports a conflict (Lumen, PR #611). This test
 * runs the real generator and then the real CLI installer on its output.
 */

import { mkdtemp, readFile, writeFile, rm } from 'fs/promises';
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
import { installHooks, isPcpHookCommand } from '../../../cli/src/commands/hooks.js';

const SETTINGS = join('.claude', 'settings.local.json');

interface HookEntry {
  hooks?: Array<{ type: string; command: string }>;
}

function hookCommands(hooks: Record<string, HookEntry[]>): string[] {
  return Object.values(hooks).flatMap((entries) =>
    entries.flatMap((entry) => (entry.hooks ?? []).map((h) => h.command))
  );
}

async function readSettings(worktree: string): Promise<{ hooks: Record<string, HookEntry[]> }> {
  return JSON.parse(await readFile(join(worktree, SETTINGS), 'utf-8'));
}

let worktree: string;

beforeEach(async () => {
  worktree = await mkdtemp(join(tmpdir(), 'studio-cli-install-'));
  resolveInkCliMock.mockReset();
});

afterEach(async () => {
  await rm(worktree, { recursive: true, force: true });
});

describe('server-generated hooks → ink hooks install', () => {
  it('a studio provisioned by the server installs without conflict', async () => {
    resolveInkCliMock.mockReturnValue({
      path: '/srv/checkout/packages/cli/dist/cli.js',
      source: 'checkout',
      script: true,
    });
    expect(await ensureStudioSettings(worktree)).toBe(true);

    const generated = hookCommands((await readSettings(worktree)).hooks);
    expect(generated).toHaveLength(6);
    for (const command of generated) {
      expect(isPcpHookCommand(command), command).toBe(true);
    }

    const { result, backend } = installHooks(worktree);
    expect(backend.name).toBe('claude-code');
    expect(result).toBe('installed');
  });

  it('holds when the checkout path carries whitespace', async () => {
    resolveInkCliMock.mockReturnValue({
      path: '/Users/o b/ink/packages/cli/dist/cli.js',
      source: 'checkout',
      script: true,
    });
    expect(await ensureStudioSettings(worktree)).toBe(true);

    expect(installHooks(worktree).result).toBe('installed');
  });

  it('round-trips an INK_CLI_PATH executable whose name looks nothing like ink', async () => {
    resolveInkCliMock.mockReturnValue({
      path: '/opt/tools/launch-ink',
      source: 'env',
      script: false,
    });
    expect(await ensureStudioSettings(worktree)).toBe(true);

    for (const command of hookCommands((await readSettings(worktree)).hooks)) {
      expect(isPcpHookCommand(command), command).toBe(true);
    }
    expect(installHooks(worktree).result).toBe('installed');
  });

  it('round-trips an INK_CLI_PATH script that is not packages/cli/dist/cli.js', async () => {
    resolveInkCliMock.mockReturnValue({
      path: '/opt/tools/entry.mjs',
      source: 'env',
      script: true,
    });
    expect(await ensureStudioSettings(worktree)).toBe(true);

    expect(installHooks(worktree).result).toBe('installed');
  });

  it('control: an unrelated CLI with the same command shape is preserved, not deleted', async () => {
    resolveInkCliMock.mockReturnValue({
      path: '/srv/checkout/packages/cli/dist/cli.js',
      source: 'checkout',
      script: true,
    });
    expect(await ensureStudioSettings(worktree)).toBe(true);

    const custom = 'node /opt/project/scripts/cli.js hooks audit --backend claude-code';
    const settings = await readSettings(worktree);
    settings.hooks.PreToolUse.push({ hooks: [{ type: 'command', command: custom }] });
    await writeFile(join(worktree, SETTINGS), JSON.stringify(settings, null, 2) + '\n');

    expect(installHooks(worktree).result).toBe('conflict');
    expect(hookCommands((await readSettings(worktree)).hooks)).toContain(custom);
  });

  it('control: a genuinely custom hook next to the generated ones still conflicts', async () => {
    resolveInkCliMock.mockReturnValue({
      path: '/srv/checkout/packages/cli/dist/cli.js',
      source: 'checkout',
      script: true,
    });
    expect(await ensureStudioSettings(worktree)).toBe(true);

    const settings = await readSettings(worktree);
    settings.hooks.PreToolUse.push({ hooks: [{ type: 'command', command: 'custom-tool audit' }] });
    await writeFile(join(worktree, SETTINGS), JSON.stringify(settings, null, 2) + '\n');

    expect(installHooks(worktree).result).toBe('conflict');
  });
});
