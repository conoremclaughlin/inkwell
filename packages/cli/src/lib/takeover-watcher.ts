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

/**
 * Mirrors hooks.ts pendingTakeoverMarkerPath — the file is the contract.
 * Round 20: the marker is PER WRAPPER GENERATION (`pending-takeover.<gen>.json`)
 * — one shared path was lossy across coexisting generations, and
 * read/check/unlink is not an atomic cross-process CAS. Each generation owns
 * its file outright; the generation-less path remains for legacy hooks and
 * the claude channel plugin.
 */
export function takeoverMarkerPath(cwd: string, generation?: string): string {
  return join(
    cwd,
    '.ink',
    generation ? `pending-takeover.${generation}.json` : 'pending-takeover.json'
  );
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
  /** Round 18: which wrapper generation claimed this epoch — see Marker. */
  wrapperGeneration?: string;
}

export function writeCliTurnEpoch(
  cwd: string,
  record: { sessionId: string; turnEpoch: string; wrapperGeneration?: string }
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

/**
 * Clear the record only when it belongs to the given session — and, when
 * `expected` fields are provided, only when they still match (round 19:
 * compare-and-delete; a record replaced by a successor generation during an
 * awaited request must not be deleted by the stale reader).
 */
export function clearCliTurnEpoch(
  cwd: string,
  sessionId: string,
  expected?: { turnEpoch?: string; wrapperGeneration?: string }
): void {
  const record = readCliTurnEpoch(cwd);
  if (record?.sessionId !== sessionId) return;
  if (expected?.turnEpoch !== undefined && record.turnEpoch !== expected.turnEpoch) return;
  if (
    expected !== undefined &&
    'wrapperGeneration' in expected &&
    (record.wrapperGeneration ?? undefined) !== (expected.wrapperGeneration ?? undefined) &&
    record.wrapperGeneration !== undefined &&
    expected.wrapperGeneration !== undefined
  ) {
    return;
  }
  try {
    rmSync(cliTurnEpochPath(cwd), { force: true });
  } catch {
    // Best-effort.
  }
}

interface Marker {
  sessionId?: string | null;
  at?: string;
  /**
   * Round 18: the WRAPPER GENERATION (runtimeLinkId) of the backend process
   * whose prompt hook wrote this marker — the hook reads it from the
   * INK_RUNTIME_LINK_ID env the wrapper set on spawn. Two wrappers can serve
   * one session across restarts; a marker belongs to exactly one of them,
   * and a stale wrapper must neither claim nor retire a successor's.
   * Absent on legacy markers (older hooks): matched by session alone.
   */
  wrapperGeneration?: string;
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
  /**
   * Round 18: the wrapper's OWN generation. A marker stamped with a
   * DIFFERENT generation belongs to another wrapper serving the same
   * session (a successor after restart) — neither claimed nor retired here.
   * Generation-less markers (legacy hooks) match by session alone.
   */
  expectedGeneration?: string;
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
  if (
    opts.expectedGeneration !== undefined &&
    marker.wrapperGeneration !== undefined &&
    marker.wrapperGeneration !== opts.expectedGeneration
  ) {
    // Same session, DIFFERENT wrapper generation: a successor's marker is
    // its own wrapper's to adjudicate (round 18).
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
  // Round 19: COMPARE-and-delete. A successor generation can overwrite the
  // shared marker path while our claim is parked — deleting blindly would
  // erase ITS marker. Only the exact marker we adjudicated retires.
  const current = readMarker(opts.markerPath);
  if (
    current &&
    current.sessionId === marker.sessionId &&
    current.at === marker.at &&
    current.wrapperGeneration === marker.wrapperGeneration
  ) {
    try {
      rmSync(opts.markerPath, { force: true });
    } catch {
      // The stop hook also deletes; re-judged next tick if it survives.
    }
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
  /** Round 18: this wrapper's generation (runtimeLinkId) — see watchTick. */
  generation?: string;
  intervalMs?: number;
  log?: (outcome: string) => void;
  /** Round 15: the lease is PERMANENTLY gone — enforce (terminate the backend). */
  onUnprotected?: () => void;
}): { stop: () => Promise<void> } {
  const markerPath = takeoverMarkerPath(opts.cwd, opts.generation);
  let stopping = false;
  let inFlight: Promise<void> | null = null;
  // Round 18: whether THIS generation ever reached a claim attempt — the
  // only case where a claim can be parked in the server, and therefore the
  // only case where a scope-end tombstone is justified. A wrapper that
  // never claimed must not stamp a tombstone that could refuse a
  // SUCCESSOR wrapper's older-marker reclaim.
  let attemptedClaim = false;
  const tickOnce = async () => {
    try {
      const outcome = await watchTick({
        markerPath,
        expectedSessionId: opts.expectedSessionId,
        expectedGeneration: opts.generation,
        claim: (sessionId, markerAt) => {
          attemptedClaim = true;
          return opts.claim(sessionId, markerAt);
        },
      });
      if (outcome !== 'skipped') opts.log?.(outcome);
      // Round 19: enforcement fires from the ADJUDICATION tick too — a
      // close-race permanent refusal must still flip the enforcement flag
      // so the wrapper exits non-zero (killing an exited child is a no-op).
      if (outcome === 'unprotected') opts.onUnprotected?.();
    } catch {
      // Never let the watcher take down the wrapper.
    } finally {
      inFlight = null;
    }
  };
  const runTick = () => {
    if (stopping || inFlight) return;
    inFlight = tickOnce();
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
    const markerName = opts.generation
      ? `pending-takeover.${opts.generation}.json`
      : 'pending-takeover.json';
    dirWatcher = watch(join(opts.cwd, '.ink'), (_event, filename) => {
      if (filename === markerName) runTick();
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
      // Rounds 17–18: stop() is a real boundary. New ticks are refused, the
      // in-flight one is AWAITED, then the OWN marker is ADJUDICATED with
      // one final tick — fs.watch delivery does not order before child
      // close, so a marker written moments before the exit may never have
      // been seen. A claim that lands here is immediately closed by the
      // fenced finalization below. Evidence (record, marker) is deleted
      // only AFTER the boundary write is acknowledged.
      stopping = true;
      clearInterval(timer);
      try {
        dirWatcher?.close();
      } catch {
        // Best-effort.
      }
      if (inFlight) await inFlight;
      await tickOnce();
      let finalized = !opts.finalizeScope;
      if (opts.finalizeScope) {
        const record = readCliTurnEpoch(opts.cwd);
        const ownRecord =
          record?.sessionId === opts.expectedSessionId &&
          (opts.generation === undefined ||
            record.wrapperGeneration === undefined ||
            record.wrapperGeneration === opts.generation);
        const claimedEpoch = ownRecord ? record?.turnEpoch : undefined;
        // A generation that never attempted a claim has nothing parked in
        // the server — and its tombstone could wrongly refuse a successor
        // wrapper's reclaim of an OLDER marker (round 18).
        if (claimedEpoch !== undefined || attemptedClaim) {
          try {
            await opts.finalizeScope(claimedEpoch);
            finalized = true;
            if (claimedEpoch) {
              clearCliTurnEpoch(opts.cwd, opts.expectedSessionId, {
                turnEpoch: claimedEpoch,
                wrapperGeneration: opts.generation,
              });
            }
          } catch {
            // The boundary write was NOT acknowledged: keep the record and
            // the marker as evidence; the sweep and the detach boundary
            // back this up (round 18 — never delete unacknowledged).
          }
        } else {
          finalized = true;
        }
      }
      if (!finalized) return;
      // Scope-end cleanup of OUR OWN marker (session AND generation) only.
      const marker = readMarker(markerPath);
      if (
        marker?.sessionId === opts.expectedSessionId &&
        (opts.generation === undefined ||
          marker.wrapperGeneration === undefined ||
          marker.wrapperGeneration === opts.generation)
      ) {
        try {
          rmSync(markerPath, { force: true });
        } catch {
          // Best-effort.
        }
      }
    },
  };
}
