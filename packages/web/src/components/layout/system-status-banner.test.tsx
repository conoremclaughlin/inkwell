// @vitest-environment jsdom
/**
 * The banner used to gate entirely on `updateAvailable`, which asks only
 * whether the tree moved under the running process. It cannot see a checkout
 * that trails its upstream, and on 2026-09-18 that read as calm: the live
 * server sat 6 API commits behind origin/main — including the heartbeat fix
 * merged that afternoon — and the dashboard showed nothing at all. #586 added
 * `behindOriginApi` to the payload to answer that second question; no surface
 * ever read it.
 *
 * These pin both questions, and the distinction between "behind" and "cannot
 * tell": an unknown count must stay quiet rather than alarm.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { SystemStatusBanner } from './system-status-banner';

const useApiQuery = vi.fn();
vi.mock('@/lib/api', () => ({
  useApiQuery: (...args: unknown[]) => useApiQuery(...args),
}));

type Build = Record<string, unknown>;

function renderWithBuild(build: Build | undefined) {
  useApiQuery.mockReturnValue({ data: build ? { build } : undefined });
  return render(<SystemStatusBanner />);
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('SystemStatusBanner', () => {
  it('warns when the checkout is behind upstream even though nothing moved on disk', () => {
    // The live payload on 2026-09-18: HEAD never moved in that checkout, so
    // updateAvailable is false in perfect good faith, while 6 API commits sit
    // unshipped on origin.
    const { container } = renderWithBuild({
      updateAvailable: false,
      requiresRestart: false,
      startupGitSha: '36af59bc56d8',
      currentGitSha: '36af59bc56d8',
      upstreamRef: 'origin/main',
      behindOriginCount: 28,
      apiBehindOriginCount: 6,
      behindOriginApi: true,
      processManager: 'direct',
    });

    expect(container.innerHTML).not.toBe('');
    expect(screen.getByText(/behind origin\/main/i)).toBeTruthy();
    expect(screen.getByText(/6 API commits of 28 total/)).toBeTruthy();
  });

  it('tells the reader a rebuild alone will not pick the commits up', () => {
    // prod:refresh installs and builds; it never pulls. Sending someone to it
    // for a drift they cannot fix that way is worse than silence.
    renderWithBuild({
      updateAvailable: false,
      upstreamRef: 'origin/main',
      behindOriginCount: 28,
      apiBehindOriginCount: 6,
      behindOriginApi: true,
    });

    expect(screen.getByText(/pull first/i)).toBeTruthy();
  });

  it('keeps the restart notice for a tree that moved under the process', () => {
    renderWithBuild({
      updateAvailable: true,
      requiresRestart: true,
      startupGitSha: 'abc12345ffff',
      currentGitSha: 'fff99999eeee',
      processManager: 'pm2',
    });

    expect(screen.getByText(/restart required/i)).toBeTruthy();
    expect(screen.getByText(/PM2/)).toBeTruthy();
  });

  it('shows both notices when both are true, because the remedies differ', () => {
    renderWithBuild({
      updateAvailable: true,
      startupGitSha: 'abc12345ffff',
      currentGitSha: 'fff99999eeee',
      upstreamRef: 'origin/main',
      behindOriginCount: 4,
      apiBehindOriginCount: 1,
      behindOriginApi: true,
    });

    expect(screen.getByText(/restart required/i)).toBeTruthy();
    expect(screen.getByText(/behind origin\/main/i)).toBeTruthy();
    expect(screen.getByText(/1 API commit of 4 total/)).toBeTruthy();
  });

  it('stays silent when the server is current', () => {
    const { container } = renderWithBuild({
      updateAvailable: false,
      behindOriginApi: false,
      behindOriginCount: 0,
      apiBehindOriginCount: 0,
    });

    expect(container.innerHTML).toBe('');
  });

  it('stays silent when the counts are unknown rather than claiming current', () => {
    // Null means "could not tell", and behindOriginApi is already false in
    // that case. Alarming on unknown would make the banner noise.
    const { container } = renderWithBuild({
      updateAvailable: false,
      behindOriginApi: false,
      behindOriginCount: null,
      apiBehindOriginCount: null,
    });

    expect(container.innerHTML).toBe('');
  });

  it('never renders a zero count when flagged behind', () => {
    // Defensive: behindOriginApi can only be true off a known non-zero count,
    // but "missing at least 0 API commits" would read as the opposite of the
    // warning it sits inside.
    renderWithBuild({
      updateAvailable: false,
      upstreamRef: 'origin/main',
      behindOriginApi: true,
      apiBehindOriginCount: null,
      behindOriginCount: null,
    });

    const banner = screen.getByText(/behind origin\/main/i).closest('div');
    expect(banner?.textContent).not.toMatch(/\b0 API\b/);
    expect(screen.getByText(/commits touching the API/)).toBeTruthy();
  });
});
