import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockExecSync = vi.fn();
const mockExecFile = vi.fn();

vi.mock('child_process', () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
  execFile: (...args: unknown[]) => mockExecFile(...args),
}));

/**
 * Drive the callback-style execFile mock: `responses` maps the git
 * subcommand ('rev-parse' | 'diff') to the stdout it should produce.
 */
function answerExecFile(responses: Record<string, string>) {
  mockExecFile.mockImplementation((...args: unknown[]) => {
    const gitArgs = args[1] as string[];
    const cb = args[args.length - 1] as (err: Error | null, stdout: string) => void;
    const sub = gitArgs[0];
    if (sub in responses) cb(null, responses[sub]);
    else cb(new Error(`unexpected git ${sub}`), '');
  });
}

async function flushRefresh() {
  // The background refresh is two chained promises; a couple of microtask
  // turns settles it.
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

describe('getRuntimeBuildInfo', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    delete process.env.pm_id;
  });

  it('reads never block: the first call reports startup state, the refresh lands later', async () => {
    mockExecSync.mockReturnValue('abc123def456');
    answerExecFile({ 'rev-parse': 'fff999aaa111', diff: 'packages/api/src/server.ts' });

    const { getRuntimeBuildInfo } = await import('./runtime-build-info');

    const immediate = getRuntimeBuildInfo(20_000);
    expect(immediate.startupGitSha).toBe('abc123def456');
    expect(immediate.currentGitSha).toBe('abc123def456');
    expect(immediate.updateAvailable).toBe(false);

    await flushRefresh();
    const after = getRuntimeBuildInfo(21_000);
    expect(after.currentGitSha).toBe('fff999aaa111');
    expect(after.updateAvailable).toBe(true);
    expect(after.requiresRestart).toBe(true);
  });

  it('a head that moved on non-API commits does NOT demand a restart', async () => {
    mockExecSync.mockReturnValue('abc123def456');
    // HEAD advanced, but the delta over API-relevant paths is empty
    // (cli/web-only commits) — the running server's code is unchanged.
    answerExecFile({ 'rev-parse': 'fff999aaa111', diff: '' });

    const { getRuntimeBuildInfo } = await import('./runtime-build-info');
    getRuntimeBuildInfo(20_000);
    await flushRefresh();

    const info = getRuntimeBuildInfo(21_000);
    expect(info.currentGitSha).toBe('fff999aaa111');
    expect(info.updateAvailable).toBe(false);
    expect(info.requiresRestart).toBe(false);
  });

  it('scopes the delta check to API-relevant paths', async () => {
    mockExecSync.mockReturnValue('abc123def456');
    answerExecFile({ 'rev-parse': 'fff999aaa111', diff: '' });

    const { getRuntimeBuildInfo } = await import('./runtime-build-info');
    getRuntimeBuildInfo(20_000);
    await flushRefresh();

    const diffCall = mockExecFile.mock.calls.find((c) => (c[1] as string[])[0] === 'diff');
    expect(diffCall).toBeDefined();
    const gitArgs = diffCall![1] as string[];
    expect(gitArgs).toContain('packages/api');
    expect(gitArgs).toContain('packages/shared');
    expect(gitArgs).not.toContain('packages/cli');
    expect(gitArgs).not.toContain('packages/web');
  });

  it('mid-refresh reads keep the prior snapshot — sha and delta publish together', async () => {
    mockExecSync.mockReturnValue('shaA');

    // First refresh: head B with an API-relevant delta → updateAvailable.
    answerExecFile({ 'rev-parse': 'shaB', diff: 'packages/api/src/x.ts' });
    const { getRuntimeBuildInfo } = await import('./runtime-build-info');
    getRuntimeBuildInfo(20_000);
    await flushRefresh();
    expect(getRuntimeBuildInfo(21_000).updateAvailable).toBe(true);

    // Second refresh: head C, cli-only delta. Hold the diff callback so the
    // refresh is mid-flight after rev-parse resolved.
    let releaseDiff: (() => void) | null = null;
    mockExecFile.mockImplementation((...args: unknown[]) => {
      const gitArgs = args[1] as string[];
      const cb = args[args.length - 1] as (err: Error | null, stdout: string) => void;
      if (gitArgs[0] === 'rev-parse') cb(null, 'shaC');
      else releaseDiff = () => cb(null, '');
    });
    getRuntimeBuildInfo(50_000);
    await flushRefresh();

    // Refresh is stalled on the diff: a read must still see the COMPLETE
    // previous snapshot (shaB + true), never shaC paired with B's verdict.
    const during = getRuntimeBuildInfo(51_000);
    expect(during.currentGitSha).toBe('shaB');
    expect(during.updateAvailable).toBe(true);

    expect(releaseDiff).not.toBeNull();
    releaseDiff!();
    await flushRefresh();

    const after = getRuntimeBuildInfo(52_000);
    expect(after.currentGitSha).toBe('shaC');
    expect(after.updateAvailable).toBe(false);
  });

  it('a failed diff fails toward restart-recommended, never toward hiding an update', async () => {
    mockExecSync.mockReturnValue('abc123def456');
    // rev-parse succeeds with a new sha; diff errors (e.g. startup sha gone).
    answerExecFile({ 'rev-parse': 'fff999aaa111' });

    const { getRuntimeBuildInfo } = await import('./runtime-build-info');
    getRuntimeBuildInfo(20_000);
    await flushRefresh();

    const info = getRuntimeBuildInfo(21_000);
    expect(info.updateAvailable).toBe(true);
  });

  it('reports process manager as pm2 when pm_id is set', async () => {
    process.env.pm_id = '0';
    mockExecSync.mockReturnValue('abc123def456');

    const { getRuntimeBuildInfo } = await import('./runtime-build-info');
    const info = getRuntimeBuildInfo(20_000);

    expect(info.processManager).toBe('pm2');
  });
});
