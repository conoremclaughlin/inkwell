/**
 * Pending-takeover watcher for backends whose prompt hooks cannot block and
 * which run no channel plugin (codex, gemini — PR #563 round 9: the round-8
 * marker had NO consumer on those backends, because the channel plugin the
 * design assumed is Claude Code's).
 *
 * THIS process — the `ink` wrapper that spawned the backend — is the
 * session's long-lived process, so the watcher lives here: every few seconds
 * it reads the marker the failed on-prompt hook wrote and converts it into a
 * claim. Round 10: the watcher is scoped to ITS OWN session — a marker left
 * by a crashed predecessor for a different session in the same checkout
 * belongs to that session's consumer, never to this one. The server CASes
 * the claim against the stop tombstone (reclaimOf), so a claim that loses
 * the race with the turn's stop is refused atomically; both 'ok' and
 * 'stopped' retire the marker. The watcher is stopped (and its OWN marker
 * best-effort cleared) when the backend child exits — the session is over,
 * nothing may claim after it.
 */

import { mkdirSync, readFileSync, rmSync, watch, writeFileSync } from 'fs';
import { join } from 'path';

export const TAKEOVER_MARKER_MAX_AGE_MS = 10 * 60 * 1000;

/** Mirrors hooks.ts pendingTakeoverMarkerPath — the file is the contract. */
export function takeoverMarkerPath(cwd: string): string {
  return join(cwd, '.ink', 'pending-takeover.json');
}

/**
 * The CLI turn-epoch record (PR #563 round 10): a successful prompt claim
 * returns the fresh epoch, and the stop boundary must identify the epoch it
 * is ending — the server cannot infer it, because a successor may already
 * own the row by the time a late stop lands. The on-prompt hook (or the
 * wrapper watcher, for reclaims) writes this file; the on-stop hook reads
 * its OWN session's record, sends the epoch with the stop event, and clears
 * the file. A foreign session's record is never sent or cleared.
 */
export function cliTurnEpochPath(cwd: string): string {
  return join(cwd, '.ink', 'cli-turn-epoch.json');
}

export interface CliTurnEpochRecord {
  sessionId?: string;
  turnEpoch?: string;
  at?: string;
}

export function writeCliTurnEpoch(
  cwd: string,
  record: { sessionId: string; turnEpoch: string }
): boolean {
  try {
    mkdirSync(join(cwd, '.ink'), { recursive: true });
    writeFileSync(
      cliTurnEpochPath(cwd),
      JSON.stringify({ ...record, at: new Date().toISOString() })
    );
    return true;
  } catch {
    // Round 11: NOT silently best-effort — the caller must know. A lost
    // record does not downgrade to legacy behavior: the modern stop sends
    // `turnEpochMissing` and the server suppresses destructive boundary
    // effects (fail closed) instead of releasing unfenced.
    return false;
  }
}

export function readCliTurnEpoch(cwd: string): CliTurnEpochRecord | null {
  try {
    return JSON.parse(readFileSync(cliTurnEpochPath(cwd), 'utf-8')) as CliTurnEpochRecord;
  } catch {
    return null;
  }
}

