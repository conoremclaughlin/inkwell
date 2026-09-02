/**
 * Post-turn terminal bookkeeping, retried.
 *
 * The bug this exists for (pr:558, 2026-09-01): a turn ran to completion and
 * its reply was delivered, then the finalization write hit a transient DB
 * outage (~24 minutes of `fetch failed` that night). The single unretried
 * throw did three unrelated kinds of damage at once:
 *
 *   1. It rode up through the trigger handler, so the SENDER was told
 *      "Trigger to lumen failed" about a delivery that had succeeded 28
 *      minutes earlier.
 *   2. The session row stayed `running` and the ActiveRun stayed registered
 *      for 14 hours, blocking the lease sweep's "holder is gone" detection.
 *   3. Shutdown then reported a process "still running" that had exited at
 *      00:23.
 *
 * The write is idempotent — it moves the row to a fixed terminal state — so
 * the correct response to a transient failure is to try again, for longer
 * than a DB flake plausibly lasts, and to treat the turn as what it was: a
 * success whose paperwork is late. Callers make their own FIRST attempt
 * inline (the fast path must not grow a sleep); this loop is the detached
 * continuation after that attempt fails.
 */

import { logger } from '../../utils/logger.js';

export type FinalizeTurnOutcome = 'finalized' | 'refused' | 'gone' | 'exhausted' | 'superseded';

/**
 * One pending background finalization per session (Lumen, PR #563 P1).
 *
 * The retry loop outlives the session processing lock: turn B can start while
 * turn A's finalization is still retrying, and A's late write would then
 * overwrite B's backendSessionId/messageCount/lifecycle, clear B's ActiveRun
 * registration, and release B's graph claims at a boundary B never reached.
 * A new turn therefore SUPERSEDES any pending finalization for its session
 * before it writes `running`: the old turn's late bookkeeping is abandoned in
 * favor of the new turn's, which is the same information-loss as the original
 * abandonment — but with no corruption.
 *
 * The token is only the in-process fast path: it stops WASTED retries. The
 * actual fence is the turn-epoch CAS inside the attempt itself — the DB
 * rotates the `turn_epoch` column whenever any writer moves the session into
 * `running`, and the fenced write matches zero rows once ownership changed,
 * including writes already in flight when the new turn arrived. An attempt
 * that loses the fence throws TurnSupersededError and the loop stands down.
 */
// Keyed session → epoch → token (round 8): an UNCONFIRMED takeover's
// recovery must be able to coexist with the previous turn's — when both
// terminal writes hit the same outage, whichever loop's CAS matches the row
// finalizes and the other fences out on its own. A single session-global
// token made the newer loop cancel the older VALID one unconditionally, and
// when the newer then fenced out, nothing anywhere retried the older row.
const pendingFinalizations = new Map<string, Map<string, { cancelled: boolean }>>();

const DEFAULT_EPOCH_KEY = '__default__';

/** Cancel EVERY pending loop for the session — confirmed-ownership takeovers only. */
export function supersedePendingFinalization(sessionId: string): void {
  const perEpoch = pendingFinalizations.get(sessionId);
  if (perEpoch && perEpoch.size > 0) {
    for (const token of perEpoch.values()) token.cancelled = true;
    pendingFinalizations.delete(sessionId);
    logger.warn('Pending turn finalization superseded by a new turn', { sessionId });
  }
}

/** Any recovery pending for the session, under any epoch. */
export function hasPendingFinalization(sessionId: string): boolean {
  return (pendingFinalizations.get(sessionId)?.size ?? 0) > 0;
}

/**
 * Is a recovery pending under THIS exact epoch? Restore decisions must be
 * owner-scoped (round 9): "some epoch is pending" may be a newer turn's
 * loop, not the one being considered for restoration.
 */
export function hasPendingFinalizationFor(sessionId: string, epochKey: string): boolean {
  return pendingFinalizations.get(sessionId)?.has(epochKey) ?? false;
}

/** Test seam: cancel and forget every pending loop. Not used in production. */
export function resetPendingFinalizations(): void {
  for (const perEpoch of pendingFinalizations.values()) {
    for (const token of perEpoch.values()) token.cancelled = true;
  }
  pendingFinalizations.clear();
}

export interface FinalizeTurnRetryOptions {
  sessionId: string;
  /** Perform the idempotent terminal write. */
  attempt: () => Promise<unknown>;
  /**
   * May a state write still proceed? Checked before EVERY attempt so a retry
   * never lands on top of a shutdown interruption record.
   */
  admit: () => boolean;
  /** Run-boundary steps, exactly once, after the write durably persists. */
  onFinalized: () => void;
  /**
   * This loop's identity within the session — its turn epoch. Loops with
   * different keys COEXIST (round 8: unconfirmed candidates arbitrate via
   * the row CAS, not by cancelling each other).
   */
  epochKey?: string;
  /**
   * Cancel the session's OTHER pending loops on entry. True for confirmed
   * ownership (the fence guarantees they can never land); FALSE when the
   * takeover is unconfirmed — the sibling might be the valid recovery.
   */
  supersedeSiblings?: boolean;
  /** The session row no longer exists — retrying cannot help. */
  isGone?: (err: unknown) => boolean;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  maxTotalMs?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
}

