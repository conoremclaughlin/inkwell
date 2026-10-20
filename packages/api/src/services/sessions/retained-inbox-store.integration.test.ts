/** Real PostgREST/constraint coverage; only the isolated DB integration project. */
import { randomUUID } from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getDataComposer } from '../../data/composer';
import { ensureEchoIntegrationFixture } from '../../test/integration-fixtures';
import { retainedInboxStore, type RetainedInboxScope } from './retained-inbox-store';

describe('retained inbox delivery database', () => {
  let client: SupabaseClient;
  let scope: RetainedInboxScope;
  const sessionId = randomUUID();
  const threadId = randomUUID();
  const launchId = randomUUID();
  const epoch = 'synthetic:turn-epoch';
  const replacementSessionId = randomUUID();

  beforeAll(async () => {
    const composer = await getDataComposer();
    client = composer.getClient();
    const fixture = await ensureEchoIntegrationFixture(composer);
    scope = { ownerId: fixture.userId, recipientId: fixture.echoSbId, sessionId };
    const session = await client.from('sessions').insert({
      id: sessionId,
      user_id: fixture.userId,
      agent_id: 'echo',
      status: 'active',
    });
    expect(session.error).toBeNull();
    expect(
      (
        await client.from('sessions').insert({
          id: replacementSessionId,
          user_id: fixture.userId,
          agent_id: 'echo',
          status: 'active',
        })
      ).error
    ).toBeNull();
    const thread = await client.from('inbox_threads').insert({
      id: threadId,
      thread_key: `test:retained-${threadId}`,
      workspace_id: fixture.workspaceId,
      created_by_kind: 'sb',
      created_by_sb_id: fixture.echoSbId,
      title: 'Retained input fixture',
    });
    expect(thread.error).toBeNull();
    const launch = await client.from('launched_processes').insert({
      id: launchId,
      session_id: sessionId,
      backend: 'claude-code',
      boot_id: 'synthetic-boot',
      server_instance: 'synthetic-host:4001',
    });
    expect(launch.error).toBeNull();
  });

  afterAll(async () => {
    if (!client) return;
    // Only this suite's rows. Derived references cascade on explicit erasure.
    for (const [table, column, value] of [
      ['sb_inbox_deliveries', 'session_id', sessionId],
      ['launched_processes', 'id', launchId],
      ['inbox_thread_messages', 'thread_id', threadId],
      ['inbox_threads', 'id', threadId],
      ['sessions', 'id', sessionId],
      ['sessions', 'id', replacementSessionId],
    ]) {
      const result = await client.from(table).delete().eq(column, value);
      expect(result.error).toBeNull();
    }
  });

  async function source() {
    const messageId = randomUUID();
    const result = await client.from('inbox_thread_messages').insert({
      id: messageId,
      thread_id: threadId,
      sender_kind: 'system',
      content: 'Synthetic retained source',
      message_type: 'message',
    });
    expect(result.error).toBeNull();
    return { kind: 'thread' as const, messageId };
  }

  it('retains a batch, binds native correlation, and accepts PostgreSQL timestamp acknowledgements', async () => {
    const store = retainedInboxStore(client);
    const inputs = await Promise.all([source(), source(), source()]);
    const rows = await store.retain(scope, inputs);
    expect(rows.map((row) => row.thread_message_id)).toEqual(
      inputs.map((input) => input.messageId)
    );
    const bound = await store.bind(rows[0], {
      launchId,
      turnEpoch: epoch,
      native: { sessionId: 'synthetic-native', inputId: randomUUID() },
    });
    expect(bound.status).toBe('written');
    if (bound.status !== 'written') throw new Error('Binding not acknowledged');
    const settled = await store.settleAfterFinalization(bound.delivery);
    expect(settled).toMatchObject({
      status: 'written',
      delivery: { state: 'settled', revision: 2 },
    });
    const open = await store.listUnsettled(scope);
    expect(open.some((row) => row.id === rows[0].id)).toBe(false);
    expect(open.map((row) => row.id)).toEqual(expect.arrayContaining([rows[1].id, rows[2].id]));
    await expect(store.retain(scope, [inputs[0]])).rejects.toThrow('do not dispatch');
  });

  it('rolls back the entire insert when one source conflicts', async () => {
    const store = retainedInboxStore(client);
    const first = await source();
    const second = await source();
    await store.retain(scope, [first]);
    await expect(store.retain(scope, [second, first])).rejects.toThrow('do not dispatch');
    const result = await client
      .from('sb_inbox_deliveries')
      .select('id')
      .eq('recipient_id', scope.recipientId)
      .eq('thread_message_id', second.messageId);
    expect(result.error).toBeNull();
    expect(result.data).toEqual([]);
  });

  it('allows exactly one binder and one terminal-state writer under concurrent requests', async () => {
    const store = retainedInboxStore(client);
    const [row] = await store.retain(scope, [await source()]);
    const binds = await Promise.all([
      store.bind(row, { launchId, turnEpoch: epoch, native: null }),
      store.bind(row, { launchId, turnEpoch: randomUUID(), native: null }),
    ]);
    expect(binds.map((r) => r.status).sort()).toEqual(['conflict', 'written']);
    const winner = binds.find((r) => r.status === 'written');
    if (!winner || winner.status !== 'written') throw new Error('No binding winner');
    const outcomes = await Promise.all([
      store.hold(winner.delivery),
      store.settleAfterFinalization(winner.delivery),
    ]);
    expect(outcomes.map((r) => r.status).sort()).toEqual(['conflict', 'written']);
  });

  it('rejects missing/contradictory state fields and an unknown source without creating rows', async () => {
    const message = await source();
    const base = {
      owner_id: scope.ownerId,
      recipient_id: scope.recipientId,
      session_id: sessionId,
      thread_message_id: message.messageId,
    };
    const changes = [
      { thread_message_id: null },
      { inbox_message_id: randomUUID() },
      { state: 'bound' },
      { state: 'bound', launch_id: launchId, turn_epoch: '' },
      { state: 'bound', launch_id: launchId, turn_epoch: 'x'.repeat(257) },
      { revision: -1 },
      { launch_id: launchId },
      { native_input_id: randomUUID() },
      { settled_at: new Date().toISOString() },
    ];
    for (const change of changes) {
      const result = await client
        .from('sb_inbox_deliveries')
        .insert({ id: randomUUID(), ...base, ...change });
      expect(result.error?.code).toBe('23514');
    }
    const missing = await client.from('sb_inbox_deliveries').insert({
      id: randomUUID(),
      ...base,
      thread_message_id: randomUUID(),
    });
    expect(missing.error?.code).toBe('23503');
    const remaining = await client
      .from('sb_inbox_deliveries')
      .select('id')
      .eq('thread_message_id', message.messageId);
    expect(remaining.error).toBeNull();
    expect(remaining.data).toEqual([]);
  });

  it('moves only pending sources during session handoff and refuses the old launch attempt', async () => {
    const store = retainedInboxStore(client);
    const [row] = await store.retain(scope, [await source()]);
    const moved = await store.movePending(row, replacementSessionId);
    expect(moved.status).toBe('written');
    if (moved.status !== 'written') throw new Error('Handoff was not confirmed');
    expect(await store.bind(row, { launchId, turnEpoch: epoch, native: null })).toEqual({
      status: 'conflict',
    });
    expect(await store.movePending(row, randomUUID())).toEqual({ status: 'conflict' });
    const open = await store.listUnsettled({ ...scope, sessionId: replacementSessionId });
    expect(open).toEqual([moved.delivery]);
  });

  it('cascades erased source references without marking other sources delivered', async () => {
    const store = retainedInboxStore(client);
    const message = await source();
    const [row] = await store.retain(scope, [message]);
    expect((await store.bind(row, { launchId, turnEpoch: epoch, native: null })).status).toBe(
      'written'
    );
    const [other] = await store.retain(scope, [await source()]);
    expect(
      (await client.from('inbox_thread_messages').delete().eq('id', message.messageId)).error
    ).toBeNull();
    const erased = await client.from('sb_inbox_deliveries').select('id').eq('id', row.id);
    expect(erased.error).toBeNull();
    expect(erased.data).toEqual([]);
    expect(await store.listUnsettled(scope)).toContainEqual(other);
  });
});
