/**
 * The in-process gate account deletion closes (ink://specs/account-deletion
 * v6 §3).
 *
 * Every piece of work for an account enters its gate synchronously, before
 * its first await, and leaves after its last write: an authenticated request
 * until its response has closed, an inkling turn from before its folder is
 * prepared until it has finalized, an upload until its last filesystem step.
 * Closing the gate refuses everything that enters later; draining waits for
 * what entered before.
 *
 * The order is what makes it safe without a lock. A writer registers, then
 * reads the closed mark. The deletion closes the mark, then reads the
 * registrations. So any writer the deletion does not see has already seen
 * the mark and been refused.
 *
 * It is in-process by design: deletion runs in the main server, the one
 * process that serves consumer accounts (§2). The closed marks are rebuilt
 * from the request rows when the server starts, before it takes work.
 *
 * The same class keys a space's gate when a space is being deleted (§8).
 */

export interface GateLease {
  /** Leave the gate. Idempotent. */
  release(): void;
}

export class GateClosedError extends Error {
  constructor(readonly key: string) {
    super('This account is being deleted');
    this.name = 'GateClosedError';
  }
}

export class WorkGate {
  private readonly closedKeys = new Set<string>();
  private readonly inFlight = new Map<string, number>();
  private readonly drainWaiters = new Map<string, Set<() => void>>();

  /**
   * Register work for `key`, then check that the gate is open. Throws
   * GateClosedError, holding nothing, when it is closed.
   */
  enter(key: string): GateLease {
    this.inFlight.set(key, (this.inFlight.get(key) ?? 0) + 1);
    let released = false;
    const lease: GateLease = {
      release: () => {
        if (released) return;
        released = true;
        this.leave(key);
      },
    };
    if (this.closedKeys.has(key)) {
      lease.release();
      throw new GateClosedError(key);
    }
    return lease;
  }

  /** Whether `key` has been closed. Work entering it is refused. */
  isClosed(key: string): boolean {
    return this.closedKeys.has(key);
  }

  /** Close `key`. Work already inside keeps its lease until it leaves. */
  close(key: string): void {
    this.closedKeys.add(key);
  }

  /** Forget `key` once nothing of it remains (a completed deletion). */
  forget(key: string): void {
    if ((this.inFlight.get(key) ?? 0) === 0) this.closedKeys.delete(key);
  }

  /** How much work for `key` is inside the gate now. */
  inFlightCount(key: string): number {
    return this.inFlight.get(key) ?? 0;
  }

  /**
   * Resolve true once no work for `key` is inside the gate, or false when
   * `timeoutMs` passes first. The caller closes the gate before waiting.
   */
  async waitDrained(key: string, timeoutMs: number): Promise<boolean> {
    if (this.inFlightCount(key) === 0) return true;
    return new Promise<boolean>((resolve) => {
      let done = false;
      const waiters = this.drainWaiters.get(key) ?? new Set<() => void>();
      this.drainWaiters.set(key, waiters);
      const onDrained = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        waiters.delete(onDrained);
        resolve(false);
      }, timeoutMs);
      waiters.add(onDrained);
    });
  }

  private leave(key: string): void {
    const remaining = (this.inFlight.get(key) ?? 1) - 1;
    if (remaining > 0) {
      this.inFlight.set(key, remaining);
      return;
    }
    this.inFlight.delete(key);
    const waiters = this.drainWaiters.get(key);
    if (!waiters) return;
    this.drainWaiters.delete(key);
    for (const waiter of waiters) waiter();
  }
}

/** One gate per account, keyed by users.id. */
export const accountGate = new WorkGate();

/** One gate per space being deleted, keyed by workspaces.id. */
export const spaceGate = new WorkGate();
