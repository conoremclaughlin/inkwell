/**
 * Thread spines — everything the system knows about a threadKey, merged.
 *
 * A threadKey is the identity of a piece of work as it moves between agents,
 * sessions, studios, and task groups. The conversation (inbox_threads) is only
 * one of the places it shows up — a session can be working a key it has never
 * messaged anyone about. The browse surface therefore keys on the UNION of
 * threadKey occurrences across all four carriers, not on the threads table:
 * work that has started but was never announced is a first-class row here
 * ("no thread yet"), not an absence.
 *
 * Pure merge logic, no DB access — the admin route maps rows in and the
 * result out. Identity rules follow ink://specs/thread-key-grammar: a key
 * with a thread row uses the DB-pinned (key_project, key_type, key_id) and is
 * marked pinned; a key seen only on sessions/studios/groups has no pinned
 * identity yet, so the injected parser provides a PROVISIONAL, display-only
 * identity (pinned: false) — it becomes authoritative only when a thread is
 * created and the DB trigger pins it.
 */

import { isTerminalPhaseMarker } from '../sessions/phase-markers';

export interface SpineThreadRow {
  threadKey: string;
  keyProject: string | null;
  keyType: string | null;
  keyId: string | null;
  title: string | null;
  summary: string | null;
  status: string;
  createdBySlug: string;
  updatedAt: string;
  closedAt: string | null;
  participants: string[];
}

export interface SpineSessionRow {
  id: string;
  sbSlug: string | null;
  lifecycle: string | null;
  status: string | null;
  currentPhase: string | null;
  /** Immutable routing anchor set at session creation. */
  threadKey: string | null;
  /** Mutable focus — what the session says it is working on right now. */
  activeThreadKey: string | null;
  updatedAt: string;
  studioId: string | null;
}

export interface SpineStudioRow {
  id: string;
  slug: string | null;
  branch: string;
  sbSlug: string;
  /** Studio affinity — the key this studio is dedicated to, if any. */
  threadKey: string | null;
  /** Live occupancy — the key the current lease was acquired for. */
  leaseThreadKey: string | null;
  leaseSlug: string | null;
  updatedAt: string;
}

export interface SpineGroupRow {
  id: string;
  title: string;
  status: string | null;
  threadKey: string | null;
  executionModel: string | null;
  executionPhase: string | null;
  updatedAt: string;
}

export interface SpineIdentity {
  project: string | null;
  type: string | null;
  id: string | null;
  /** True when identity comes from the DB-pinned thread columns. */
  pinned: boolean;
}

export type SpineSource = 'thread' | 'session' | 'studio' | 'group';

export interface ThreadSpine {
  key: string;
  identity: SpineIdentity | null;
  thread: {
    title: string | null;
    /** One-line "what is this about", capped at 280 chars by the DB. */
    summary: string | null;
    status: string;
    createdBySlug: string;
    participants: string[];
    closedAt: string | null;
  } | null;
  sessions: Array<{
    id: string;
    sbSlug: string | null;
    lifecycle: string | null;
    status: string | null;
    phase: string | null;
    /** How this session references the key: routing anchor, active focus, or both. */
    relation: 'anchor' | 'active' | 'both';
    /**
     * Whether this session is working RIGHT NOW — see isSessionLive. Computed
     * here so every client agrees; `lifecycle` alone does not answer it.
     */
    live: boolean;
    updatedAt: string;
    studioId: string | null;
  }>;
  studios: Array<{
    id: string;
    slug: string | null;
    branch: string;
    sbSlug: string;
    /** Dedicated to this key, currently leased for it, or both. */
    relation: 'affinity' | 'lease' | 'both';
    leaseSlug: string | null;
    updatedAt: string;
  }>;
  taskGroups: Array<{
    id: string;
    title: string;
    status: string | null;
    executionModel: string | null;
    executionPhase: string | null;
    updatedAt: string;
  }>;
  /** Union of thread participants, session agents, and lease holders. */
  participants: string[];
  sources: SpineSource[];
  lastActivityAt: string;
}

/**
 * Lifecycles in which a session is doing something. `idle` is a session that
 * exists between turns; `interrupted`, `completed` and `failed` are over.
 * These are the only values the canonical SessionLifecycle union admits —
 * the dashboard also tested for `generating`, which is not one of them and
 * therefore never matched anything.
 */
