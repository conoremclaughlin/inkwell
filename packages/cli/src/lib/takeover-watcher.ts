/**
 * Pending-takeover watcher for backends whose prompt hooks cannot block and
 * which run no channel plugin (codex, gemini — PR #563 round 9: the round-8
 * marker had NO consumer on those backends, because the channel plugin the
 * design assumed is Claude Code's).
 *
 * THIS process — the `ink` wrapper that spawned the backend — is the
 * session's long-lived process, so the watcher lives here: every few seconds
 * it reads the marker the failed on-prompt hook wrote and converts it into a
 * claim. The server CASes the claim against the stop tombstone (reclaimOf),
 * so a claim that loses the race with the turn's stop is refused atomically;
 * both 'ok' and 'stopped' retire the marker. The watcher is stopped (and the
 * marker best-effort cleared) when the backend child exits — the session is
 * over, nothing may claim after it.
 */

import { readFileSync, rmSync } from 'fs';
import { join } from 'path';

export const TAKEOVER_MARKER_MAX_AGE_MS = 10 * 60 * 1000;

/** Mirrors hooks.ts pendingTakeoverMarkerPath — the file is the contract. */
export function takeoverMarkerPath(cwd: string): string {
  return join(cwd, '.ink', 'pending-takeover.json');
}

interface Marker {
  sessionId?: string | null;
  at?: string;
}

function readMarker(path: string): Marker | null {
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as Marker;
  } catch {
    return null;
  }
}

/**
 * One tick: read → judge freshness → claim (server-fenced) → retire.
 * Exported for tests; the interval wrapper below is thin.
 */
export async function watchTick(opts: {
  markerPath: string;
  claim: (sessionId: string, markerAt: string) => Promise<'ok' | 'stopped' | 'failed'>;
  now?: number;
}): Promise<'claimed' | 'stopped' | 'skipped' | 'failed'> {
  const marker = readMarker(opts.markerPath);
  if (!marker?.sessionId || !marker.at) return 'skipped';
  const at = Date.parse(marker.at);
  const now = opts.now ?? Date.now();
  if (!Number.isFinite(at) || now - at > TAKEOVER_MARKER_MAX_AGE_MS) {
    // Its turn is long over; a claim now could only mislabel a dead turn.
    try {
      rmSync(opts.markerPath, { force: true });
    } catch {
      // Best-effort.
    }
    return 'skipped';
  }
  const verdict = await opts.claim(marker.sessionId, marker.at);
  if (verdict === 'failed') return 'failed';
  try {
    rmSync(opts.markerPath, { force: true });
  } catch {
    // The stop hook also deletes; re-judged next tick if it survives.
  }
  return verdict === 'ok' ? 'claimed' : 'stopped';
}

export function startTakeoverWatcher(opts: {
  cwd: string;
  claim: (sessionId: string, markerAt: string) => Promise<'ok' | 'stopped' | 'failed'>;
  intervalMs?: number;
  log?: (outcome: string) => void;
}): { stop: () => void } {
  const markerPath = takeoverMarkerPath(opts.cwd);
  let inFlight = false;
  const timer = setInterval(async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      const outcome = await watchTick({ markerPath, claim: opts.claim });
      if (outcome !== 'skipped') opts.log?.(outcome);
    } catch {
      // Never let the watcher take down the wrapper.
    } finally {
      inFlight = false;
    }
  }, opts.intervalMs ?? 3_000);
  // Deliberately NOT unref'd in spirit — but the wrapper waits on the child
  // anyway; unref keeps us from pinning the process if the child exits
  // without our stop() (belt and braces).
  timer.unref();

  return {
    stop: () => {
      clearInterval(timer);
      try {
        rmSync(markerPath, { force: true });
      } catch {
        // Best-effort final scope-end cleanup.
      }
    },
  };
}
