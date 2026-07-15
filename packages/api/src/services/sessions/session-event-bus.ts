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

class SessionEventBus extends EventEmitter {
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