const LIVE_LIFECYCLES = new Set(['running', 'compacting']);

/**
 * How long a session's own last write vouches for it still being alive.
 *
 * Nothing reaps abandoned sessions: `ended_at` is NULL on every `running` row
 * in production, so a session that died mid-turn keeps that lifecycle
 * forever. Measured 2026-09-17: 73 rows said `running`, 3 had been written
 * within fifteen minutes, and the oldest had been "running" since March. A
 * badge that believes the column marks fifty threads as live for one agent
 * who is working on maybe two, which makes the badge worse than nothing —
 * the reader learns to ignore it, including on the thread that is real.
 *
 * So liveness is a CLAIM WITH AN EXPIRY, not a stored state. Thirty minutes
 * is deliberately generous: a session waiting on a sibling's review writes
 * nothing while it waits, and it is still live in the sense the reader cares
 * about. The observed gap is wide enough that the exact number barely
 * matters — real sessions had written within ~2 hours, and the next-freshest
 * abandoned one was ~10 hours stale.
 */
export const SESSION_LIVE_WINDOW_MS = 30 * 60 * 1000;

/** The fields liveness depends on — a subset of SpineSessionRow. */
export interface SessionLivenessFields {
  lifecycle: string | null;
  currentPhase: string | null;
  updatedAt: string;
}

/**
 * Whether a session is working right now. Three independent ways to be not-live:
 *
 * 1. The lifecycle is not a working one.
 * 2. The session declared itself finished via its phase but the lifecycle was
 *    never moved off `running` — a real and common shape, and the phase is the
 *    more recent statement of the two. "Finished" is isTerminalPhaseMarker's
 *    call, not a comparison invented here: the fleet already recognises
 *    `complete`, `completed` and either with a `:<reason>` suffix, and a
 *    session the CLI's picker treats as history must not be advertised live.
 * 3. Its last write is older than the window (see above).
 *
 * `nowMs` is injected rather than read here so the rule is testable and so a
 * single request classifies every session against one instant.
 */
export function isSessionLive(session: SessionLivenessFields, nowMs: number): boolean {
  if (!session.lifecycle || !LIVE_LIFECYCLES.has(session.lifecycle)) return false;
  if (isTerminalPhaseMarker(session.currentPhase)) return false;
  const updatedMs = Date.parse(session.updatedAt);
  // An unparseable timestamp is no evidence of life. A future one is clock
  // skew, not a lie, so it stays live.
  if (!Number.isFinite(updatedMs)) return false;
  return nowMs - updatedMs <= SESSION_LIVE_WINDOW_MS;
}

export interface MergeThreadSpinesInput {
  threads: SpineThreadRow[];
  sessions: SpineSessionRow[];
  studios: SpineStudioRow[];
  groups: SpineGroupRow[];
  /**
   * Registry-driven parser for keys with no pinned identity (display-only).
   * Return null for untyped keys — they stay browsable with identity null.
   * Pass () => null when the slug registry is unreadable: per the grammar
   * spec's fail-closed rule, "could not read the registry" must degrade to
   * "identity unknown", never to a wrong identity parsed against an empty
   * slug set.
   */
  parse: (key: string) => { project: string | null; type: string; id: string } | null;
  /**
   * The instant every session is classified against. Injected so one request
   * cannot call an early session live and a later identical one stale.
   */
  nowMs?: number;
}

/**
 * Keys referenced by sessions/studios/groups that have no row in the fetched
 * thread window. The list feed is capped to the newest threads, but a carrier
 * can reference an older real thread — merging without its row would fabricate
 * a "no thread yet" state and re-parse a key whose identity is already pinned
 * (the reinterpretation the grammar spec forbids). The route hydrates thread
 * rows for exactly these keys before merging.
 */
export function missingThreadKeys(
  fetchedThreadKeys: Iterable<string>,
  sessions: SpineSessionRow[],
  studios: SpineStudioRow[],
  groups: SpineGroupRow[]
): string[] {
  const have = new Set(fetchedThreadKeys);
  const missing = new Set<string>();
  const consider = (key: string | null) => {
    if (key && !have.has(key)) missing.add(key);
  };
  for (const s of sessions) {
    consider(s.threadKey);
    consider(s.activeThreadKey);
  }
  for (const st of studios) {
    consider(st.threadKey);
    consider(st.leaseThreadKey);
  }
  for (const g of groups) {
    consider(g.threadKey);
  }
  return [...missing];
}

