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
});
