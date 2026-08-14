/**
 * Input Slot
 *
 * The Ink UI has exactly ONE line of input, so it can answer exactly one
 * question at a time. This owns that invariant — and the fact that not every
 * asker is equal.
 *
 * Two kinds of caller share the line, and they overlap by design:
 *
 * - The **standing reader**: the REPL loop, which re-arms immediately after
 *   dispatching a turn (`void enqueueTurn(raw)`), so it is almost always
 *   waiting while a turn runs.
 * - A **prompt**: a tool approval raised from inside that turn, which needs the
 *   line *now* and must be answered before the turn can continue.
 *
 * A prompt therefore PREEMPTS the standing reader rather than competing with
 * it: it takes the line, gets the next submission, and on release hands the line
 * back to the reader, whose promise was never disturbed. Mutual exclusion alone
 * would fail every interactive approval — the reader already holds the slot.
 *
 * This used to be a bare `let pendingInput` in `renderApp.tsx` that
 * `waitForInput()` reassigned unconditionally. That accidentally implemented the
 * takeover, but by *orphaning* the reader's promise, so the REPL loop hung on a
 * dead await once the approval was answered. Preemption is the same intent done
 * so both callers survive.
 *
 * Two prompts at once still reject each other — that is `ApprovalCoordinator`'s
 * job to prevent, and a violation should be loud.
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
  /** The standing reader — the REPL loop, waiting for the next command. */
  private reader: Waiter | null = null;
  /** A prompt that has preempted the reader. Answered first when set. */
  private prompt: Waiter | null = null;

  get occupied(): boolean {
    return this.reader !== null || this.prompt !== null;
  }

  /** True while a prompt holds the line ahead of the standing reader. */
  get preempted(): boolean {
    return this.prompt !== null;
  }

  /**
   * Wait for the next submitted line as the standing reader.
   *
   * Rejects if a reader is already waiting: quietly evicting one would strand it
   * forever. Note this does NOT reject while a prompt holds the line — the
   * reader may legitimately re-arm underneath a prompt, and will be served once
   * the prompt releases.
   */
  wait(opts?: { signal?: AbortSignal }): Promise<string> {
    return this.claim('reader', opts);
  }

  /**
   * Take the line ahead of the standing reader, for a question that must be
   * answered before the current turn can proceed.
   *
   * The reader keeps its promise and its place; the next submission comes here
   * instead, and the one after that goes back to the reader.
   */
  waitPriority(opts?: { signal?: AbortSignal }): Promise<string> {
    return this.claim('prompt', opts);
  }

  private claim(kind: 'reader' | 'prompt', opts?: { signal?: AbortSignal }): Promise<string> {
    if (this[kind]) {
      return Promise.reject(
        new Error(
          kind === 'prompt'
            ? 'Another prompt already holds the input line — serialize prompts before waiting'
            : 'Input slot is already occupied — serialize callers before waiting'
        )
      );
    }
    if (opts?.signal?.aborted) return Promise.reject(new InkInputAborted());

    return new Promise<string>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject };
      this[kind] = waiter;

      const signal = opts?.signal;
      if (!signal) return;

      const onAbort = () => {
        // Release only if the slot is still ours. A later waiter may hold it,
        // and clearing that one would strand a live caller.
        if (this[kind] === waiter) this[kind] = null;
        reject(new InkInputAborted());
      };
      signal.addEventListener('abort', onAbort, { once: true });
      waiter.detach = () => signal.removeEventListener('abort', onAbort);
    });
  }

  /**
   * Deliver a submitted line. A waiting prompt is served before the standing
   * reader — that ordering IS the preemption. No-op when nobody is waiting.
   */
  submit(value: string): boolean {
    const kind = this.prompt ? 'prompt' : 'reader';
    const waiter = this[kind];
    if (!waiter) return false;
    this[kind] = null;
    waiter.detach?.();
    waiter.resolve(value);
    return true;
  }

  /** Fail everyone waiting — used for exit signals. False when nobody was. */
  fail(error: unknown): boolean {
    let failed = false;
    for (const kind of ['prompt', 'reader'] as const) {
      const waiter = this[kind];
      if (!waiter) continue;
      this[kind] = null;
      waiter.detach?.();
      waiter.reject(error);
      failed = true;
    }
    return failed;
  }
}
