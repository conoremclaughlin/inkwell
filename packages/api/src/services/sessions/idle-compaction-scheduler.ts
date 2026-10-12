/**
 * Compact an idle ink session before its prompt cache expires.
 *
 * A provider keeps a prompt prefix cached for a fixed lifetime after the
 * request that last used it: five minutes or an hour on Anthropic. A turn that
 * arrives after that writes the whole context to the cache again, at the
 * write price, and an SB at 300k tokens pays that for every turn that follows
 * a long gap. Compacting just before the cache expires reads the history at
 * the cache-read price instead, and leaves the next cold turn only the small
 * seed to write (Conor, 2026-10-11, after Claude Code's "Compacted while
 * idle, before the prompt cache expired").
 *
 * The compaction is a turn in the session itself, never a separate
 * summarizer: a fresh request shares no cached prefix, and it would see only
 * ink's ledger, not the native history the provider holds. The SB writes its
 * own brief (buildIdleCompactionPrompt) and calls compact_context, which
 * reseeds the native session from the compacted ledger.
 *
 * Every ink run reports the provider's context and the cache lifetime it wrote
 * at; this arms one timer per session at that lifetime less a margin. A newer
 * run replaces the timer. When it fires, the turn is skipped if the session is
 * busy, if it ended, or if one of the SB's reminders is due before the cache
 * expires: that wake reads the cache warm and arms a new timer when it ends.
 * Timers live in this process, so a restart forgets them; the next run arms
 * again.
 */

import { quietHoursAt, type QuietHoursWindow } from '../quiet-hours.js';
import { mayRunDuringQuietHours } from '../reminder-quiet-hours.js';

/** An active reminder, as far as when it will next wake its SB. */
export interface WakeReminder {
  next_run_at: string;
  run_during_quiet_hours?: boolean | null;
  metadata?: unknown;
}

/**
 * When the earliest of these reminders will actually wake its SB. A reminder
 * that comes due in quiet hours is held until they end, and its next_run_at
 * stays where it was, so a held overnight beat reads as overdue all night.
 * Taken at face value it would be "a wake before the cache expires" every
 * night, which is exactly when a long gap makes compacting worth it.
 */
export function effectiveWakeAt(
  reminders: readonly WakeReminder[],
  window: QuietHoursWindow | null,
  now: Date
): Date | null {
  let earliest: Date | null = null;
  for (const reminder of reminders) {
    const dueMs = Date.parse(reminder.next_run_at);
    if (!Number.isFinite(dueMs)) continue;
    const due = new Date(Math.max(dueMs, now.getTime()));
    const quiet = window ? quietHoursAt(due, window) : { quiet: false as const };
    const wake = quiet.quiet && !mayRunDuringQuietHours(reminder) ? quiet.until : due;
    if (!earliest || wake < earliest) earliest = wake;
  }
  return earliest;
}

export interface IdleCompactionConfig {
  enabled: boolean;
  /** Provider context below which a compaction is not worth what it loses. */
  minContextTokens: number;
  /** How long before expiry to compact, at most. A fifth of the lifetime caps it. */
  marginSeconds: number;
}

export const DEFAULT_IDLE_COMPACTION_CONFIG: IdleCompactionConfig = {
  enabled: true,
  // A fresh ink session on Claude measured ~86k right after a reseed (Myra,
  // 2026-10-11 05:52Z): identity envelope, provider prompt and tools. A floor
  // near that would compact for almost nothing.
  minContextTokens: 150_000,
  marginSeconds: 300,
};

/** One finished ink run, as the session service reports it. */
export interface IdleRunReport {
  sessionId: string;
  userId: string;
  sbSlug: string;
  sbId: string | null;
  providerContextTokens?: number;
  cacheTtlSeconds?: number;
  /** The run was itself an idle compaction. */
  idleCompaction?: boolean;
}

export interface IdleSessionState {
  busy: boolean;
  ended: boolean;
}

export interface IdleCompactionDeps {
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  /** The SB's earliest active reminder, or null when it has none. */
  nextScheduledWakeAt(input: { userId: string; sbId: string }): Promise<Date | null>;
  /** Null when the session no longer exists. */
  sessionState(sessionId: string): Promise<IdleSessionState | null>;
  deliver(input: {
    report: IdleRunReport;
    providerContextTokens: number;
    cacheTtlSeconds: number;
  }): Promise<void>;
  log(event: string, detail: Record<string, unknown>): void;
}

export type IdleArmDecision =
  | { armed: true; fireAt: number; expiresAt: number }
  | { armed: false; reason: string };

export type IdleFireOutcome = { delivered: true } | { delivered: false; reason: string };

interface ArmedTimer {
  handle: unknown;
  report: IdleRunReport;
  providerContextTokens: number;
  cacheTtlSeconds: number;
  expiresAt: number;
}

