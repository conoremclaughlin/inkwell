/**
 * The message watcher behind `ink wait`: one thread, the inbox, and the opt-in
 * pending-trigger queue.
 *
 * Two modes share one loop. One-shot (the default) exits on the first batch.
 * Follow (`--follow`) emits every batch and keeps going until it is cancelled
 * or reaches a deadline the caller configured. Follow mode writes nothing but
 * batches to stdout, so each stdout line is an event a stream consumer can act
 * on; progress and diagnostics go to stderr.
 *
 * The tool transport, the clock and the output streams are injected so the
 * cursor and timing rules can be driven by a fake transport and a virtual
 * clock in tests.
 */

export type WaitToolCall = (
  tool: string,
  args: Record<string, unknown>
) => Promise<Record<string, unknown>>;

export interface WaitClock {
  now(): number;
  /** Resolves after `ms`, or as soon as `signal` aborts. Never rejects. */
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  /**
   * Like sleep, but runs alongside whatever else the watcher is waiting on:
   * the deadline uses it to end a call that is still in flight.
   */
  timer(ms: number, signal: AbortSignal): Promise<void>;
  /** Jitter source in [0, 1). */
  random(): number;
}

export interface WaitOutput {
  /** One batch of new messages, written as a unit. */
  batch(lines: string[]): void;
  /** Progress and diagnostics: stdout in one-shot mode, stderr in follow mode. */
  status(line: string): void;
  /** The terminal timeout report. */
  error(line: string): void;
}

export interface MessageWaitOptions {
  email: string;
  sbSlug: string;
  threadKey?: string;
  pending: boolean;
  follow: boolean;
  /** Overall deadline. Undefined means no deadline, which only follow mode allows. */
  timeoutSec?: number;
  intervalSec: number;
}

export interface MessageWaitDeps {
  call: WaitToolCall;
  clock: WaitClock;
  output: WaitOutput;
  /** Aborted with the signal name ('SIGINT' / 'SIGTERM') on cancellation. */
  signal: AbortSignal;
}

/** Page size for draining a thread or the legacy inbox past the cursor. */
export const WAIT_PAGE_SIZE = 50;
/** The largest page the server serves: how far a page grows to get past a tie. */
export const WAIT_MAX_PAGE_SIZE = 200;
/** Pages drained per poll before the rest is left for the next one. */
const MAX_PAGES_PER_POLL = 20;

/** Conventional shell status for a process ended by a signal: 128 + signo. */
export function exitCodeForSignal(reason: unknown): number {
  return reason === 'SIGTERM' ? 143 : 130;
}

interface WatchSource {
  /** Record where "new" starts. Throws when that could not be established. */
  baseline(): Promise<void>;
  /** The lines of one batch covering everything new since the last poll; [] when nothing arrived. */
  poll(): Promise<string[]>;
}

type Row = Record<string, unknown>;

/**
 * Where a drain stands: the newest timestamp read, and the ids read at or
 * just below it.
 *
 * The server's floors are strict (`created_at > floor`, for a thread's
 * `newerThan` and `afterMessageId` and for the inbox's `since`), and a thread
 * page is ordered by `created_at` alone. A cursor on the newest message read
 * therefore skips every other message sharing its timestamp, and rows written
 * in one transaction all share it. So each read starts one millisecond before
 * the newest timestamp seen, which the ids already read are filtered against.
 * Timestamps are compared as instants, never as strings: the server writes
 * microseconds and `+00:00` where a Date writes milliseconds and `Z`.
 */
interface DrainTail {
  boundary?: string;
  seen: Map<string, number>;
}

/** A page past `floor` (exclusive), oldest first, or undefined when there is nothing to read. */
type PageReader = (floor: string | undefined, limit: number) => Promise<Row[] | undefined>;

const emptyTail = (): DrainTail => ({ seen: new Map() });

function instantOf(row: Row): number {
  return Date.parse(String(row.createdAt));
}

/** One millisecond before `at`: an inclusive floor for a strict `created_at >`. */
function inclusiveFloor(at: string): string {
  return new Date(Date.parse(at) - 1).toISOString();
}

