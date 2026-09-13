/**
 * Thread-borne trigger scope (spec inkmail-thread-scope §1a) — the guards
 * Lumen probed on #618 by executing the handler's prefix, now as functions:
 * a shared-workspace member reaches a target another member owns; a sender
 * outside the thread's workspace, a target outside it, a thread that cannot
 * be read, and a thread read that errors are all REFUSED — never degraded to
 * the bare-trigger lane. And the failure notice's legacy lane belongs to the
 * SENDER's owner, not the failed target's.
 */

import { describe, it, expect } from 'vitest';
import { makeFakeSupabase } from './sessions/fake-supabase.js';
import { resolveFailureNoticeAddress, resolveThreadTriggerScope } from './trigger-scope';

const identities = () => [
  { id: 'sb-a', agent_id: 'wren', user_id: 'user-a', workspace_id: 'ws-a' },
  { id: 'sb-b', agent_id: 'lumen', user_id: 'user-b', workspace_id: 'ws-a' },
  { id: 'sb-c', agent_id: 'aster', user_id: 'user-c', workspace_id: 'ws-c' },
];
const world = () =>
  makeFakeSupabase({
    agent_identities: identities(),
    inbox_threads: [{ id: 'thread-a', thread_key: 'pr:618', workspace_id: 'ws-a', status: 'open' }],
    inbox_thread_messages: [{ id: 'msg-1', thread_id: 'thread-a' }],
    workspace_members: [
      { workspace_id: 'ws-a', user_id: 'user-a', role: 'member' },
      { workspace_id: 'ws-a', user_id: 'user-b', role: 'owner' },
    ],
  });

describe('resolveThreadTriggerScope', () => {
  it("a shared member may reach a target with another owner: the owner is the identity's user", async () => {
    const scope = await resolveThreadTriggerScope(world() as never, {
      threadId: 'thread-a',
      toSbId: 'sb-b',
      targetAgentId: 'lumen',
      authUserId: 'user-a',
    });
    expect(scope).toEqual({
      threadId: 'thread-a',
      threadWorkspaceId: 'ws-a',
      userId: 'user-b',
      recipientSbId: 'sb-b',
    });
  });

  it('resolves the thread from the message when only the message is named', async () => {
    const scope = await resolveThreadTriggerScope(world() as never, {
      threadMessageId: 'msg-1',
      toSbId: 'sb-b',
      targetAgentId: 'lumen',
      authUserId: 'user-a',
    });
    expect(scope.threadId).toBe('thread-a');
  });

  it('refuses a sender outside the existing thread workspace', async () => {
    await expect(
      resolveThreadTriggerScope(world() as never, {
        threadId: 'thread-a',
        toSbId: 'sb-b',
        targetAgentId: 'lumen',
        authUserId: 'outsider',
      })
    ).rejects.toThrow('sender is not a member of the thread workspace');
  });

  it('refuses a target outside the existing thread workspace', async () => {
    await expect(
      resolveThreadTriggerScope(world() as never, {
        threadId: 'thread-a',
        toSbId: 'sb-c',
        targetAgentId: 'aster',
        authUserId: 'user-a',
      })
    ).rejects.toThrow('target identity is not in the thread workspace');
  });

  it('refuses a target whose slug is not the one the payload names', async () => {
    await expect(
      resolveThreadTriggerScope(world() as never, {
        threadId: 'thread-a',
        toSbId: 'sb-b',
        targetAgentId: 'wren',
        authUserId: 'user-a',
      })
    ).rejects.toThrow('target identity is "lumen", not "wren"');
  });

  it('fails closed if the named thread cannot be resolved — no foreign owner is selected', async () => {
    await expect(
      resolveThreadTriggerScope(world() as never, {
        threadId: 'missing-thread',
        toSbId: 'sb-b',
        targetAgentId: 'lumen',
        authUserId: 'outsider',
      })
    ).rejects.toThrow('thread could not be resolved');
  });

  it('fails closed if the thread read returns an error', async () => {
    const db = world();
    const from = db.from.bind(db);
    db.from = ((table: string) => {
      const q = from(table);
      if (table === 'inbox_threads') {
        q.select = (() => ({
          eq: () => ({ single: async () => ({ data: null, error: { message: 'read failed' } }) }),
        })) as never;
      }
      return q;
    }) as never;
    await expect(
      resolveThreadTriggerScope(db as never, {
        threadId: 'thread-a',
        toSbId: 'sb-b',
        targetAgentId: 'lumen',
        authUserId: 'outsider',
      })
    ).rejects.toThrow('thread could not be resolved');
  });

  it('fails closed if the message that names the thread cannot be resolved', async () => {
    await expect(
      resolveThreadTriggerScope(world() as never, {
        threadMessageId: 'no-such-message',
        toSbId: 'sb-b',
        targetAgentId: 'lumen',
        authUserId: 'user-a',
      })
    ).rejects.toThrow('thread message could not be resolved');
  });

  it('a bare thread trigger (no canonical target) still requires membership and returns no owner', async () => {
    expect(
      await resolveThreadTriggerScope(world() as never, {
        threadId: 'thread-a',
        targetAgentId: 'lumen',
        authUserId: 'user-a',
      })
    ).toEqual({ threadId: 'thread-a', threadWorkspaceId: 'ws-a' });
    await expect(
      resolveThreadTriggerScope(world() as never, {
        threadId: 'thread-a',
        targetAgentId: 'lumen',
        authUserId: 'outsider',
      })
    ).rejects.toThrow('sender is not a member');
  });
});

describe('resolveFailureNoticeAddress', () => {
  it("separates the target's owner (attribution) from the sender's owner (the legacy lane)", async () => {
    expect(
      await resolveFailureNoticeAddress(world() as never, {
        threadId: 'thread-a',
        toSbId: 'sb-b',
        fromSbId: 'sb-a',
      })
    ).toEqual({
      threadId: 'thread-a',
      threadWorkspaceId: 'ws-a',
      targetOwnerUserId: 'user-b',
      senderOwnerUserId: 'user-a',
    });
  });

  it('a person or the system as sender has no legacy lane: no sender owner', async () => {
    const address = await resolveFailureNoticeAddress(world() as never, {
      threadMessageId: 'msg-1',
      toSbId: 'sb-b',
    });
    expect(address).toEqual({
      threadId: 'thread-a',
      threadWorkspaceId: 'ws-a',
      targetOwnerUserId: 'user-b',
    });
    expect(address.senderOwnerUserId).toBeUndefined();
  });
});
