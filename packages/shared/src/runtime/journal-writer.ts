import {
  canonicalJournalJson,
  freezeJournalEntry,
  JournalRecordError,
  type JournalEntry,
  type JournalIdentity,
  type JournalRecord,
} from './journal-record.js';

export type JournalProjection =
  | 'none'
  | 'recorded'
  | 'already_recorded'
  | 'contradiction'
  | 'needs_reconciler';
export interface JournalAppendRequest {
  readonly expectedCommittedEid: number;
  readonly entry: Readonly<JournalEntry>;
}
export interface JournalCommitReceipt {
  readonly outcome: 'committed' | 'already_committed';
  readonly entry: Readonly<JournalEntry>;
  /** Current store head, NOT necessarily the eid of an exact retry. */
  readonly committedEid: number;
  readonly projection: JournalProjection;
}
export type JournalFailureCode =
  | 'invalid_entry'
  | 'entry_too_large'
  | 'queue_capacity'
  | 'eid_exhausted'
  | 'append_failed'
  | 'invalid_receipt'
  | 'store_refused'
  | 'projection_held'
  | 'head_advanced';
export interface JournalHoldRequest extends JournalIdentity {
  reasonCode: JournalFailureCode;
}

/**
 * Host-owned port, bound to the holder capability OUTSIDE the record. The DB
 * implementation must authenticate every append/retry under canonical locks,
 * atomically insert+project+advance the head, and return the complete entry.
 * No separate projection call is allowed. A receipt is never a dispatch permit.
 */
export interface JournalStore {
  append(request: JournalAppendRequest): Promise<unknown>;
  /** Set-only conservative hold under the SAME authority, even at capacity. */
  hold(request: Readonly<JournalHoldRequest>): Promise<unknown>;
}
export interface JournalWriterOptions {
  identity: JournalIdentity;
  /** From an authenticated, incarnation-verified canonical header, never mtime. */
  committedEid: number;
  store: JournalStore;
  now(): string;
  maxEntryBytes: number;
  maxPendingEntries: number;
  maxPendingBytes: number;
}
export class JournalWriterFailure extends Error {
  constructor(readonly code: JournalFailureCode) {
    super(`Journal writer stopped: ${code}`);
    this.name = 'JournalWriterFailure';
  }
}
interface PendingEntry {
  snapshot: ReturnType<typeof freezeJournalEntry>;
  resolve(receipt: JournalCommitReceipt): void;
  reject(error: JournalWriterFailure): void;
}

/**
 * Bounded serialized D1 writer. Dark: no live caller, DB adapter or recovery
 * implementation. Unlike legacy SessionLog, only acknowledged eids escape.
 * After ANY failure it never writes again, retries automatically or falls back
 * to a file. A host must stop dispatch immediately when failure appears, and
 * must not release authority merely because the hold was acknowledged.
 */
export class JournalWriter {
  private readonly identity: Readonly<JournalIdentity>;
  private readonly store: JournalStore;
  private readonly now: () => string;
  private readonly limits: {
    maxEntryBytes: number;
    maxPendingEntries: number;
    maxPendingBytes: number;
  };
  private readonly queue: PendingEntry[] = [];
  private pendingCount = 0;
  private pendingSize = 0;
  private reserved: number;
  private committed: number;
  private stopped: JournalWriterFailure | undefined;
  private holdState: 'none' | 'pending' | 'confirmed' | 'unconfirmed' = 'none';
  private holdCompletion: Promise<void> | undefined;
  private draining: Promise<void> | undefined;
  private closed = false;

