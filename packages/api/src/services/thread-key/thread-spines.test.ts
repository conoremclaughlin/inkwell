import { describe, it, expect } from 'vitest';
import {
  aggregateStudioHistory,
  mergeThreadSpines,
  missingThreadKeys,
  type SpineGroupRow,
  type SpineSessionRow,
  type SpineStudioRow,
  type SpineThreadRow,
  type StudioLeaseEventRow,
} from './thread-spines';

const at = (h: number) => new Date(Date.UTC(2026, 7, 25, h)).toISOString();

const thread = (over: Partial<SpineThreadRow> = {}): SpineThreadRow => ({
  threadKey: 'pr:531',
  keyProject: null,
  keyType: 'pr',
  keyId: '531',
  title: 'Command center viz',
  status: 'open',
  createdByAgentId: 'wren',
  updatedAt: at(10),
  closedAt: null,
  participants: ['wren', 'lumen'],
  ...over,
});

const session = (over: Partial<SpineSessionRow> = {}): SpineSessionRow => ({
  id: 's1',
  agentId: 'wren',
  lifecycle: 'running',
  status: 'active',
  currentPhase: 'implementing',
  threadKey: null,
  activeThreadKey: null,
  updatedAt: at(9),
  studioId: 'st1',
  ...over,
});

const studio = (over: Partial<SpineStudioRow> = {}): SpineStudioRow => ({
  id: 'st1',
  slug: 'wren-omega',
  branch: 'wren/feat/x',
  agentId: 'wren',
  threadKey: null,
  leaseThreadKey: null,
  leaseAgentId: null,
  updatedAt: at(8),
  ...over,
});

const group = (over: Partial<SpineGroupRow> = {}): SpineGroupRow => ({
  id: 'g1',
  title: 'Release pipeline',
  status: 'active',
  threadKey: 'pr:531',
  executionModel: 'graph',
  executionPhase: 'worker_active',
  updatedAt: at(7),
  ...over,
});

const noParse = () => null;