/** Record `rows` as read, moving the boundary to the newest of them. */
function absorb(tail: DrainTail, rows: Row[]): Row[] {
  const unseen: Row[] = [];
  for (const row of rows) {
    const id = String(row.id);
    if (tail.seen.has(id)) continue;
    tail.seen.set(id, instantOf(row));
    unseen.push(row);
    const at = stringOf(row.createdAt);
    if (at && (!tail.boundary || Date.parse(at) >= Date.parse(tail.boundary))) tail.boundary = at;
  }
  return unseen;
}

/**
 * Everything past `tail`, oldest first. Works on a copy, returned with the
 * rows: a read that fails midway leaves the caller's tail where it was, so
 * the next poll reads those pages again rather than skipping them.
 */
async function drainPast(
  from: DrainTail,
  read: PageReader,
  warn: (line: string) => void
): Promise<{ fresh: Row[]; tail: DrainTail }> {
  const tail: DrainTail = { boundary: from.boundary, seen: new Map(from.seen) };
  const fresh: Row[] = [];
  let limit = WAIT_PAGE_SIZE;
  for (let page = 0; page < MAX_PAGES_PER_POLL; page++) {
    const rows = await read(tail.boundary ? inclusiveFloor(tail.boundary) : undefined, limit);
    if (!rows) break;
    const unseen = absorb(tail, rows);
    fresh.push(...unseen);
    if (rows.length < limit) break;
    if (unseen.length === 0) {
      // A full page of rows already read: a tie group at least a page long
      // sits on the boundary. One larger page gets past it.
      if (limit < WAIT_MAX_PAGE_SIZE) {
        limit = WAIT_MAX_PAGE_SIZE;
        continue;
      }
      warn(
        `[ink wait] More than ${WAIT_MAX_PAGE_SIZE} messages share one timestamp; any past that page are not reported.`
      );
      break;
    }
    limit = WAIT_PAGE_SIZE;
  }
  // Only ids the next read can return again are worth remembering.
  if (tail.boundary) {
    const keepFrom = Date.parse(tail.boundary) - 1;
    for (const [id, at] of tail.seen) if (at < keepFrom) tail.seen.delete(id);
  }
  fresh.sort((a, b) => instantOf(a) - instantOf(b));
  return { fresh, tail };
}

export async function watchMessages(
  opts: MessageWaitOptions,
  deps: MessageWaitDeps
): Promise<number> {
  const { clock, output, signal } = deps;
  const deadline =
    opts.timeoutSec === undefined ? Number.POSITIVE_INFINITY : clock.now() + opts.timeoutSec * 1000;
  // The deadline bounds everything, a call in flight included: a read that
  // hangs would otherwise hold the watcher until the transport's own timeout,
  // five minutes past a 30s deadline.
  const expired = new AbortController();
  const stopTimer = new AbortController();
  if (Number.isFinite(deadline)) {
    void clock.timer(deadline - clock.now(), stopTimer.signal).then(() => {
      if (!stopTimer.signal.aborted) expired.abort('deadline');
    });
  }
  const stopped = AbortSignal.any([signal, expired.signal]);
  // A call still in flight at cancellation or at the deadline is abandoned,
  // not awaited: Ctrl-C must not sit out a 30s fetch timeout.
  const call: WaitToolCall = (tool, args) => untilAborted(deps.call(tool, args), stopped);
  try {
    return await watchUntilStopped(opts, deps, call, deadline, stopped);
  } finally {
    stopTimer.abort();
  }
}

