/**
 * Bounded live delivery, not history or admission (live-agent-surfaces R5).
 *
 * One instance belongs to ONE already-authorized projection. The host guards
 * and projects events, then encodes them before publishing. Strings keep one
 * reader from mutating another's frame. Nothing here authorizes subscribers,
 * inspects provider output, mints cursors, replays history, or stops execution.
 * The host must also bound its registry of fanouts and its transport buffers.
 */
export interface FrameFanoutLimits {
  maxSubscribers: number;
  maxQueuedFrames: number;
  maxQueuedBytes: number;
}

export type FrameStreamEndReason = 'unsubscribed' | 'overflow' | 'revoked' | 'source_closed';

/** A failed stream must recover from authorized replay/snapshot, not skip ahead. */
export class FrameStreamEnded extends Error {
  constructor(readonly reason: Exclude<FrameStreamEndReason, 'unsubscribed'>) {
    super(`Live frame stream ended: ${reason}`);
    this.name = 'FrameStreamEnded';
  }
}

export class FrameSubscribeRefusal extends Error {
  constructor(readonly reason: 'closed' | 'capacity') {
    super(`Live frame subscription refused: ${reason}`);
    this.name = 'FrameSubscribeRefusal';
  }
}

/** Consumer misuse, not a stream end: the existing pending read stays usable. */
export class FrameReadPendingError extends Error {
  constructor() {
    super('A live frame read is already pending');
    this.name = 'FrameReadPendingError';
  }
}

export interface FrameSubscription extends AsyncIterableIterator<string> {
  /** Always resolves, including while a consumer is busy writing its last frame. */
  readonly ended: Promise<FrameStreamEndReason>;
  readonly endReason: FrameStreamEndReason | undefined;
  readonly queuedFrames: number;
  readonly queuedBytes: number;
  /** Detach/revoke only this view. Neither action interrupts the writer. */
  close(reason?: 'unsubscribed' | 'revoked'): void;
}

export type FramePublishResult =
  | { outcome: 'published'; readers: number; overflowed: number }
  | { outcome: 'closed' | 'too_large' };

class FrameReader implements FrameSubscription {
  private readonly queue: Array<{ frame: string; bytes: number }> = [];
  private bytes = 0;
  private reason: FrameStreamEndReason | undefined;
  private pending:
    | {
        resolve(value: IteratorResult<string>): void;
        reject(error: FrameStreamEnded): void;
      }
    | undefined;
  private resolveEnd!: (reason: FrameStreamEndReason) => void;
  readonly ended: Promise<FrameStreamEndReason>;

  constructor(
    private readonly limits: Readonly<FrameFanoutLimits>,
    private readonly remove: () => void
  ) {
    this.ended = new Promise((resolve) => {
      this.resolveEnd = resolve;
    });
  }

  get endReason(): FrameStreamEndReason | undefined {
    return this.reason;
  }

  get queuedFrames(): number {
    return this.queue.length;
  }

  get queuedBytes(): number {
    return this.bytes;
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<string> {
    return this;
  }

  next(): Promise<IteratorResult<string>> {
    if (this.reason) {
      return this.reason === 'unsubscribed'
        ? Promise.resolve({ done: true, value: undefined })
        : Promise.reject(new FrameStreamEnded(this.reason));
    }
    // Bound retained read promises too. A pull consumer needs one pending read,
    // not an unbounded list of prefetch requests when the source is quiet.
    if (this.pending) return Promise.reject(new FrameReadPendingError());
    const next = this.queue.shift();
    if (next) {
      this.bytes -= next.bytes;
      return Promise.resolve({ done: false, value: next.frame });
    }
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
    });
  }

  return(): Promise<IteratorResult<string>> {
    this.close();
    return Promise.resolve({ done: true, value: undefined });
  }

  close(reason: 'unsubscribed' | 'revoked' = 'unsubscribed'): void {
    this.end(reason);
  }

  /** Called only by the source. No consumer code runs on the publisher stack. */
  offer(frame: string, bytes: number): boolean {
    if (this.reason) return false;
    if (this.pending) {
      const pending = this.pending;
      this.pending = undefined;
      pending.resolve({ done: false, value: frame });
      return true;
    }
    if (
      this.queue.length >= this.limits.maxQueuedFrames ||
      bytes > this.limits.maxQueuedBytes - this.bytes
    ) {
      this.end('overflow');
      return false;
    }
    this.queue.push({ frame, bytes });
    this.bytes += bytes;
    return true;
  }

  end(reason: FrameStreamEndReason): void {
    if (this.reason) return;
    this.reason = reason;
    this.queue.length = 0;
    this.bytes = 0;
    this.remove();
    this.resolveEnd(reason);
    const pending = this.pending;
    this.pending = undefined;
    if (pending) {
      if (reason === 'unsubscribed') pending.resolve({ done: true, value: undefined });
      else pending.reject(new FrameStreamEnded(reason));
    }
  }
}

export class FrameFanout {
  private readonly readers = new Set<FrameReader>();
  private readonly encoder = new TextEncoder();
  private readonly limits: Readonly<FrameFanoutLimits>;
  private closed = false;

  constructor(limits: FrameFanoutLimits) {
    for (const limit of [limits.maxSubscribers, limits.maxQueuedFrames, limits.maxQueuedBytes]) {
      if (!Number.isSafeInteger(limit) || limit <= 0) {
        throw new RangeError('Live frame limits must be positive safe integers');
      }
    }
    this.limits = { ...limits };
  }

  get subscriberCount(): number {
    return this.readers.size;
  }

  /** Live only. The host must arrange replay/snapshot plus captured live input. */
  subscribe(): FrameSubscription {
    if (this.closed) throw new FrameSubscribeRefusal('closed');
    if (this.readers.size >= this.limits.maxSubscribers) {
      throw new FrameSubscribeRefusal('capacity');
    }
    const reader = new FrameReader(this.limits, () => this.readers.delete(reader));
    this.readers.add(reader);
    return reader;
  }

  /**
   * Synchronous local delivery, NOT a durable receipt or cursor acknowledgment.
   * Each subscriber gets the same immutable encoded frame. A lagging view ends
   * explicitly; no listener callback, I/O, or consumer promise is awaited here.
   *
   * An individually oversized frame is refused for EVERY reader, even a reader
   * waiting in next(). The host must handle that refusal, not pretend delivery.
   * Returned frames belong to the consumer: its in-flight writes need separate
   * bounds. These limits cover the queued frames retained by this primitive.
   */
  publish(frame: string): FramePublishResult {
    if (this.closed) return { outcome: 'closed' };
    if (typeof frame !== 'string') throw new TypeError('A live frame must be an encoded string');
    // UTF-8 needs at least one byte per UTF-16 code unit. Refuse obvious
    // oversize before allocating the encoder's byte array.
    if (frame.length > this.limits.maxQueuedBytes) return { outcome: 'too_large' };
    const bytes = this.encoder.encode(frame).byteLength;
    if (bytes > this.limits.maxQueuedBytes) return { outcome: 'too_large' };
    let readers = 0;
    let overflowed = 0;
    for (const reader of this.readers) {
      if (reader.offer(frame, bytes)) readers += 1;
      else overflowed += 1;
    }
    return { outcome: 'published', readers, overflowed };
  }

  /**
   * Failure/teardown only: discards backlog, with no drain, and fails all readers.
   * Keep the fanout open across normal turns; completion comes from the host's
   * durable record, never from closing this source.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const reader of this.readers) reader.end('source_closed');
  }
}