/**
 * Lease events that are evidence a session actually occupied the studio for
 * this key. `conflict` is the opposite — it records a studio that REFUSED
 * the thread (candidate diverted elsewhere) — and `overflow` merely
 * announces a spawn; a studio that was really entered gets an `acquired`
 * row moments later. Building history from anything outside this set
 * fabricates "work happened here" for studios the thread never touched.
 */
const OCCUPANCY_EVENTS = new Set(['acquired', 'released', 'expired', 'reclaimed']);

export interface StudioLeaseEventRow {
  studioId: string;
  sbSlug: string | null;
  event: string;
  createdAt: string;
}

export interface StudioHistoryEntry {
  studioId: string;
  agents: string[];
  firstAt: string;
  lastAt: string;
  lastEvent: string;
}

/**
 * Aggregate occupancy history per studio from lease-event rows (any order
 * of arrival; typically newest-first). Non-occupancy rows are ignored
 * entirely — a studio whose only rows for this key are conflicts does not
 * appear. Sorted most-recently-active first.
 */
export function aggregateStudioHistory(events: StudioLeaseEventRow[]): StudioHistoryEntry[] {
  interface Working {
    studioId: string;
    agents: Set<string>;
    firstAtMs: number;
    lastAtMs: number;
    firstAt: string;
    lastAt: string;
    lastEvent: string;
  }
  const byStudio = new Map<string, Working>();
  for (const ev of events) {
    if (!OCCUPANCY_EVENTS.has(ev.event)) continue;
    const ms = Date.parse(ev.createdAt);
    const entry = byStudio.get(ev.studioId);
    if (!entry) {
      byStudio.set(ev.studioId, {
        studioId: ev.studioId,
        agents: new Set(ev.sbSlug ? [ev.sbSlug] : []),
        firstAtMs: ms,
        lastAtMs: ms,
        firstAt: ev.createdAt,
        lastAt: ev.createdAt,
        lastEvent: ev.event,
      });
      continue;
    }
    if (ev.sbSlug) entry.agents.add(ev.sbSlug);
    if (ms < entry.firstAtMs) {
      entry.firstAtMs = ms;
      entry.firstAt = ev.createdAt;
    }
    if (ms > entry.lastAtMs) {
      entry.lastAtMs = ms;
      entry.lastAt = ev.createdAt;
      entry.lastEvent = ev.event;
    }
  }
  return [...byStudio.values()]
    .map((w) => ({
      studioId: w.studioId,
      agents: [...w.agents].sort(),
      firstAt: w.firstAt,
      lastAt: w.lastAt,
      lastEvent: w.lastEvent,
    }))
    .sort((a, b) => Date.parse(b.lastAt) - Date.parse(a.lastAt));
}

interface WorkingSpine {
  key: string;
  identity: SpineIdentity | null;
  thread: ThreadSpine['thread'];
  sessions: ThreadSpine['sessions'];
  studios: Map<string, ThreadSpine['studios'][number]>;
  taskGroups: ThreadSpine['taskGroups'];
  participants: Set<string>;
  sources: Set<SpineSource>;
  lastActivityAt: string;
}

function laterIso(a: string, b: string): string {
  return Date.parse(b) > Date.parse(a) ? b : a;
}

