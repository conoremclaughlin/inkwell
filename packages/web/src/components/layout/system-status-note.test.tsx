// @vitest-environment jsdom
/**
 * The note asks two questions. `updateAvailable` asks whether the tree moved
 * under the running process. `behindOriginApi` asks whether the checkout
 * trails its upstream: on 2026-09-18 the live server sat 6 API commits behind
 * origin/main, including the heartbeat fix merged that afternoon, and the old
 * banner, which asked only the first, showed nothing (#586).
 *
 * On 2026-09-30 the banner, then above every page, hid the bottom of the
 * Threads view, and Conor asked for a short note in the navigation, only for
 * a prod server, never under `yarn dev`, which reloads its own code. These pin
 * that rule, both questions, and the difference between "behind" and "cannot
 * tell": an unknown count stays quiet rather than alarm.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { SystemStatusNote } from './system-status-note';

const useApiQuery = vi.fn();
vi.mock('@/lib/api', () => ({
  useApiQuery: (...args: unknown[]) => useApiQuery(...args),
}));

type Build = Record<string, unknown>;

/** The 2026-09-18 payload: HEAD never moved, 6 API commits sit on origin. */
const BEHIND: Build = {
  updateAvailable: false,
  requiresRestart: false,
  startupGitSha: '36af59bc56d8',
  currentGitSha: '36af59bc56d8',
  upstreamRef: 'origin/main',
  behindOriginCount: 28,
  apiBehindOriginCount: 6,
  behindOriginApi: true,
  processManager: 'direct',
};

function renderWithBuild(build: Build | undefined) {
  useApiQuery.mockReturnValue({ data: build ? { build } : undefined });
  return render(<SystemStatusNote />);
}

const note = () => screen.getByRole('status');

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('SystemStatusNote: only for a prod server', () => {
  it('stays silent under yarn dev, however far behind the checkout is', () => {
    expect(renderWithBuild({ ...BEHIND, runMode: 'dev' }).container.innerHTML).toBe('');
    expect(
      renderWithBuild({ ...BEHIND, updateAvailable: true, runMode: 'dev' }).container.innerHTML
    ).toBe('');
  });

  it('stays silent for an API too old to report its run mode', () => {
    expect(renderWithBuild(BEHIND).container.innerHTML).toBe('');
  });
});

describe('SystemStatusNote: a prod server', () => {
  it('names a checkout behind upstream even though nothing moved on disk, with the count on hover', () => {
    renderWithBuild({ ...BEHIND, runMode: 'prod' });
    expect(note().textContent).toMatch(/Behind origin\/main/);
    expect(note().getAttribute('title')).toMatch(/6 API commits of 28 total/);
  });

  it('tells the reader a rebuild alone will not pick the commits up', () => {
    // prod:refresh installs and builds; it never pulls.
    renderWithBuild({ ...BEHIND, runMode: 'prod' });
    expect(note().textContent).toMatch(/Pull, then yarn prod:refresh/);
    expect(note().getAttribute('title')).toMatch(/pull first/);
  });

  it('keeps the restart notice for a tree that moved under the process', () => {
    renderWithBuild({
      updateAvailable: true,
      requiresRestart: true,
      startupGitSha: 'abc12345ffff',
      currentGitSha: 'fff99999eeee',
      processManager: 'pm2',
      runMode: 'prod',
    });
    expect(note().textContent).toMatch(/Restart needed/);
    expect(note().getAttribute('title')).toMatch(/moved to fff99999/);
  });

  it('names both when both are true, because the remedies differ', () => {
    renderWithBuild({
      ...BEHIND,
      updateAvailable: true,
      currentGitSha: 'fff99999eeee',
      behindOriginCount: 4,
      apiBehindOriginCount: 1,
      runMode: 'prod',
    });
    expect(note().textContent).toMatch(/Behind origin\/main · restart needed/);
    expect(note().getAttribute('title')).toMatch(/1 API commit of 4 total/);
  });

  it('stays silent when the server is current', () => {
    const { container } = renderWithBuild({
      updateAvailable: false,
      behindOriginApi: false,
      behindOriginCount: 0,
      apiBehindOriginCount: 0,
      runMode: 'prod',
    });
    expect(container.innerHTML).toBe('');
  });

  it('stays silent when the counts are unknown rather than claiming current', () => {
    // Null means "could not tell", and behindOriginApi is already false then.
    const { container } = renderWithBuild({
      updateAvailable: false,
      behindOriginApi: false,
      behindOriginCount: null,
      apiBehindOriginCount: null,
      runMode: 'prod',
    });
    expect(container.innerHTML).toBe('');
  });

  it('never renders a zero count when flagged behind', () => {
    // "missing at least 0 API commits" would read as the opposite of the note.
    renderWithBuild({
      updateAvailable: false,
      upstreamRef: 'origin/main',
      behindOriginApi: true,
      apiBehindOriginCount: null,
      behindOriginCount: null,
      runMode: 'prod',
    });
    expect(note().getAttribute('title')).not.toMatch(/\b0 API\b/);
    expect(note().getAttribute('title')).toMatch(/commits touching the API/);
  });
});
