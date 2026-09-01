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
 * In-process is the right scope: turns for one session are serialized by the
 * processing lock in this process, and the ActiveRun registry this protects
 * is per-process by design. The cross-path case (a CLI hook resuming the
 * session through a different repository) is covered by the caller-supplied
 * `isStale` check, which reads the row before each attempt.
 */
const pendingFinalizations = new Map<string, { cancelled: boolean }>();

export function supersedePendingFinalization(sessionId: string): void {
  const token = pendingFinalizations.get(sessionId);
  if (token) {
    token.cancelled = true;
    pendingFinalizations.delete(sessionId);
    logger.warn('Pending turn finalization superseded by a new turn', { sessionId });
  }
}

/** Test seam. */
export function hasPendingFinalization(sessionId: string): boolean {
  return pendingFinalizations.has(sessionId);
}

/** Test seam: cancel and forget every pending loop. Not used in production. */
export function resetPendingFinalizations(): void {
  for (const token of pendingFinalizations.values()) token.cancelled = true;
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
  /** The session row no longer exists — retrying cannot help. */
  isGone?: (err: unknown) => boolean;
  /**
   * Has another writer taken the session over since this turn ended? Checked
   * immediately before each attempt. Covers resumes that do not go through
   * this process's supersede call (CLI lifecycle hooks write `running`
   * through a different repository). The residual window is one round-trip —
   * the same doctrine as the interrupt path's read-modify-write.
   */
  isStale?: () => Promise<boolean>;
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
    isStale,
    sleep = defaultSleep,
    now = Date.now,
    maxTotalMs = FINALIZE_RETRY_MAX_TOTAL_MS,
    initialDelayMs = FINALIZE_RETRY_INITIAL_DELAY_MS,
    maxDelayMs = FINALIZE_RETRY_MAX_DELAY_MS,
  } = options;

  // Registering replaces any older pending loop's token wholesale; the older
  // loop sees its own token cancelled and stops. One pending finalization per
  // session, and it is always the newest turn's.
  supersedePendingFinalization(sessionId);
  const token = { cancelled: false };
  pendingFinalizations.set(sessionId, token);
  const done = (outcome: FinalizeTurnOutcome): FinalizeTurnOutcome => {
    if (pendingFinalizations.get(sessionId) === token) pendingFinalizations.delete(sessionId);
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

    if (isStale) {
      try {
        if (await isStale()) {
          logger.warn('Turn finalization superseded outside this process; abandoning', {
            sessionId,
            attempts: attemptNo,
          });
          return done('superseded');
        }
      } catch {
        // An unreadable row is indistinguishable from the DB flake being
        // retried — fall through and let the attempt itself decide.
      }
    }

    if (token.cancelled) return done('superseded');

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
