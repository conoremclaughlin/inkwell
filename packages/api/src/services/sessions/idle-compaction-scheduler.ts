/**
 * Compact an idle ink session before its prompt cache expires.
 *
 * A provider keeps a prompt prefix cached for a fixed lifetime from the START
 * of the request that last used it: five minutes or an hour on Anthropic, so
 * generation time already spends it (Anthropic's prompt-caching docs). A
 * turn that arrives after that writes the whole context to the cache again,
 * at the write price, and a large session pays that for every turn that
 * follows a long gap. Compacting just before the cache expires reads the
 * history at the cache-read price instead, and leaves the next cold turn
 * only the small seed to write. Claude Code does the same for its own
 * sessions ("Compacted while idle, before the prompt cache expired").
 *
 * The compaction is a turn in the session itself, never a separate
 * summarizer: a fresh request shares no cached prefix, and it would see only
 * ink's ledger, not the native history the provider holds. The SB writes its
 * own brief (buildIdleCompactionPrompt) and calls compact_context, which
 * reseeds the native session from the compacted ledger.
 *
 * Every ink run reports the provider's context, the cache lifetime it wrote
 * at, and when its last provider invocation began. This arms one timer per
 * session at that start plus the lifetime, less a margin; with any of the
 * three unknown, or the window already gone, it arms nothing. A newer run
 * replaces the timer. It arms only when the context is above a floor and has
 * grown since the last idle compaction, so a large fixed prefix is not
 * summarized again and again. When it fires it is skipped if the session is
 * busy or ended, or if the cache has already expired. A cancel, a newer run
 * or a stop that lands while it is checking voids it. A failed or refused
 * compaction leaves the context as it was; nothing here trims. Timers live in
 * this process, so a restart forgets them; the next run arms again.
 *
 * A reminder due before expiry does not suppress it. Which session a
 * reminder wakes is decided by heartbeat routing (channel routes, default
 * session, studio hints), and a reminder that wakes another session leaves
 * this one's cache to expire. Suppressing on an SB's reminders without
 * proving the session was wrong (Lumen, #845 r1); the growth gate is what
 * bounds how often this runs.
 */

export interface IdleCompactionConfig {
  enabled: boolean;
  /** Provider context below which a compaction is not worth what it loses. */
  minContextTokens: number;
  /** Growth since the last idle compaction needed before another one. */
  minGrowthTokens: number;
  /** How long before expiry to compact, at most. A fifth of the lifetime caps it. */
  marginSeconds: number;
}

export const DEFAULT_IDLE_COMPACTION_CONFIG: IdleCompactionConfig = {
  enabled: true,
  // A freshly reseeded ink session on Claude already carries tens of
  // thousands of tokens (identity envelope, provider prompt, tools). A floor
  // near that would compact for almost nothing.
  minContextTokens: 150_000,
  minGrowthTokens: 50_000,
  marginSeconds: 300,
};

/** One finished ink run, as the session service reports it. */
export interface IdleRunReport {
  sessionId: string;
  userId: string;
  sbSlug: string;
  sbId: string | null;
  /** The session's contact scope, so the turn is admitted in that scope only. */
  contactId?: string;
  providerContextTokens?: number;
  cacheTtlSeconds?: number;
  /** When the run's last provider invocation began (ISO): the cache's clock. */
  lastRequestStartedAt?: string;
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
  /** The provider context each session's last idle compaction left. */
  private readonly baselines = new Map<string, number>();
  /** Set by stop(): nothing arms or delivers after it. */
  private stopped = false;

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
    if (report.idleCompaction && report.providerContextTokens !== undefined) {
      this.baselines.set(report.sessionId, report.providerContextTokens);
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
    this.stopped = true;
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
    // The candidate stays registered while it is checked, so a cancel, a
    // newer run or a stop during the awaited reads replaces or removes it, and
    // the identity check below sees that (Lumen, #845 r1). A stop removes
    // every candidate, so it is covered by the same check.
    const outcome = await this.check(armed);
    const current = this.timers.get(sessionId) === armed;
    if (current) this.timers.delete(sessionId);
    if (!outcome.delivered || !current) {
      const reason = outcome.delivered ? 'superseded while it was checked' : outcome.reason;
      this.deps.log('idle compaction skipped', { sessionId, reason });
      return { delivered: false, reason };
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
    if (this.stopped) return { armed: false, reason: 'stopped' };
    if (report.idleCompaction) {
      return { armed: false, reason: 'this run was an idle compaction' };
    }
    const ttl = this.lifetimes.get(report.sessionId);
    if (ttl === undefined) return { armed: false, reason: 'cache lifetime unknown' };
    const startedAt =
      report.lastRequestStartedAt !== undefined ? Date.parse(report.lastRequestStartedAt) : NaN;
    if (!Number.isFinite(startedAt)) return { armed: false, reason: 'request start unknown' };
    const context = report.providerContextTokens;
    if (context === undefined) return { armed: false, reason: 'no provider measurement' };
    if (context < this.config.minContextTokens) {
      return {
        armed: false,
        reason: `context ${context} below ${this.config.minContextTokens}`,
      };
    }
    const baseline = this.baselines.get(report.sessionId);
    if (baseline !== undefined && context < baseline + this.config.minGrowthTokens) {
      return {
        armed: false,
        reason: `context ${context} has not grown ${this.config.minGrowthTokens} since the last idle compaction left ${baseline}`,
      };
    }
    const marginSeconds = Math.min(this.config.marginSeconds, ttl / 5);
    const expiresAt = startedAt + ttl * 1000;
    const fireAt = expiresAt - marginSeconds * 1000;
    // The turn ran so long that the useful window is gone. A late compaction
    // would read a cold cache, which is no cheaper than the next real turn.
    if (fireAt <= this.deps.now()) {
      return { armed: false, reason: 'the cache window passed during the run' };
    }
    return { armed: true, fireAt, expiresAt };
  }

  private async check(armed: ArmedTimer): Promise<IdleFireOutcome> {
    const { report } = armed;
    // A timer that ran late (a blocked event loop, a sleeping machine) would
    // read a cold cache, which is no cheaper than the next real turn.
    if (this.deps.now() >= armed.expiresAt) {
      return { delivered: false, reason: 'the cache has already expired' };
    }
    const state = await this.deps.sessionState(report.sessionId);
    if (!state) return { delivered: false, reason: 'session gone' };
    if (state.ended) return { delivered: false, reason: 'session ended' };
    // A running turn uses the cache and arms a new timer when it ends.
    if (state.busy) return { delivered: false, reason: 'session busy' };
    if (this.deps.now() >= armed.expiresAt) {
      return { delivered: false, reason: 'the cache has already expired' };
    }
    return { delivered: true };
  }
}
