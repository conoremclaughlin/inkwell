import { describe, expect, it, vi } from 'vitest';
import {
  JournalWriter,
  type JournalAppendRequest,
  type JournalHoldRequest,
  type JournalStore,
  type JournalWriterOptions,
} from './journal-writer.js';
import type { JournalIdentity, JournalRecord } from './journal-record.js';

const identity: JournalIdentity = {
  journalId: '00000000-0000-4000-8000-000000000001',
  sessionId: '00000000-0000-4000-8000-000000000002',
  writerTenureId: '00000000-0000-4000-8000-000000000003',
  hostInstanceId: 'fixture-host',
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function ack(request: JournalAppendRequest) {
  return {
    outcome: 'committed',
    entry: request.entry,
    committedEid: request.entry.eid,
    projection: request.entry.type.startsWith('provider_spawn_') ? 'recorded' : 'none',
  };
}
function fixture(overrides: Partial<JournalWriterOptions> = {}) {
  const append = vi.fn(async (request: JournalAppendRequest): Promise<unknown> => ack(request));
  const hold = vi.fn(
    async (request: Readonly<JournalHoldRequest>): Promise<unknown> => ({
      outcome: 'held',
      ...request,
    })
  );
  const writer = new JournalWriter({
    identity: { ...identity },
    committedEid: 0,
    store: { append, hold },
    now: () => '2026-01-01T00:00:00.000Z',
    maxEntryBytes: 4096,
    maxPendingEntries: 4,
    maxPendingBytes: 16384,
    ...overrides,
  });
  return { writer, append, hold };
}
function record(text = 'fixture'): JournalRecord {
  return { type: 'assistant', target: null, body: { text } };
}
function intent(): JournalRecord {
  return {
    type: 'provider_spawn_intent',
    target: {
      tenureId: identity.writerTenureId,
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

describe('D1 bounded journal writer (fake store only)', () => {
  it.each(['depth', 'nodes'])(
    'does not count receipt wrappers against a valid entry %s limit',
    async (boundary) => {
      const { writer } = fixture({ maxEntryBytes: 256 * 1024, maxPendingBytes: 1024 * 1024 });
      let nested: import('./journal-record.js').JournalJson = 'leaf';
      for (let i = 0; i < 62; i++) nested = { child: nested };
      const body: JournalRecord['body'] =
        boundary === 'depth' ? { nested } : { values: Array(99_988).fill(0) };
      expect((await writer.append({ type: 'assistant', target: null, body })).entry.body).toEqual(
        body
      );
      expect(writer.committedEid).toBe(1);
      expect(writer.failure).toBeUndefined();
    }
  );

  it('serializes writes, freezes at admission, and exposes only committed cursors', async () => {
    const gate = deferred<unknown>();
    const { writer, append } = fixture();
    append.mockImplementationOnce(() => gate.promise);
    const firstRecord = record('first');
    const first = writer.append(firstRecord);
    const second = writer.append(record('second'));
    firstRecord.body.text = 'mutated';
    expect(writer.committedEid).toBe(0);
    expect(writer.pendingEntries).toBe(2);
    await Promise.resolve();
    expect(append).toHaveBeenCalledTimes(1);
    const sent = append.mock.calls[0][0];
    expect(sent.expectedCommittedEid).toBe(0);
    expect(sent.entry.body.text).toBe('first');
    expect(Object.isFrozen(sent.entry)).toBe(true);
    gate.resolve(ack(sent));
    expect((await first).entry.eid).toBe(1);
    expect((await second).entry.eid).toBe(2);
    await writer.flush();
    expect(append.mock.calls[1][0].expectedCommittedEid).toBe(1);
    expect(writer.committedEid).toBe(2);
    expect(writer.pendingEntries).toBe(0);
    expect(writer.pendingBytes).toBe(0);
  });

  it('lets an independent session progress while another store is stalled', async () => {
    const gate = deferred<unknown>();
    const slow = fixture();
    slow.append.mockImplementationOnce(() => gate.promise);
    const first = slow.writer.append(record());
    await Promise.resolve();
    const fast = fixture();
    expect((await fast.writer.append(record())).entry.eid).toBe(1);
    expect(slow.writer.committedEid).toBe(0);
    gate.resolve(ack(slow.append.mock.calls[0][0]));
    await first;
  });

  it.each(['async', 'sync'])(
    'stops on %s store failure, never sends the queued negative record, confirms one hold',
    async (kind) => {
      const { writer, append, hold } = fixture();
      append.mockImplementationOnce(() => {
        if (kind === 'sync') throw new Error('private store detail');
        return Promise.reject(new Error('private store detail'));
      });
      const first = writer.append(record());
      const second = writer.append({
        ...intent(),
        type: 'provider_spawn_observation',
        body: { kind: 'unknown', reasonCode: 'lost_ack' },
      });
      await expect(first).rejects.toThrow('append_failed');
      await expect(second).rejects.toThrow('append_failed');
      await expect(writer.flush()).rejects.toThrow('append_failed');
      expect(writer.failure).toEqual({ code: 'append_failed', hold: 'confirmed' });
      expect(append).toHaveBeenCalledTimes(1);
      expect(hold).toHaveBeenCalledTimes(1);
      expect(writer.committedEid).toBe(0);
      await expect(writer.append(record())).rejects.toThrow('append_failed');
      expect(append).toHaveBeenCalledTimes(1);
      expect(writer.pendingEntries).toBe(0);
    }
  );

  it('bounds queued + in-flight count and remains stopped even when the active append commits', async () => {
    const gate = deferred<unknown>();
    const { writer, append, hold } = fixture({ maxPendingEntries: 2 });
    append.mockImplementationOnce(() => gate.promise);
    const first = writer.append(record());
    await Promise.resolve();
    const second = writer.append(record());
    await expect(writer.append(record())).rejects.toThrow('queue_capacity');
    await expect(second).rejects.toThrow('queue_capacity');
    expect(writer.pendingEntries).toBe(1);
    expect(append).toHaveBeenCalledTimes(1);
    gate.resolve(ack(append.mock.calls[0][0]));
    await first;
    await expect(writer.flush()).rejects.toThrow('queue_capacity');
    expect(writer.committedEid).toBe(1);
    expect(writer.failure?.hold).toBe('confirmed');
    expect(hold).toHaveBeenCalledTimes(1);
  });

  it('counts encoded bytes independently and refuses before reserving/sending', async () => {
    const gate = deferred<unknown>();
    const { writer, append } = fixture({ maxPendingBytes: 650 });
    append.mockImplementationOnce(() => gate.promise);
    const first = writer.append(record('🌱'.repeat(60)));
    await Promise.resolve();
    expect(writer.pendingBytes).toBeGreaterThan(500);
    await expect(writer.append(record())).rejects.toThrow('queue_capacity');
    gate.resolve(ack(append.mock.calls[0][0]));
    await first;
    await expect(writer.flush()).rejects.toThrow('queue_capacity');
    expect(append).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['entry_too_large', () => record('x'.repeat(5000))],
    ['invalid_entry', () => ({ ...record(), eid: 99 })],
    ['invalid_entry', () => ({ ...record(), body: { ts: 'override' } })],
  ] as const)('makes %s sticky and requests a hold without any append', async (code, invalid) => {
    const { writer, append, hold } = fixture();
    await expect(writer.append(invalid())).rejects.toThrow(code);
    await expect(writer.flush()).rejects.toThrow(code);
    expect(writer.failure?.hold).toBe('confirmed');
    expect(append).not.toHaveBeenCalled();
    expect(hold).toHaveBeenCalledTimes(1);
    expect(writer.committedEid).toBe(0);
  });

  it.each(['throw', 'wrong_identity', 'extra_field'])(
    'does not claim a durable hold on %s',
    async (kind) => {
      const { writer, append, hold } = fixture();
      append.mockRejectedValueOnce(new Error('lost ack'));
      hold.mockImplementationOnce(async (request) => {
        if (kind === 'throw') throw new Error('unavailable');
        return kind === 'extra_field'
          ? { outcome: 'held', ...request, extra: true }
          : { outcome: 'held', ...request, journalId: 'different-journal' };
      });
      await expect(writer.append(record())).rejects.toThrow('append_failed');
      await expect(writer.close()).rejects.toThrow('append_failed');
      expect(writer.failure?.hold).toBe('unconfirmed');
    }
  );

  it.each([
    'changed_body',
    'changed_writer',
    'wrong_eid',
    'low_head',
    'unsafe_head',
    'new_commit_higher_head',
    'unknown_projection',
    'extra_field',
    'missing_projection',
  ])('refuses invalid receipt: %s', async (kind) => {
    const { writer, append } = fixture();
    append.mockImplementationOnce(async (request) => {
      const reply = ack(request);
      switch (kind) {
        case 'changed_body':
          return { ...reply, entry: { ...request.entry, body: { text: 'other' } } };
        case 'changed_writer':
          return {
            ...reply,
            entry: { ...request.entry, writerTenureId: '00000000-0000-4000-8000-000000000009' },
          };
        case 'wrong_eid':
          return { ...reply, entry: { ...request.entry, eid: 2 } };
        case 'low_head':
          return { ...reply, committedEid: 0 };
        case 'unsafe_head':
          return { ...reply, committedEid: Number.MAX_SAFE_INTEGER + 1 };
        case 'new_commit_higher_head':
          return { ...reply, committedEid: 2 };
        case 'unknown_projection':
          return { ...reply, projection: 'safe_to_spawn' };
        case 'extra_field':
          return { ...reply, accepted: true };
        default:
          return { outcome: 'committed', entry: request.entry, committedEid: 1 };
      }
    });
    await expect(writer.append(record())).rejects.toThrow('invalid_receipt');
    await expect(writer.flush()).rejects.toThrow('invalid_receipt');
    expect(writer.committedEid).toBe(0);
  });

  it('requires critical atomic projection, accepts a stored contradiction as fact and stops later writes', async () => {
    const missing = fixture();
    missing.append.mockImplementationOnce(async (r) => ({ ...ack(r), projection: 'none' }));
    await expect(missing.writer.append(intent())).rejects.toThrow('invalid_receipt');
    const { writer, append } = fixture();
    append.mockImplementationOnce(async (r) => ({ ...ack(r), projection: 'contradiction' }));
    const first = writer.append({
      ...intent(),
      type: 'provider_spawn_observation',
      body: { kind: 'child_alive', evidenceRef: 'checked-ref' },
    });
    const queued = writer.append(record());
    expect((await first).projection).toBe('contradiction');
    await expect(queued).rejects.toThrow('projection_held');
    await expect(writer.flush()).rejects.toThrow('projection_held');
    expect(writer.committedEid).toBe(1);
    expect(append).toHaveBeenCalledTimes(1);
  });

  it('keeps exact-retry receipt eid separate from later store head and will not fill/reuse those slots', async () => {
    const { writer, append } = fixture();
    append.mockImplementationOnce(async (r) => ({
      ...ack(r),
      outcome: 'already_committed',
      committedEid: 8,
    }));
    const first = writer.append(record());
    const second = writer.append(record());
    const receipt = await first;
    expect(receipt.entry.eid).toBe(1);
    expect(receipt.committedEid).toBe(8);
    expect(writer.committedEid).toBe(1);
    await expect(second).rejects.toThrow('head_advanced');
    await expect(writer.flush()).rejects.toThrow('head_advanced');
    expect(append).toHaveBeenCalledTimes(1);
  });

  it('compares full normalized entries on exact retry, not key order or a digest alone', async () => {
    const { writer, append } = fixture();
    append.mockImplementationOnce(async (r) => ({
      ...ack(r),
      outcome: 'already_committed',
      entry: { ...r.entry, body: { b: 2, a: 1 } },
    }));
    const receipt = await writer.append({ ...record(), body: { a: 1, b: 2 } });
    expect(receipt.outcome).toBe('already_committed');
    await writer.flush();
    expect(writer.committedEid).toBe(1);
  });

  it('treats a store refusal as a stopped writer, not a safe dispatch or retry signal', async () => {
    const { writer, append } = fixture();
    append.mockResolvedValueOnce({ outcome: 'refused', reason: 'not_holder' });
    await expect(writer.append(intent())).rejects.toThrow('store_refused');
    await expect(writer.flush()).rejects.toThrow('store_refused');
    expect(writer.committedEid).toBe(0);
  });

  it('close drains admitted writes, refuses new intake, and does not release tenure', async () => {
    const gate = deferred<unknown>();
    const { writer, append, hold } = fixture();
    append.mockImplementationOnce(() => gate.promise);
    const first = writer.append(record());
    const second = writer.append(record());
    await Promise.resolve();
    const closing = writer.close();
    await expect(writer.append(record())).rejects.toThrow('closed');
    gate.resolve(ack(append.mock.calls[0][0]));
    await Promise.all([first, second, closing]);
    expect(writer.committedEid).toBe(2);
    expect(hold).not.toHaveBeenCalled();
  });

  it('validates configuration, detaches identity, and refuses eid exhaustion before dispatch', async () => {
    for (const bad of [0, -1, 1.5, Infinity, NaN])
      expect(() => fixture({ maxPendingBytes: bad })).toThrow();
    expect(() => fixture({ committedEid: -1 })).toThrow();
    expect(() => fixture({ store: {} as JournalStore })).toThrow();
    const changed = { ...identity };
    const f = fixture({ identity: changed, committedEid: 9 });
    changed.sessionId = 'other';
    expect((await f.writer.append(record())).entry.sessionId).toBe(identity.sessionId);
    expect(f.writer.committedEid).toBe(10);
    const exhausted = fixture({ committedEid: Number.MAX_SAFE_INTEGER });
    await expect(exhausted.writer.append(record())).rejects.toThrow('eid_exhausted');
    await expect(exhausted.writer.flush()).rejects.toThrow();
    expect(exhausted.append).not.toHaveBeenCalled();
  });
});
