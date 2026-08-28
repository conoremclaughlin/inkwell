import { execSync, execFile } from 'child_process';
import { APP_VERSION } from '../config/constants';

const STARTED_AT = new Date().toISOString();
const GIT_SHA_CACHE_TTL_MS = 15_000;

/**
 * The running API server's own inputs. HEAD moving on commits that touch
 * only other packages (cli, web, docs) does not make THIS process stale —
 * the web dev server hot-reloads its own code and the CLI is a separate
 * binary — so "restart required" is only honest when the delta reaches
 * these paths. (Observed live: a cli-only run of commits kept the banner
 * up for a server whose executable code had not changed at all.)
 */
const API_RELEVANT_PATHS = ['packages/api', 'packages/shared', 'package.json', 'yarn.lock'];

// Startup resolution is deliberately synchronous: it runs once at module
// load, before the HTTP listener opens — the documented exception to the
// no-blocking rule. Everything after startup refreshes asynchronously.
function resolveGitShaSync(): string | null {
  try {
    const raw = execSync('git rev-parse --short=12 HEAD', {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf-8',
    }).trim();
    return raw || null;
  } catch {
    return null;
  }
}

const STARTUP_GIT_SHA = resolveGitShaSync();

let cachedCurrentGitSha: string | null = STARTUP_GIT_SHA;
let cachedApiDeltaNonEmpty = false;
let cachedAtMs = 0;
let refreshInFlight: Promise<void> | null = null;

function execFileText(args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd: process.cwd() }, (error, stdout) => {
      resolve(error ? null : String(stdout).trim());
    });
  });
}

async function refresh(): Promise<void> {
  const current = await execFileText(['rev-parse', '--short=12', 'HEAD']);
  cachedCurrentGitSha = current || null;

  if (STARTUP_GIT_SHA && cachedCurrentGitSha && STARTUP_GIT_SHA !== cachedCurrentGitSha) {
    const delta = await execFileText([
      'diff',
      '--name-only',
      `${STARTUP_GIT_SHA}..${cachedCurrentGitSha}`,
      '--',
      ...API_RELEVANT_PATHS,
    ]);
    // A failed diff (e.g. the startup sha was garbage-collected) fails
    // toward "restart recommended" — never hide a possible real update.
    cachedApiDeltaNonEmpty = delta === null ? true : delta.length > 0;
  } else {
    cachedApiDeltaNonEmpty = false;
  }
}

/**
 * Reads never block: the git state refreshes in the background on a TTL,
 * and callers get the latest completed snapshot. `updateAvailable` means
 * HEAD moved since startup AND the delta touches the API's own code — a
 * head that advanced on cli/web-only commits reports false.
 */
export function getRuntimeBuildInfo(nowMs = Date.now()) {
  if (!refreshInFlight && nowMs - cachedAtMs > GIT_SHA_CACHE_TTL_MS) {
    cachedAtMs = nowMs;
    refreshInFlight = refresh()
      .catch(() => {})
      .finally(() => {
        refreshInFlight = null;
      });
  }

  const updateAvailable =
    Boolean(STARTUP_GIT_SHA) &&
    Boolean(cachedCurrentGitSha) &&
    STARTUP_GIT_SHA !== cachedCurrentGitSha &&
    cachedApiDeltaNonEmpty;

  return {
    appVersion: APP_VERSION,
    startedAt: STARTED_AT,
    startupGitSha: STARTUP_GIT_SHA,
    currentGitSha: cachedCurrentGitSha,
    updateAvailable,
    requiresRestart: updateAvailable,
    processManager: process.env.pm_id ? 'pm2' : 'direct',
  };
}
