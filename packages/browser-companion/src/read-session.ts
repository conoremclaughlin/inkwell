import { parseSnapshot, type BrowserSnapshot } from './protocol';

export const MAX_READ_SESSION_MS = 10 * 60 * 1000;
export const MAX_READ_OPERATIONS = 60;
export const MAX_READ_LIVENESS_MS = 15_000;

/** Local attachment identity, supplied by the trusted browser adapter, not page data. */
export interface ReadTarget {
  tabId: number;
  documentId: string;
  navigationId: string;
}

/** An already authenticated grant; this module is NOT a token verifier. */
export interface ReadGrant {
  id: string;
  controllerSessionId: string;
  expiresAt: number;
  maxReads: number;
}

export interface ReadClock {
  wall(): number;
  monotonic(): number;
}

export interface PageReadAdapter {
  /** Recheck the authoritative grant, owner and budget on the server for EVERY read.
   * Return the remaining liveness duration, not a client-selected TTL.
   * Request latency consumes this duration. Reject revocation/auth/network errors.
   */
  verify(grant: Readonly<ReadGrant>, signal: AbortSignal): Promise<number>;
  /** Address the exact Chrome document and verify navigation identity before/after.
   * The returned target must come from trusted browser metadata, not page claims.
   */
  capture(
    target: Readonly<ReadTarget>,
    mode: BrowserSnapshot['mode'],
    signal: AbortSignal
  ): Promise<{ target: ReadTarget; snapshot: unknown }>;
}

export type ReadStopReason = 'user' | 'navigation' | 'disconnected' | 'expired' | 'clock-changed';

function identity(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200;
}

function sameTarget(a: ReadTarget, b: ReadTarget): boolean {
  return a.tabId === b.tabId && a.documentId === b.documentId && a.navigationId === b.navigationId;
}

/** Read-only local lifecycle foundation, intentionally not wired into the prototype.
 * No tokens, Chrome permissions, transport, persistence, writes or egress policy here.
 * Human regrant creates a NEW instance; a stopped instance cannot be renewed.
 * The server must retain grant budgets across worker restarts: local counters alone
 * do not enforce an installation-wide ceiling. Never restore this object as live.
 */
export class PageReadSession {
  private readonly grant: Readonly<ReadGrant>;
  private readonly target: Readonly<ReadTarget>;
  private readonly deadline: number;
  private readonly monotonicDeadline: number;
  private lastWall: number;
  private lastMonotonic: number;
  private reads = 0;
  private stopped?: ReadStopReason;
  private pending?: AbortController;

  constructor(
    grant: ReadGrant,
    target: ReadTarget,
    private readonly clock: ReadClock = {
      wall: () => Date.now(),
      monotonic: () => performance.now(),
    }
  ) {
    const wall = clock.wall();
    const monotonic = clock.monotonic();
    if (
      !Number.isFinite(wall) ||
      !Number.isFinite(monotonic) ||
      !Number.isSafeInteger(grant.expiresAt) ||
      grant.expiresAt <= wall ||
      !Number.isSafeInteger(grant.maxReads) ||
      grant.maxReads < 1 ||
      !identity(grant.id) ||
      !identity(grant.controllerSessionId) ||
      !Number.isSafeInteger(target.tabId) ||
      target.tabId < 0 ||
      !identity(target.documentId) ||
      !identity(target.navigationId)
    )
      throw new Error('Invalid page-read grant or attachment.');
    this.grant = Object.freeze({
      id: grant.id,
      controllerSessionId: grant.controllerSessionId,
      expiresAt: grant.expiresAt,
      maxReads: Math.min(grant.maxReads, MAX_READ_OPERATIONS),
    });
    this.target = Object.freeze({
      tabId: target.tabId,
      documentId: target.documentId,
      navigationId: target.navigationId,
    });
    this.deadline = Math.min(grant.expiresAt, wall + MAX_READ_SESSION_MS);
    this.monotonicDeadline = monotonic + (this.deadline - wall);
    this.lastWall = wall;
    this.lastMonotonic = monotonic;
  }

  get status() {
    this.checkClock();
    return {
      state: this.stopped
        ? ('stopped' as const)
        : this.pending
          ? ('reading' as const)
          : ('ready' as const),
      reason: this.stopped,
      readsUsed: this.reads,
      readLimit: this.grant.maxReads,
    };
  }

  /** Synchronous local revocation: never wait behind network IO or a work queue. */
  stop(reason: ReadStopReason = 'user'): void {
    this.stopped ??= reason;
    this.pending?.abort();
  }