  constructor(options: JournalWriterOptions) {
    for (const limit of [
      options.maxEntryBytes,
      options.maxPendingEntries,
      options.maxPendingBytes,
    ]) {
      if (!Number.isSafeInteger(limit) || limit < 1)
        throw new RangeError('Journal limits must be positive safe integers');
    }
    if (!Number.isSafeInteger(options.committedEid) || options.committedEid < 0)
      throw new RangeError('Invalid committed journal cursor');
    if (
      !options.store ||
      typeof options.store.append !== 'function' ||
      typeof options.store.hold !== 'function' ||
      typeof options.now !== 'function'
    )
      throw new TypeError('Journal requires explicit store and clock');
    // Validate and detach identity before storing it. Extra fields are refused.
    const identity = JSON.parse(
      canonicalJournalJson(options.identity, options.maxEntryBytes)
    ) as JournalIdentity;
    if (
      Object.keys(identity).sort().join(',') !== 'hostInstanceId,journalId,sessionId,writerTenureId'
    )
      throw new JournalRecordError('invalid_entry');
    freezeJournalEntry(
      {
        ...identity,
        version: 1,
        eid: 1,
        ts: '2000-01-01T00:00:00.000Z',
        type: 'session_open',
        target: null,
        body: {},
      },
      options.maxEntryBytes
    );
    this.identity = Object.freeze(identity);
    this.store = options.store;
    this.now = options.now;
    this.limits = {
      maxEntryBytes: options.maxEntryBytes,
      maxPendingEntries: options.maxPendingEntries,
      maxPendingBytes: options.maxPendingBytes,
    };
    this.reserved = this.committed = options.committedEid;
  }

  get committedEid(): number {
    return this.committed;
  }
  get pendingEntries(): number {
    return this.pendingCount;
  }
  get pendingBytes(): number {
    return this.pendingSize;
  }
  get failure():
    | Readonly<{ code: JournalFailureCode; hold: 'none' | 'pending' | 'confirmed' | 'unconfirmed' }>
    | undefined {
    return this.stopped
      ? Object.freeze({ code: this.stopped.code, hold: this.holdState })
      : undefined;
  }

  append(record: JournalRecord): Promise<JournalCommitReceipt> {
    if (this.stopped) return this.rejected(this.stopped);
    if (this.closed) return this.rejected(new Error('Journal intake is closed'));
    let snapshot: ReturnType<typeof freezeJournalEntry>;
    try {
      if (this.reserved === Number.MAX_SAFE_INTEGER)
        throw new JournalWriterFailure('eid_exhausted');
      const data = JSON.parse(
        canonicalJournalJson(record, this.limits.maxEntryBytes)
      ) as JournalRecord;
      if (!data || Object.keys(data).sort().join(',') !== 'body,target,type')
        throw new JournalRecordError('invalid_entry');
      snapshot = freezeJournalEntry(
        {
          ...this.identity,
          version: 1,
          eid: this.reserved + 1,
          ts: this.now(),
          type: data.type,
          target: data.target,
          body: data.body,
        },
        this.limits.maxEntryBytes
      );
      if (
        this.pendingCount >= this.limits.maxPendingEntries ||
        snapshot.bytes > this.limits.maxPendingBytes - this.pendingSize
      )
        throw new JournalWriterFailure('queue_capacity');
    } catch (error) {
      const code =
        error instanceof JournalRecordError || error instanceof JournalWriterFailure
          ? error.code
          : 'invalid_entry';
      this.stop(code);
      return this.rejected(this.stopped!);
    }
    // Only validated, fully frozen, capacity-reserved entries receive an eid.
    this.reserved = snapshot.entry.eid;
    this.pendingCount++;
    this.pendingSize += snapshot.bytes;
    const result = new Promise<JournalCommitReceipt>((resolve, reject) => {
      this.queue.push({ snapshot, resolve, reject });
    });
    // Permit a host to attach its await at a later flush boundary without a
    // process-global unhandled rejection; the returned promise still rejects.
    void result.catch(() => undefined);
    this.startDrain();
    return result;
  }

  async flush(): Promise<void> {
    while (this.draining) await this.draining;
    if (this.holdCompletion) await this.holdCompletion;
    if (this.stopped) throw this.stopped;
  }

  /** Graceful intake closure, not owner release, cancellation or reconciliation. */
  async close(): Promise<void> {
    this.closed = true;
    await this.flush();
  }

  private rejected(error: Error): Promise<never> {
    const result = Promise.reject<never>(error);
    void result.catch(() => undefined);
    return result;
  }

