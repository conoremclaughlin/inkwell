import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  JournalWriter,
  type JournalAppendRequest,
  type JournalEntry,
  type JournalHoldRequest,
  type JournalIdentity,
} from '@inklabs/shared/runtime';
import { ADMISSION_PROTOCOL } from './command-admission';
import { tenureCapabilityHash } from './tenure-admission';
import { SessionJournalStore, SessionJournalStoreError } from './session-journal-store';

const identity: JournalIdentity = {
  sessionId: '00000000-0000-4000-8000-000000000001',
  journalId: '00000000-0000-4000-8000-000000000002',
  writerTenureId: '00000000-0000-4000-8000-000000000003',
  hostInstanceId: 'fixture-host',
};
const capability = 'synthetic-holder-secret-not-for-the-journal';
const ts = '2026-10-05T01:00:00.000Z';
function entry(eid = 1): JournalEntry {
  return {
    ...identity,
    version: 1,
    eid,
    ts,
    type: 'assistant',
    target: null,
    body: { text: 'hello' },
  };
}
function request(eid = 1): JournalAppendRequest {
  return { expectedCommittedEid: eid - 1, entry: entry(eid) };
}
function hold(): JournalHoldRequest {
  return { ...identity, reasonCode: 'append_failed' };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function fixture() {
  const rpc = vi.fn(
    async (name: string, args: Record<string, unknown>) =>
      ({
        data:
          name === 'hold_session_journal'
            ? { outcome: 'held', ...identity, reasonCode: args.p_reason_code }
            : {
                outcome: 'committed',
                entry: args.p_entry,
                committedEid: (args.p_entry as JournalEntry).eid,
                projection: (args.p_entry as JournalEntry).type.startsWith('provider_spawn_')
                  ? 'recorded'
                  : 'none',
              },
        error: null,
      }) as { data: unknown; error: unknown }
  );
  const client = { rpc } as unknown as SupabaseClient;
  const mutableIdentity = { ...identity };
  const store = new SessionJournalStore({
    client,
    identity: mutableIdentity,
    capability,
    maxEntryBytes: 4096,
  });
  const writer = new JournalWriter({
    identity,
    store,
    committedEid: 0,
    now: () => ts,
    maxEntryBytes: 4096,
    maxPendingEntries: 4,
    maxPendingBytes: 16384,
  });
  return { rpc, client, store, writer, mutableIdentity };
}

describe('D1 session journal store (mock transport, no live caller)', () => {
  it.each([
    { maxEntryBytes: 0 },
    { maxEntryBytes: 256 * 1024 + 1 },
    { maxEntryBytes: Infinity },
    { capability: '' },
    { capability: 'x'.repeat(4097) },
    { identity: { ...identity, writerTenureId: 'not-a-uuid' } },
    { identity: { ...identity, hostInstanceId: 'x'.repeat(201) } },
    { identity: { ...identity, secret: capability } },
    { client: {} },
  ])('refuses an invalid bound store before network use', (overrides) => {
    const { client, rpc } = fixture();
    expect(
      () =>
        new SessionJournalStore({
          client,
          identity,
          capability,
          maxEntryBytes: 4096,
          ...overrides,
        } as ConstructorParameters<typeof SessionJournalStore>[0])
    ).toThrow(SessionJournalStoreError);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('binds the full authority, hashes the secret, and makes exactly one atomic append call', async () => {
    const { store, rpc } = fixture();
    await store.append(request());
    expect(rpc).toHaveBeenCalledExactlyOnceWith('append_session_journal', {
      p_session_id: identity.sessionId,
      p_tenure_id: identity.writerTenureId,
      p_host_instance_id: identity.hostInstanceId,
      p_journal_id: identity.journalId,
      p_capability_hash: tenureCapabilityHash(capability),
      p_protocol: ADMISSION_PROTOCOL,
      p_expected_committed_eid: 0,
      p_entry: entry(),
    });
    expect(JSON.stringify(rpc.mock.calls)).not.toContain(capability);
    // Private fields prevent a diagnostic JSON.stringify from exposing client credentials.
    expect(JSON.stringify(store)).toBe('{}');
  });

  it('detaches identity and entry before the first await', async () => {
    const { store, rpc, mutableIdentity } = fixture();
    const pending = deferred<{ data: unknown; error: unknown }>();
    rpc.mockImplementationOnce(() => pending.promise);
    mutableIdentity.hostInstanceId = 'another-host';
    const input = request();
    const response = store.append(input);
    input.entry.body.text = 'changed-after-send';
    expect((rpc.mock.calls[0][1].p_entry as JournalEntry).body.text).toBe('hello');
    expect(Object.isFrozen(rpc.mock.calls[0][1].p_entry)).toBe(true);
    expect(rpc.mock.calls[0][1].p_host_instance_id).toBe(identity.hostInstanceId);
    pending.resolve({ data: { outcome: 'refused', reasonCode: 'not_holder' }, error: null });
    await response;
  });

  it.each(['journalId', 'sessionId', 'writerTenureId', 'hostInstanceId'] as const)(
    'refuses cross-identity %s before sending append or hold',
    async (field) => {
      const { store, rpc } = fixture();
      const changed =
        field === 'hostInstanceId' ? 'different' : '00000000-0000-4000-8000-000000000009';
      const input = request();
      const wrong = { ...input, entry: { ...input.entry, [field]: changed } };
      await expect(store.append(wrong)).rejects.toMatchObject({ code: 'invalid_request' });
      await expect(store.hold({ ...hold(), [field]: changed })).rejects.toMatchObject({
        code: 'invalid_request',
      });
      expect(rpc).not.toHaveBeenCalled();
    }
  );

  it.each([-1, 0.5, 2, Number.MAX_SAFE_INTEGER + 1, NaN])(
    'refuses non-contiguous/invalid expected cursor %s',
    async (expectedCommittedEid) => {
      const { store, rpc } = fixture();
      await expect(store.append({ ...request(), expectedCommittedEid })).rejects.toMatchObject({
        code: 'invalid_request',
      });
      expect(rpc).not.toHaveBeenCalled();
    }
  );

  it('refuses extra fields, lossy objects, getters and oversize payloads without calling transport', async () => {
    const { store, rpc } = fixture();
    const getter = vi.fn(() => 'secret');
    const badBody = Object.defineProperty({}, 'text', { get: getter, enumerable: true });
    const badInputs: unknown[] = [
      { ...request(), secret: capability },
      { ...request(), entry: { ...entry(), extra: true } },
      { ...request(), entry: { ...entry(), body: { value: undefined } } },
      { ...request(), entry: { ...entry(), body: badBody } },
      { ...request(), entry: { ...entry(), body: { text: 'x'.repeat(4096) } } },
      null,
    ];
    for (const input of badInputs)
      await expect(store.append(input as JournalAppendRequest)).rejects.toMatchObject({
        code: 'invalid_request',
      });
    expect(getter).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('requests a set-only hold under the same holder, never a release', async () => {
    const { store, rpc } = fixture();
    expect(await store.hold(hold())).toEqual({ outcome: 'held', ...hold() });
    expect(rpc).toHaveBeenCalledExactlyOnceWith('hold_session_journal', {
      p_session_id: identity.sessionId,
      p_tenure_id: identity.writerTenureId,
      p_host_instance_id: identity.hostInstanceId,
      p_journal_id: identity.journalId,
      p_capability_hash: tenureCapabilityHash(capability),
      p_protocol: ADMISSION_PROTOCOL,
      p_reason_code: 'append_failed',
    });
  });

  it.each([
    { ...hold(), reasonCode: 'caller-free-text' },
    { ...hold(), reasonCode: undefined },
    { ...hold(), evidence: 'extra' },
    null,
  ])('rejects a malformed hold', async (input) => {
    const { store, rpc } = fixture();
    await expect(store.hold(input as JournalHoldRequest)).rejects.toMatchObject({
      code: 'invalid_request',
    });
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each(['throws', 'rpc-error'] as const)(
    'keeps %s ambiguous, sanitized and non-retried',
    async (mode) => {
      const { store, rpc } = fixture();
      const sensitive = `db-error ${capability}`;
      if (mode === 'throws') rpc.mockRejectedValueOnce(new Error(sensitive));
      else
        rpc.mockResolvedValueOnce({
          data: { outcome: 'committed' },
          error: { message: sensitive },
        });
      const error = await store.append(request()).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(SessionJournalStoreError);
      expect(error).toMatchObject({ code: 'transport_failed' });
      expect(String(error)).not.toContain(capability);
      expect(error).not.toHaveProperty('cause');
      expect(rpc).toHaveBeenCalledTimes(1);
    }
  );

  it('bounds and snapshots untrusted replies without interpreting them as commits', async () => {
    const { store, rpc } = fixture();
    const data = { outcome: 'refused', reasonCode: 'capacity_hold' };
    rpc.mockResolvedValueOnce({ data, error: null });
    const result = await store.append(request());
    data.reasonCode = 'mutated';
    expect(result).toEqual({ outcome: 'refused', reasonCode: 'capacity_hold' });
    rpc.mockResolvedValueOnce({ data: { text: 'x'.repeat(7000) }, error: null });
    await expect(store.append(request())).rejects.toMatchObject({ code: 'invalid_reply' });
  });

  it('lets the writer verify a real-shaped committed receipt', async () => {
    const { writer, rpc } = fixture();
    const receipt = await writer.append({
      type: 'assistant',
      target: null,
      body: { text: 'hello' },
    });
    expect(receipt).toEqual({
      outcome: 'committed',
      entry: entry(),
      committedEid: 1,
      projection: 'none',
    });
    expect(writer.committedEid).toBe(1);
    expect(writer.failure).toBeUndefined();
    await writer.close();
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('accepts an exact receipt behind the current head only as evidence, then stops the writer', async () => {
    const { writer, rpc } = fixture();
    rpc.mockImplementationOnce(async (_name, args) => ({
      data: {
        outcome: 'already_committed',
        entry: args.p_entry,
        committedEid: 2,
        projection: 'none',
      },
      error: null,
    }));
    const receipt = await writer.append({
      type: 'assistant',
      target: null,
      body: { text: 'hello' },
    });
    expect(receipt.outcome).toBe('already_committed');
    expect(receipt.committedEid).toBe(2);
    expect(writer.committedEid).toBe(1);
    await expect(writer.flush()).rejects.toMatchObject({ code: 'head_advanced' });
    expect(writer.failure).toEqual({ code: 'head_advanced', hold: 'confirmed' });
    expect(rpc.mock.calls.map(([name]) => name)).toEqual([
      'append_session_journal',
      'hold_session_journal',
    ]);
  });

  it('does not retry a lost commit response: the writer stops and requests the hold once', async () => {
    const { writer, rpc } = fixture();
    rpc.mockRejectedValueOnce(new Error('lost after database commit'));
    const first = writer.append({ type: 'assistant', target: null, body: { text: 'first' } });
    const second = writer.append({ type: 'assistant', target: null, body: { text: 'second' } });
    await expect(first).rejects.toMatchObject({ code: 'append_failed' });
    await expect(second).rejects.toMatchObject({ code: 'append_failed' });
    await expect(writer.flush()).rejects.toMatchObject({ code: 'append_failed' });
    expect(writer.committedEid).toBe(0);
    expect(writer.failure).toEqual({ code: 'append_failed', hold: 'confirmed' });
    expect(rpc.mock.calls.map(([name]) => name)).toEqual([
      'append_session_journal',
      'hold_session_journal',
    ]);
  });

  it('preserves a held negative fact as a commit, then stops further appends', async () => {
    const { writer, rpc } = fixture();
    rpc.mockImplementationOnce(async (_name, args) => ({
      data: {
        outcome: 'committed',
        entry: args.p_entry,
        committedEid: 1,
        projection: 'needs_reconciler',
      },
      error: null,
    }));
    const receipt = await writer.append({
      type: 'provider_spawn_observation',
      target: {
        tenureId: identity.writerTenureId,
        epoch: 'epoch-1',
        commandUuid: '00000000-0000-4000-8000-000000000004',
        invocationId: 'inv-1',
      },
      body: { kind: 'unknown', reasonCode: 'binding_lost' },
    });
    expect(receipt.outcome).toBe('committed');
    expect(writer.committedEid).toBe(1);
    await expect(writer.flush()).rejects.toMatchObject({ code: 'projection_held' });
    expect(writer.failure).toEqual({ code: 'projection_held', hold: 'confirmed' });
  });

  it.each(['wrong-entry', 'wrong-head', 'malformed', 'refused'])(
    'never blesses a %s response',
    async (kind) => {
      const { writer, rpc } = fixture();
      const good = { outcome: 'committed', entry: entry(), committedEid: 1, projection: 'none' };
      const data =
        kind === 'wrong-entry'
          ? { ...good, entry: { ...entry(), body: { text: 'different' } } }
          : kind === 'wrong-head'
            ? { ...good, committedEid: 20 }
            : kind === 'refused'
              ? { outcome: 'refused', reasonCode: 'not_holder' }
              : { outcome: 'committed' };
      rpc.mockResolvedValueOnce({ data, error: null });
      await expect(
        writer.append({ type: 'assistant', target: null, body: { text: 'hello' } })
      ).rejects.toThrow();
      await expect(writer.flush()).rejects.toThrow();
      expect(writer.committedEid).toBe(0);
      expect(rpc).toHaveBeenCalledTimes(2);
    }
  );

  it.each(['wrong-echo', 'refused', 'throw'])('keeps a %s hold unconfirmed', async (kind) => {
    const { writer, rpc } = fixture();
    rpc.mockRejectedValueOnce(new Error('lost append'));
    if (kind === 'throw') rpc.mockRejectedValueOnce(new Error('lost hold'));
    else
      rpc.mockResolvedValueOnce({
        data:
          kind === 'refused'
            ? { outcome: 'refused', reasonCode: 'not_holder' }
            : {
                outcome: 'held',
                ...hold(),
                writerTenureId: '00000000-0000-4000-8000-000000000009',
              },
        error: null,
      });
    await expect(writer.append({ type: 'assistant', target: null, body: {} })).rejects.toThrow();
    await expect(writer.flush()).rejects.toThrow();
    expect(writer.failure).toEqual({ code: 'append_failed', hold: 'unconfirmed' });
    expect(rpc).toHaveBeenCalledTimes(2);
  });
});
