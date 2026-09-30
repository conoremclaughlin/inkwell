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

export async function watchMessages(
  opts: MessageWaitOptions,
  deps: MessageWaitDeps
): Promise<number> {
  const { clock, output, signal } = deps;
  // A call still in flight at cancellation is abandoned, not awaited: Ctrl-C
  // must not sit out a 30s fetch timeout.
  const call: WaitToolCall = (tool, args) => untilAborted(deps.call(tool, args), signal);

  const source: WatchSource = opts.threadKey
    ? new ThreadWatch(call, opts, opts.threadKey, output)
    : opts.follow
      ? new InboxActivityWatch(call, opts, output)
      : new InboxCountWatch(call, opts, output);
  const pending = opts.pending
    ? new PendingWatch(call, new Date(clock.now()).toISOString())
    : undefined;

  const deadline =
    opts.timeoutSec === undefined ? Number.POSITIVE_INFINITY : clock.now() + opts.timeoutSec * 1000;
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
        if (signal.aborted) break;
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
          if (signal.aborted) break;
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
        if (signal.aborted) break;
        consecutiveErrors += 1;
        lastError = { kind: 'Poll error', message: messageOf(error) };
      }
    }

    if (signal.aborted) break;
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
    await clock.sleep(Math.min(sleepMs, remaining), signal);
    if (signal.aborted) break;
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
 * One thread, cursor-based. The cursor is the newest message consumed from
 * anyone, so the watcher's own messages move it forward without being
 * reported. `fullHistory` keeps every read independent of the read pointer:
 * push-channel delivery marks threads read, and a watcher that fell back to
 * the pointer baselined on 0 messages and then raced the push pipeline on
 * every poll (the pr:404/pr:408 watchers timed out through live replies).
 */
class ThreadWatch implements WatchSource {
  private cursor: { id: string; createdAt?: string } | undefined;

  constructor(
    private readonly call: WaitToolCall,
    private readonly opts: MessageWaitOptions,
    private readonly threadKey: string,
    private readonly output: WaitOutput
  ) {}

  private args(extra: Record<string, unknown>): Record<string, unknown> {
    return {
      email: this.opts.email,
      sbSlug: this.opts.sbSlug,
      threadKey: this.threadKey,
      markRead: false,
      fullHistory: true,
      ...extra,
    };
  }

  async baseline(): Promise<void> {
    // latestN returns the newest message, so the anchor is the true end of
    // the thread however long it is. `limit: 200` is what a server predating
    // latestN falls back to: the anchor lands on message #200, as it used to.
    const result = await this.call('get_thread_messages', this.args({ latestN: 1, limit: 200 }));
    if (threadAbsent(result)) {
      this.output.status(
        `[ink wait] Baseline: ${String(result.error)} (watching from its first message)`
      );
      return;
    }
    requireSuccess(result, 'get_thread_messages');
    const messages = rowsOf(result.messages);
    const newest = messages[messages.length - 1];
    this.cursor = newest ? cursorOf(newest) : undefined;
    const total = messages.length + (Number(result.skippedOlderCount) || 0);
    this.output.status(
      `[ink wait] Baseline: ${total} messages in thread${this.cursor ? ` (anchor: ${this.cursor.id.slice(0, 8)})` : ''}`
    );
  }

