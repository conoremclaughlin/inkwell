/**
 * Input Slot
 *
 * The Ink UI has exactly ONE line of input, so it can answer exactly one
 * question at a time. This owns that invariant.
 *
 * It used to live inline in `renderApp.tsx` as a bare `let pendingInput`, which
 * `waitForInput()` reassigned unconditionally — a second concurrent caller
 * silently replaced the first, whose promise then never settled at all. That was
 * harmless while only the REPL loop ever asked; concurrent shadow clones make it
 * a hang. `ApprovalCoordinator` is what keeps callers from overlapping here, and
 * this class is what makes a violation loud instead of silent.
 */

/** Thrown to a caller whose wait was cancelled via its AbortSignal. */
export class InkInputAborted extends Error {
  constructor() {
    super('Input aborted');
    this.name = 'InkInputAborted';
  }
}

interface Waiter {
  resolve: (value: string) => void;
  reject: (error: unknown) => void;
  detach?: () => void;
}

export class InputSlot {
  private waiter: Waiter | null = null;

  get occupied(): boolean {
    return this.waiter !== null;
  }

  /**
   * Wait for the next submitted line.
   *
   * Rejects immediately if someone is already waiting: there is one slot, and
   * quietly evicting the incumbent would strand a caller forever. A caller that
   * can overlap must serialize upstream.
   */
  wait(opts?: { signal?: AbortSignal }): Promise<string> {
    if (this.waiter) {
      return Promise.reject(
        new Error('Input slot is already occupied — serialize callers before waiting')
      );
    }
    if (opts?.signal?.aborted) return Promise.reject(new InkInputAborted());

    return new Promise<string>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject };
      this.waiter = waiter;

      const signal = opts?.signal;
      if (!signal) return;

      const onAbort = () => {
        // Release only if the slot is still ours. A later waiter may hold it,
        // and clearing that one would strand a live caller.
        if (this.waiter === waiter) this.waiter = null;
        reject(new InkInputAborted());
      };
      signal.addEventListener('abort', onAbort, { once: true });
      waiter.detach = () => signal.removeEventListener('abort', onAbort);
    });
  }

  /** Deliver a submitted line to whoever is waiting. No-op when nobody is. */
  submit(value: string): boolean {
    const waiter = this.waiter;
    if (!waiter) return false;
    this.waiter = null;
    waiter.detach?.();
    waiter.resolve(value);
    return true;
  }

  /** Fail the current wait — used for exit signals. No-op when nobody is waiting. */
  fail(error: unknown): boolean {
    const waiter = this.waiter;
    if (!waiter) return false;
    this.waiter = null;
    waiter.detach?.();
    waiter.reject(error);
    return true;
  }
}
