/**
 * The trigger failure listener over a table-backed client: where the notice
 * goes, whom it names, and what must NOT silence it. The notice sender and
 * the address resolver are the real ones — only the logger is mocked — so
 * what these pin is the decision the server actually registers.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeFakeSupabase, type Row } from './sessions/fake-supabase';
import { handleTriggerFailure } from './trigger-failure-listener';
import { logger } from '../utils/logger';

vi.mock('../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

type Db = ReturnType<typeof makeFakeSupabase>;

const identities = [
  { id: 'sb-a', agent_id: 'wren', user_id: 'user-a', workspace_id: 'ws-a' },
  { id: 'sb-b', agent_id: 'lumen', user_id: 'user-b', workspace_id: 'ws-a' },
];

function client(extra: Record<string, Row[]> = {}): Db {
  return makeFakeSupabase({
    agent_identities: identities.map((i) => ({ ...i })),
    inbox_threads: [{ id: 'thread-a', thread_key: 'pr:618', workspace_id: 'ws-a', status: 'open' }],
    inbox_thread_messages: [],
    agent_inbox: [],
    ...extra,
  });
}

/** The target identity row cannot be read; every other read is untouched. */
function withFailingTargetRead(db: Db, targetSbId: string): Db {
  const from = db.from.bind(db);
  db.from = ((table: string) => {
    const q = from(table);
    if (table !== 'agent_identities') return q;
    const select = q.select.bind(q);
    return {
      ...q,
      select: () => {
        const chain = select();
        const eq = chain.eq.bind(chain);
        let targeted = false;
        chain.eq = ((col: string, value: unknown) => {
          eq(col, value);
          if (col === 'id' && value === targetSbId) targeted = true;
          return chain;
        }) as never;
        const maybeSingle = chain.maybeSingle.bind(chain);
        chain.maybeSingle = (() =>
          targeted
            ? Promise.resolve({ data: null, error: { message: 'target read failed' } })
            : maybeSingle()) as never;
        return chain;
      },
    };
  }) as never;
  return db;
}

/** The thread lane's insert fails, as when the thread row is gone. */
function withFailingThreadInsert(db: Db): Db {
  const from = db.from.bind(db);
  db.from = ((table: string) => {
    const q = from(table);
    if (table !== 'inbox_thread_messages') return q;
    return {
      ...q,
      insert: () => Promise.resolve({ data: null, error: { message: 'thread unavailable' } }),
    };
  }) as never;
  return db;
}

const rows = async (db: Db, table: string) => (await db.from(table).select('*')).data;

const threadBorne = {
  triggerId: 'trig-1',
  error: new Error('runner exited 1'),
  payload: {
    fromSlug: 'wren',
    fromSbId: 'sb-a',
    toSlug: 'lumen',
    toSbId: 'sb-b',
    threadId: 'thread-a',
    threadKey: 'pr:618',
    triggerType: 'message',
  },
} as const;

const logInkmailFailure = vi.fn().mockResolvedValue(undefined);
const deps = { logInkmailFailure };

beforeEach(() => vi.clearAllMocks());