  private startDrain(): void {
    if (this.draining || this.stopped) return;
    // Defer entering the host port until after queue/bookkeeping is complete.
    this.draining = Promise.resolve()
      .then(() => this.drain())
      .finally(() => {
        this.draining = undefined;
        if (this.queue.length && !this.stopped) this.startDrain();
      });
  }

  private async drain(): Promise<void> {
    while (this.queue.length && !this.stopped) {
      const pending = this.queue.shift()!;
      try {
        const request = Object.freeze({
          expectedCommittedEid: pending.snapshot.entry.eid - 1,
          entry: pending.snapshot.entry,
        });
        let reply: unknown;
        try {
          reply = await this.store.append(request);
        } catch {
          throw new JournalWriterFailure('append_failed');
        }
        const receipt = this.receipt(reply, pending.snapshot);
        // A concurrent local overflow may have stopped the writer while this
        // request was in flight. Its ACK is still evidence of this commit.
        this.committed = pending.snapshot.entry.eid;
        pending.resolve(receipt);
        if (receipt.projection === 'contradiction' || receipt.projection === 'needs_reconciler')
          this.stop('projection_held');
        else if (receipt.committedEid !== this.committed) this.stop('head_advanced');
      } catch (error) {
        this.stop(error instanceof JournalWriterFailure ? error.code : 'invalid_receipt');
        pending.reject(this.stopped!);
      } finally {
        this.pendingCount--;
        this.pendingSize -= pending.snapshot.bytes;
      }
    }
  }

  private receipt(
    reply: unknown,
    snapshot: ReturnType<typeof freezeJournalEntry>
  ): JournalCommitReceipt {
    // Bound the untrusted store response, including the full entry echo.
    const parsed = JSON.parse(
      canonicalJournalJson(reply, this.limits.maxEntryBytes + 2048)
    ) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new JournalWriterFailure('invalid_receipt');
    if (parsed.outcome === 'refused') throw new JournalWriterFailure('store_refused');
    if (
      Object.keys(parsed).sort().join(',') !== 'committedEid,entry,outcome,projection' ||
      !['committed', 'already_committed'].includes(parsed.outcome as string)
    )
      throw new JournalWriterFailure('invalid_receipt');
    const echoed = freezeJournalEntry(parsed.entry, this.limits.maxEntryBytes);
    if (
      echoed.json !== snapshot.json ||
      typeof parsed.committedEid !== 'number' ||
      !Number.isSafeInteger(parsed.committedEid) ||
      parsed.committedEid < echoed.entry.eid
    )
      throw new JournalWriterFailure('invalid_receipt');
    if (parsed.outcome === 'committed' && parsed.committedEid !== echoed.entry.eid)
      throw new JournalWriterFailure('invalid_receipt');
    if (
      !['none', 'recorded', 'already_recorded', 'contradiction', 'needs_reconciler'].includes(
        parsed.projection as string
      )
    )
      throw new JournalWriterFailure('invalid_receipt');
    if (
      echoed.entry.type.startsWith('provider_spawn_')
        ? parsed.projection === 'none'
        : parsed.projection !== 'none'
    )
      throw new JournalWriterFailure('invalid_receipt');
    return Object.freeze({
      outcome: parsed.outcome,
      entry: echoed.entry,
      committedEid: parsed.committedEid,
      projection: parsed.projection,
    }) as JournalCommitReceipt;
  }

  private stop(code: JournalFailureCode): void {
    if (this.stopped) return;
    this.stopped = new JournalWriterFailure(code);
    this.holdState = 'pending';
    for (const pending of this.queue.splice(0)) {
      this.pendingCount--;
      this.pendingSize -= pending.snapshot.bytes;
      pending.reject(this.stopped);
    }
    const request = Object.freeze({ ...this.identity, reasonCode: code });
    this.holdCompletion = Promise.resolve()
      .then(() => this.store.hold(request))
      .then((reply) => {
        const json = canonicalJournalJson(reply, 2048);
        const expected = canonicalJournalJson({ outcome: 'held', ...request }, 2048);
        this.holdState = json === expected ? 'confirmed' : 'unconfirmed';
      })
      .catch(() => {
        this.holdState = 'unconfirmed';
      });
  }
}
