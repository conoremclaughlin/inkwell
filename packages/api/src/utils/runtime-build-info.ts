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
 *
 * Anchored with `:(top)` so they resolve from the repository root rather than
 * the process's cwd. Plain relative pathspecs are interpreted relative to cwd,
 * and this server's cwd is `packages/api` under `yarn workspace @inklabs/api
 * server:dev` — where `packages/api` matches nothing at all. Every path-scoped
 * count then came back 0, i.e. "verified up to date", which is the precise
 * fail-toward-reassurance shape this file exists to remove. Measured on
 * 960d87c2..3fa12459: 2 from the repo root, 0 from `packages/api`, 2 from
 * either once anchored (Lumen, PR #586 r1 P1).
 */
const API_RELEVANT_PATHS = [
  ':(top)packages/api',
  ':(top)packages/shared',
  ':(top)package.json',
  ':(top)yarn.lock',
];

// Startup resolution is deliberately synchronous: it runs once at module
// load, before the HTTP listener opens — the documented exception to the
// no-blocking rule. Everything after startup refreshes asynchronously.
function resolveGitShaSync(): string | null {
  try {
    // Full ID, shortened for display below. `--short=12` returns MORE than 12
    // characters when 12 would be ambiguous, so resolving startup and refresh
    // through different commands could yield different-length strings for the
    // same commit — and these two are compared for equality to decide
    // `updateAvailable`. Both sides now take a full ID and slice it.
    const raw = execSync('git rev-parse HEAD', {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf-8',
    }).trim();
    return raw || null;
  } catch {
    return null;
  }
}

/** Full commit ID, for ranges. */
const STARTUP_GIT_SHA_FULL = resolveGitShaSync();
/** The same commit, shortened for display and for the equality comparison. */
const STARTUP_GIT_SHA = STARTUP_GIT_SHA_FULL ? STARTUP_GIT_SHA_FULL.slice(0, 12) : null;

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
  //
  // Resolved to an immutable commit ID once, and every range below is built
  // from that ID rather than from the name `HEAD`. Re-resolving a mutable name
  // per command lets a concurrent fetch or checkout land between two counts, so
  // the pair published describes two different repository states — e.g. an
  // overall count taken before the fetch and an api count taken after, giving
  // behindOriginCount=0 alongside apiBehindOriginCount=1. That is not merely
  // imprecise: "0 behind, but 1 api commit behind" is incoherent, and a reader
  // resolving the contradiction in the reassuring direction is exactly the
  // failure this file exists to prevent (Lumen, PR #586 r1 P2).
  const headSha = await execFileText(['rev-parse', 'HEAD']);
  const nextCurrentGitSha = headSha ? headSha.slice(0, 12) : null;

  let nextApiDeltaNonEmpty = false;
  if (STARTUP_GIT_SHA && nextCurrentGitSha && STARTUP_GIT_SHA !== nextCurrentGitSha) {
    const delta = await execFileText([
      'diff',
      '--name-only',
      `${STARTUP_GIT_SHA_FULL}..${headSha}`,
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
  // must not do network I/O. The count is therefore bounded by whenever that
  // ref was last refreshed, AND THAT AGE IS NOT DETERMINABLE FROM THE
  // REPOSITORY. This is worth stating precisely, because the plausible local
  // signals all overstate freshness:
  //
  //   - FETCH_HEAD's mtime is written by a fetch of ANY remote or refspec, so
  //     `git fetch origin some-branch` refreshes it while leaving this upstream
  //     untouched. Measured: a side-branch-only fetch gave an mtime of seconds
  //     ago next to a count of 0 on a checkout genuinely 1 commit behind —
  //     a timestamp certifying a false zero, which is this file's own defect
  //     rebuilt one level up (Lumen, PR #586 r2).
  //   - The tracking ref's own mtime answers "when did origin/main last MOVE",
  //     not "when did we last check" — a fetch that finds nothing leaves it
  //     untouched, so a current ref reads as an ancient one.
  //
  // So the honest disclosure is the absence of one: callers are told the count
  // is as-of-last-fetch and that its age is unknown. Whoever wants a bounded
  // answer has to make the fetch a scheduled job with its own recorded time,
  // and read that — not infer it from a file a fetch happens to touch.
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
  if (upstream && headSha) {
    // The upstream NAME is resolved to a commit ID once too, for the same
    // reason as HEAD: both endpoints of both ranges must name the same two
    // commits, or the two counts do not describe one snapshot.
    const upstreamSha = await execFileText(['rev-parse', upstream]);
    if (upstreamSha) {
      const range = `${headSha}..${upstreamSha}`;
      nextBehind = await countRevs([range]);
      nextApiBehind = await countRevs([range, '--', ...API_RELEVANT_PATHS]);
    }
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
     * Commits on the upstream that this checkout does not have, as of whenever
     * the remote-tracking ref was last refreshed. NULL MEANS UNKNOWN, not up to
     * date.
     *
     * READ THIS AS A LOWER BOUND. /health never fetches, and the age of the
     * last fetch is not determinable locally (see refresh()), so a 0 means
     * "nothing new as of a refresh of unknown age", never "verified current
     * against the remote just now". A caller wanting the stronger claim has to
     * fetch on a schedule it records the time of.
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