describe('mergeThreadSpines', () => {
  it('surfaces a key seen only on a session — work begun, nothing announced', () => {
    const spines = mergeThreadSpines({
      threads: [],
      sessions: [session({ activeThreadKey: 'inkread:pr:512' })],
      studios: [],
      groups: [],
      parse: (key) =>
        key === 'inkread:pr:512' ? { project: 'inkread', type: 'pr', id: '512' } : null,
    });

    expect(spines).toHaveLength(1);
    const [spine] = spines;
    expect(spine.key).toBe('inkread:pr:512');
    expect(spine.thread).toBeNull();
    expect(spine.sources).toEqual(['session']);
    expect(spine.identity).toEqual({ project: 'inkread', type: 'pr', id: '512', pinned: false });
    expect(spine.sessions[0].relation).toBe('active');
  });

  it('merges all four carriers of one key into a single spine', () => {
    const spines = mergeThreadSpines({
      threads: [thread()],
      sessions: [session({ threadKey: 'pr:531', activeThreadKey: 'pr:531', updatedAt: at(11) })],
      studios: [studio({ leaseThreadKey: 'pr:531', leaseAgentId: 'lumen', updatedAt: at(6) })],
      groups: [group()],
      parse: noParse,
    });

    expect(spines).toHaveLength(1);
    const [spine] = spines;
    expect(spine.sources).toEqual(['thread', 'session', 'studio', 'group']);
    expect(spine.sessions[0].relation).toBe('both');
    expect(spine.studios[0].relation).toBe('lease');
    expect(spine.taskGroups[0].executionModel).toBe('graph');
    // Union of thread participants, session agent, and lease holder.
    expect(spine.participants).toEqual(['lumen', 'wren']);
    // Max across contributors — the session touched it last.
    expect(spine.lastActivityAt).toBe(at(11));
  });

  it('pinned thread identity wins over the parser, even when the pin is all-null', () => {
    let parserCalls = 0;
    const spines = mergeThreadSpines({
      threads: [thread({ keyProject: null, keyType: null, keyId: null })],
      sessions: [],
      studios: [],
      groups: [],
      parse: () => {
        parserCalls += 1;
        return { project: null, type: 'pr', id: '531' };
      },
    });

    // An unpinned legacy thread stays "identity unknown" awaiting DB
    // reconciliation — it is never live-re-parsed into a fresh identity.
    expect(spines[0].identity).toEqual({ project: null, type: null, id: null, pinned: true });
    expect(parserCalls).toBe(0);
  });

  it('keeps untyped keys browsable with identity null when the parser declines', () => {
    const spines = mergeThreadSpines({
      threads: [],
      sessions: [session({ threadKey: 'not-a-typed-key' })],
      studios: [],
      groups: [],
      parse: noParse,
    });
    expect(spines[0].key).toBe('not-a-typed-key');
    expect(spines[0].identity).toBeNull();
  });

  it('a session anchored to one key but focused on another appears under both', () => {
    const spines = mergeThreadSpines({
      threads: [],
      sessions: [session({ threadKey: 'pr:531', activeThreadKey: 'pr:540' })],
      studios: [],
      groups: [],
      parse: noParse,
    });

    const byKey = new Map(spines.map((s) => [s.key, s]));
    expect(byKey.get('pr:531')?.sessions[0].relation).toBe('anchor');
    expect(byKey.get('pr:540')?.sessions[0].relation).toBe('active');
  });

  it('a studio dedicated to one key but leased for another appears under both', () => {
    const spines = mergeThreadSpines({
      threads: [],
      sessions: [],
      studios: [
        studio({ threadKey: 'spec:fleet', leaseThreadKey: 'pr:540', leaseAgentId: 'wren' }),
      ],
      groups: [],
      parse: noParse,
    });

    const byKey = new Map(spines.map((s) => [s.key, s]));
    expect(byKey.get('spec:fleet')?.studios[0].relation).toBe('affinity');
    // Affinity alone says nothing about who is present.
    expect(byKey.get('spec:fleet')?.studios[0].leaseAgentId).toBeNull();
    expect(byKey.get('spec:fleet')?.participants).toEqual([]);
    expect(byKey.get('pr:540')?.studios[0].relation).toBe('lease');
    expect(byKey.get('pr:540')?.studios[0].leaseAgentId).toBe('wren');
    expect(byKey.get('pr:540')?.participants).toEqual(['wren']);
  });

  it('sorts spines by last activity and sessions within a spine newest-first', () => {
    const spines = mergeThreadSpines({
      threads: [thread({ threadKey: 'pr:1', updatedAt: at(1) })],
      sessions: [
        session({ id: 's-old', threadKey: 'pr:2', updatedAt: at(2) }),
        session({ id: 's-new', threadKey: 'pr:2', updatedAt: at(12) }),
      ],
      studios: [],
      groups: [group({ threadKey: 'pr:3', updatedAt: at(5) })],
      parse: noParse,
    });

    expect(spines.map((s) => s.key)).toEqual(['pr:2', 'pr:3', 'pr:1']);
    expect(spines[0].sessions.map((s) => s.id)).toEqual(['s-new', 's-old']);
  });
});

describe('lastActivityAt vs studio heartbeats', () => {
  it('a lease heartbeat never makes an old conversation read as fresh', () => {
    const spines = mergeThreadSpines({
      threads: [thread({ updatedAt: at(1) })],
      sessions: [session({ threadKey: 'pr:531', updatedAt: at(2) })],
      // Studio row touched moments ago by the lease heartbeat.
      studios: [studio({ leaseThreadKey: 'pr:531', leaseAgentId: 'wren', updatedAt: at(12) })],
      groups: [],
      parse: noParse,
    });

    expect(spines[0].lastActivityAt).toBe(at(2));
    // Presence still renders — the studio itself is not hidden.
    expect(spines[0].studios).toHaveLength(1);
  });

  it('a key carried only by a studio falls back to the studio timestamp, not the epoch', () => {
    const spines = mergeThreadSpines({
      threads: [],
      sessions: [],
      studios: [studio({ threadKey: 'spec:fleet', updatedAt: at(4) })],
      groups: [],
      parse: noParse,
    });
    expect(spines[0].lastActivityAt).toBe(at(4));
  });
});

