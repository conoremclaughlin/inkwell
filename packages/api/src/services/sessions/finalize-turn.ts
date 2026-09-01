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

export type FinalizeTurnOutcome = 'finalized' | 'refused' | 'gone' | 'exhausted';

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
    sleep = defaultSleep,
    now = Date.now,
    maxTotalMs = FINALIZE_RETRY_MAX_TOTAL_MS,
    initialDelayMs = FINALIZE_RETRY_INITIAL_DELAY_MS,
    maxDelayMs = FINALIZE_RETRY_MAX_DELAY_MS,
  } = options;

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
      return 'exhausted';
    }

    await sleep(delay);
    attemptNo += 1;

    if (!admit()) {
      logger.warn('Turn finalization retry refused; shutdown owns this session now', {
        sessionId,
        attempts: attemptNo,
      });
      return 'refused';
    }

    try {
      await attempt();
      onFinalized();
      logger.info('Turn finalization succeeded on retry', { sessionId, attempts: attemptNo });
      return 'finalized';
    } catch (err) {
      if (isGone(err)) {
        logger.error('Turn finalization abandoned; session row is gone', {
          sessionId,
          attempts: attemptNo,
        });
        return 'gone';
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
