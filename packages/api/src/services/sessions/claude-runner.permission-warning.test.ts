/** Model-free: final admission always refuses. No subprocess, settings write,
 * runtime hint, real home lookup, database or network operation is reachable. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClaudeRunnerConfig } from './types.js';
vi.mock('./context-builder.js', () => ({ formatInjectedContext: () => '' }));
vi.mock('../../config/env.js', () => ({ env: {} }));
const mocks = vi.hoisted(() => ({
  order: [] as string[],
  warn: vi.fn(),
  spawn: vi.fn(),
  cleanup: vi.fn(),
  restore: vi.fn(),
}));
vi.mock('child_process', () => ({ spawn: mocks.spawn }));
vi.mock('./resolve-binary.js', () => ({
  resolveBinaryPath: async () => '/synthetic/claude',
  buildSpawnPath: () => '',
}));
vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('./spawn-permission-warning.js', () => ({ warnBeforeClaudeSpawn: mocks.warn }));
vi.mock('../studio-settings.js', () => ({
  applyPermissionOverlay: async () => {
    mocks.order.push('overlay');
    return mocks.restore;
  },
}));
vi.mock('./launch-settings.js', () => ({
  prepareLaunchSettings: async () => {
    mocks.order.push('settings');
    return {
      settings: { permissions: { allow: ['mcp__inkwell__*'], deny: [] } },
      processPath: '/synthetic/launch.json',
      cleanup: mocks.cleanup,
    };
  },
}));
import { ClaudeRunner } from './claude-runner.js';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.order.length = 0;
  mocks.cleanup.mockResolvedValue(undefined);
  mocks.restore.mockResolvedValue(undefined);
  mocks.warn.mockImplementation(async (_input, notify) => {
    mocks.order.push('warning');
    await notify({ missingRules: ['mcp__playwright__*'] }, new AbortController().signal);
  });
});
const spawnPrepared = (config: ClaudeRunnerConfig) =>
  (
    new ClaudeRunner() as unknown as {
      spawnProcess(
        args: string[],
        message: string,
        config: ClaudeRunnerConfig
      ): Promise<{ refusedBeforeSpawn?: string }>;
    }
  ).spawnProcess([], 'fixture message', config);

describe('Claude permission warning at the final launch seam', () => {
  it('observes final launch/overlay state, then rechecks admission without spawning', async () => {
    let held = false;
    const result = await spawnPrepared({
      workingDirectory: '/synthetic/studio',
      mcpConfigPath: '',
      launchPermissions: {
        profile: 'builder',
        owner: 'fixture',
        mainRoot: '/synthetic/main',
        worktreePath: '/synthetic/studio',
      },
      permissionOverlay: { allow: ['mcp__playwright__*'] },
      onPermissionWarning: async () => {
        held = true;
      },
      admitSpawn: () => {
        mocks.order.push('admission');
        return held ? 'fixture hold' : undefined;
      },
    });
    expect(mocks.order).toEqual(['settings', 'overlay', 'warning', 'admission']);
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        workingDirectory: '/synthetic/studio',
        mainRoot: '/synthetic/main',
        launchSettings: expect.objectContaining({
          settings: { permissions: { allow: ['mcp__inkwell__*'], deny: [] } },
        }),
      }),
      expect.any(Function)
    );
    expect(result.refusedBeforeSpawn).toBe('fixture hold');
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(mocks.cleanup).toHaveBeenCalledOnce();
    expect(mocks.restore).toHaveBeenCalledOnce();
  });
  it('also inspects a main checkout with no launch profile', async () => {
    await spawnPrepared({
      workingDirectory: '/synthetic/main',
      mcpConfigPath: '',
      onPermissionWarning: async () => {},
      admitSpawn: () => 'fixture hold',
    });
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        workingDirectory: '/synthetic/main',
        launchSettings: null,
      }),
      expect.any(Function)
    );
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
  it('does no inspection when the advisory has not been enabled', async () => {
    await spawnPrepared({
      workingDirectory: '/synthetic/main',
      mcpConfigPath: '',
      admitSpawn: () => 'fixture hold',
    });
    expect(mocks.warn).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
});
