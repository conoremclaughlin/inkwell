/**
 * Lumen's #618 round-1 probes at the send boundary, folded in as regressions
 * (spec inkmail-thread-scope §7 and the checked participant write). These
 * run the real thread handlers over the table-backed fake — nothing in the
 * module is mocked except the user resolver, the request context and the
 * gateway — so what they pin is the handler's behavior, not a mock's.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeFakeSupabase } from '../../services/sessions/fake-supabase';
import { userPrincipal } from '../../services/principals';
import { handleSendToInbox } from './inbox-handlers';
import { handleAddThreadParticipant } from './thread-handlers';
import { getAgentGateway } from '../../channels/agent-gateway';

vi.mock('../../services/user-resolver', async (original) => ({
  ...(await original<typeof import('../../services/user-resolver')>()),
  resolveUserOrThrow: vi.fn().mockResolvedValue({ user: { id: 'user-a' }, resolvedBy: 'userId' }),
}));
vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../utils/request-context', async (original) => ({
  ...(await original<typeof import('../../utils/request-context')>()),
  getRequestContext: vi.fn().mockReturnValue({ userId: 'user-a', sessionId: 'session-a' }),
  getSessionContext: vi.fn().mockReturnValue(undefined),
  getPinnedAgentId: vi.fn().mockReturnValue(undefined),
}));
vi.mock('../../channels/agent-gateway', () => ({
  getAgentGateway: vi.fn().mockReturnValue({
    dispatchTrigger: vi.fn().mockReturnValue({ success: true, accepted: true }),
    processTrigger: vi.fn().mockResolvedValue({ success: true }),
  }),
}));

const identities = [
  { id: 'sb-a', agent_id: 'wren', user_id: 'user-a', workspace_id: 'ws-a' },
  { id: 'sb-b', agent_id: 'lumen', user_id: 'user-b', workspace_id: 'ws-a' },
  { id: 'sb-c', agent_id: 'myra', user_id: 'user-c', workspace_id: 'ws-a' },
];
const thread = {
  id: 'thread-a',
  thread_key: 'pr:618',
  workspace_id: 'ws-a',
  created_by_kind: 'sb',
  created_by_sb_id: 'sb-a',
  metadata: {},
  status: 'open',
};
function client() {
  return makeFakeSupabase({
    agent_identities: identities.map((i) => ({ ...i })),
    inbox_threads: [{ ...thread }],
    inbox_thread_participants: identities.map((i) => ({
      thread_id: 'thread-a',
      workspace_id: 'ws-a',
      sb_id: i.id,
      user_id: null,
      session_id: null,
    })),
    inbox_thread_messages: [],
    inbox_thread_read_status: [],
    workspace_members: [{ workspace_id: 'ws-a', user_id: 'user-a', role: 'member' }],
  });
}
const dispatched = () =>
  vi.mocked(getAgentGateway().dispatchTrigger).mock.calls.map((c) => c[0].toSbId);

beforeEach(() => vi.clearAllMocks());

describe('send boundary (Lumen, #618 round 1)', () => {
  it('does not replace an empty explicit triggerAgents intersection with defaults', async () => {
    const db = client();
    await handleSendToInbox(
      {
        senderAgentId: 'wren',
        recipientAgentId: 'lumen',
        threadKey: 'pr:618',
        content: 'hello',
        triggerAgents: ['nonparticipant'],
      },
      { getClient: () => db } as never
    );
    expect(getAgentGateway().dispatchTrigger).not.toHaveBeenCalled();
  });

  it('the full human send path wakes every SB on an existing thread, not only the addressed one', async () => {
    const db = client();
    await handleSendToInbox(
      { recipientAgentId: 'lumen', threadKey: 'pr:618', content: 'human reply' },
      { getClient: () => db } as never,
      { sender: { principal: userPrincipal('user-a'), workspaceId: 'ws-a' } }
    );
    // Every SB, the addressed one included — order is dispatch order, not a contract.
    expect([...dispatched()].sort()).toEqual(['sb-a', 'sb-b', 'sb-c']);
  });

  it('a failed human participant insert prevents the message insert', async () => {
    const db = client();
    const from = db.from.bind(db);
    const messageInserts: unknown[] = [];
    db.from = ((table: string) => {
      const q = from(table);
      if (table === 'inbox_thread_participants') {
        q.insert = (() =>
          Promise.resolve({
            data: null,
            error: { message: 'injected participant write failure', code: '42501' },
          })) as never;
      }
      if (table === 'inbox_thread_messages') {
        const insert = q.insert.bind(q);
        q.insert = ((row: unknown) => {
          messageInserts.push(row);
          return insert(row as never);
        }) as never;
      }
      return q;
    }) as never;
    await expect(
      handleSendToInbox(
        { recipientAgentId: 'lumen', threadKey: 'pr:618', content: 'human reply', trigger: false },
        { getClient: () => db } as never,
        { sender: { principal: userPrincipal('user-a'), workspaceId: 'ws-a' } }
      )
    ).rejects.toThrow('Failed to add participant');
    expect(messageInserts).toHaveLength(0);
  });

  it('a duplicate-key race on the human participant row is not a failure', async () => {
    const db = client();
    const from = db.from.bind(db);
    db.from = ((table: string) => {
      const q = from(table);
      if (table === 'inbox_thread_participants') {
        q.insert = (() =>
          Promise.resolve({ data: null, error: { message: 'duplicate', code: '23505' } })) as never;
      }
      return q;
    }) as never;
    await handleSendToInbox(
      { recipientAgentId: 'lumen', threadKey: 'pr:618', content: 'human reply', trigger: false },
      { getClient: () => db } as never,
      { sender: { principal: userPrincipal('user-a'), workspaceId: 'ws-a' } }
    );
    const { data: messages } = await db.from('inbox_thread_messages').select('*');
    expect(messages).toHaveLength(1);
  });

  it("an SB's dispatch carries its own identity so a failure notice can find its owner", async () => {
    const db = client();
    await handleSendToInbox(
      { senderAgentId: 'wren', recipientAgentId: 'lumen', threadKey: 'pr:618', content: 'hi' },
      { getClient: () => db } as never
    );
    const payloads = vi.mocked(getAgentGateway().dispatchTrigger).mock.calls.map((c) => c[0]);
    expect(payloads.map((p) => [p.fromSbId, p.toSbId])).toEqual([['sb-a', 'sb-b']]);
  });

  it("an SB adding a participant carries its own identity in the newcomer's trigger (round 2)", async () => {
    const db = makeFakeSupabase({
      agent_identities: identities.map((i) => ({ ...i })),
      inbox_threads: [{ ...thread }],
      inbox_thread_participants: [
        {
          thread_id: 'thread-a',
          workspace_id: 'ws-a',
          sb_id: 'sb-a',
          user_id: null,
          session_id: null,
        },
      ],
      inbox_thread_messages: [],
      workspace_members: [{ workspace_id: 'ws-a', user_id: 'user-a', role: 'member' }],
    });
    await handleAddThreadParticipant(
      { threadKey: 'pr:618', addedByAgentId: 'wren', agentId: 'lumen' },
      { getClient: () => db } as never
    );
    const payloads = vi.mocked(getAgentGateway().dispatchTrigger).mock.calls.map((c) => c[0]);
    expect(payloads.map((p) => [p.fromAgentId, p.fromSbId, p.toSbId])).toEqual([
      ['wren', 'sb-a', 'sb-b'],
    ]);
  });

  it("a viewer's SB is refused at send, and at add_thread_participant, before any row is written", async () => {
    const db = client();
    await db.from('workspace_members').update({ role: 'viewer' }).eq('user_id', 'user-a');
    await expect(
      handleSendToInbox(
        { senderAgentId: 'wren', recipientAgentId: 'lumen', threadKey: 'pr:618', content: 'hi' },
        { getClient: () => db } as never
      )
    ).rejects.toThrow('Your role in this workspace (viewer) cannot send to a thread');
    await expect(
      handleAddThreadParticipant({ threadKey: 'pr:618', addedByAgentId: 'wren', agentId: 'myra' }, {
        getClient: () => db,
      } as never)
    ).rejects.toThrow('Your role in this workspace (viewer) cannot add a participant');
    expect((await db.from('inbox_thread_messages').select('*')).data).toHaveLength(0);
    expect(getAgentGateway().dispatchTrigger).not.toHaveBeenCalled();
  });
});