async function watchUntilStopped(
  opts: MessageWaitOptions,
  deps: MessageWaitDeps,
  call: WaitToolCall,
  deadline: number,
  stopped: AbortSignal
): Promise<number> {
  const { clock, output, signal } = deps;

  const source: WatchSource = opts.threadKey
    ? new ThreadWatch(call, opts, opts.threadKey, output)
    : opts.follow
      ? new InboxActivityWatch(call, opts, output)
      : new InboxCountWatch(call, opts, output);
  const pending = opts.pending
    ? new PendingWatch(call, new Date(clock.now()).toISOString())
    : undefined;

  const timing = opts.follow
    ? `follow, ${opts.timeoutSec === undefined ? 'no deadline' : `deadline: ${opts.timeoutSec}s`}, interval: ${opts.intervalSec}s`
    : `timeout: ${opts.timeoutSec}s, interval: ${opts.intervalSec}s`;
  output.status(
    `[ink wait] Watching ${opts.threadKey ? `thread ${opts.threadKey}` : 'inbox'} for ${opts.sbSlug} (${timing})`
  );

  // Exponential backoff on consecutive errors. This stops `ink wait` from
  // hammering the server when it's brownouting (the 2026-04-19 incident:
  // background waits retried every 15s through a 503 storm and helped fill
  // Docker's disk with Kong error logs). Never shorter than the interval, so
  // an error can only slow the watcher down.
  const intervalMs = opts.intervalSec * 1000;
  const maxBackoffMs = Math.max(opts.intervalSec, 120) * 1000;
  let consecutiveErrors = 0;
  let lastError = { kind: '', message: '' };
  let lastPendingError = '';
  let baselined = false;
  let batches = 0;

  const emit = (lines: string[]): boolean => {
    output.batch(lines);
    batches += 1;
    return !opts.follow;
  };

  for (;;) {
    if (!baselined) {
      // A baseline that failed is retried, never assumed empty: an empty
      // baseline would report everything already there as new.
      try {
        await source.baseline();
        baselined = true;
        consecutiveErrors = 0;
      } catch (error) {
        if (stopped.aborted) break;
        consecutiveErrors += 1;
        lastError = { kind: 'Baseline error', message: messageOf(error) };
      }
    } else {
      // The pending queue is checked on its own: its failure must not stop
      // the thread or inbox watch from running.
      if (pending) {
        try {
          const lines = await pending.poll();
          lastPendingError = '';
          if (lines.length > 0) {
            const done = emit(lines);
            await pending.acknowledge();
            if (done) return 0;
          }
        } catch (error) {
          if (stopped.aborted) break;
          const text = messageOf(error);
          if (text !== lastPendingError) {
            output.status(`[ink wait] --pending check failed: ${text.slice(0, 200)}`);
            lastPendingError = text;
          }
        }
      }

      try {
        const lines = await source.poll();
        consecutiveErrors = 0;
        if (lines.length > 0) {
          if (emit(lines)) return 0;
        } else if (!opts.follow) {
          output.status('[ink wait] No new messages yet...');
        }
      } catch (error) {
        if (stopped.aborted) break;
        consecutiveErrors += 1;
        lastError = { kind: 'Poll error', message: messageOf(error) };
      }
    }

    if (stopped.aborted) break;
    const remaining = deadline - clock.now();
    if (remaining <= 0) break;

    let sleepMs = intervalMs;
    if (consecutiveErrors > 0) {
      const exponential = Math.min(maxBackoffMs, intervalMs * 2 ** Math.min(consecutiveErrors, 6));
      sleepMs = Math.max(intervalMs, exponential * (0.5 + clock.random() * 0.5)); // 50–100% jitter
      output.status(
        `[ink wait] ${lastError.kind} #${consecutiveErrors} (next retry in ~${Math.round(sleepMs / 1000)}s): ${lastError.message.slice(0, 100)}`
      );
    }
    await clock.sleep(Math.min(sleepMs, remaining), stopped);
    // A sleep clamped to the deadline ends at it; the watch ends there too,
    // rather than starting one more poll that the deadline has already passed.
    if (stopped.aborted || clock.now() >= deadline) break;
  }

  if (signal.aborted) {
    output.status(`[ink wait] Stopped by ${String(signal.reason)}.`);
    return exitCodeForSignal(signal.reason);
  }
  if (batches > 0) {
    output.status(
      `[ink wait] Deadline of ${opts.timeoutSec}s reached; ${batches} batch(es) delivered.`
    );
    return 0;
  }
  output.error(`[ink wait] Timed out after ${opts.timeoutSec}s with no new messages.`);
  return 1;
}

