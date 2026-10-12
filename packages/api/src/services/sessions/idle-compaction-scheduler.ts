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

import type { CacheEvidence } from './types.js';

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
  // Off until a deployment turns it on: the turn's "do not message anyone"
  // is a prompt, not an enforced maintenance mode (Lumen, #845 r2).
  enabled: false,
  // A freshly reseeded ink session on Claude already carries tens of
  // thousands of tokens (identity envelope, provider prompt, tools), and a
  // session past a few hundred thousand is where it gets unwieldy. The floor
  // sits well above the first and below the second.
  minContextTokens: 250_000,
  // Not every cache lifetime: another compaction waits for this much new
  // context past what the last one left.
  minGrowthTokens: 100_000,
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
  /** What the run left in its prompt cache, with its scope. Absent is unknown. */
  cacheEvidence?: CacheEvidence;
  /** When the run's last provider invocation began (ISO): the cache's clock. */
  lastRequestStartedAt?: string;
  /** The run was itself an idle compaction. */
  idleCompaction?: boolean;
}

/**
 * What the idle turn carries to its admission. The session service checks it
 * where the turn takes the session's lock, with no await in between: a
 * candidate that a cancel, a newer run or a stop has superseded, or whose
 * cache has expired, is refused there rather than queued (Lumen, #845 r2).
 */
export interface IdleAdmissionTicket {
  generation: number;
  expiresAt: number;
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
    ticket: IdleAdmissionTicket;
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
  generation: number;
}

interface LearnedLifetime {
  ttl: number;
  providerSessionId?: string;
  model?: string;
}

export class IdleCompactionScheduler {
  private readonly timers = new Map<string, ArmedTimer>();
  /**
   * The last cache lifetime each session wrote, with the native session and
   * model it was written under. A read-only run inherits it only in that same
   * scope; an unknown run forgets it, since whatever it wrote may have
   * replaced it (Lumen, #845 r3).
   */
  private readonly lifetimes = new Map<string, LearnedLifetime>();
  /**
   * Bumped by every cancel, so a ticket issued before a later run started or
   * finished no longer matches at admission.
   */
  private readonly generations = new Map<string, number>();
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
    const ttl = this.resolveLifetime(report);
    if (report.idleCompaction && report.providerContextTokens !== undefined) {
      this.baselines.set(report.sessionId, report.providerContextTokens);
    }
    const decision = this.decide(report, ttl);
    if (!decision.armed) {
      this.deps.log('idle compaction not armed', {
        sessionId: report.sessionId,
        reason: decision.reason,
      });
      return decision;
    }
    const providerContextTokens = report.providerContextTokens as number;
    const cacheTtlSeconds = ttl as number;
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
      generation: this.generationOf(report.sessionId),
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
    // Always, armed or not: an idle turn already on its way to admission is
    // no longer in the map, and only the generation can void it.
    this.generations.set(sessionId, this.generationOf(sessionId) + 1);
    const armed = this.timers.get(sessionId);
    if (!armed) return;
    this.deps.clearTimer(armed.handle);
    this.timers.delete(sessionId);
  }

  /**
   * Why an idle turn holding this ticket may not run now, or null when it may.
   * Synchronous, so the caller can check it and take the session's lock with
   * nothing in between.
   */
  admissionRefusal(sessionId: string, ticket: IdleAdmissionTicket): string | null {
    if (this.stopped) return 'stopped';
    if (this.generationOf(sessionId) !== ticket.generation) {
      return 'superseded before admission';
    }
    if (this.deps.now() >= ticket.expiresAt) return 'the cache has already expired';
    return null;
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
      ticket: { generation: armed.generation, expiresAt: armed.expiresAt },
    });
    return outcome;
  }

  private generationOf(sessionId: string): number {
    return this.generations.get(sessionId) ?? 0;
  }

  /** Learns from, or forgets on, this run's evidence; returns the lifetime it supports. */
  private resolveLifetime(report: IdleRunReport): number | undefined {
    const evidence = report.cacheEvidence ?? { kind: 'unknown' as const };
    if (evidence.kind === 'ttl') {
      this.lifetimes.set(report.sessionId, {
        ttl: evidence.seconds,
        providerSessionId: evidence.providerSessionId,
        model: evidence.model,
      });
      return evidence.seconds;
    }
    if (evidence.kind === 'unknown') {
      this.lifetimes.delete(report.sessionId);
      return undefined;
    }
    const learned = this.lifetimes.get(report.sessionId);
    // An unreported session or model is never the same scope.
    if (!learned || evidence.providerSessionId === undefined || evidence.model === undefined) {
      return undefined;
    }
    return learned.providerSessionId === evidence.providerSessionId &&
      learned.model === evidence.model
      ? learned.ttl
      : undefined;
  }

  private decide(report: IdleRunReport, ttl: number | undefined): IdleArmDecision {
    if (!this.config.enabled) return { armed: false, reason: 'disabled' };
    if (this.stopped) return { armed: false, reason: 'stopped' };
    if (report.idleCompaction) {
      return { armed: false, reason: 'this run was an idle compaction' };
    }
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