export class IdleCompactionScheduler {
  private readonly timers = new Map<string, ArmedTimer>();
  /**
   * The last cache lifetime each session reported. A run that only read the
   * cache reports none, and the lifetime it read under is still the last one
   * written.
   */
  private readonly lifetimes = new Map<string, number>();

  constructor(
    private readonly config: IdleCompactionConfig,
    private readonly deps: IdleCompactionDeps
  ) {}

  noteRunFinished(report: IdleRunReport): IdleArmDecision {
    // Any run supersedes the timer an earlier one armed: it used the cache,
    // so the earlier expiry no longer holds.
    this.cancel(report.sessionId);
    if (report.cacheTtlSeconds !== undefined) {
      this.lifetimes.set(report.sessionId, report.cacheTtlSeconds);
    }
    const decision = this.decide(report);
    if (!decision.armed) {
      this.deps.log('idle compaction not armed', {
        sessionId: report.sessionId,
        reason: decision.reason,
      });
      return decision;
    }
    const providerContextTokens = report.providerContextTokens as number;
    const cacheTtlSeconds = this.lifetimes.get(report.sessionId) as number;
    const handle = this.deps.setTimer(() => {
      void this.fire(report.sessionId).catch((error) => {
        this.deps.log('idle compaction failed', {
          sessionId: report.sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, decision.fireAt - this.deps.now());
    this.timers.set(report.sessionId, {
      handle,
      report,
      providerContextTokens,
      cacheTtlSeconds,
      expiresAt: decision.expiresAt,
    });
    this.deps.log('idle compaction armed', {
      sessionId: report.sessionId,
      providerContextTokens,
      cacheTtlSeconds,
      fireAt: new Date(decision.fireAt).toISOString(),
    });
    return decision;
  }

  cancel(sessionId: string): void {
    const armed = this.timers.get(sessionId);
    if (!armed) return;
    this.deps.clearTimer(armed.handle);
    this.timers.delete(sessionId);
  }

  stop(): void {
    for (const sessionId of [...this.timers.keys()]) this.cancel(sessionId);
  }

  /** Armed sessions, for tests and diagnostics. */
  armedSessionIds(): string[] {
    return [...this.timers.keys()];
  }

  /** Runs when the timer does. Public so tests can drive it without a clock. */
  async fire(sessionId: string): Promise<IdleFireOutcome> {
    const armed = this.timers.get(sessionId);
    if (!armed) return { delivered: false, reason: 'not armed' };
    this.timers.delete(sessionId);
    const outcome = await this.check(armed);
    if (!outcome.delivered) {
      this.deps.log('idle compaction skipped', { sessionId, reason: outcome.reason });
      return outcome;
    }
    this.deps.log('idle compaction delivering', {
      sessionId,
      providerContextTokens: armed.providerContextTokens,
      cacheTtlSeconds: armed.cacheTtlSeconds,
    });
    await this.deps.deliver({
      report: armed.report,
      providerContextTokens: armed.providerContextTokens,
      cacheTtlSeconds: armed.cacheTtlSeconds,
    });
    return outcome;
  }

  private decide(report: IdleRunReport): IdleArmDecision {
    if (!this.config.enabled) return { armed: false, reason: 'disabled' };
    if (report.idleCompaction) {
      return { armed: false, reason: 'this run was an idle compaction' };
    }
    const ttl = this.lifetimes.get(report.sessionId);
    if (ttl === undefined) return { armed: false, reason: 'cache lifetime unknown' };
    const context = report.providerContextTokens;
    if (context === undefined) return { armed: false, reason: 'no provider measurement' };
    if (context < this.config.minContextTokens) {
      return {
        armed: false,
        reason: `context ${context} below ${this.config.minContextTokens}`,
      };
    }
    const now = this.deps.now();
    const marginSeconds = Math.min(this.config.marginSeconds, ttl / 5);
    return {
      armed: true,
      fireAt: now + (ttl - marginSeconds) * 1000,
      expiresAt: now + ttl * 1000,
    };
  }

  private async check(armed: ArmedTimer): Promise<IdleFireOutcome> {
    const { report } = armed;
    const state = await this.deps.sessionState(report.sessionId);
    if (!state) return { delivered: false, reason: 'session gone' };
    if (state.ended) return { delivered: false, reason: 'session ended' };
    // A running turn uses the cache and arms a new timer when it ends.
    if (state.busy) return { delivered: false, reason: 'session busy' };
    if (report.sbId) {
      const wake = await this.deps.nextScheduledWakeAt({
        userId: report.userId,
        sbId: report.sbId,
      });
      if (wake && wake.getTime() < armed.expiresAt) {
        return {
          delivered: false,
          reason: `a reminder is due at ${wake.toISOString()}, before the cache expires`,
        };
      }
    }
    return { delivered: true };
  }
}