/**
 * A read position in one thread, tie-safe (see DrainTail). The position is
 * the newest message read from anyone, so the watcher's own messages move it
 * forward without being reported. `fullHistory` keeps each read independent
 * of the read pointer: push-channel delivery marks threads read, and a
 * watcher that fell back to the pointer baselined on 0 messages and then
 * raced the push pipeline on every poll (the pr:404/pr:408 watchers timed out
 * through live replies).
 */
class ThreadCursor {
  private tail: DrainTail = emptyTail();

  constructor(
    private readonly call: WaitToolCall,
    private readonly opts: MessageWaitOptions,
    readonly threadKey: string,
    private readonly warn: (line: string) => void
  ) {}

  private args(extra: Record<string, unknown>): Record<string, unknown> {
    return {
      email: this.opts.email,
      sbSlug: this.opts.sbSlug,
      threadKey: this.threadKey,
      markRead: false,
      ...extra,
    };
  }

  private readonly readPage: PageReader = async (floor, limit) => {
    const extra: Record<string, unknown> = { fullHistory: true, limit };
    if (floor) extra.newerThan = floor;
    const result = await this.call('get_thread_messages', this.args(extra));
    if (threadAbsent(result)) return undefined;
    requireSuccess(result, 'get_thread_messages');
    return rowsOf(result.messages);
  };

  /**
   * Anchor at the thread's current end, so nothing already there is new:
   * the newest message and every message sharing its timestamp. Returns the
   * thread's length, or the server's reason when the thread is absent.
   */
  async anchorAtEnd(): Promise<{ total: number; anchor?: string } | { absent: string }> {
    const end = await this.readEnd();
    if ('absent' in end) return end;
    this.tail = end.tail;
    return { total: end.total, anchor: end.anchor };
  }

  /** The position at the thread's current end, without taking it. */
  private async readEnd(): Promise<
    { tail: DrainTail; total: number; anchor?: string } | { absent: string }
  > {
    // latestN returns the newest message, so the anchor is the true end of
    // the thread however long it is. `limit: 200` is what a server predating
    // latestN falls back to: the anchor lands on message #200, as it used to.
    const result = await this.call(
      'get_thread_messages',
      this.args({ fullHistory: true, latestN: 1, limit: WAIT_MAX_PAGE_SIZE })
    );
    if (threadAbsent(result)) return { absent: String(result.error) };
    requireSuccess(result, 'get_thread_messages');
    const messages = rowsOf(result.messages);
    const total = messages.length + (Number(result.skippedOlderCount) || 0);
    const newest = messages[messages.length - 1];
    const tail = emptyTail();
    absorb(tail, messages.slice(-1));
    if (tail.boundary) {
      absorb(tail, (await this.readPage(inclusiveFloor(tail.boundary), WAIT_MAX_PAGE_SIZE)) ?? []);
    }
    return { tail, total, anchor: newest ? String(newest.id) : undefined };
  }

  /**
   * For a thread first seen after the baseline: it had nothing unread then,
   * so everything past its read pointer arrived since. Reads that, then
   * drains on from its newest message.
   *
   * Another session can read the thread between the inbox listing it and
   * this read, and then nothing past the pointer is left. That read gives no
   * position to start from. An empty position would read the thread's whole
   * history as new on its next arrival, and anchoring at the thread's end
   * would swallow a reply landing between this read and the anchor (Lumen,
   * #702 r2). So `keep` is false: the thread is not registered yet, and the
   * next poll that lists it reads from its pointer again. The same goes for
   * a thread that is gone.
   */
  async readFromPointer(): Promise<{ fresh: Row[]; commit: () => void; keep: boolean }> {
    const result = await this.call('get_thread_messages', this.args({ limit: WAIT_PAGE_SIZE }));
    if (threadAbsent(result)) return { fresh: [], commit: () => {}, keep: false };
    requireSuccess(result, 'get_thread_messages');
    const rows = rowsOf(result.messages);
    if (rows.length === 0) return { fresh: [], commit: () => {}, keep: false };
    const start = emptyTail();
    const first = absorb(start, rows);
    if (rows.length < WAIT_PAGE_SIZE) {
      return { fresh: first, commit: () => (this.tail = start), keep: true };
    }
    const { fresh, tail } = await drainPast(start, this.readPage, this.warn);
    return { fresh: [...first, ...fresh], commit: () => (this.tail = tail), keep: true };
  }

