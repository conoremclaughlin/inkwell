/**
 * A bounded ordinary-input drain for ONE session, not an ownership registry.
 * The host still authorizes and durably admits commands, and checks the current
 * generation before dispatch. Hosted queues should retain durable command IDs,
 * not entire prompts. Controls (interrupt/approval) never wait in this queue.
 */
export interface SerialInputDrainOptions<Input> {
  maxPendingInputs: number;
  maxPendingBytes: number;
  /** Retained payload size. The host owns encoding and storage. */
  sizeOf(input: Input): number;
  run(input: Input): Promise<void>;
}

export class InputDrainRefusal extends Error {
  constructor(readonly reason: 'closed' | 'capacity' | 'reentrant') {
    super(`Session input was not queued: ${reason}`);
    this.name = 'InputDrainRefusal';
  }
}

export class SerialInputDrain<Input> {
  private tail: Promise<void> = Promise.resolve();
  private count = 0;
  private bytes = 0;
  private closed = false;
  private accepting = false;
  private readonly options: SerialInputDrainOptions<Input>;

  constructor(options: SerialInputDrainOptions<Input>) {
    for (const limit of [options.maxPendingInputs, options.maxPendingBytes]) {
      if (!Number.isSafeInteger(limit) || limit <= 0) {
        throw new RangeError('Input drain limits must be positive safe integers');
      }
    }
    this.options = { ...options };
  }

  /** Includes the active input until its complete run promise settles. */
  get pendingInputs(): number {
    return this.count;
  }

  get pendingBytes(): number {
    return this.bytes;
  }

  /**
   * Synchronous local acceptance; the returned promise is completion, NOT a
   * durable receipt. Refusal throws before anything can run. The optional
   * local preparation hook supports CLI echo/status: if it throws, nothing
   * is queued and an inbox caller must not acknowledge delivery.
   *
   * Inputs must not be mutated after acceptance. No timeout here: giving up
   * waiting on a run is not evidence that its execution stopped.
   */
  enqueue(input: Input, prepare?: () => void): Promise<void> {
    if (this.closed) throw new InputDrainRefusal('closed');
    if (this.accepting) throw new InputDrainRefusal('reentrant');
    this.accepting = true;
    let bytes: number;
    try {
      bytes = this.options.sizeOf(input);
      if (!Number.isSafeInteger(bytes) || bytes < 0) {
        throw new RangeError('Input size must be a non-negative safe integer');
      }
      if (
        this.count >= this.options.maxPendingInputs ||
        bytes > this.options.maxPendingBytes - this.bytes
      ) {
        throw new InputDrainRefusal('capacity');
      }
      if (this.closed) throw new InputDrainRefusal('closed');
      prepare?.();
      // A preparation callback may close intake; it cannot reopen it.
      if (this.closed) throw new InputDrainRefusal('closed');
    } finally {
      this.accepting = false;
    }
    this.count += 1;
    this.bytes += bytes;
    const result = this.tail.then(async () => {
      try {
        await this.options.run(input);
      } finally {
        this.count -= 1;
        this.bytes -= bytes;
      }
    });
    // One failed input does not poison the next one. Keep a rejection handler
    // attached even when a UI intentionally does not await completion; callers
    // still receive the original rejected result, never a false success.
    this.tail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  /** Wait for inputs accepted so far; individual errors belong to their results. */
  flush(): Promise<void> {
    return this.tail;
  }

  /** Close intake, then drain already accepted inputs. Does not cancel work. */
  close(): Promise<void> {
    this.closed = true;
    return this.flush();
  }
}
