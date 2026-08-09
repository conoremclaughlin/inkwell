/**
 * Session Event Bus
 *
 * The fan-out layer for live session activity. Today, a server-spawned ink
 * worker (InkRunner) emits a tool-by-tool NDJSON stream on stdout as it churns
 * through a turn — but that stream dead-ends at the runner, consumed only for
 * the inactivity-timeout liveness signal. Nothing relays it to observers, so an
 * attached `ink chat` terminal (or the web dashboard) can't watch the work live.
 *
 * This bus is where the runner republishes each event, keyed by session id. Any
 * number of observers subscribe — the SSE endpoint streams a session's events to
 * an attached terminal; a future dashboard timeline subscribes to the firehose.
 * The bus is transport-agnostic and in-process: it does NOT persist anything and
 * is NOT a source of truth (the transcript + durable mailbox are). It is a
 * best-effort live tap. A subscriber that misses events (connected late, dropped)
 * recovers from the transcript, not from here.
 *
 * When execution eventually moves to a persistent per-session actor, the actor
 * publishes to this exact bus — the observation contract doesn't change.
 */

import { EventEmitter } from 'events';
import { createReadStream } from 'fs';
import { stat } from 'fs/promises';
import { createInterface } from 'readline';
import { isAbsolute, sep } from 'path';
import { logger } from '../../utils/logger.js';

/** A single live event about a session's turn (tool call, status, result, …). */
export interface SessionStreamEvent {
  /**
   * Process-unique, monotonic id. Lets a client de-dupe: the replay tail is
   * re-sent on every (re)connect, so a dropped/restored SSE connection would
   * otherwise render the same tool_call twice.
   */
  id: number;
  /** Session the event belongs to (pcpSessionId). */
  sessionId: string;
  /** ISO timestamp stamped at publish time. */
  ts: string;
  /** Event kind as emitted by the worker (e.g. 'tool_call', 'result', 'status'). */
  type: string;
  /** The raw event payload from the worker's NDJSON line. */
  data: Record<string, unknown>;
}

export type SessionStreamListener = (event: SessionStreamEvent) => void;

// ─── Observer attach (spec:observer-attach §4.3–4.4) ─────────────────────────
//
// Alongside the legacy best-effort live tap above, the bus carries a second,
// stronger channel: canonical ledger entries (`obs` lines from the ink
// runtime), keyed by the ledger's monotonic eid. For these, the ledger is the
// truth — observers attach with *replay after cursor, then follow*, and a
// subscriber that can't keep up is DISCONNECTED (never skipped ahead) so its
// view can never diverge from the ledger; it reconverges via durable replay.
//
// CONTRACT (v4, reconciled after Lumen's M4.2 re-review): the wire does NOT
// carry the raw appended ledger object. Every frame — live and replayed — is
// the deterministic SERVER-SIDE PROJECTION of that entry (projectObserverEntry:
// type allowlist + per-type field allowlist + preview truncation). The no-fork
// invariant is therefore: rendered stream ≡ projection(ledger), same eids and
// order; raw payloads and secrets structurally never cross the wire.

/**
 * A ledger entry keyed by the ledger's own eid. Used for BOTH the raw ingest
 * input (as appended by the runtime) and the projected frame observers
 * receive — projectObserverEntry maps the former onto the latter.
 */
export interface ObserverEntry {
  eid: number;
  ts: string;
  type: string;
  [key: string]: unknown;
}

export type ObserverSinkEndReason =
  | 'overflow'
  | 'session_released'
  | 'unsubscribed'
  | 'replay_failed'
  | 'sink_error';

/**
 * Delivery channel for an observer. `write` returns false when the transport
 * is backpressured; the bus's per-subscriber pump awaits `waitDrain` — the
 * PUBLISHER never does.
 */
export interface ObserverSink {
  write(entry: ObserverEntry): boolean;
  waitDrain(): Promise<void>;
  end(reason: ObserverSinkEndReason): void;
}

