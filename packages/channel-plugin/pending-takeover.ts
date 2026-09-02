/**
 * Durable turn-takeover recovery (PR #563 round 8).
 *
 * When an interactive prompt's turn takeover fails on a backend whose hooks
 * cannot block (codex, gemini), the SHORT-LIVED hook process cannot retry —
 * it exits before any timer fires. It writes a marker file instead, and this
 * long-lived channel-plugin process converts the marker into a claim on its
 * poll loop. Scope: the on-stop hook (and any later successful takeover)
 * deletes the marker, so a recovery never outlives its prompt generation;
 * this module additionally refuses markers that are stale by age, bounding
 * the check-then-act race with a stop event that deletes the marker while a
 * claim is in flight.
 */

import { readFileSync, rmSync } from 'fs';
import { join } from 'path';

export interface PendingTakeoverMarker {
  sessionId?: string | null;
  agentId?: string;
  at?: string;
}

export const MARKER_MAX_AGE_MS = 10 * 60 * 1000;

/** Mirrors packages/cli hooks.ts pendingTakeoverMarkerPath — the file is the contract. */
export function pendingTakeoverMarkerPath(cwd: string): string {
  return join(cwd, '.ink', 'pending-takeover.json');
}

export function readPendingTakeover(path: string): PendingTakeoverMarker | null {
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as PendingTakeoverMarker;
  } catch {
    return null;
  }
}

/**
 * Should this plugin convert the marker into a claim? Only for its OWN
 * session (a marker for another session belongs to another plugin), and only
 * while fresh — an aged marker's turn is long over and claiming would mark a
 * finished turn as running.
 */
export function shouldReclaim(
  marker: PendingTakeoverMarker | null,
  sessionId: string | undefined,
  now: number = Date.now()
): boolean {
  if (!marker || !sessionId) return false;
  if (marker.sessionId !== sessionId) return false;
  const at = marker.at ? Date.parse(marker.at) : NaN;
  if (!Number.isFinite(at) || now - at > MARKER_MAX_AGE_MS) return false;
  return true;
}

/**
 * One poll-tick's worth of recovery: read → decide → claim → clear.
 * The claim callback POSTs the lifecycle prompt event (the atomic
 * epoch+lifecycle+marker takeover on the server). The marker is removed only
 * after a SUCCESSFUL claim, so a transient failure retries next tick.
 */
export async function processPendingTakeover(opts: {
  markerPath: string;
  sessionId: string | undefined;
  claim: () => Promise<boolean>;
  now?: number;
}): Promise<'claimed' | 'skipped' | 'failed'> {
  const marker = readPendingTakeover(opts.markerPath);
  if (!shouldReclaim(marker, opts.sessionId, opts.now)) {
    // A stale or foreign marker is not ours to keep around when it names our
    // session (aged) — but foreign markers are left for their owner.
    if (marker && marker.sessionId === opts.sessionId) {
      try {
        rmSync(opts.markerPath, { force: true });
      } catch {
        // Best-effort.
      }
    }
    return 'skipped';
  }
  if (!(await opts.claim())) return 'failed';
  try {
    rmSync(opts.markerPath, { force: true });
  } catch {
    // The stop hook also deletes; a leftover file is re-judged next tick.
  }
  return 'claimed';
}