describe('aggregateStudioHistory', () => {
  const ev = (over: Partial<StudioLeaseEventRow>): StudioLeaseEventRow => ({
    studioId: 'st-a',
    agentId: 'lumen',
    event: 'acquired',
    createdAt: at(5),
    ...over,
  });

  it('a conflict-then-diversion never fabricates history for the refusing studio', () => {
    // The thread was refused by st-busy (conflict row) and diverted to
    // st-overflow, which it actually occupied. Only the occupied studio
    // is history — a conflict-only studio never appears.
    const entries = aggregateStudioHistory([
      ev({ studioId: 'st-overflow', event: 'released', createdAt: at(8) }),
      ev({ studioId: 'st-overflow', event: 'acquired', createdAt: at(6) }),
      ev({ studioId: 'st-overflow', event: 'overflow', createdAt: at(6) }),
      ev({ studioId: 'st-busy', event: 'conflict', createdAt: at(5) }),
    ]);

    expect(entries.map((e) => e.studioId)).toEqual(['st-overflow']);
    expect(entries[0].firstAt).toBe(at(6));
    expect(entries[0].lastAt).toBe(at(8));
    expect(entries[0].lastEvent).toBe('released');
  });

  it('overflow announcements alone are not occupancy', () => {
    expect(aggregateStudioHistory([ev({ event: 'overflow' })])).toEqual([]);
    expect(aggregateStudioHistory([ev({ event: 'conflict' })])).toEqual([]);
  });

  it('aggregates agents and orders studios by most recent occupancy, input order irrelevant', () => {
    const entries = aggregateStudioHistory([
      ev({ studioId: 'st-a', agentId: 'wren', event: 'acquired', createdAt: at(1) }),
      ev({ studioId: 'st-b', event: 'expired', createdAt: at(9) }),
      ev({ studioId: 'st-a', agentId: 'lumen', event: 'released', createdAt: at(3) }),
    ]);

    expect(entries.map((e) => e.studioId)).toEqual(['st-b', 'st-a']);
    expect(entries[1].agents).toEqual(['lumen', 'wren']);
    expect(entries[1].lastEvent).toBe('released');
  });
});

describe('missingThreadKeys', () => {
  it('collects every carrier key absent from the fetched window, deduped', () => {
    const keys = missingThreadKeys(
      ['pr:1'],
      [session({ threadKey: 'pr:1', activeThreadKey: 'pr:2' })],
      [studio({ threadKey: 'spec:a', leaseThreadKey: 'pr:2' })],
      [group({ threadKey: 'task:x' })]
    );
    expect(keys.sort()).toEqual(['pr:2', 'spec:a', 'task:x']);
  });

  it('returns nothing when the window already covers all carriers', () => {
    expect(
      missingThreadKeys(
        ['pr:1', 'spec:a'],
        [session({ threadKey: 'pr:1' })],
        [studio({ threadKey: 'spec:a' })],
        []
      )
    ).toEqual([]);
  });

  it('boundary: a pinned thread omitted by the window is re-fetched, never re-parsed', () => {
    // A session references an old thread that fell past the list cap. The
    // route asks missingThreadKeys which rows to hydrate; once the hydrated
    // row is in the merge input, the spine keeps its DB-pinned identity and
    // its thread — the parser must never see the key.
    const oldKey = 'inkread:pr:12';
    const carrier = session({ threadKey: oldKey, updatedAt: at(3) });

    const toHydrate = missingThreadKeys([], [carrier], [], []);
    expect(toHydrate).toEqual([oldKey]);

    let parserCalls = 0;
    const spines = mergeThreadSpines({
      threads: [
        thread({
          threadKey: oldKey,
          keyProject: 'inkread',
          keyType: 'pr',
          keyId: '12',
          status: 'closed',
          updatedAt: at(1),
        }),
      ],
      sessions: [carrier],
      studios: [],
      groups: [],
      parse: () => {
        parserCalls += 1;
        return { project: null, type: 'wrong', id: 'wrong' };
      },
    });

    expect(spines).toHaveLength(1);
    expect(spines[0].thread).not.toBeNull();
    expect(spines[0].identity).toEqual({
      project: 'inkread',
      type: 'pr',
      id: '12',
      pinned: true,
    });
    expect(parserCalls).toBe(0);
  });
});