/** Clear the record only when it belongs to the given session. */
export function clearCliTurnEpoch(cwd: string, sessionId: string): void {
  const record = readCliTurnEpoch(cwd);
  if (record?.sessionId !== sessionId) return;
  try {
    rmSync(cliTurnEpochPath(cwd), { force: true });
  } catch {
    // Best-effort.
  }
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
 * One tick: read → judge ownership + freshness → claim (server-fenced) →
 * retire. Exported for tests; the interval wrapper below is thin.
 */
export async function watchTick(opts: {
  markerPath: string;
  /** The wrapper's own session — the ONLY session this watcher may claim for. */
  expectedSessionId: string;
  claim: (
    sessionId: string,
    markerAt: string
  ) => Promise<'ok' | 'stopped' | 'unprotected' | 'failed'>;
  now?: number;
}): Promise<'claimed' | 'stopped' | 'unprotected' | 'skipped' | 'failed'> {
  const marker = readMarker(opts.markerPath);
  if (!marker?.sessionId || !marker.at) return 'skipped';
  if (marker.sessionId !== opts.expectedSessionId) {
    // A foreign marker (crashed predecessor, different session in this
    // checkout) is not ours to claim OR to delete — claiming would re-mark
    // another session's dead turn as running (round 10).
    return 'skipped';
  }
  const at = Date.parse(marker.at);
  const now = opts.now ?? Date.now();
  if (!Number.isFinite(at) || now - at > TAKEOVER_MARKER_MAX_AGE_MS) {
    // Our own turn, but long over; a claim now could only mislabel it.
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
  // 'unprotected' (round 15): the server refused the lease PERMANENTLY —
  // revoked thread, expired/retired studio, or another holder. Recovery can
  // never converge, so the marker retires and the WRAPPER must enforce
  // (terminate the backend rather than knowingly run in a revoked worktree).
  if (verdict === 'unprotected') return 'unprotected';
  return verdict === 'ok' ? 'claimed' : 'stopped';
}

export function startTakeoverWatcher(opts: {
  cwd: string;
  expectedSessionId: string;
  claim: (
    sessionId: string,
    markerAt: string
  ) => Promise<'ok' | 'stopped' | 'unprotected' | 'failed'>;
  /**
   * Round 17: the scope-end boundary. Called from stop() AFTER any in-flight
   * tick settles: with the claimed epoch when this watcher's claim committed
   * (the wrapper closes the turn with a FENCED stop — a crashed child sends
   * no stop hook of its own), or with undefined when nothing was claimed
   * (the wrapper stamps the stop tombstone so a claim still parked in the
   * server — e.g. behind a timed-out fetch — is refused when it lands).
   */
  finalizeScope?: (turnEpoch: string | undefined) => Promise<void>;
  intervalMs?: number;
  log?: (outcome: string) => void;
  /** Round 15: the lease is PERMANENTLY gone — enforce (terminate the backend). */
  onUnprotected?: () => void;
}): { stop: () => Promise<void> } {
  const markerPath = takeoverMarkerPath(opts.cwd);
  let stopping = false;
  let inFlight: Promise<void> | null = null;
  const runTick = () => {
    if (stopping || inFlight) return;
    inFlight = (async () => {
      try {
        const outcome = await watchTick({
          markerPath,
          expectedSessionId: opts.expectedSessionId,
          claim: opts.claim,
        });
        if (outcome !== 'skipped') opts.log?.(outcome);
        if (outcome === 'unprotected') opts.onUnprotected?.();
      } catch {
        // Never let the watcher take down the wrapper.
      } finally {
        inFlight = null;
      }
    })();
  };
  // Round 16: the FIRST tick runs immediately (a marker may predate us).
  runTick();
  // Round 17: ticks are EVENT-DRIVEN, not just periodic — the marker is
  // written by the backend's prompt hook AFTER spawn, so a purely timed
  // first tick ran before the marker could exist and a short one-shot kept
  // its 3s escape. Watching the marker's directory converts the write into
  // an immediate claim while the turn is still running.
  let dirWatcher: import('fs').FSWatcher | undefined;
  try {
    mkdirSync(join(opts.cwd, '.ink'), { recursive: true });
    dirWatcher = watch(join(opts.cwd, '.ink'), (_event, filename) => {
      if (filename === 'pending-takeover.json') runTick();
    });
    dirWatcher.unref?.();
  } catch {
    // The interval remains the fallback cadence.
  }
  const timer = setInterval(runTick, opts.intervalMs ?? 3_000);
  // The wrapper waits on the child anyway; unref keeps us from pinning the
  // process if the child exits without our stop() (belt and braces).
  timer.unref();

  return {
    stop: async () => {
      // Round 17: stop() is a real boundary. New ticks are refused, the
      // in-flight one is AWAITED (its claim commits and records its epoch
      // before we read), and the scope is finalized: a claimed turn is
      // closed with its fenced stop; an unclaimed scope stamps the stop
      // tombstone so a server-parked claim is refused when it lands.
      stopping = true;
      clearInterval(timer);
      try {
        dirWatcher?.close();
      } catch {
        // Best-effort.
      }
      if (inFlight) await inFlight;
      if (opts.finalizeScope) {
        const record = readCliTurnEpoch(opts.cwd);
        const claimedEpoch =
          record?.sessionId === opts.expectedSessionId ? record.turnEpoch : undefined;
        try {
          await opts.finalizeScope(claimedEpoch);
          if (claimedEpoch) clearCliTurnEpoch(opts.cwd, opts.expectedSessionId);
        } catch {
          // Best-effort: the sweep and the detach boundary back this up.
        }
      }
      // Scope-end cleanup of OUR OWN marker only — a foreign session's
      // marker still belongs to its consumer (round 10).
      const marker = readMarker(markerPath);
      if (marker?.sessionId === opts.expectedSessionId) {
        try {
          rmSync(markerPath, { force: true });
        } catch {
          // Best-effort.
        }
      }
    },
  };
}
