import { execSync } from 'child_process';
import { APP_VERSION } from '../config/constants';

const STARTED_AT = new Date().toISOString();
const STARTUP_GIT_SHA = resolveGitSha();
const GIT_SHA_CACHE_TTL_MS = 15_000;

let cachedCurrentGitSha: string | null = null;
let cachedAtMs = 0;

function resolveGitSha(): string | null {
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

function getCurrentGitSha(nowMs: number): string | null {
  if (nowMs - cachedAtMs > GIT_SHA_CACHE_TTL_MS) {
    cachedCurrentGitSha = resolveGitSha();
    cachedAtMs = nowMs;
  }
  return cachedCurrentGitSha;
}

export function getRuntimeBuildInfo(nowMs = Date.now()) {
  const currentGitSha = getCurrentGitSha(nowMs);
  const updateAvailable =
    Boolean(STARTUP_GIT_SHA) && Boolean(currentGitSha) && STARTUP_GIT_SHA !== currentGitSha;

  return {
    appVersion: APP_VERSION,
    startedAt: STARTED_AT,
    startupGitSha: STARTUP_GIT_SHA,
    currentGitSha,
    updateAvailable,
    requiresRestart: updateAvailable,
    processManager: process.env.pm_id ? 'pm2' : 'direct',
  };
}
