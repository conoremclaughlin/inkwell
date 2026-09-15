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
    // rev-list is asked twice — overall, then API-relevant — so allow the
    // fixture to distinguish them by whether a pathspec was supplied.
    if (sub === 'rev-list') {
      const key = gitArgs.includes('--') ? 'rev-list:api' : 'rev-list';
      if (key in responses) return cb(null, responses[key]);
    }
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
    // Top-anchored: the diff is path-scoped too, so it carried the same
    // cwd-relative defect as the counts (Lumen, #586 r1 P1).
    expect(gitArgs).toContain(':(top)packages/api');
    expect(gitArgs).toContain(':(top)packages/shared');
    expect(gitArgs.some((a) => a.includes('packages/cli'))).toBe(false);
    expect(gitArgs.some((a) => a.includes('packages/web'))).toBe(false);
  });

  it('mid-refresh reads keep the prior snapshot — sha and delta publish together', async () => {
    mockExecSync.mockReturnValue('shaA');

    // First refresh: head B with an API-relevant delta → updateAvailable.
    answerExecFile({
      'rev-parse': 'shaB',
      diff: 'packages/api/src/x.ts',
      'rev-list': '4',
      'rev-list:api': '1',
    });
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
      // Stall the DIFF specifically. Matching "anything that isn't rev-parse"
      // silently re-bound this to a later call once the refresh grew more
      // steps, and the release then freed the wrong one.
      if (gitArgs[0] === 'diff') releaseDiff = () => cb(null, '');
      else if (gitArgs[0] === 'rev-parse') cb(null, 'shaC');
      else cb(null, '0');
    });
    getRuntimeBuildInfo(50_000);
    await flushRefresh();

    // Refresh is stalled on the diff: a read must still see the COMPLETE
    // previous snapshot (shaB + true), never shaC paired with B's verdict.
    const during = getRuntimeBuildInfo(51_000);
    expect(during.currentGitSha).toBe('shaB');
    expect(during.updateAvailable).toBe(true);
    // The distance fields publish in the same block, so they must be the
    // PREVIOUS refresh's values too — never shaC's sha beside stale counts.
    expect(during.behindOriginCount).toBe(4);
    expect(during.apiBehindOriginCount).toBe(1);

    expect(releaseDiff).not.toBeNull();
    releaseDiff!();
    await flushRefresh();

    const after = getRuntimeBuildInfo(52_000);
    expect(after.currentGitSha).toBe('shaC');
    expect(after.updateAvailable).toBe(false);
    expect(after.behindOriginCount).toBe(0);
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

/**
 * How far the CHECKOUT trails origin — the question `updateAvailable` cannot
 * answer.
 *
 * It compares the startup sha to the local HEAD, so it means "did the tree move
 * under me, do I need a restart". On 2026-09-04 the deployed tree sat 75
 * commits behind origin/main, 2 of them touching the API, twenty hours after a
 * fix was merged for it — and /health reported `updateAvailable: false` in
 * perfect good faith. Myra's classification: two questions, one signal, and the
 * unanswered one fails toward reassurance.
 */