  async poll(): Promise<string[]> {
    let cursor = this.cursor;
    const fresh: Row[] = [];
    for (let page = 0; page < MAX_PAGES_PER_POLL; page++) {
      const extra: Record<string, unknown> = { limit: WAIT_PAGE_SIZE };
      if (cursor) {
        extra.afterMessageId = cursor.id;
        // The same floor by timestamp: if the cursor message is ever gone,
        // afterMessageId resolves to nothing and the read would restart at
        // the beginning of the thread.
        if (cursor.createdAt) extra.newerThan = cursor.createdAt;
      }
      const result = await this.call('get_thread_messages', this.args(extra));
      if (threadAbsent(result)) break;
      requireSuccess(result, 'get_thread_messages');
      const messages = rowsOf(result.messages);
      const last = messages[messages.length - 1];
      if (!last || String(last.id) === cursor?.id) break;
      fresh.push(...messages);
      cursor = cursorOf(last);
      if (messages.length < WAIT_PAGE_SIZE) break;
    }
    // Committed only once every page has landed. A failure mid-drain leaves
    // the cursor where the last complete poll put it, so the next poll reads
    // those pages again rather than skipping them.
    this.cursor = cursor;

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
 * never reported. This tracks what it has reported instead: a high-water
 * `createdAt` for legacy inbox messages, and per thread the newest message
 * from someone else. Both are server timestamps compared with each other,
 * never with the local clock.
 *
 * Like one-shot inbox mode it reports what is still unread when it polls; a
 * message another path delivered and marked read first is not reported.
 */
class InboxActivityWatch implements WatchSource {
  private legacyHighWater: string | undefined;
  private threadMarks = new Map<string, string>();

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

  async baseline(): Promise<void> {
    // status 'all' selects newest-first, so this is the newest legacy message
    // whether or not it has been read.
    const result = await this.read({ status: 'all', limit: 1 });
    requireSuccess(result, 'get_inbox');
    this.legacyHighWater = stringOf(rowsOf(result.messages)[0]?.createdAt);
    for (const thread of rowsOf(result.threadsWithUnread)) {
      const newest = newestFromOthers(thread, this.opts.sbSlug);
      if (newest) this.threadMarks.set(String(thread.threadKey), newest);
    }
    this.output.status(`[ink wait] Baseline: ${unreadTotal(result)} unread`);
  }

  async poll(): Promise<string[]> {
    let highWater = this.legacyHighWater;
    const fresh: Row[] = [];
    let threads: Row[] | undefined;
    for (let page = 0; page < MAX_PAGES_PER_POLL; page++) {
      // status 'unread' selects oldest-first, so `since` pages forward.
      const extra: Record<string, unknown> = { status: 'unread', limit: WAIT_PAGE_SIZE };
      if (highWater) extra.since = highWater;
      const result = await this.read(extra);
      requireSuccess(result, 'get_inbox');
      threads ??= rowsOf(result.threadsWithUnread);
      const messages = rowsOf(result.messages);
      const newer = messages.filter((m) => {
        const at = stringOf(m.createdAt);
        return at !== undefined && (highWater === undefined || at > highWater);
      });
      if (newer.length === 0) break;
      fresh.push(...newer);
      highWater = newer.map((m) => String(m.createdAt)).reduce((a, b) => (b > a ? b : a));
      if (messages.length < WAIT_PAGE_SIZE) break;
    }

    const marks = new Map(this.threadMarks);
    const active: Row[] = [];
    for (const thread of threads ?? []) {
      const newest = newestFromOthers(thread, this.opts.sbSlug);
      const key = String(thread.threadKey);
      const reported = marks.get(key);
      if (!newest || (reported !== undefined && newest <= reported)) continue;
      marks.set(key, newest);
      active.push(thread);
    }

    // Committed together, after every read succeeded.
    this.legacyHighWater = highWater;
    this.threadMarks = marks;

    const legacy = fresh
      .filter((m) => m.senderSlug !== this.opts.sbSlug)
      .sort((a, b) => (String(a.createdAt) < String(b.createdAt) ? -1 : 1));
    if (legacy.length === 0 && active.length === 0) return [];

    const lines = [
      `[ink wait] New unread: ${legacy.length} inbox message(s), ${active.length} thread(s) with new activity`,
    ];
    for (const m of legacy) {
      lines.push(`  inbox: from ${senderOf(m)}: ${preview(m.content, 150)}`);
    }
    for (const thread of active) {
      lines.push(`  thread ${String(thread.threadKey)}: ${String(thread.unreadCount)} unread`);
      const latest = latestFromOthers(thread, this.opts.sbSlug);
      if (latest) {
        lines.push(`    latest from ${senderOf(latest)}: ${preview(latest.content, 150)}`);
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

function cursorOf(message: Row): { id: string; createdAt?: string } {
  return { id: String(message.id), createdAt: stringOf(message.createdAt) };
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

/** The newest preview message from someone other than `sbSlug`. */
function latestFromOthers(thread: Row, sbSlug: string): Row | undefined {
  let latest: Row | undefined;
  for (const m of rowsOf(thread.previewMessages)) {
    const at = stringOf(m.createdAt);
    if (!at || m.senderSlug === sbSlug) continue;
    if (!latest || at > String(latest.createdAt)) latest = m;
  }
  return latest;
}

/**
 * When the thread's activity from others was last seen. Previews carry the
 * newest three messages, so three of the watcher's own posts landing on top
 * of someone else's reply inside one interval hide that reply.
 */
function newestFromOthers(thread: Row, sbSlug: string): string | undefined {
  return stringOf(latestFromOthers(thread, sbSlug)?.createdAt);
}
