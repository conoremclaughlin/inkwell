/**
 * Trigger Retry Scheduler
 *
 * Delayed re-queue for agent triggers whose backend spawn failed transiently
 * (network dips, connect timeouts, codex stream disconnects, models-refresh
 * timeouts). The runner has its own short inner retry, but both inner attempts
 * usually land inside the same outage window — this scheduler retries on a
 * much longer horizon (~2min, then ~10min) so the outage has time to clear.
 *
 * State is in-memory (Map keyed by a stable trigger identity + setTimeout),
 * mirroring scheduleChannelRetry in channels/gateway.ts. A process restart
 * drops pending retries — acceptable for v1, since the original inbox message
 * is restored to unread when the final attempt fails.
 *
 * Attempt count travels on payload.metadata.triggerAttempt so it survives
 * re-dispatch (each dispatch generates a fresh gateway triggerId, which is
 * why the gateway triggerId itself cannot be the retry key).
 */

import type { AgentTriggerPayload } from './agent-gateway';
import type { ErrorClassification } from '@inklabs/shared';
import { logger } from '../utils/logger';

/** Total attempts including the original dispatch. */
export const TRIGGER_MAX_ATTEMPTS = 3;

/** Delay before attempt 2, then before attempt 3. */
export const TRIGGER_RETRY_DELAYS_MS = [2 * 60 * 1000, 10 * 60 * 1000];

const ATTEMPT_METADATA_KEY = 'triggerAttempt';

/** Read the 1-based attempt number from a trigger payload (defaults to 1). */
export function getTriggerAttempt(payload: AgentTriggerPayload): number {
  const raw = payload.metadata?.[ATTEMPT_METADATA_KEY];
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 1 ? raw : 1;
}

/**
 * Stable identity for a trigger across re-dispatches. Combines the source
 * message id with the target agent so fan-out (one thread message triggering
 * multiple recipients) gets independent retry timers per recipient.
 */
export function getTriggerRetryKey(payload: AgentTriggerPayload): string {
  const sourceId =
    payload.inboxMessageId ??
    payload.threadMessageId ??
    payload.threadId ??
    payload.threadKey ??
    'no-thread';
  return `${sourceId}::${payload.toAgentId}`;
}

export type ScheduleResult =
  | { scheduled: true; attempt: number; delayMs: number }
  | { scheduled: false; reason: 'not_transient' | 'exhausted' | 'already_pending' };

export interface TriggerRetrySchedulerOptions {
  maxAttempts?: number;
  delaysMs?: number[];
}

export class TriggerRetryScheduler {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly maxAttempts: number;
  private readonly delaysMs: number[];

  constructor(
    private readonly redispatch: (payload: AgentTriggerPayload) => void,
    options: TriggerRetrySchedulerOptions = {}
  ) {
    this.maxAttempts = options.maxAttempts ?? TRIGGER_MAX_ATTEMPTS;
    this.delaysMs = options.delaysMs ?? TRIGGER_RETRY_DELAYS_MS;
  }

  get pendingCount(): number {
    return this.timers.size;
  }

  /**
   * Schedule a delayed re-dispatch for a failed trigger.
   *
   * Only transient (retryable) classifications are retried, capped at
   * maxAttempts total. Returns whether a retry was scheduled so the caller
   * can decide between "wait for retry" and "send failure notification now".
   */
  scheduleRetry(payload: AgentTriggerPayload, classification: ErrorClassification): ScheduleResult {
    if (!classification.retryable) {
      return { scheduled: false, reason: 'not_transient' };
    }

    const attempt = getTriggerAttempt(payload);
    if (attempt >= this.maxAttempts) {
      return { scheduled: false, reason: 'exhausted' };
    }

    const key = getTriggerRetryKey(payload);
    if (this.timers.has(key)) {
      return { scheduled: false, reason: 'already_pending' };
    }

    const nextAttempt = attempt + 1;
    const delayMs = this.delaysMs[Math.min(attempt - 1, this.delaysMs.length - 1)];

    const retryPayload: AgentTriggerPayload = {
      ...payload,
      metadata: { ...(payload.metadata ?? {}), [ATTEMPT_METADATA_KEY]: nextAttempt },
    };

    const timer = setTimeout(() => {
      this.timers.delete(key);
      try {
        this.redispatch(retryPayload);
      } catch (err) {
        logger.error('[TriggerRetry] Re-dispatch threw', {
          key,
          attempt: nextAttempt,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }, delayMs);
    // Don't hold the process open just for a pending retry.
    timer.unref?.();

    this.timers.set(key, timer);
    return { scheduled: true, attempt: nextAttempt, delayMs };
  }

  /** Cancel a pending retry (e.g. message handled through another path). */
  cancel(key: string): boolean {
    const timer = this.timers.get(key);
    if (!timer) return false;
    clearTimeout(timer);
    this.timers.delete(key);
    return true;
  }

  /** Cancel all pending retries (shutdown / tests). */
  clear(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}
