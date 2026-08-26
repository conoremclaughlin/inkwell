import { describe, it, expect } from 'vitest';
import {
  mergeThreadSpines,
  type SpineGroupRow,
  type SpineSessionRow,
  type SpineStudioRow,
  type SpineThreadRow,
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