  /** Everything past the position, oldest first; applied only by `commit`. */
  async drain(): Promise<{ fresh: Row[]; commit: () => void }> {
    const { fresh, tail } = await drainPast(this.tail, this.readPage, this.warn);
    return { fresh, commit: () => (this.tail = tail) };
  }
}

/** One thread. */
class ThreadWatch implements WatchSource {
  private readonly cursor: ThreadCursor;

  constructor(
    call: WaitToolCall,
    private readonly opts: MessageWaitOptions,
    private readonly threadKey: string,
    private readonly output: WaitOutput
  ) {
    this.cursor = new ThreadCursor(call, opts, threadKey, (line) => output.status(line));
  }

  async baseline(): Promise<void> {
    const anchored = await this.cursor.anchorAtEnd();
    if ('absent' in anchored) {
      this.output.status(
        `[ink wait] Baseline: ${anchored.absent} (watching from its first message)`
      );
      return;
    }
    this.output.status(
      `[ink wait] Baseline: ${anchored.total} messages in thread${anchored.anchor ? ` (anchor: ${anchored.anchor.slice(0, 8)})` : ''}`
    );
  }

  async poll(): Promise<string[]> {
    // Applied only once every page has landed. A failure mid-drain leaves the
    // position where the last complete poll put it, so the next poll reads
    // those pages again rather than skipping them.
    const { fresh, commit } = await this.cursor.drain();
    commit();
    const fromOthers = fresh.filter((m) => m.senderSlug !== this.opts.sbSlug);
    if (fromOthers.length === 0) return [];
    return [
      `[ink wait] ${fromOthers.length} new message(s) on ${this.threadKey}`,
      ...fromOthers.map((m) => `  from ${senderOf(m)}: ${preview(m.content, 200)}`),
    ];
  }
}

/**
 * The inbox, one-shot: exits when the unread total rises above the baseline.
 * A count is enough for "has anything arrived", which is all one-shot asks.
 */
class InboxCountWatch implements WatchSource {
  private baselineCount = 0;

  constructor(
    private readonly call: WaitToolCall,
    private readonly opts: MessageWaitOptions,
    private readonly output: WaitOutput
  ) {}

  private read(limit: number): Promise<Record<string, unknown>> {
    return this.call('get_inbox', {
      email: this.opts.email,
      sbSlug: this.opts.sbSlug,
      status: 'unread',
      limit,
      // A watcher has no drain authority (spec inkmail-read-state §7): it
      // observes on someone else's behalf and never renders anything into
      // agent context. Before this flag, every poll advanced the pointer past
      // the newest unread message, so merely watching for a reply marked the
      // whole inbox read.
      markRead: false,
    });
  }

  async baseline(): Promise<void> {
    const result = await this.read(1);
    requireSuccess(result, 'get_inbox');
    this.baselineCount = unreadTotal(result);
    this.output.status(`[ink wait] Baseline: ${this.baselineCount} unread`);
  }

  async poll(): Promise<string[]> {
    const result = await this.read(5);
    requireSuccess(result, 'get_inbox');
    const current = unreadTotal(result);
    if (current <= this.baselineCount) return [];
    return [
      `[ink wait] ${current - this.baselineCount} new unread message(s)`,
      ...rowsOf(result.messages)
        .slice(0, 3)
        .map((m) => `  inbox: from ${senderOf(m)}: ${preview(m.content, 150)}`),
      ...rowsOf(result.threadsWithUnread)
        .slice(0, 3)
        .map((t) => `  thread ${String(t.threadKey)}: ${String(t.unreadCount)} unread`),
    ];
  }
}

