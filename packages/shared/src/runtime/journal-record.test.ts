import { describe, expect, it } from 'vitest';
import {
  canonicalJournalJson,
  freezeJournalEntry,
  journalReplayEvent,
  type JournalEntry,
} from './journal-record.js';

function entry(): JournalEntry {
  return {
    version: 1,
    journalId: '00000000-0000-4000-8000-000000000001',
    sessionId: '00000000-0000-4000-8000-000000000002',
    writerTenureId: '00000000-0000-4000-8000-000000000003',
    hostInstanceId: 'fixture-host',
    eid: 1,
    ts: '2026-01-01T00:00:00.000Z',
    type: 'assistant',
    target: null,
    body: { text: 'fixture' },
  };
}
function spawn(type = 'provider_spawn_intent'): JournalEntry {
  const result = entry();
  return {
    ...result,
    type,
    target: {
      tenureId: result.writerTenureId,
      epoch: '1',
      commandUuid: '00000000-0000-4000-8000-000000000004',
      invocationId: 'fixture-invocation',
    },
    body: {
      adapter: 'ink',
      hostMode: 'server_hosted',
      attemptId: null,
      deadlineAt: null,
      execution: { kind: 'unverified', reasonCode: 'unsupported' },
    },
  };
}

describe('D1 journal record snapshot', () => {
  it('matches existing projection text/reason/PID bounds rather than deferring overflow to SQL', () => {
    const binding = spawn('provider_spawn_binding');
    const body = {
      kind: 'process_binding',
      pid: 2_147_483_647,
      startIdentity: 'x'.repeat(200),
      containment: { kind: 'unknown' },
    };
    expect(freezeJournalEntry({ ...binding, body }, 4096).entry.body.pid).toBe(2_147_483_647);
    expect(() =>
      freezeJournalEntry({ ...binding, body: { ...body, pid: 2_147_483_648 } }, 4096)
    ).toThrow('invalid_entry');
    expect(() =>
      freezeJournalEntry({ ...binding, body: { ...body, startIdentity: 'x'.repeat(201) } }, 4096)
    ).toThrow('invalid_entry');
    expect(() =>
      freezeJournalEntry(
        {
          ...binding,
          body: {
            ...body,
            containment: { kind: 'process_group', pgid: 2_147_483_648, evidenceRef: 'fixture' },
          },
        },
        4096
      )
    ).toThrow('invalid_entry');
    const observation = spawn('provider_spawn_observation');
    expect(
      freezeJournalEntry(
        { ...observation, body: { kind: 'unknown', reasonCode: 'x'.repeat(100) } },
        4096
      ).entry.body.kind
    ).toBe('unknown');
    for (const reasonCode of ['x'.repeat(101), 'Uppercase', 'path/reason', 'free form']) {
      expect(() =>
        freezeJournalEntry({ ...observation, body: { kind: 'unknown', reasonCode } }, 4096)
      ).toThrow('invalid_entry');
    }
    const original = spawn();
    expect(() =>
      freezeJournalEntry(
        {
          ...original,
          body: { ...original.body, execution: { kind: 'unverified', reasonCode: 'Uppercase' } },
        },
        4096
      )
    ).toThrow('invalid_entry');
  });
  it('detaches and deeply freezes data, canonicalizes key order, and preserves replay fields', () => {
    const original = entry();
    original.body = { nested: { z: 1, a: ['x'] } };
    const frozen = freezeJournalEntry(original, 4096);
    (original.body.nested as { z: number }).z = 9;
    expect(frozen.entry.body).toEqual({ nested: { a: ['x'], z: 1 } });
    expect(Object.isFrozen(frozen.entry.body.nested)).toBe(true);
    expect(() => {
      (frozen.entry.body.nested as { z: number }).z = 3;
    }).toThrow();
    const reordered = { ...frozen.entry, body: { nested: { z: 1, a: ['x'] } } };
    expect(freezeJournalEntry(reordered, 4096).json).toBe(frozen.json);
    expect(journalReplayEvent(frozen.entry)).toEqual({
      eid: 1,
      ts: original.ts,
      type: 'assistant',
      nested: { a: ['x'], z: 1 },
    });
  });

  it.each([
    undefined,
    NaN,
    Infinity,
    -Infinity,
    -0,
    1n,
    () => 1,
    Symbol('x'),
    new Date(),
    new Map(),
    new Set(),
    /x/,
    '\u0000',
    '\ud800',
    '\udc00',
  ])('refuses lossy or non-JSON payload %#', (bad) => {
    expect(() => freezeJournalEntry({ ...entry(), body: { value: bad } }, 4096)).toThrow(
      'invalid_entry'
    );
  });

  it('does not execute getters or toJSON; refuses hidden/symbol fields, cycles and array extras', () => {
    let called = false;
    const getter = Object.defineProperty({}, 'x', {
      enumerable: true,
      get() {
        called = true;
        return 1;
      },
    });
    const toJSON = {
      toJSON() {
        called = true;
        return {};
      },
    };
    const hidden = Object.defineProperty({}, 'x', { value: 1 });
    const symbol = { [Symbol('x')]: 1 };
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const extra = Object.assign(['a'], { extra: 'b' });
    for (const bad of [
      getter,
      toJSON,
      hidden,
      symbol,
      cycle,
      extra,
      Array(2),
      Object.create({ x: 1 }),
    ]) {
      expect(() => freezeJournalEntry({ ...entry(), body: { value: bad } }, 4096)).toThrow(
        'invalid_entry'
      );
    }
    expect(called).toBe(false);
  });

  it('bounds depth, node count and UTF-8 bytes without truncation', () => {
    let deep: unknown = null;
    for (let i = 0; i < 66; i++) deep = [deep];
    expect(() => canonicalJournalJson(deep, 4096)).toThrow('invalid_entry');
    expect(() => canonicalJournalJson(Array(100_001).fill(0), 1_000_000)).toThrow('invalid_entry');
    expect(canonicalJournalJson('🌱', 6)).toBe('"🌱"');
    expect(() => canonicalJournalJson('🌱', 5)).toThrow('entry_too_large');
    const frozen = freezeJournalEntry({ ...entry(), body: { text: '🌱' } }, 4096);
    expect(freezeJournalEntry(frozen.entry, frozen.bytes).bytes).toBe(frozen.bytes);
    expect(() => freezeJournalEntry(frozen.entry, frozen.bytes - 1)).toThrow('entry_too_large');
  });

  it.each([
    'eid',
    'ts',
    'type',
    'version',
    'journalId',
    'sessionId',
    'writerTenureId',
    'hostInstanceId',
    'target',
    'body',
  ])('refuses payload-owned envelope key %s', (key) => {
    expect(() => freezeJournalEntry({ ...entry(), body: { [key]: null } }, 4096)).toThrow(
      'invalid_entry'
    );
  });
  it.each([0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])('refuses unsafe eid %s', (eid) => {
    expect(() => freezeJournalEntry({ ...entry(), eid }, 4096)).toThrow('invalid_entry');
  });
  it.each(['2026-02-30T00:00:00.000Z', '2026-01-01T00:00:00Z', 'yesterday'])(
    'refuses non-round-tripping timestamp %s',
    (ts) => {
      expect(() => freezeJournalEntry({ ...entry(), ts }, 4096)).toThrow('invalid_entry');
    }
  );
  it('refuses raw JSON and unknown envelope/critical fields', () => {
    expect(() => freezeJournalEntry(JSON.stringify(entry()), 4096)).toThrow();
    expect(() => freezeJournalEntry({ ...entry(), surprise: true }, 4096)).toThrow();
    expect(() =>
      freezeJournalEntry({ ...spawn(), body: { ...spawn().body, args: 'not allowed' } }, 4096)
    ).toThrow();
    expect(() => freezeJournalEntry(spawn('provider_spawn_unrecognized'), 4096)).toThrow();
    expect(() => freezeJournalEntry({ ...spawn(), target: null }, 4096)).toThrow();
  });

  it('separates intent, process identity, transcript identity and observation strengths', () => {
    expect(freezeJournalEntry(spawn(), 4096).entry.type).toBe('provider_spawn_intent');
    const bodies = [
      {
        kind: 'process_binding',
        pid: 123,
        startIdentity: 'start-1',
        containment: { kind: 'unknown' },
      },
      {
        kind: 'process_binding',
        pid: 123,
        startIdentity: 'start-1',
        containment: { kind: 'process_group', pgid: 123, evidenceRef: 'group-proof' },
      },
      {
        kind: 'process_binding',
        pid: 123,
        startIdentity: 'start-1',
        containment: { kind: 'attested_tree', identity: 'tree-1', evidenceRef: 'tree-proof' },
      },
      { kind: 'transcript_binding', providerTranscriptId: 'transcript-1' },
    ];
    for (const body of bodies)
      expect(
        freezeJournalEntry({ ...spawn('provider_spawn_binding'), body }, 4096).entry.body
      ).toEqual(body);
    for (const kind of [
      'parent_exited',
      'group_empty',
      'tree_quiescent',
      'not_spawned',
      'child_alive',
      'contradiction',
    ]) {
      expect(
        freezeJournalEntry(
          { ...spawn('provider_spawn_observation'), body: { kind, evidenceRef: 'checked-ref' } },
          4096
        ).entry.body.kind
      ).toBe(kind);
      expect(() =>
        freezeJournalEntry({ ...spawn('provider_spawn_observation'), body: { kind } }, 4096)
      ).toThrow();
    }
    expect(() =>
      freezeJournalEntry(
        {
          ...spawn('provider_spawn_binding'),
          body: {
            kind: 'process_binding',
            pid: 0,
            startIdentity: 'start-1',
            containment: { kind: 'unknown' },
          },
        },
        4096
      )
    ).toThrow();
  });

  it('permits only negative observations to target another tenure; the store must verify that target exists', () => {
    const original = spawn('provider_spawn_observation');
    original.target!.tenureId = '00000000-0000-4000-8000-000000000005';
    for (const kind of ['unknown', 'child_alive', 'contradiction']) {
      const body =
        kind === 'unknown'
          ? { kind, reasonCode: 'unverified' }
          : { kind, evidenceRef: 'checked-ref' };
      expect(freezeJournalEntry({ ...original, body }, 4096).entry.target?.tenureId).toBe(
        original.target!.tenureId
      );
    }
    for (const kind of ['parent_exited', 'group_empty', 'tree_quiescent', 'not_spawned']) {
      expect(() =>
        freezeJournalEntry({ ...original, body: { kind, evidenceRef: 'checked-ref' } }, 4096)
      ).toThrow();
    }
    expect(() =>
      freezeJournalEntry({ ...original, type: 'assistant', body: { text: 'x' } }, 4096)
    ).toThrow();
  });
});
