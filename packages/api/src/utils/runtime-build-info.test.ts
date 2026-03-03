import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockExecSync = vi.fn();

vi.mock('child_process', () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
}));

describe('getRuntimeBuildInfo', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    delete process.env.pm_id;
  });

  it('marks update as available when current git sha differs from startup sha', async () => {
    mockExecSync.mockReturnValueOnce('abc123def456').mockReturnValueOnce('fff999aaa111');

    const { getRuntimeBuildInfo } = await import('./runtime-build-info');
    const info = getRuntimeBuildInfo(20_000);

    expect(info.startupGitSha).toBe('abc123def456');
    expect(info.currentGitSha).toBe('fff999aaa111');
    expect(info.updateAvailable).toBe(true);
    expect(info.requiresRestart).toBe(true);
  });

  it('reports process manager as pm2 when pm_id is set', async () => {
    process.env.pm_id = '0';
    mockExecSync.mockReturnValue('abc123def456');

    const { getRuntimeBuildInfo } = await import('./runtime-build-info');
    const info = getRuntimeBuildInfo(20_000);

    expect(info.processManager).toBe('pm2');
  });
});