/**
 * The inbox, followed. A running count cannot carry a cursor: a message read
 * and a message arriving inside one interval cancel out, and the arrival is
 * never reported. This keeps read positions instead: one over legacy inbox
 * messages, and one per thread. All of them are server timestamps compared
 * with each other, never with the local clock.
 *
 * A thread's inbox summary says only that it has unread messages. Its count
 * includes the watcher's own posts to itself, and its preview is the newest
 * three messages, so neither can say what arrived from others: three posts
 * of the watcher's own hid a reply under them, and one of them re-surfaced a
 * reply read long ago (Lumen, #702). A listed thread is read instead, from
 * its own position.
 *
 * Like one-shot inbox mode it reports what is still unread when it polls; a
 * message another path delivered and marked read first is not reported. The
 * inbox lists at most 20 unread threads (`unreadThreadsTruncated`), so a
 * thread past that page is read once it comes onto it.
 */
class InboxActivityWatch implements WatchSource {
  private legacy: DrainTail = emptyTail();
  private readonly threads = new Map<string, ThreadCursor>();

  constructor(
    private readonly call: WaitToolCall,
    private readonly opts: MessageWaitOptions,
    private readonly output: WaitOutput
  ) {}

  private read(extra: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.call('get_inbox', {
      email: this.opts.email,
      sbSlug: this.opts.sbSlug,
      markRead: false, // observe only, as in InboxCountWatch
      ...extra,
    });
  }

  private cursorFor(threadKey: string): ThreadCursor {
    return new ThreadCursor(this.call, this.opts, threadKey, (line) => this.output.status(line));
  }

  async baseline(): Promise<void> {
    // status 'all' selects newest-first, so this is the newest legacy message
    // whether or not it has been read, then everything sharing its timestamp.
    const result = await this.read({ status: 'all', limit: 1 });
    requireSuccess(result, 'get_inbox');
    const legacy = emptyTail();
    absorb(legacy, rowsOf(result.messages).slice(0, 1));
    if (legacy.boundary) {
      const ties = await this.read({
        status: 'all',
        since: inclusiveFloor(legacy.boundary),
        limit: WAIT_MAX_PAGE_SIZE,
      });
      requireSuccess(ties, 'get_inbox');
      absorb(legacy, rowsOf(ties.messages));
    }
    // A thread with unread messages now is anchored at its end: what it
    // already holds is backlog, not arrival.
    const threads = new Map<string, ThreadCursor>();
    for (const thread of rowsOf(result.threadsWithUnread)) {
      const cursor = this.cursorFor(String(thread.threadKey));
      await cursor.anchorAtEnd();
      threads.set(cursor.threadKey, cursor);
    }
    this.legacy = legacy;
    for (const [key, cursor] of threads) this.threads.set(key, cursor);
    this.output.status(`[ink wait] Baseline: ${unreadTotal(result)} unread`);
  }

  async poll(): Promise<string[]> {
    let listed: Row[] | undefined;
    // status 'unread' selects oldest-first, so `since` pages forward.
    const readLegacy: PageReader = async (floor, limit) => {
      const extra: Record<string, unknown> = { status: 'unread', limit };
      if (floor) extra.since = floor;
      const result = await this.read(extra);
      requireSuccess(result, 'get_inbox');
      listed ??= rowsOf(result.threadsWithUnread);
      return rowsOf(result.messages);
    };
    const legacy = await drainPast(this.legacy, readLegacy, (line) => this.output.status(line));

    const active: Array<{ threadKey: string; unreadCount: unknown; fromOthers: Row[] }> = [];
    const commits: Array<() => void> = [];
    const discovered: ThreadCursor[] = [];
    for (const thread of listed ?? []) {
      const threadKey = String(thread.threadKey);
      let cursor = this.threads.get(threadKey);
      let read: { fresh: Row[]; commit: () => void };
      if (cursor) {
        read = await cursor.drain();
      } else {
        cursor = this.cursorFor(threadKey);
        const first = await cursor.readFromPointer();
        read = first;
        if (first.keep) discovered.push(cursor);
      }
      commits.push(read.commit);
      const fromOthers = read.fresh.filter((m) => m.senderSlug !== this.opts.sbSlug);
      if (fromOthers.length > 0) {
        active.push({ threadKey, unreadCount: thread.unreadCount, fromOthers });
      }
    }

    // Committed together, after every read succeeded.
    this.legacy = legacy.tail;
    for (const commit of commits) commit();
    for (const cursor of discovered) this.threads.set(cursor.threadKey, cursor);

    const inbox = legacy.fresh.filter((m) => m.senderSlug !== this.opts.sbSlug);
    if (inbox.length === 0 && active.length === 0) return [];

    const lines = [
      `[ink wait] New unread: ${inbox.length} inbox message(s), ${active.length} thread(s) with new activity`,
    ];
    for (const m of inbox) {
      lines.push(`  inbox: from ${senderOf(m)}: ${preview(m.content, 150)}`);
    }
    for (const thread of active) {
      lines.push(`  thread ${thread.threadKey}: ${String(thread.unreadCount)} unread`);
      for (const m of thread.fromOthers) {
        lines.push(`    from ${senderOf(m)}: ${preview(m.content, 150)}`);
      }
    }
    return lines;
  }
}

