import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('maybeWarnServerUpdate', () => {
  const originalFetch = global.fetch;
  const originalIsTty = process.stdout.isTTY;
  const originalSkip = process.env.SB_SKIP_SERVER_UPDATE_CHECK;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.stdout.isTTY = true;
    delete process.env.SB_SKIP_SERVER_UPDATE_CHECK;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.stdout.isTTY = originalIsTty;
    process.env.SB_SKIP_SERVER_UPDATE_CHECK = originalSkip;
  });

  it('prints a warning when health endpoint reports updateAvailable=true', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        build: {
          updateAvailable: true,
          startupGitSha: 'abc12345ffff',
          currentGitSha: 'fff99999eeee',
        },
      }),
    }) as unknown as typeof fetch;

    const { maybeWarnServerUpdate } = await import('./server-update-notice.js');
    await maybeWarnServerUpdate();

    expect(logSpy).toHaveBeenCalled();
    expect(logSpy.mock.calls[0]?.[0]).toContain('restart recommended');
  });

  it('stays quiet when updateAvailable=false', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        build: { updateAvailable: false },
      }),
    }) as unknown as typeof fetch;

    const { maybeWarnServerUpdate } = await import('./server-update-notice.js');
    await maybeWarnServerUpdate();

    expect(logSpy).not.toHaveBeenCalled();
  });

  /**
   * `updateAvailable` asks whether the tree moved under the running process.
   * It cannot see a checkout that trails its upstream, and on 2026-09-18 that
   * read as calm: the live server sat 6 API commits behind origin/main —
   * including the heartbeat fix merged that afternoon — and every surface was
   * silent. #586 added `behindOriginApi` to the payload; nothing read it.
   */
  function mockHealth(build: Record<string, unknown>) {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ build }),
    }) as unknown as typeof fetch;
  }

  function allOutput(logSpy: { mock: { calls: unknown[][] } }): string {
    return logSpy.mock.calls.map((call) => String(call[0])).join('\n');
  }

  it('warns when the checkout is behind upstream even though nothing moved on disk', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockHealth({
      updateAvailable: false,
      startupGitSha: '36af59bc56d8',
      currentGitSha: '36af59bc56d8',
      upstreamRef: 'origin/main',
      behindOriginCount: 28,
      apiBehindOriginCount: 6,
      behindOriginApi: true,
    });

    const { maybeWarnServerUpdate } = await import('./server-update-notice.js');
    await maybeWarnServerUpdate();

    const output = allOutput(logSpy);
    expect(output).toContain('behind origin/main');
    expect(output).toContain('6 API commits of 28 total');
    // prod:refresh installs and builds; it never pulls.
    expect(output).toContain('pull first');
  });

  it('prints both notices when both hold, because the remedies differ', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockHealth({
      updateAvailable: true,
      startupGitSha: 'abc12345ffff',
      currentGitSha: 'fff99999eeee',
      upstreamRef: 'origin/main',
      behindOriginCount: 4,
      apiBehindOriginCount: 1,
      behindOriginApi: true,
    });

    const { maybeWarnServerUpdate } = await import('./server-update-notice.js');
    await maybeWarnServerUpdate();

    const output = allOutput(logSpy);
    expect(output).toContain('restart recommended');
    expect(output).toContain('behind origin/main');
    expect(output).toContain('1 API commit of 4 total');
  });

  it('stays quiet when the counts are unknown rather than claiming current', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockHealth({
      updateAvailable: false,
      behindOriginApi: false,
      behindOriginCount: null,
      apiBehindOriginCount: null,
    });

    const { maybeWarnServerUpdate } = await import('./server-update-notice.js');
    await maybeWarnServerUpdate();

    expect(logSpy).not.toHaveBeenCalled();
  });

  it('never prints a zero count when flagged behind', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockHealth({
      updateAvailable: false,
      upstreamRef: 'origin/main',
      behindOriginApi: true,
      apiBehindOriginCount: null,
      behindOriginCount: null,
    });

    const { maybeWarnServerUpdate } = await import('./server-update-notice.js');
    await maybeWarnServerUpdate();

    const output = allOutput(logSpy);
    expect(output).not.toMatch(/\b0 API\b/);
    expect(output).toContain('commits touching the API');
  });
});
