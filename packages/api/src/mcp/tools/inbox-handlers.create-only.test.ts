/**
 * createOnly at the send boundary: a client-identified create either creates
 * its thread or writes nothing. POST /api/admin/threads relies on this so a
 * retried submission can never add anyone to a conversation, including when
 * a concurrent request takes the key between the handler's lookup and its
 * insert. Runs the real handler over the table-backed fake, as
 * inbox-handlers.review-r1.test.ts does.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeFakeSupabase, type Row } from '../../services/sessions/fake-supabase';
import { userPrincipal } from '../../services/principals';
import { handleSendToInbox } from './inbox-handlers';
import { ThreadKeyTakenError } from './thread-key-taken';
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
  getRequestContext: vi.fn().mockReturnValue({ userId: 'user-a' }),
  getSessionContext: vi.fn().mockReturnValue(undefined),
  getPinnedSlug: vi.fn().mockReturnValue(undefined),
}));
vi.mock('../../channels/agent-gateway', () => ({
  getAgentGateway: vi.fn().mockReturnValue({
    dispatchTrigger: vi.fn().mockReturnValue({ success: true, accepted: true }),
    processTrigger: vi.fn().mockResolvedValue({ success: true }),
  }),
}));

const KEY = 'chat:conversation-5f0c';
const identities = [
  { id: 'sb-fern', agent_id: 'fern', user_id: 'user-a', workspace_id: 'ws-a' },
  { id: 'sb-moss', agent_id: 'moss', user_id: 'user-a', workspace_id: 'ws-a' },
];
/** Fern's private conversation, as another request left it. */
const fernsThread = { id: 'thread-fern', thread_key: KEY, workspace_id: 'ws-a', metadata: {} };

type FakeDb = ReturnType<typeof makeFakeSupabase>;

function client(withFernsThread: boolean): { db: FakeDb; tables: Record<string, Row[]> } {
  const tables: Record<string, Row[]> = {
    agent_identities: identities.map((i) => ({ ...i })),
    inbox_threads: withFernsThread ? [{ ...fernsThread }] : [],
    inbox_thread_participants: withFernsThread
      ? [{ thread_id: 'thread-fern', workspace_id: 'ws-a', sb_id: 'sb-fern', user_id: null }]
      : [],
    inbox_thread_messages: [],
    inbox_thread_read_status: [],
    workspace_members: [{ workspace_id: 'ws-a', user_id: 'user-a', role: 'owner' }],
  };
  return { db: makeFakeSupabase(tables), tables };
}

/** Fern and Moss, from the person, as POST /api/admin/threads sends it. */
function send(db: FakeDb, createOnly: boolean) {
  return handleSendToInbox(
    { recipients: ['fern', 'moss'], threadKey: KEY, content: 'hello both', triggerAll: true },
    { getClient: () => db } as never,
    { sender: { principal: userPrincipal('user-a'), workspaceId: 'ws-a' }, createOnly }
  );
}

/** Another request creates Fern's thread after this send's lookup and before its insert. */
function takeKeyMidSend(db: FakeDb, tables: Record<string, Row[]>): void {
  const from = db.from.bind(db);
  let threadLookups = 0;
  db.from = ((table: string) => {
    if (table === 'inbox_threads' && ++threadLookups === 2) {
      tables.inbox_threads.push({ ...fernsThread });
      tables.inbox_thread_participants.push({
        thread_id: 'thread-fern',
        workspace_id: 'ws-a',
        sb_id: 'sb-fern',
        user_id: null,
      });
    }
    return from(table);
  }) as never;
}

/**
 * Another request inserts Fern's thread first, so this send's own thread
 * insert fails on the key's uniqueness (23505) and findOrCreateThread
 * re-reads the winner.
 */
function loseThreadInsert(db: FakeDb, tables: Record<string, Row[]>): void {
  const from = db.from.bind(db);
  db.from = ((table: string) => {
    const query = from(table);
    if (table !== 'inbox_threads') return query;
    return {
      ...query,
      insert: () => {
        tables.inbox_threads.push({ ...fernsThread });
        tables.inbox_thread_participants.push({
          thread_id: 'thread-fern',
          workspace_id: 'ws-a',
          sb_id: 'sb-fern',
          user_id: null,
        });
        return {
          select: () => ({
            single: async () => ({
              data: null,
              error: {
                code: '23505',
                message:
                  'duplicate key value violates unique constraint "inbox_threads_workspace_key"',
              },
            }),
          }),
        };
      },
    };
  }) as never;
}

const participantsOf = (tables: Record<string, Row[]>) =>
  tables.inbox_thread_participants
    .filter((p) => p.thread_id === 'thread-fern')
    .map((p) => p.sb_id ?? p.user_id);

beforeEach(() => vi.clearAllMocks());

describe('createOnly sends', () => {
  it('create a new thread as usual', async () => {
    const { db, tables } = client(false);
    await send(db, true);
    expect(tables.inbox_threads).toHaveLength(1);
    expect(tables.inbox_thread_messages).toHaveLength(1);
    // The fake stores an array insert as one keyless row; the handler then
    // writes each participant again. Count the principals, not the rows.
    const principals = tables.inbox_thread_participants
      .map((p) => p.sb_id ?? p.user_id)
      .filter((p) => p !== undefined);
    expect([...new Set(principals)].sort()).toEqual(['sb-fern', 'sb-moss', 'user-a']);
  });

  it('refuse a key that is already taken, before writing a participant or a message', async () => {
    const { db, tables } = client(true);
    await expect(send(db, true)).rejects.toBeInstanceOf(ThreadKeyTakenError);
    expect(participantsOf(tables)).toEqual(['sb-fern']);
    expect(tables.inbox_thread_messages).toHaveLength(0);
    expect(getAgentGateway().dispatchTrigger).not.toHaveBeenCalled();
  });

  it('refuse a key a concurrent request takes between the lookup and the insert', async () => {
    const { db, tables } = client(false);
    takeKeyMidSend(db, tables);
    await expect(send(db, true)).rejects.toBeInstanceOf(ThreadKeyTakenError);
    expect(participantsOf(tables)).toEqual(['sb-fern']);
    expect(tables.inbox_thread_messages).toHaveLength(0);
  });

  it('refuse when the thread insert itself loses the race on the key (23505)', async () => {
    const { db, tables } = client(false);
    loseThreadInsert(db, tables);
    await expect(send(db, true)).rejects.toBeInstanceOf(ThreadKeyTakenError);
    expect(participantsOf(tables)).toEqual(['sb-fern']);
    expect(tables.inbox_thread_messages).toHaveLength(0);
  });

  it('control: without createOnly, losing the thread insert joins the winner rather than failing', async () => {
    const { db, tables } = client(false);
    loseThreadInsert(db, tables);
    await send(db, false);
    expect(participantsOf(tables)).toEqual(expect.arrayContaining(['sb-fern', 'sb-moss']));
    expect(tables.inbox_thread_messages).toHaveLength(1);
  });

  it("control: without createOnly the same interleaving adds Moss to Fern's conversation", async () => {
    const { db, tables } = client(false);
    takeKeyMidSend(db, tables);
    await send(db, false);
    expect(participantsOf(tables)).toEqual(expect.arrayContaining(['sb-fern', 'sb-moss']));
    expect(tables.inbox_thread_messages).toHaveLength(1);
  });
});