  /** Invoke for reloads, SPA navigation, detach and source-tab changes. */
  observeTarget(target: ReadTarget): void {
    if (!sameTarget(this.target, target)) this.stop('navigation');
  }

  private checkClock(): { wall: number; monotonic: number } {
    const wall = this.clock.wall();
    const monotonic = this.clock.monotonic();
    if (
      !Number.isFinite(wall) ||
      !Number.isFinite(monotonic) ||
      wall < this.lastWall ||
      monotonic < this.lastMonotonic
    ) {
      this.stop('clock-changed');
    } else if (wall >= this.deadline || monotonic >= this.monotonicDeadline) {
      this.stop('expired');
    }
    this.lastWall = wall;
    this.lastMonotonic = monotonic;
    return { wall, monotonic };
  }

  private requireLive(): { wall: number; monotonic: number } {
    const now = this.checkClock();
    if (this.stopped) throw new Error(`Page discussion stopped: ${this.stopped}.`);
    return now;
  }

  async read(mode: BrowserSnapshot['mode'], adapter: PageReadAdapter): Promise<BrowserSnapshot> {
    const started = this.requireLive();
    if (mode !== 'selection' && mode !== 'page') throw new Error('Unsupported read mode.');
    if (this.pending) throw new Error('A page read is already in progress.');
    if (this.reads >= this.grant.maxReads)
      throw new Error('Page-read budget exhausted. Regrant required.');
    // Reserve BEFORE awaiting: failed reads spend the local budget too.
    this.reads++;
    const pending = new AbortController();
    this.pending = pending;
    let confirmedDuration = MAX_READ_LIVENESS_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let rejectStop!: () => void;
    const interrupted = new Promise<never>((_resolve, reject) => {
      rejectStop = () => reject(new Error('Page read interrupted. Nothing returned.'));
      pending.signal.addEventListener('abort', rejectStop, { once: true });
    });
    const checkDeadline = (duration: number) => {
      const now = this.requireLive();
      const remaining = Math.min(
        duration - (now.wall - started.wall),
        duration - (now.monotonic - started.monotonic),
        this.deadline - now.wall,
        this.monotonicDeadline - now.monotonic
      );
      if (remaining <= 0) throw new Error('Page-read liveness expired. Revalidate before reading.');
      return remaining;
    };
    const armTimeout = (remaining: number) => {
      clearTimeout(timer);
      timer = setTimeout(() => pending.abort(), remaining);
    };
    try {
      const work = async () => {
        armTimeout(checkDeadline(MAX_READ_LIVENESS_MS));
        let duration: number;
        try {
          duration = await adapter.verify(this.grant, pending.signal);
        } catch {
          throw new Error('Page-read authorization failed.');
        }
        if (pending.signal.aborted) throw new Error('Page read interrupted.');
        if (!Number.isFinite(duration) || duration <= 0)
          throw new Error('Invalid page-read liveness confirmation.');
        confirmedDuration = Math.min(duration, MAX_READ_LIVENESS_MS);
        armTimeout(checkDeadline(confirmedDuration));
        let captured: Awaited<ReturnType<PageReadAdapter['capture']>>;
        try {
          captured = await adapter.capture(this.target, mode, pending.signal);
        } catch {
          throw new Error('Page capture failed.');
        }
        if (pending.signal.aborted) throw new Error('Page read interrupted.');
        checkDeadline(confirmedDuration);
        if (!sameTarget(this.target, captured.target)) {
          this.stop('navigation');
          throw new Error('Page changed during the read.');
        }
        const snapshot = parseSnapshot(captured.snapshot);
        if (
          snapshot.mode !== mode ||
          snapshot.capturedAt < started.wall ||
          snapshot.capturedAt > this.clock.wall()
        )
          throw new Error('Observation does not belong to this read.');
        // Own the returned data: later adapter mutation cannot change this observation.
        return structuredClone(snapshot);
      };
      const observation = await Promise.race([interrupted, work()]);
      // Promise.race can already have selected the capture when Stop/expiry wins
      // the following microtask. Recheck at the actual observation handoff too.
      if (pending.signal.aborted) throw new Error('Page read interrupted.');
      checkDeadline(confirmedDuration);
      return observation;
    } finally {
      clearTimeout(timer);
      pending.signal.removeEventListener('abort', rejectStop);
      pending.abort();
      if (this.pending === pending) this.pending = undefined;
    }
  }
}