export function mergeThreadSpines(input: MergeThreadSpinesInput): ThreadSpine[] {
  const spines = new Map<string, WorkingSpine>();
  const nowMs = input.nowMs ?? Date.now();

  const spineFor = (key: string): WorkingSpine => {
    let spine = spines.get(key);
    if (!spine) {
      spine = {
        key,
        identity: null,
        thread: null,
        sessions: [],
        studios: new Map(),
        taskGroups: [],
        participants: new Set(),
        sources: new Set(),
        lastActivityAt: new Date(0).toISOString(),
      };
      spines.set(key, spine);
    }
    return spine;
  };

  for (const t of input.threads) {
    const spine = spineFor(t.threadKey);
    spine.thread = {
      title: t.title,
      summary: t.summary,
      status: t.status,
      createdBySlug: t.createdBySlug,
      participants: t.participants,
      closedAt: t.closedAt,
    };
    // Pinned identity is authoritative even when all three components are
    // null (a pre-pinning thread awaiting reconciliation stays "unknown",
    // it is never re-parsed).
    spine.identity = { project: t.keyProject, type: t.keyType, id: t.keyId, pinned: true };
    for (const p of t.participants) spine.participants.add(p);
    spine.sources.add('thread');
    spine.lastActivityAt = laterIso(spine.lastActivityAt, t.updatedAt);
  }

  for (const s of input.sessions) {
    const anchor = s.threadKey;
    const active = s.activeThreadKey;
    const keys = new Map<string, 'anchor' | 'active' | 'both'>();
    if (anchor) keys.set(anchor, 'anchor');
    if (active) keys.set(active, keys.has(active) ? 'both' : 'active');
    // Classified once, outside the key loop: a session carried by two keys is
    // one session, and must not be live on one of them and stale on the other.
    const live = isSessionLive(s, nowMs);
    for (const [key, relation] of keys) {
      const spine = spineFor(key);
      spine.sessions.push({
        id: s.id,
        sbSlug: s.sbSlug,
        lifecycle: s.lifecycle,
        status: s.status,
        phase: s.currentPhase,
        relation,
        live,
        updatedAt: s.updatedAt,
        studioId: s.studioId,
      });
      if (s.sbSlug) spine.participants.add(s.sbSlug);
      spine.sources.add('session');
      spine.lastActivityAt = laterIso(spine.lastActivityAt, s.updatedAt);
    }
  }

  for (const st of input.studios) {
    const keys = new Map<string, 'affinity' | 'lease' | 'both'>();
    if (st.threadKey) keys.set(st.threadKey, 'affinity');
    if (st.leaseThreadKey) {
      keys.set(st.leaseThreadKey, keys.has(st.leaseThreadKey) ? 'both' : 'lease');
    }
    for (const [key, relation] of keys) {
      const spine = spineFor(key);
      spine.studios.set(st.id, {
        id: st.id,
        slug: st.slug,
        branch: st.branch,
        sbSlug: st.sbSlug,
        relation,
        leaseSlug: relation === 'affinity' ? null : st.leaseSlug,
        updatedAt: st.updatedAt,
      });
      if (relation !== 'affinity' && st.leaseSlug) {
        spine.participants.add(st.leaseSlug);
      }
      spine.sources.add('studio');
      // Deliberately NOT folded into lastActivityAt: studio rows are touched
      // by lease heartbeats, so a four-day-old conversation whose studio is
      // merely occupied would read "just now" and every leased key would
      // crowd the top of the sort. Presence renders in the studios section;
      // recency belongs to conversation, sessions, and work.
    }
  }

  for (const g of input.groups) {
    if (!g.threadKey) continue;
    const spine = spineFor(g.threadKey);
    spine.taskGroups.push({
      id: g.id,
      title: g.title,
      status: g.status,
      executionModel: g.executionModel,
      executionPhase: g.executionPhase,
      updatedAt: g.updatedAt,
    });
    spine.sources.add('group');
    spine.lastActivityAt = laterIso(spine.lastActivityAt, g.updatedAt);
  }

  const order: SpineSource[] = ['thread', 'session', 'studio', 'group'];
  return [...spines.values()]
    .map((w): ThreadSpine => {
      const identity =
        w.identity ??
        (() => {
          const parsed = input.parse(w.key);
          return parsed
            ? { project: parsed.project, type: parsed.type, id: parsed.id, pinned: false }
            : null;
        })();
      const studios = [...w.studios.values()];
      // A key carried ONLY by a studio has no real activity signal; fall
      // back to the studio timestamp rather than reporting the epoch. Any
      // conversation, session, or work timestamp outranks this.
      const lastActivityAt =
        Date.parse(w.lastActivityAt) > 0
          ? w.lastActivityAt
          : studios.reduce((max, st) => laterIso(max, st.updatedAt), w.lastActivityAt);
      return {
        key: w.key,
        identity,
        thread: w.thread,
        sessions: w.sessions.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)),
        studios,
        taskGroups: w.taskGroups.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)),
        participants: [...w.participants].sort(),
        sources: order.filter((s) => w.sources.has(s)),
        lastActivityAt,
      };
    })
    .sort((a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt));
}
