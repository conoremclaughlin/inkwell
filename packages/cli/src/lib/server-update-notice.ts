import chalk from 'chalk';

type HealthPayload = {
  build?: {
    updateAvailable?: boolean;
    startupGitSha?: string | null;
    currentGitSha?: string | null;
  };
};

let didCheckThisProcess = false;

function shortSha(value?: string | null): string {
  if (!value) return 'unknown';
  return value.slice(0, 8);
}

export async function maybeWarnServerUpdate(): Promise<void> {
  if (didCheckThisProcess || process.env.SB_SKIP_SERVER_UPDATE_CHECK === '1') {
    return;
  }

  didCheckThisProcess = true;

  if (!process.stdout.isTTY) {
    return;
  }

  const baseUrl = (process.env.PCP_SERVER_URL || 'http://localhost:3001').replace(/\/+$/, '');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 750);

  try {
    const res = await fetch(`${baseUrl}/health`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });

    if (!res.ok) return;

    const body = (await res.json()) as HealthPayload;
    if (!body?.build?.updateAvailable) return;

    console.log(
      chalk.yellow(
        `⚠ PCP server restart recommended: running ${shortSha(body.build.startupGitSha)}, latest ${shortSha(body.build.currentGitSha)}`
      )
    );
    console.log(chalk.dim('  Run `yarn prod:refresh` and restart the server process.\n'));
  } catch {
    // Best-effort only; never block CLI startup.
  } finally {
    clearTimeout(timeout);
  }
}