// The observed outage window was ~24 minutes; the budget must outlast the
// longest DB flake we have actually seen, not the longest one we would like.
export const FINALIZE_RETRY_MAX_TOTAL_MS = 30 * 60 * 1000;
export const FINALIZE_RETRY_INITIAL_DELAY_MS = 5_000;
export const FINALIZE_RETRY_MAX_DELAY_MS = 60_000;

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref();
  });

/**
 * Thrown by the fenced finalize attempt when the turn-epoch CAS matched zero
 * rows: a newer turn owns the session. Not an error to retry.
 */
export class TurnSupersededError extends Error {
  constructor(sessionId: string) {
    super(`Turn finalization superseded: ${sessionId}`);
    this.name = 'TurnSupersededError';
  }
}

/** SessionRepository.update throws this exact prefix when findById returns null. */
export function isSessionGoneError(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith('Session not found:');
}

export async function retryTurnFinalization(
  options: FinalizeTurnRetryOptions
): Promise<FinalizeTurnOutcome> {
  const {
    sessionId,
    attempt,
    admit,
    onFinalized,
    isGone = isSessionGoneError,
    sleep = defaultSleep,
    now = Date.now,
    maxTotalMs = FINALIZE_RETRY_MAX_TOTAL_MS,
    initialDelayMs = FINALIZE_RETRY_INITIAL_DELAY_MS,
    maxDelayMs = FINALIZE_RETRY_MAX_DELAY_MS,
  } = options;

  const epochKey = options.epochKey ?? DEFAULT_EPOCH_KEY;
  const supersedeSiblings = options.supersedeSiblings ?? true;
  if (supersedeSiblings) {
    supersedePendingFinalization(sessionId);
  }
  let perEpoch = pendingFinalizations.get(sessionId);
  if (!perEpoch) {
    perEpoch = new Map();
    pendingFinalizations.set(sessionId, perEpoch);
  }
  // Re-entry under the SAME epoch replaces (and cancels) its own older loop.
  perEpoch.get(epochKey) && (perEpoch.get(epochKey)!.cancelled = true);
  const token = { cancelled: false };
  perEpoch.set(epochKey, token);
  const done = (outcome: FinalizeTurnOutcome): FinalizeTurnOutcome => {
    const map = pendingFinalizations.get(sessionId);
    if (map?.get(epochKey) === token) {
      map.delete(epochKey);
      if (map.size === 0) pendingFinalizations.delete(sessionId);
    }
    return outcome;
  };

  const startedAt = now();
  let delay = initialDelayMs;
  // The caller's failed inline write was attempt 1.
  let attemptNo = 1;

  for (;;) {
    if (now() - startedAt >= maxTotalMs) {
      // The run stays registered on purpose: shutdown will report it, and
      // with runnerSettledAt set the report says "finished but unrecorded"
      // rather than pretending a process is alive.
      logger.error('Turn finalization retries exhausted; run stays registered for shutdown', {
        sessionId,
        attempts: attemptNo,
        maxTotalMs,
      });
      return done('exhausted');
    }

    await sleep(delay);
    attemptNo += 1;

    if (token.cancelled) {
      // A newer turn owns the session's bookkeeping now. Writing anything —
      // including clearActiveRun via onFinalized — would corrupt ITS state.
      return done('superseded');
    }

    if (!admit()) {
      logger.warn('Turn finalization retry refused; shutdown owns this session now', {
        sessionId,
        attempts: attemptNo,
      });
      return done('refused');
    }

    try {
      await attempt();
      if (token.cancelled) {
        // Cancelled while the write was in flight: the write raced a new
        // turn's `running` and may have lost or won, but the boundary steps
        // belong to the new turn either way.
        logger.warn('Turn finalization write landed while superseded; boundary steps skipped', {
          sessionId,
        });
        return done('superseded');
      }
      onFinalized();
      logger.info('Turn finalization succeeded on retry', { sessionId, attempts: attemptNo });
      return done('finalized');
    } catch (err) {
      if (err instanceof TurnSupersededError) {
        // The fenced write matched zero rows: another writer rotated the
        // epoch. That writer owns the row AND the registry entry now.
        logger.warn('Turn finalization fenced out by a newer turn; abandoning', {
          sessionId,
          attempts: attemptNo,
        });
        return done('superseded');
      }
      if (isGone(err)) {
        logger.error('Turn finalization abandoned; session row is gone', {
          sessionId,
          attempts: attemptNo,
        });
        return done('gone');
      }
      logger.warn('Turn finalization retry failed', {
        sessionId,
        attempt: attemptNo,
        nextDelayMs: Math.min(delay * 2, maxDelayMs),
        error: err instanceof Error ? err.message : String(err),
      });
      delay = Math.min(delay * 2, maxDelayMs);
    }
  }
}