/**
 * The pending-trigger queue. The server returns entries it has already marked
 * read, so follow mode remembers what it reported rather than trusting the
 * mark to hide them.
 */
class PendingWatch {
  private readonly reported = new Set<string>();
  private unacknowledged: string[] = [];

  constructor(
    private readonly call: WaitToolCall,
    private readonly startedAt: string
  ) {}

  async poll(): Promise<string[]> {
    const result = await this.call('get_pending_messages', {
      channel: 'agent',
      limit: 5,
      since: this.startedAt,
    });
    requireSuccess(result, 'get_pending_messages');
    // Filter to messages created after we started waiting.
    const fresh = rowsOf(result.messages).filter((m) => {
      const ts = stringOf(m.timestamp);
      const id = stringOf(m.id);
      return (!ts || ts >= this.startedAt) && !(id && this.reported.has(id));
    });
    if (fresh.length === 0) return [];
    this.unacknowledged = fresh.map((m) => stringOf(m.id)).filter((id): id is string => !!id);
    for (const id of this.unacknowledged) this.reported.add(id);
    return [
      `[ink wait] ${fresh.length} pending trigger message(s) found`,
      ...fresh.map((m) => {
        const sender =
          typeof m.sender === 'object' && m.sender !== null
            ? (m.sender as Row).id || 'unknown'
            : m.sender || 'unknown';
        return `  from ${String(sender)}: ${preview(m.content, 200)}`;
      }),
    ];
  }

  /** Mark the last batch read so the next `ink wait` doesn't re-trigger on it. */
  async acknowledge(): Promise<void> {
    const ids = this.unacknowledged;
    this.unacknowledged = [];
    if (ids.length > 0) {
      await this.call('mark_messages_read', { messageIds: ids }).catch(() => {});
    }
  }
}

// ── helpers ──

function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('cancelled'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error('cancelled'));
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      }
    );
  });
}

/**
 * A thread that does not exist yet, or that this SB has not joined, is a
 * thread to watch for. Any other `success: false` is a failed read: the
 * server returns a thrown handler error in the same envelope.
 */
function threadAbsent(result: Record<string, unknown>): boolean {
  return (
    result.success === false && /not found|not a participant/i.test(String(result.error ?? ''))
  );
}

function requireSuccess(result: Record<string, unknown>, tool: string): void {
  if (result.success === false) {
    throw new Error(typeof result.error === 'string' ? result.error : `${tool} failed`);
  }
}

function rowsOf(value: unknown): Row[] {
  return Array.isArray(value)
    ? value.filter((v): v is Row => typeof v === 'object' && v !== null)
    : [];
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function unreadTotal(result: Record<string, unknown>): number {
  return ((result.totalUnreadCount as number) ?? (result.unreadCount as number)) || 0;
}

function senderOf(message: Row): string {
  return String(message.senderSlug || 'unknown');
}

function preview(content: unknown, length: number): string {
  return typeof content === 'string' ? content.slice(0, length) : '';
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