describe('handleTriggerFailure', () => {
  it('a thread-borne failure posts a system notice into the thread and attributes the activity to the target owner', async () => {
    const db = client();
    await handleTriggerFailure(db, threadBorne, deps);
    const notices = await rows(db, 'inbox_thread_messages');
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      thread_id: 'thread-a',
      sender_kind: 'system',
      sender_sb_id: null,
      message_type: 'notification',
    });
    expect(String(notices[0].content)).toContain('Trigger to lumen failed');
    expect(await rows(db, 'agent_inbox')).toHaveLength(0);
    expect(logInkmailFailure).toHaveBeenCalledWith(
      expect.objectContaining({ toSlug: 'lumen' }),
      'user-b',
      { error: 'runner exited 1' }
    );
  });

  it('a target identity that cannot be read does not silence a notice whose thread is known (Lumen, #618 round 2)', async () => {
    const db = withFailingTargetRead(client(), 'sb-b');
    await handleTriggerFailure(db, threadBorne, deps);
    expect(await rows(db, 'inbox_thread_messages')).toHaveLength(1);
    // No owner to attribute the activity to — the notice is not the activity.
    expect(logInkmailFailure).not.toHaveBeenCalled();
  });

  it("when the thread write fails the notice falls back to the SENDER's owner inbox, never the target's (Lumen, #618 round 1)", async () => {
    const db = withFailingThreadInsert(client());
    await handleTriggerFailure(db, threadBorne, deps);
    const legacy = await rows(db, 'agent_inbox');
    expect(legacy).toHaveLength(1);
    expect(legacy[0]).toMatchObject({
      recipient_user_id: 'user-a',
      recipient_agent_id: 'wren',
      sender_agent_id: 'lumen',
      thread_key: 'pr:618',
    });
  });

  it("a person's thread reply that fails is noticed in the thread even though a person has no inbox", async () => {
    // No fromSbId (a person sent it), no stamped owner — the thread alone is
    // the address, and it is enough.
    const db = client();
    await handleTriggerFailure(
      db,
      {
        triggerId: 'trig-5',
        error: new Error('boom'),
        payload: {
          fromSlug: 'system',
          toSlug: 'lumen',
          toSbId: 'sb-b',
          threadId: 'thread-a',
          threadKey: 'pr:618',
          triggerType: 'message',
        },
      },
      deps
    );
    expect(await rows(db, 'inbox_thread_messages')).toHaveLength(1);
    expect(await rows(db, 'agent_inbox')).toHaveLength(0);
  });

  it("when the thread write fails and the sender has no inbox, the target owner's inbox is NOT a fallback", async () => {
    // A person's send: no fromSbId. The only owner in sight is the target's,
    // and the target is not who needs telling (Lumen, #618 round 1).
    const db = withFailingThreadInsert(client());
    await handleTriggerFailure(
      db,
      {
        triggerId: 'trig-6',
        error: new Error('boom'),
        payload: {
          fromSlug: 'system',
          toSlug: 'lumen',
          toSbId: 'sb-b',
          threadId: 'thread-a',
          threadKey: 'pr:618',
          triggerType: 'message',
        },
      },
      deps
    );
    expect(await rows(db, 'agent_inbox')).toHaveLength(0);
  });

  it('a threadless failure from a sender with no inbox of their own has nowhere to go', async () => {
    // A person's send carries no fromSbId and the target has its own owner:
    // neither lane has an address, and nothing is written anywhere.
    const db = client();
    await handleTriggerFailure(
      db,
      {
        triggerId: 'trig-2',
        error: new Error('boom'),
        payload: {
          fromSlug: 'wren',
          toSlug: 'lumen',
          toSbId: 'sb-b',
          triggerType: 'message',
        },
      },
      deps
    );
    expect(await rows(db, 'inbox_thread_messages')).toHaveLength(0);
    expect(await rows(db, 'agent_inbox')).toHaveLength(0);
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.stringContaining('Cannot notify sender'),
      expect.anything()
    );
  });

  it("a legacy inbox failure restores the row to unread and notifies the row's owner", async () => {
    const db = client({
      agent_inbox: [
        { id: 'm1', status: 'read', read_at: '2026-09-13T00:00:00Z', recipient_user_id: 'user-a' },
      ],
    });
    await handleTriggerFailure(
      db,
      {
        triggerId: 'trig-3',
        error: new Error('boom'),
        payload: {
          inboxMessageId: 'm1',
          fromSlug: 'wren',
          toSlug: 'lumen',
          triggerType: 'message',
        },
      },
      deps
    );
    const inbox = await rows(db, 'agent_inbox');
    expect(inbox.find((r) => r.id === 'm1')).toMatchObject({ status: 'unread', read_at: null });
    expect(inbox.filter((r) => r.id !== 'm1')).toMatchObject([
      { recipient_user_id: 'user-a', recipient_agent_id: 'wren' },
    ]);
    expect(logInkmailFailure).toHaveBeenCalledWith(expect.anything(), 'user-a', expect.anything());
  });

  it('a failure with no sender notifies nobody — that is the loop guard', async () => {
    const db = client();
    await handleTriggerFailure(
      db,
      {
        triggerId: 'trig-4',
        error: new Error('boom'),
        payload: {
          toSlug: 'lumen',
          toSbId: 'sb-b',
          threadId: 'thread-a',
          triggerType: 'message',
        },
      } as never,
      deps
    );
    expect(await rows(db, 'inbox_thread_messages')).toHaveLength(0);
  });
});
