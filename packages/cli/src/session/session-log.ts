import { appendFileSync } from 'fs';
import { appendFile } from 'fs/promises';

/**
 * The observer projection (spec:observer-attach §4.1): ledger entry types that
 * are ALSO mirrored to live observers. Must stay in sync with
 * OBSERVER_PROJECTION_TYPES in the server's session-event-bus.ts. Every
 * projection append is mirrored from ONE place (SessionLog.append) so the live
 * view can never diverge from replay.
 */
export const OBS_PROJECTION_TYPES: ReadonlySet<string> = new Set([
  'user',
  'system_turn',
  'auto_turn',
  'assistant',
  'inbox',
  'backend_tool',
  'backend_text',
  'local_tool_call',
  'pcp_tool',
  'backend_session',
  'compaction',
  'session_pause',
  'session_end',
]);

/**
 * Where a session log's entries are persisted. `line` is one complete,
 * newline-terminated JSON entry.
 *
 * A synchronous sink reports failure by throwing, to the caller whose append
 * caused it. An asynchronous sink reports it by rejecting, after that caller
 * has moved on — which is why SessionLog serializes async writes and carries
 * their failure forward (see `append`).
 */
export interface SessionLogSink {
  write(line: string): void | Promise<void>;
}

/** Append each entry to a JSONL file, blocking until it is written. */
export function jsonlFileSink(path: string): SessionLogSink {
  return { write: (line) => appendFileSync(path, line) };
}

/**
 * Append each entry to a JSONL file without blocking the event loop. The file
 * must only be written through one SessionLog: concurrent appends to one path
 * are not ordered, and the log's serialization is what orders them.
 */
export function asyncJsonlFileSink(path: string): SessionLogSink {
  return { write: (line) => appendFile(path, line) };
}

export interface SessionLogOptions {
  /** The log's location: announced to the server, and read back on reattach. */
  path: string;
  /** Defaults to the synchronous JSONL file at `path`. */
  sink?: SessionLogSink;
  /**
   * Live mirror for projection entries. The entry it receives IS the appended
   * ledger entry, delivered only after its write succeeds; consumers must
   * preserve the eid and never mint their own.
   */
  onProjection?: (entry: Record<string, unknown>) => void;
}

const isPromiseLike = (value: unknown): value is PromiseLike<void> =>
  typeof (value as { then?: unknown } | null | undefined)?.then === 'function';

/**
 * One session's append-only event log (spec:live-agent-surfaces, SessionLog).
 *
 * Everything that orders and mirrors a session's events lives on its own
 * instance: the eid sequence, and the observer that receives projection
 * entries. These used to be module state in commands/chat.ts — an eid Map
 * keyed by path, and one process-wide emitter — so every log in the process
 * mirrored to whichever observer registered last. Shadow clones already put
 * several logs in one process; they stayed out of the parent's observer stream
 * only because none of their entry types is a projection type.
 */
export class SessionLog {
  readonly path: string;
  private readonly sink: SessionLogSink;
  private readonly onProjection?: (entry: Record<string, unknown>) => void;
  private lastEid = 0;
  /** Tail of the async write queue; undefined while nothing is in flight. */
  private pending: Promise<void> | undefined;
  /** The first async write failure. Once set, nothing more is written. */
  private failure: { error: unknown } | undefined;

  constructor(options: SessionLogOptions) {
    this.path = options.path;
    this.sink = options.sink ?? jsonlFileSink(options.path);
    this.onProjection = options.onProjection;
  }

  /**
   * Continue the eid sequence from an existing log (reattach). Never lowers it:
   * eids reference events across reattach (context_evict), so reusing one
   * would make two events answer to the same reference.
   */
  seed(maxSeen: number): void {
    if (maxSeen > this.lastEid) this.lastEid = maxSeen;
  }

  /**
   * Append an event and return its eid.
   *
   * The eid is assigned now, so callers can reference the entry before it is
   * durable. A synchronous sink writes before this returns, and a failed write
   * throws here, exactly as a direct appendFileSync did. An asynchronous sink's
   * writes are queued behind one another, so a slow write is never overtaken.
   * Its failure cannot reach the caller that caused it; it is kept, every later
   * `append` throws it, `flush` rejects with it, and entries still queued
   * behind it are not written. A silent gap in the log would be worse.
   *
   * Either way, a projection entry reaches the observer only once its own write
   * has succeeded, so an observer never sees an event that replay will not.
   */
  append(event: Record<string, unknown>): number {
    if (this.failure) throw this.failure.error;
    const eid = this.lastEid + 1;
    this.lastEid = eid;
    const entry: Record<string, unknown> = { ts: new Date().toISOString(), eid, ...event };
    const line = JSON.stringify(entry) + '\n';

    if (this.pending) {
      const previous = this.pending;
      this.enqueue(
        previous.then(() => {
          if (this.failure) throw this.failure.error;
          return this.sink.write(line);
        }),
        entry
      );
    } else {
      const written = this.sink.write(line);
      if (isPromiseLike(written)) this.enqueue(Promise.resolve(written), entry);
      else this.mirror(entry);
    }
    return entry.eid as number;
  }

  /** Resolves once every queued write has landed; rejects if any failed. */
  async flush(): Promise<void> {
    while (this.pending) await this.pending;
    if (this.failure) throw this.failure.error;
  }

  private enqueue(write: Promise<void>, entry: Record<string, unknown>): void {
    const settled: Promise<void> = write
      .then(
        () => this.mirror(entry),
        (error: unknown) => {
          this.failure ??= { error };
        }
      )
      .finally(() => {
        if (this.pending === settled) this.pending = undefined;
      });
    this.pending = settled;
  }

  private mirror(entry: Record<string, unknown>): void {
    if (!this.onProjection) return;
    if (typeof entry.type !== 'string' || !OBS_PROJECTION_TYPES.has(entry.type)) return;
    try {
      this.onProjection(entry);
    } catch {
      // The live mirror must never break the ledger write path.
    }
  }
}
