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
/**
 * How far this CHECKOUT trails its upstream. Null means undeterminable, which
 * is deliberately distinct from zero — see the note on getRuntimeBuildInfo.
 */
let cachedUpstreamRef: string | null = null;
let cachedBehindOrigin: number | null = null;
let cachedApiBehindOrigin: number | null = null;
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
  // Computed entirely in locals and published in one synchronous block at
  // the end: assigning the sha before awaiting the diff let a read combine
  // the NEW sha with the PREVIOUS refresh's delta bit — a torn snapshot
  // that could report a restart verdict belonging to neither state
  // (Lumen, PR #547 r1). Readers always see a matched (sha, delta) pair.
  const nextCurrentGitSha = (await execFileText(['rev-parse', '--short=12', 'HEAD'])) || null;

  let nextApiDeltaNonEmpty = false;
  if (STARTUP_GIT_SHA && nextCurrentGitSha && STARTUP_GIT_SHA !== nextCurrentGitSha) {
    const delta = await execFileText([
      'diff',
      '--name-only',
      `${STARTUP_GIT_SHA}..${nextCurrentGitSha}`,
      '--',
      ...API_RELEVANT_PATHS,
    ]);
    // A failed diff (e.g. the startup sha was garbage-collected) fails
    // toward "restart recommended" — never hide a possible real update.
    nextApiDeltaNonEmpty = delta === null ? true : delta.length > 0;
  }

  // How far the CHECKOUT trails origin — a different question from the one
  // above, and the one nobody was asking.
  //
  // `updateAvailable` compares the startup sha to the local HEAD, so it answers
  // "did the tree move under me, do I need a restart". It cannot answer "is
  // this checkout behind origin", and on 2026-09-04 that gap read as calm: the
  // deployed tree sat 75 commits behind origin/main with 2 of them touching the
  // API, twenty hours after a fix was merged for it, and /health reported
  // updateAvailable: false in perfect good faith. Two questions, one signal,
  // and the unanswered one failed toward reassurance.
  //
  // Read from the remote-tracking ref, never by fetching: a health endpoint
  // must not do network I/O. That makes the count only as fresh as the last
  // fetch, which is why `originFetchedAt` is reported alongside it — a number
  // whose staleness is undisclosed is its own calm wrong answer.
  //
  // Compared against the tracked upstream rather than a hardcoded origin/main,
  // so a deployment running a release branch is measured against its own
  // branch instead of being told it is behind by everything on main.
  const upstream = await execFileText([
    'rev-parse',
    '--abbrev-ref',
    '--symbolic-full-name',
    '@{upstream}',
  ]);
  let nextBehind: number | null = null;
  let nextApiBehind: number | null = null;
  if (upstream) {
    nextBehind = await countRevs([`HEAD..${upstream}`]);
    nextApiBehind = await countRevs([`HEAD..${upstream}`, '--', ...API_RELEVANT_PATHS]);
  }

  cachedCurrentGitSha = nextCurrentGitSha;
  cachedApiDeltaNonEmpty = nextApiDeltaNonEmpty;
  cachedUpstreamRef = upstream;
  cachedBehindOrigin = nextBehind;
  cachedApiBehindOrigin = nextApiBehind;
}

/**
 * `git rev-list --count`, or null when it cannot be determined.
 *
 * Null rather than 0 on failure, always. Zero means "verified up to date" and
 * failing into it is the exact shape of defect this field exists to remove.
 */
async function countRevs(args: string[]): Promise<number | null> {
  const raw = await execFileText(['rev-list', '--count', ...args]);
  if (raw === null) return null;
  const n = Number.parseInt(raw.trim(), 10);
  return Number.isNaN(n) ? null : n;
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
    /** The upstream compared against, e.g. "origin/main". Null if untracked. */
    upstreamRef: cachedUpstreamRef,
    /**
     * Commits on the upstream that this checkout does not have, as of the last
     * fetch. NULL MEANS UNKNOWN, not up to date.
     */
    behindOriginCount: cachedBehindOrigin,
    /** Of those, the ones touching this server's own inputs. Null = unknown. */
    apiBehindOriginCount: cachedApiBehindOrigin,
    /**
     * True only when we can SHOW the checkout is missing API-relevant commits.
     * An unknown count leaves this false, so callers must read the count to
     * tell "verified current" from "could not tell" — the distinction the old
     * single boolean erased.
     */
    behindOriginApi: cachedApiBehindOrigin !== null && cachedApiBehindOrigin > 0,
    processManager: process.env.pm_id ? 'pm2' : 'direct',
  };
}