describe('getRuntimeBuildInfo — distance from origin', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    delete process.env.pm_id;
  });

  it('reports the checkout as behind even when no restart is needed', async () => {
    mockExecSync.mockReturnValue('abc123def456');
    answerExecFile({
      'rev-parse': 'abc123def456', // HEAD unmoved since startup
      diff: '',
      'rev-list': '75',
      'rev-list:api': '2',
    });

    const { getRuntimeBuildInfo } = await import('./runtime-build-info');
    getRuntimeBuildInfo(20_000);
    await flushRefresh();
    const info = getRuntimeBuildInfo(40_000);

    // The old signal is correct and says nothing is wrong...
    expect(info.updateAvailable).toBe(false);
    // ...while the checkout is missing 75 commits, 2 of them ours.
    expect(info.behindOriginCount).toBe(75);
    expect(info.apiBehindOriginCount).toBe(2);
    expect(info.behindOriginApi).toBe(true);
  });

  it('reports a current checkout as verified, not merely quiet', async () => {
    mockExecSync.mockReturnValue('abc123def456');
    answerExecFile({
      'rev-parse': 'abc123def456',
      diff: '',
      'rev-list': '0',
      'rev-list:api': '0',
    });

    const { getRuntimeBuildInfo } = await import('./runtime-build-info');
    getRuntimeBuildInfo(20_000);
    await flushRefresh();
    const info = getRuntimeBuildInfo(40_000);

    expect(info.behindOriginCount).toBe(0);
    expect(info.behindOriginApi).toBe(false);
  });

  /**
   * THE ROW-ONE ASSERTION. Unknown must not read as up-to-date. A checkout with
   * no upstream, or a git failure, has to leave the count null so a caller can
   * tell "verified current" from "could not tell".
   */
  it('leaves the count NULL when it cannot be determined', async () => {
    mockExecSync.mockReturnValue('abc123def456');
    // No upstream configured: rev-parse @{upstream} fails.
    mockExecFile.mockImplementation((...args: unknown[]) => {
      const gitArgs = args[1] as string[];
      const cb = args[args.length - 1] as (err: Error | null, stdout: string) => void;
      if (gitArgs.includes('@{upstream}')) return cb(new Error('no upstream'), '');
      if (gitArgs[0] === 'rev-parse') return cb(null, 'abc123def456');
      return cb(null, '');
    });

    const { getRuntimeBuildInfo } = await import('./runtime-build-info');
    getRuntimeBuildInfo(20_000);
    await flushRefresh();
    const info = getRuntimeBuildInfo(40_000);

    expect(info.behindOriginCount).toBeNull();
    expect(info.apiBehindOriginCount).toBeNull();
    // Never true on an unknown — but a reader must consult the count rather
    // than trusting this alone.
    expect(info.behindOriginApi).toBe(false);
    expect(info.upstreamRef).toBeNull();
  });

  /**
   * The guard I wrote most deliberately and had not pinned: the upstream
   * RESOLVES but rev-list fails. Found by mutating `return null` to `return 0`
   * and watching every test stay green — the null-vs-unknown test above kills
   * the upstream lookup, so countRevs never ran.
   *
   * Zero means "verified up to date". Failing into it is precisely the calm
   * wrong answer this field exists to remove.
   */
  it('returns NULL, never 0, when rev-list itself fails', async () => {
    mockExecSync.mockReturnValue('abc123def456');
    mockExecFile.mockImplementation((...args: unknown[]) => {
      const gitArgs = args[1] as string[];
      const cb = args[args.length - 1] as (err: Error | null, stdout: string) => void;
      if (gitArgs.includes('@{upstream}')) return cb(null, 'origin/main');
      if (gitArgs[0] === 'rev-parse') return cb(null, 'abc123def456');
      if (gitArgs[0] === 'rev-list') return cb(new Error('bad revision'), '');
      return cb(null, '');
    });

    const { getRuntimeBuildInfo } = await import('./runtime-build-info');
    getRuntimeBuildInfo(20_000);
    await flushRefresh();
    const info = getRuntimeBuildInfo(40_000);

    // The upstream was found, so this is not the "no upstream" path.
    expect(info.upstreamRef).toBe('origin/main');
    expect(info.behindOriginCount).toBeNull();
    expect(info.apiBehindOriginCount).toBeNull();
    expect(info.behindOriginApi).toBe(false);
  });

  it('returns NULL when rev-list emits something unparseable', async () => {
    mockExecSync.mockReturnValue('abc123def456');
    answerExecFile({
      'rev-parse': 'origin/main',
      diff: '',
      'rev-list': 'not-a-number',
      'rev-list:api': '',
    });

    const { getRuntimeBuildInfo } = await import('./runtime-build-info');
    getRuntimeBuildInfo(20_000);
    await flushRefresh();
    expect(getRuntimeBuildInfo(40_000).behindOriginCount).toBeNull();
  });

  it('measures against the tracked upstream, not a hardcoded main', async () => {
    mockExecSync.mockReturnValue('abc123def456');
    answerExecFile({
      'rev-parse': 'origin/release-2',
      diff: '',
      'rev-list': '3',
      'rev-list:api': '0',
    });

    const { getRuntimeBuildInfo } = await import('./runtime-build-info');
    getRuntimeBuildInfo(20_000);
    await flushRefresh();
    const info = getRuntimeBuildInfo(40_000);

    expect(info.upstreamRef).toBe('origin/release-2');
    // Behind by three, but none of them ours: no restart urgency.
    expect(info.behindOriginCount).toBe(3);
    expect(info.behindOriginApi).toBe(false);
  });

  /**
   * P1 (Lumen, #586 r1). A relative pathspec is resolved against the process's
   * cwd, and this server's cwd is `packages/api` — where `packages/api` matches
   * nothing. The API-relevant count therefore came back 0 from the only
   * directory the server actually runs in, and 0 reads as "verified up to
   * date". Measured on the real repository at 960d87c2..3fa12459: 2 from the
   * repo root, 0 from packages/api, and 2 from either once anchored.
   *
   * Asserted on the argv rather than the count because the count is what the
   * mock supplies — only the pathspec sent to git distinguishes the fix.
   */
  it('anchors API pathspecs to the repo root, not the process cwd', async () => {
    mockExecSync.mockReturnValue('abc123def456');
    answerExecFile({
      'rev-parse': 'abc123def456',
      diff: '',
      'rev-list': '75',
      'rev-list:api': '2',
    });

    const { getRuntimeBuildInfo } = await import('./runtime-build-info');
    getRuntimeBuildInfo(20_000);
    await flushRefresh();

    const pathScoped = mockExecFile.mock.calls
      .map((call) => call[1] as string[])
      .filter((args) => args.includes('--'));
    expect(pathScoped.length).toBeGreaterThan(0);

    for (const args of pathScoped) {
      const paths = args.slice(args.indexOf('--') + 1);
      expect(paths.length).toBeGreaterThan(0);
      for (const p of paths) expect(p.startsWith(':(top)')).toBe(true);
    }
  });

  /**
   * P2 (Lumen, #586 r1). Both counts must describe ONE snapshot. Re-resolving
   * the mutable names `HEAD` and the upstream per command lets a concurrent
   * fetch land between the two, publishing an overall count from before it
   * beside an API count from after — "0 behind, but 1 API commit behind", a
   * contradiction a reader resolves in the reassuring direction.
   *
   * Pinned by asserting both ranges are the identical resolved-ID pair, so a
   * regression to `HEAD..origin/main` in either call fails here.
   */
  it('takes both counts from one pinned commit range', async () => {
    const HEAD_SHA = '1111111111111111111111111111111111111111';
    const UPSTREAM_SHA = '2222222222222222222222222222222222222222';

    mockExecSync.mockReturnValue(HEAD_SHA);
    mockExecFile.mockImplementation((...args: unknown[]) => {
      const gitArgs = args[1] as string[];
      const cb = args[args.length - 1] as (err: Error | null, stdout: string) => void;
      if (gitArgs[0] === 'rev-parse') {
        if (gitArgs.includes('@{upstream}')) return cb(null, 'origin/main');
        if (gitArgs.includes('origin/main')) return cb(null, UPSTREAM_SHA);
        return cb(null, HEAD_SHA);
      }
      if (gitArgs[0] === 'rev-list') return cb(null, gitArgs.includes('--') ? '2' : '75');
      return cb(null, '');
    });

    const { getRuntimeBuildInfo } = await import('./runtime-build-info');
    getRuntimeBuildInfo(20_000);
    await flushRefresh();

    const ranges = mockExecFile.mock.calls
      .map((call) => call[1] as string[])
      .filter((a) => a[0] === 'rev-list')
      .map((a) => a[2]);

    expect(ranges).toHaveLength(2);
    // Same pair of resolved IDs for both counts...
    expect(new Set(ranges).size).toBe(1);
    // ...and resolved IDs, not the mutable names that can move between calls.
    expect(ranges[0]).toBe(`${HEAD_SHA}..${UPSTREAM_SHA}`);
  });
});
