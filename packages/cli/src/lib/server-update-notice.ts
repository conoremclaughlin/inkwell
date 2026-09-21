import chalk from 'chalk';

type HealthPayload = {
  build?: {
    updateAvailable?: boolean;
    startupGitSha?: string | null;
    currentGitSha?: string | null;
    upstreamRef?: string | null;
    behindOriginApi?: boolean;
    apiBehindOriginCount?: number | null;
    behindOriginCount?: number | null;
  };
};

let didCheckThisProcess = false;

function shortSha(value?: string | null): string {
  if (!value) return 'unknown';
  return value.slice(0, 8);
}

/**
 * "at least N commits", or a count-free phrase when the number is unknown.
 *
 * `behindOriginApi` can only be true off a known count, so the null branch is
 * defensive — but it must never render as "0", which reads as the opposite of
 * what the flag is saying.
 */
function behindPhrase(apiCount?: number | null, totalCount?: number | null): string {
  if (typeof apiCount !== 'number') return 'commits touching the API';
  const plural = apiCount === 1 ? 'commit' : 'commits';
  const total = typeof totalCount === 'number' ? ` of ${totalCount} total` : '';
  return `${apiCount} API ${plural}${total}`;
}

export async function maybeWarnServerUpdate(): Promise<void> {
  if (didCheckThisProcess || process.env.SB_SKIP_SERVER_UPDATE_CHECK === '1') {
    return;
  }

  didCheckThisProcess = true;

  if (!process.stdout.isTTY) {
    return;
  }

  const baseUrl = (process.env.INK_SERVER_URL || 'http://localhost:3001').replace(/\/+$/, '');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 750);

  try {
    const res = await fetch(`${baseUrl}/health`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });

    if (!res.ok) return;

    const build = ((await res.json()) as HealthPayload)?.build;
    if (!build) return;

    // Two independent questions with two different remedies, so both are asked
    // and both can print. `updateAvailable` means the tree moved under the
    // running process — a restart picks it up. `behindOriginApi` means the
    // CHECKOUT itself trails its upstream, and a restart alone rebuilds the
    // same commit; that one needs a pull first.
    const movedOnDisk = build.updateAvailable === true;
    const behindUpstream = build.behindOriginApi === true;
    if (!movedOnDisk && !behindUpstream) return;

    if (movedOnDisk) {
      console.log(
        chalk.yellow(
          `⚠ Inkwell server restart recommended: running ${shortSha(build.startupGitSha)}, latest ${shortSha(build.currentGitSha)}`
        )
      );
      console.log(chalk.dim('  Run `yarn prod:refresh` and restart the server process.\n'));
    }

    if (behindUpstream) {
      const upstream = build.upstreamRef || 'origin';
      console.log(
        chalk.yellow(
          `⚠ Inkwell server checkout is behind ${upstream}: missing at least ${behindPhrase(build.apiBehindOriginCount, build.behindOriginCount)}`
        )
      );
      console.log(
        chalk.dim(
          '  Merged code is not running here. `yarn prod:refresh` rebuilds the same commit —\n' +
            '  pull first, then refresh and restart. (Count is as of the last fetch; its age is unknown.)\n'
        )
      );
    }
  } catch {
    // Best-effort only; never block CLI startup.
  } finally {
    clearTimeout(timeout);
  }
}