export interface ObserverSubscribeOptions {
  /** Exclusive cursor: replay begins at the first entry with eid > afterEid.
   *  Omitted → replay the in-memory ring only (default attach). */
  afterEid?: number;
  /** false → replay only, then end('unsubscribed'). Default true. */
  follow?: boolean;
  /**
   * Aborted when the transport closes. Checked inside the replay loops so a
   * vanished client CANCELS an in-progress disk replay instead of letting it
   * run to EOF while holding a subscriber slot (Lumen re-review, blocker 2).
   */
  signal?: AbortSignal;
}

/**
 * The observer projection (spec §4.1): ledger entry types observers may see.
 * Internal bookkeeping (hooks, eviction refs, delegation flows, permission
 * plumbing) is excluded — identically in replay and live. delegation_* stays
 * out per the credential sequencing rule (§4.7).
 */
export const OBSERVER_PROJECTION_TYPES: ReadonlySet<string> = new Set([
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

const truncateForWire = (value: unknown, max: number): string => {
  const text = String(value ?? '');
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1))}…`;
};

/**
 * Per-type field projection — THE security boundary for observer frames
 * (Lumen review of PR #455, blocker 1). Frames are CONSTRUCTED from an
 * allowlist of fields, never by deleting from the original, so unknown or
 * secret-bearing fields (tool args/results, rawContent, stderr,
 * delegationToken, …) structurally cannot cross the wire. Applied identically
 * at ingest and at ledger replay — both paths emit the same projected shape,
 * preserving the no-fork invariant.
 *
 * Returns null for non-projection types.
 */
export function projectObserverEntry(entry: ObserverEntry): ObserverEntry | null {
  if (typeof entry?.eid !== 'number' || typeof entry?.type !== 'string') return null;
  const base = { eid: entry.eid, ts: String(entry.ts ?? ''), type: entry.type };
  switch (entry.type) {
    case 'backend_tool':
      return {
        ...base,
        ...(entry.name !== undefined ? { name: String(entry.name) } : {}),
        ...(entry.status !== undefined ? { status: String(entry.status) } : {}),
        ...(entry.toolUseId !== undefined ? { toolUseId: String(entry.toolUseId) } : {}),
      };
    case 'backend_text':
      return { ...base, preview: truncateForWire(entry.preview, 200) };
    case 'local_tool_call':
    case 'pcp_tool':
      // Tool identity + status only — args and results NEVER cross the wire.
      return {
        ...base,
        ...(entry.tool !== undefined || entry.name !== undefined
          ? { tool: String(entry.tool ?? entry.name) }
          : {}),
        ...(entry.status !== undefined ? { status: String(entry.status) } : {}),
      };
    case 'user':
    case 'system_turn':
    case 'auto_turn':
    case 'assistant':
      return {
        ...base,
        content: truncateForWire(entry.content, 400),
        ...(entry.label !== undefined ? { label: String(entry.label) } : {}),
      };
    case 'inbox':
      // Sender + rendered preview only. delegationToken and raw payloads are
      // excluded by construction (spec §4.7 credential rule).
      return {
        ...base,
        ...(entry.sender !== undefined ? { sender: String(entry.sender) } : {}),
        ...(entry.subject !== undefined ? { subject: String(entry.subject) } : {}),
        preview: truncateForWire(entry.rendered ?? entry.content, 200),
      };
    case 'backend_session':
      return { ...base, ...(entry.id !== undefined ? { id: String(entry.id) } : {}) };
    case 'compaction':
      return { ...base, ...(entry.reason !== undefined ? { reason: String(entry.reason) } : {}) };
    case 'session_pause':
    case 'session_end':
      return base;
    default:
      return null;
  }
}

/**
 * What the durable locator store knows about a session. `hasHistory` is the
 * authoritative evidence the replay decision needs when the locator is
 * absent: whether the sessions row shows the session has EVER run (backend
 * session seeded, tokens or messages recorded). An in-memory `highWater === 0`
 * alone proves nothing — it is also 0 after eviction/restart (Lumen M4.3
 * re-review).
 */
export interface LedgerLocatorRecord {
  ledgerPath: string | null;
  hasHistory: boolean;
}

/**
 * Optional durable locator store (wired by the server to the dedicated
 * sessions.observer_ledger_path column). Keeps replay working across bus
 * eviction and process restarts without any new tables — the sessions row the
 * runtime already owns carries the path. `load` must THROW on store errors —
 * the bus propagates them as replay_failed rather than silently downgrading
 * to an empty replay.
 */
export interface LedgerLocatorStore {
  persist(sessionId: string, ledgerPath: string): Promise<void>;
  load(sessionId: string): Promise<LedgerLocatorRecord>;
}

const intFromEnv = (name: string, fallback: number): number => {
  const raw = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
};

export const OBS_RING_CAPACITY = intFromEnv('SESSION_EVENT_RING_SIZE', 1_000);
export const OBS_QUEUE_MAX_EVENTS = intFromEnv('SESSION_OBSERVE_QUEUE_EVENTS', 64);
export const OBS_QUEUE_MAX_BYTES = intFromEnv('SESSION_OBSERVE_QUEUE_BYTES', 256 * 1024);
export const OBS_MAX_SUBSCRIBERS = intFromEnv('SESSION_OBSERVE_MAX_SUBSCRIBERS', 8);
export const OBS_RETENTION_MS = intFromEnv('SESSION_OBSERVE_RETENTION_MS', 5 * 60_000);

interface ObserverSubscriber {
  sink: ObserverSink;
  /** Post-cutover delivery queue (count- and byte-capped). */
  queue: ObserverEntry[];
  queuedBytes: number;
  pumping: boolean;
  /** True from synchronous registration until the capture queue is drained. */
  replaying: boolean;
  /** Live entries arriving during replay. Same caps. */
  capture: ObserverEntry[];
  captureBytes: number;
  closed: boolean;
  /**
   * Monotonic delivery guard: only entries with eid > lastDeliveredEid are
   * written. Makes replay/capture/ring overlap idempotent by construction —
   * duplicates are impossible regardless of which path served an entry first.
   */
  lastDeliveredEid: number;
}

interface ObserverChannel {
  ledgerPath?: string;
  ring: ObserverEntry[];
  lastEid: number;
  subscribers: Set<ObserverSubscriber>;
  evictTimer?: NodeJS.Timeout;
}

const observerEntryBytes = (entry: ObserverEntry): number => JSON.stringify(entry).length;

/** Firehose channel name — subscribers here see every session's events. */
const FIREHOSE = '*';

/**
 * Per-session replay ring buffer. A terminal that attaches mid-turn should see
 * the tool calls that already ran this turn, not just future ones — so we keep a
 * small tail per session and hand it to new subscribers on connect.
 */
const REPLAY_PER_SESSION = 200;
/** Cap the number of sessions we retain buffers for; evict least-recently-active. */
const MAX_TRACKED_SESSIONS = 256;

export class SessionEventBus extends EventEmitter {
  /** sessionId -> recent events (bounded), for replay-on-subscribe. */
  private readonly replay = new Map<string, SessionStreamEvent[]>();
  /** Monotonic event id source (process-unique). */
  private nextId = 1;

  constructor() {
    super();
    // Many observers may attach across sessions; the default cap of 10 would
    // spam MaxListeners warnings. 0 = unlimited (we bound growth ourselves via
    // subscriber lifecycle + the session/replay caps).
    this.setMaxListeners(0);
  }

  /**
   * Drop a session's replay tail. InkRunner calls this at turn start AND at
   * turn end, which turn-scopes the buffer: attach mid-turn and you replay only
   * the in-flight turn's events (real live context); attach while idle and you
   * replay nothing, so a finished turn can never be re-rendered as if it were
   * happening now.
   */
  clearReplay(sessionId: string): void {
    if (!sessionId) return;
    this.replay.delete(sessionId);
  }

  /** Publish one live event for a session. Non-blocking, best-effort. */
  publish(sessionId: string, type: string, data: Record<string, unknown>): void {
    if (!sessionId) return;
    const event: SessionStreamEvent = {
      id: this.nextId++,
      sessionId,
      ts: new Date().toISOString(),
      type,
      data,
    };
    this.recordReplay(event);
    // Listeners are wrapped (see makeSafeListener) so one that throws is
    // isolated — it can't break the publisher OR sibling subscribers. Node's
    // emit() otherwise aborts at the first throwing listener.
    this.emit(sessionId, event);
    this.emit(FIREHOSE, event);
  }

  /**
   * Subscribe to one session's events. Immediately replays the recent tail (so a
   * mid-turn attach isn't blank), then streams new events. Returns an unsubscribe
   * function — call it on disconnect to avoid leaking listeners.
   */
  subscribe(
    sessionId: string,
    listener: SessionStreamListener,
    options: { replay?: boolean } = {}
  ): () => void {
    const safe = this.makeSafeListener(sessionId, listener);
    if (options.replay !== false) {
      for (const past of this.replay.get(sessionId) ?? []) {
        safe(past);
      }
    }
    this.on(sessionId, safe);
    return () => this.off(sessionId, safe);
  }

  /** Subscribe to every session's events (dashboard timeline, debugging). */
  subscribeAll(listener: SessionStreamListener): () => void {
    const safe = this.makeSafeListener(FIREHOSE, listener);
    this.on(FIREHOSE, safe);
    return () => this.off(FIREHOSE, safe);
  }

  /**
   * Wrap a subscriber so a thrown error is logged and swallowed rather than
   * aborting emit() (which would skip every later listener) or crashing the
   * publisher. The wrapper is the registered listener, so unsubscribe removes it.
   */
  private makeSafeListener(
    channel: string,
    listener: SessionStreamListener
  ): SessionStreamListener {
    return (event: SessionStreamEvent) => {
      try {
        listener(event);
      } catch (err) {
        logger.warn('session-event-bus listener threw', {
          channel,
          type: event.type,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    };
  }

  /** How many live subscribers a session currently has (for tests/introspection). */
  subscriberCount(sessionId: string): number {
    return this.listenerCount(sessionId);
  }

  // ─── Observer attach (canonical obs entries, ledger-eid keyed) ────────────

  /** sessionId -> observer channel state. Separate from the legacy replay tap. */
  private readonly obsChannels = new Map<string, ObserverChannel>();

  /** Durable locator store — wired once at server init (session metadata). */
  private locatorStore: LedgerLocatorStore | null = null;

  setLocatorStore(store: LedgerLocatorStore | null): void {
    this.locatorStore = store;
  }

  private obsChannel(sessionId: string): ObserverChannel {
    let ch = this.obsChannels.get(sessionId);
    if (!ch) {
      ch = { ring: [], lastEid: 0, subscribers: new Set() };
      this.obsChannels.set(sessionId, ch);
    }
    if (ch.evictTimer) {
      clearTimeout(ch.evictTimer);
      ch.evictTimer = undefined;
    }
    return ch;
  }

  /**
   * Record the session's ledger location, announced by the runtime itself
   * (session_meta line). Never derived from the API cwd, never caller-supplied
   * over the observe API.
   */
  registerLedgerPath(sessionId: string, ledgerPath: string): void {
    if (!isAbsolute(ledgerPath) || !ledgerPath.endsWith('.jsonl')) {
      logger.warn('[EventBus] Rejected non-absolute or non-jsonl ledger path', {
        sessionId,
        ledgerPath,
      });
      return;
    }
    // Runtime transcripts live under .ink/runtime/repl — reject anything else.
    if (!ledgerPath.includes(`${sep}.ink${sep}runtime${sep}repl${sep}`)) {
      logger.warn('[EventBus] Rejected ledger path outside runtime/repl', {
        sessionId,
        ledgerPath,
      });
      return;
    }
    this.obsChannel(sessionId).ledgerPath = ledgerPath;
    // Durably persist so replay survives bus eviction and process restarts.
    // One retry, then an ERROR-level log: a lost locator silently downgrades
    // durable replay to live-only for this session, so the failure must be
    // loud (Lumen re-review, blocker 1).
    const store = this.locatorStore;
    if (store) {
      void store
        .persist(sessionId, ledgerPath)
        .catch(() => store.persist(sessionId, ledgerPath))
        .catch((err) => {
          logger.error('[EventBus] Ledger locator persist failed after retry', {
            sessionId,
            ledgerPath,
            error: String(err),
          });
        });
    }
  }

  /**
   * Publish one canonical ledger entry (from the runtime's `obs` line).
   * Synchronous; NEVER awaits a sink. The entry's eid is the ledger's —
   * this bus never mints ids for observer entries.
   */
  publishObserverEntry(sessionId: string, rawEntry: ObserverEntry): void {
    // Project at ingest — the ring and every frame downstream hold ONLY the
    // allowlisted view; raw payloads never enter observer-facing state.
    const entry = projectObserverEntry(rawEntry);
    if (!entry) return;
    const ch = this.obsChannel(sessionId);
    if (entry.eid > ch.lastEid) ch.lastEid = entry.eid;
    ch.ring.push(entry);
    if (ch.ring.length > OBS_RING_CAPACITY) {
      ch.ring.splice(0, ch.ring.length - OBS_RING_CAPACITY);
    }

    const bytes = observerEntryBytes(entry);
    for (const sub of ch.subscribers) {
      if (sub.closed) continue;
      if (sub.replaying) {
        if (
          sub.capture.length >= OBS_QUEUE_MAX_EVENTS ||
          sub.captureBytes + bytes > OBS_QUEUE_MAX_BYTES
        ) {
          this.disconnectObserver(ch, sub, 'overflow');
          continue;
        }
        sub.capture.push(entry);
        sub.captureBytes += bytes;
      } else {
        this.enqueueObserver(ch, sub, entry, bytes);
      }
    }
  }

  /**
   * Attach an observer to the canonical entry stream. The subscriber record
   * and high-water snapshot are created synchronously BEFORE any I/O — the
   * atomic half of the replay→follow cutover. Resolves with an unsubscribe
   * function once replay + cutover complete.
   */
  async subscribeObserver(
    sessionId: string,
    sink: ObserverSink,
    options: ObserverSubscribeOptions = {}
  ): Promise<() => void> {
    const ch = this.obsChannel(sessionId);
    if (ch.subscribers.size >= OBS_MAX_SUBSCRIBERS) {
      sink.end('replay_failed');
      throw new Error(`Observer limit reached for session ${sessionId}`);
    }

    const sub: ObserverSubscriber = {
      sink,
      queue: [],
      queuedBytes: 0,
      pumping: false,
      replaying: true,
      capture: [],
      captureBytes: 0,
      closed: false,
      lastDeliveredEid: options.afterEid ?? 0,
    };
    ch.subscribers.add(sub);
    const highWater = ch.lastEid;
    const follow = options.follow !== false;

    // Durable locator: if this channel has no in-memory path (fresh process,
    // evicted channel), recover it from the store before any replay decision.
    // A load ERROR is not caught here — it propagates through the outer catch
    // as replay_failed: an unreachable store must fail the subscription
    // loudly, never silently downgrade an old session to an empty replay
    // (Lumen M4.3 re-review).
    let durableHistoryWithoutLocator = false;
    const unsubscribe = (): void => {
      if (!sub.closed) this.disconnectObserver(ch, sub, 'unsubscribed');
    };

    try {
      if (!ch.ledgerPath && this.locatorStore) {
        const record = await this.locatorStore.load(sessionId);
        if (record.ledgerPath) {
          ch.ledgerPath = record.ledgerPath;
        } else {
          durableHistoryWithoutLocator = record.hasHistory;
        }
      }

      await this.replayObserver(
        ch,
        sub,
        options.afterEid,
        highWater,
        options.signal,
        durableHistoryWithoutLocator
      );

      if (!follow || options.signal?.aborted) {
        unsubscribe();
        return unsubscribe;
      }

      // Drain capture in eid order until empty, then flip to direct follow.
      // New publishes keep landing in capture (bounded) while draining, so
      // the flip happens only at a genuinely empty queue.
      while (!sub.closed && !options.signal?.aborted && sub.capture.length > 0) {
        const next = sub.capture.shift()!;
        sub.captureBytes -= observerEntryBytes(next);
        await this.writeObserver(sub, next);
      }
      if (options.signal?.aborted) {
        unsubscribe();
        return unsubscribe;
      }
      sub.replaying = false;
      return unsubscribe;
    } catch (error) {
      logger.warn('[EventBus] Observer replay failed', { sessionId, error: String(error) });
      if (!sub.closed) this.disconnectObserver(ch, sub, 'replay_failed');
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  /**
   * A turn's process exited. Turn-end is NOT session-end (Lumen review,
   * blocker 5): attached observers stay attached across turns — the next
   * turn's registration re-arms the channel. Memory is reclaimed only when
   * nobody is watching; the durable locator store keeps replay working even
   * after eviction.
   */
  releaseObserverSession(sessionId: string): void {
    const ch = this.obsChannels.get(sessionId);
    if (!ch) return;
    if (ch.evictTimer) clearTimeout(ch.evictTimer);
    ch.evictTimer = setTimeout(() => {
      const current = this.obsChannels.get(sessionId);
      if (!current) return;
      if (current.subscribers.size > 0) return; // watchers ride across turns
      this.obsChannels.delete(sessionId);
    }, OBS_RETENTION_MS);
    ch.evictTimer.unref?.();
  }

  private async replayObserver(
    ch: ObserverChannel,
    sub: ObserverSubscriber,
    afterEid: number | undefined,
    highWater: number,
    signal?: AbortSignal,
    durableHistoryWithoutLocator = false
  ): Promise<void> {
    const gone = (): boolean => sub.closed || signal?.aborted === true;
    if (highWater === 0 && afterEid === undefined) return;

    // Default attach: ring only.
    if (afterEid === undefined) {
      for (const entry of [...ch.ring]) {
        if (gone()) return;
        if (entry.eid <= highWater) await this.writeObserver(sub, entry);
      }
      return;
    }

    const ringCoversCursor = ch.ring.length > 0 && ch.ring[0].eid <= afterEid + 1;
    if (ringCoversCursor) {
      for (const entry of [...ch.ring]) {
        if (gone()) return;
        if (entry.eid > afterEid && entry.eid <= highWater) {
          await this.writeObserver(sub, entry);
        }
      }
      return;
    }

    // Cursor precedes the ring — durable backfill from the ledger. The ledger
    // is always a superset of the ring: the runtime appends synchronously
    // BEFORE emitting the obs line. No high-water cap here: the per-subscriber
    // monotonic lastDeliveredEid guard makes any overlap with the capture
    // queue idempotent, and it also serves the fresh-channel case (lastEid=0
    // after eviction/restart) where a cap would wrongly suppress all history.
    if (!ch.ledgerPath) {
      // No durable locator. Vacuous replay (follow live) is claimed ONLY with
      // authoritative evidence of a genuine first turn: nothing published in
      // this process AND the durable sessions row shows no prior activity.
      // `highWater === 0` alone is NOT that evidence — it is also 0 after
      // eviction/restart, where an old session whose locator was lost must
      // fail loudly rather than silently omit its history (Lumen M4.3
      // re-review).
      if (highWater === 0 && !durableHistoryWithoutLocator) return;
      throw new Error(
        durableHistoryWithoutLocator
          ? 'Session has prior history but no ledger locator — durable replay unavailable'
          : 'Cursor precedes ring and no ledger path is registered'
      );
    }
    await stat(ch.ledgerPath); // surface missing-file as replay failure
    const rl = createInterface({
      input: createReadStream(ch.ledgerPath, { encoding: 'utf-8' }),
      crlfDelay: Infinity,
    });
    try {
      for await (const line of rl) {
        if (gone()) return;
        const trimmed = line.trim();
        if (!trimmed) continue;
        let parsed: ObserverEntry;
        try {
          parsed = JSON.parse(trimmed) as ObserverEntry;
        } catch {
          continue;
        }
        if (typeof parsed.eid !== 'number' || parsed.eid <= afterEid) continue;
        // Same projection as ingest — replay and live frames are one shape.
        const projected = projectObserverEntry(parsed);
        if (!projected) continue;
        await this.writeObserver(sub, projected);
      }
    } finally {
      rl.close();
    }
  }

  private async writeObserver(sub: ObserverSubscriber, entry: ObserverEntry): Promise<void> {
    if (sub.closed) return;
    // Monotonic guard: whatever path got here first wins; duplicates and
    // out-of-order re-delivery are dropped by construction.
    if (entry.eid <= sub.lastDeliveredEid) return;
    let ok: boolean;
    try {
      ok = sub.sink.write(entry);
    } catch (error) {
      throw new Error(`observer sink write failed: ${String(error)}`);
    }
    sub.lastDeliveredEid = entry.eid;
    if (!ok) await sub.sink.waitDrain();
  }

  private enqueueObserver(
    ch: ObserverChannel,
    sub: ObserverSubscriber,
    entry: ObserverEntry,
    bytes: number
  ): void {
    if (sub.queue.length >= OBS_QUEUE_MAX_EVENTS || sub.queuedBytes + bytes > OBS_QUEUE_MAX_BYTES) {
      // Overflow DISCONNECTS — clearing the queue and continuing would leave
      // this observer's view permanently different from the ledger. The
      // client reconnects from its last processed eid and reconverges via
      // durable replay.
      this.disconnectObserver(ch, sub, 'overflow');
      return;
    }
    sub.queue.push(entry);
    sub.queuedBytes += bytes;
    if (!sub.pumping) void this.pumpObserver(ch, sub);
  }

  private async pumpObserver(ch: ObserverChannel, sub: ObserverSubscriber): Promise<void> {
    sub.pumping = true;
    try {
      while (!sub.closed && sub.queue.length > 0) {
        const entry = sub.queue.shift()!;
        sub.queuedBytes -= observerEntryBytes(entry);
        await this.writeObserver(sub, entry);
      }
    } catch (error) {
      logger.debug('[EventBus] Observer sink error during pump; disconnecting', {
        error: String(error),
      });
      this.disconnectObserver(ch, sub, 'sink_error');
    } finally {
      sub.pumping = false;
    }
  }

  private disconnectObserver(
    ch: ObserverChannel,
    sub: ObserverSubscriber,
    reason: ObserverSinkEndReason
  ): void {
    if (sub.closed) return;
    sub.closed = true;
    sub.queue = [];
    sub.queuedBytes = 0;
    sub.capture = [];
    sub.captureBytes = 0;
    ch.subscribers.delete(sub);
    try {
      sub.sink.end(reason);
    } catch {
      // A failing end() must not propagate into the publish path.
    }
  }

  private recordReplay(event: SessionStreamEvent): void {
    let buf = this.replay.get(event.sessionId);
    if (!buf) {
      this.evictIfFull();
      buf = [];
      this.replay.set(event.sessionId, buf);
    } else {
      // Refresh recency: re-insert at the end so LRU eviction keeps active ones.
      this.replay.delete(event.sessionId);
      this.replay.set(event.sessionId, buf);
    }
    buf.push(event);
    if (buf.length > REPLAY_PER_SESSION) {
      buf.splice(0, buf.length - REPLAY_PER_SESSION);
    }
  }

  private evictIfFull(): void {
    while (this.replay.size >= MAX_TRACKED_SESSIONS) {
      // Map preserves insertion order; the first key is the least-recently-active.
      const oldest = this.replay.keys().next().value;
      if (oldest === undefined) break;
      this.replay.delete(oldest);
    }
  }
}

/** Process-wide singleton — the one place session events converge. */
export const sessionEventBus = new SessionEventBus();
