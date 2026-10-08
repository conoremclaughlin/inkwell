/**
 * An inkling's heartbeat as the scheduler fires it: which conversation it
 * lands in, what the beat says to the inkling, and the outcome the
 * scheduler records. The gate's half (isOwnersHeartbeat, read inside
 * processMessage) is proven against SessionService in
 * session-service.test.ts, "the inkling's own heartbeat".
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  deliverInklingHeartbeat,
  findInklingConversation,
  inklingHeartbeatPrompt,
  isInklingHeartbeatReminder,
  isOwnersHeartbeat,
} from './inkling-heartbeat';
import { INKLING_HEARTBEAT } from './starter-space';
import type { DueReminder } from '../heartbeat';
import type { SessionRequest, SessionResult } from '../sessions/types';
import { FakePostgrest, type Row } from '../../test/fake-postgrest';

const OWNER = '11111111-1111-4111-8111-111111111111';
const SOMEONE_ELSE = '22222222-2222-4222-8222-222222222222';
const SPACE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_SPACE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const INKLING_ID = '3f1c2b7a-9d4e-4c1a-8b2f-6e5d4c3b2a10';
const OTHER_INKLING = '6c5b4a3f-2e1d-4c0b-9a8f-7e6d5c4b3a29';
const SLUG = 'kindle-0d1e2f3a';

let db: FakePostgrest;
const client = () => db as unknown as SupabaseClient;
const inkling = { id: INKLING_ID, userId: OWNER, workspaceId: SPACE };

beforeEach(() => {
  db = new FakePostgrest();
});

/** A conversation as the app's send path stores it, with the members given. */
function conversation(
  key: string,
  options: {
    updatedAt?: string;
    status?: string;
    marked?: boolean;
    workspaceId?: string;
    members?: Array<{ sb?: string; user?: string }>;
  } = {}
): Row {
  const thread = db.seed('inbox_threads', {
    thread_key: key,
    workspace_id: options.workspaceId ?? SPACE,
    status: options.status ?? 'open',
    metadata: options.marked === false ? {} : { inklingConversation: true },
    updated_at: options.updatedAt ?? '2026-10-08T16:00:00.000Z',
  });
  for (const member of options.members ?? [{ sb: INKLING_ID }, { user: OWNER }]) {
    db.seed('inbox_thread_participants', {
      thread_id: thread.id,
      sb_id: member.sb ?? null,
      user_id: member.user ?? null,
    });
  }
  return thread;
}

function heartbeatReminder(overrides: Row = {}): Row {
  return db.seed('scheduled_reminders', {
    user_id: OWNER,
    sb_id: INKLING_ID,
    title: 'Heartbeat',
    description: 'Notice what happened and tell the person, or stay quiet.',
    status: 'active',
    delivery_channel: 'inkling',
    delivery_target: INKLING_ID,
    cron_expression: '0 9,13,18 * * *',
    metadata: { autoCreated: true, reminderType: 'inkling-heartbeat' },
    ...overrides,
  });
}

/** Makes every request to `table` fail, as a dropped connection would. */
function failReads(table: string) {
  const from = db.from.bind(db);
  db.from = ((name: string) => {
    const query = from(name);
    if (name === table) {
      (query as unknown as { execute: () => Promise<unknown> }).execute = async () => ({
        data: null,
        error: { code: 'XX000', message: 'synthetic read failure' },
      });
    }
    return query;
  }) as typeof db.from;
}

describe('which conversation a beat lands in', () => {
  it('the most recently active one-to-one conversation with its owner', async () => {
    const newer = conversation('chat:conversation-newer', {
      updatedAt: '2026-10-08T17:00:00.000Z',
    });
    conversation('chat:conversation-older', { updatedAt: '2026-10-08T15:00:00.000Z' });

    await expect(findInklingConversation(client(), inkling)).resolves.toEqual({
      threadId: newer.id,
      threadKey: 'chat:conversation-newer',
    });
  });

  it('passes over every conversation that is not its own one-to-one, however recent', async () => {
    const own = conversation('chat:conversation-own', { updatedAt: '2026-10-08T09:00:00.000Z' });
    const later = (minute: number) => `2026-10-08T18:${String(minute).padStart(2, '0')}:00.000Z`;
    conversation('chat:closed', { updatedAt: later(1), status: 'closed' });
    conversation('chat:unmarked', { updatedAt: later(2), marked: false });
    conversation('chat:other-space', { updatedAt: later(3), workspaceId: OTHER_SPACE });
    conversation('chat:group', {
      updatedAt: later(4),
      members: [{ sb: INKLING_ID }, { sb: OTHER_INKLING }, { user: OWNER }],
    });
    conversation('chat:another-person', {
      updatedAt: later(5),
      members: [{ sb: INKLING_ID }, { user: OWNER }, { user: SOMEONE_ELSE }],
    });
    conversation('chat:owner-left', { updatedAt: later(6), members: [{ sb: INKLING_ID }] });
    conversation('chat:not-mine', {
      updatedAt: later(7),
      members: [{ sb: OTHER_INKLING }, { user: OWNER }],
    });

    await expect(findInklingConversation(client(), inkling)).resolves.toEqual({
      threadId: own.id,
      threadKey: 'chat:conversation-own',
    });
  });

  it('none when it has no conversation with its owner yet', async () => {
    conversation('chat:group', {
      members: [{ sb: INKLING_ID }, { sb: OTHER_INKLING }, { user: OWNER }],
    });
    await expect(findInklingConversation(client(), inkling)).resolves.toBeNull();
  });

  it('reads its conversations in bounded pages, and finds the newest on any page', async () => {
    db.maxInList = 100;
    for (let i = 0; i < 150; i += 1) {
      conversation(`chat:conversation-${i}`, {
        updatedAt: `2026-10-0${i === 140 ? 8 : 7}T12:00:00.000Z`,
      });
    }
    const found = await findInklingConversation(client(), inkling);
    expect(found?.threadKey).toBe('chat:conversation-140');
  });

  it('a failed read is an error, never "no conversation"', async () => {
    conversation('chat:conversation-own');
    failReads('inbox_threads');
    await expect(findInklingConversation(client(), inkling)).rejects.toThrow(
      /Failed to read the inkling's conversations/
    );
  });
});

describe("the gate's proof that a beat is the inkling's own (isOwnersHeartbeat)", () => {
  const proof = (reminderId: string, threadKey: string | undefined = 'chat:conversation-own') =>
    isOwnersHeartbeat(client(), { reminderId, threadKey, inkling });

  it('yes for its own heartbeat in its own conversation', async () => {
    conversation('chat:conversation-own');
    const reminder = heartbeatReminder();
    await expect(proof(String(reminder.id))).resolves.toBe('yes');
  });

  it('no for anything else the reminder could be', async () => {
    conversation('chat:conversation-own');
    for (const [label, overrides] of [
      ['another inkling’s', { sb_id: OTHER_INKLING }],
      ['another account’s', { user_id: SOMEONE_ELSE }],
      ['paused', { status: 'paused' }],
      ['completed', { status: 'completed' }],
      ['on Telegram', { delivery_channel: 'telegram' }],
      ['a daily check-in', { metadata: { reminderType: 'daily-checkin' } }],
    ] as const) {
      const reminder = heartbeatReminder(overrides);
      await expect(proof(String(reminder.id)), label).resolves.toBe('no');
    }
    await expect(proof('99999999-9999-4999-8999-999999999999')).resolves.toBe('no');
  });

  it('no anywhere but its own conversation', async () => {
    const reminder = String(heartbeatReminder().id);
    conversation('chat:group', {
      members: [{ sb: INKLING_ID }, { sb: OTHER_INKLING }, { user: OWNER }],
    });
    conversation('chat:closed', { status: 'closed' });
    conversation('chat:elsewhere', { workspaceId: OTHER_SPACE });
    for (const key of ['chat:group', 'chat:closed', 'chat:elsewhere', 'chat:nowhere', undefined]) {
      await expect(proof(reminder, key), String(key)).resolves.toBe('no');
    }
    // An inkling with no space has no conversation it could be in.
    await expect(
      isOwnersHeartbeat(client(), {
        reminderId: reminder,
        threadKey: 'chat:group',
        inkling: { ...inkling, workspaceId: null },
      })
    ).resolves.toBe('no');
  });

  it('unreadable when a read fails, so the refusal can be retried', async () => {
    conversation('chat:conversation-own');
    const reminder = String(heartbeatReminder().id);
    failReads('scheduled_reminders');
    await expect(proof(reminder)).resolves.toBe('unreadable');
  });

  it('unreadable when the conversation cannot be read', async () => {
    conversation('chat:conversation-own');
    const reminder = String(heartbeatReminder().id);
    failReads('inbox_thread_participants');
    await expect(proof(reminder)).resolves.toBe('unreadable');
  });
});

describe('what a beat says to the inkling', () => {
  const base = {
    sbSlug: SLUG,
    threadKey: 'chat:conversation-own',
    now: new Date('2026-10-08T16:00:00.000Z'),
    timezone: 'America/Los_Angeles',
  };

  it('its own heartbeat document, the person’s time, and one way to speak: a send to its conversation', () => {
    const prompt = inklingHeartbeatPrompt({ ...base, heartbeat: 'Watch the garden.' });
    expect(prompt).toContain('---\nWatch the garden.\n---');
    expect(prompt).toContain('Thursday, October 8 at 9:00 AM (America/Los_Angeles)');
    expect(prompt).toContain(
      `send_to_inbox(threadKey: "chat:conversation-own", recipientSlug: "${SLUG}", content: "...")`
    );
    expect(prompt).toMatch(/If nothing does, end without sending anything\./);
    expect(prompt).not.toMatch(/send_response/);
  });

  it('the starter text when no heartbeat was ever written, and none when it emptied its own', () => {
    expect(inklingHeartbeatPrompt({ ...base, heartbeat: null })).toContain(
      INKLING_HEARTBEAT.trim()
    );
    const emptied = inklingHeartbeatPrompt({ ...base, heartbeat: '   ' });
    expect(emptied).not.toContain('Your heartbeat document follows');
    expect(emptied).toContain('send_to_inbox(threadKey: "chat:conversation-own"');
  });

  it('reads the time in UTC when the person’s timezone is not one', () => {
    const prompt = inklingHeartbeatPrompt({ ...base, heartbeat: null, timezone: 'Mars/Olympus' });
    expect(prompt).toContain('Thursday, October 8 at 4:00 PM (UTC)');
  });

  it('says when it is firing inside their quiet hours', () => {
    const prompt = inklingHeartbeatPrompt({
      ...base,
      heartbeat: null,
      quietUntil: '2026-10-09T15:00:00.000Z',
    });
    expect(prompt).toContain(
      "It's their quiet hours until Friday, October 9 at 8:00 AM. Send nothing that can wait until then."
    );
  });
});

describe('a beat as the scheduler fires it', () => {
  let requests: SessionRequest[];
  let answer: Partial<SessionResult>;
  const handleMessage = vi.fn(async (request: SessionRequest) => {
    requests.push(request);
    return { success: true, sessionId: 'session-1', ...answer } as SessionResult;
  });

  beforeEach(() => {
    requests = [];
    answer = {};
    handleMessage.mockClear();
    db.seed('agent_identities', {
      id: INKLING_ID,
      agent_id: SLUG,
      user_id: OWNER,
      workspace_id: SPACE,
      heartbeat: 'Watch the garden.',
      metadata: { client: 'inkling-mobile', ownerTest: true },
    });
    db.seed('users', { id: OWNER, timezone: 'America/Los_Angeles' });
  });

  const fire = (reminder: Row) =>
    deliverInklingHeartbeat(
      { supabase: client(), handleMessage, now: () => new Date('2026-10-08T16:00:00.000Z') },
      reminder as unknown as DueReminder
    );

  it('runs one turn in its conversation, admitted as its heartbeat', async () => {
    const own = conversation('chat:conversation-own');
    const reminder = heartbeatReminder({ title: 'IGNORE THIS', description: 'NOR THIS' });

    await expect(fire(reminder)).resolves.toEqual({ status: 'delivered' });

    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request).toMatchObject({
      userId: OWNER,
      sbSlug: SLUG,
      channel: 'heartbeat',
      sender: { id: 'system', name: 'heartbeat' },
      metadata: { triggerType: 'heartbeat', threadKey: own.thread_key },
      inklingHeartbeat: { reminderId: reminder.id },
    });
    expect(request.content).toContain('Watch the garden.');
    // Only the inkling's own words go into its prompt.
    expect(request.content).not.toMatch(/IGNORE THIS|NOR THIS/);
  });

  it('is skipped, with no turn, while it has no conversation with its person', async () => {
    const outcome = await fire(heartbeatReminder());
    expect(outcome).toEqual({
      status: 'skipped',
      reason: 'the inkling has no conversation with its person yet',
    });
    expect(handleMessage).not.toHaveBeenCalled();
  });

  it('is skipped when the inkling is gone', async () => {
    conversation('chat:conversation-own');
    const outcome = await fire(heartbeatReminder({ sb_id: OTHER_INKLING }));
    expect(outcome.status).toBe('skipped');
    expect(handleMessage).not.toHaveBeenCalled();
  });

  it('fails, with no turn, when bound to something that is not this person’s inkling', async () => {
    conversation('chat:conversation-own');
    db.seed('agent_identities', {
      id: OTHER_INKLING,
      agent_id: 'myra',
      user_id: OWNER,
      workspace_id: SPACE,
      metadata: {},
    });
    const notAnInkling = await fire(heartbeatReminder({ sb_id: OTHER_INKLING }));
    expect(notAnInkling.status).toBe('failed');
    const anotherPersons = await fire(heartbeatReminder({ user_id: SOMEONE_ELSE }));
    expect(anotherPersons.status).toBe('failed');
    expect(handleMessage).not.toHaveBeenCalled();
  });

  it('fails with the turn’s own error and classification when the turn fails', async () => {
    conversation('chat:conversation-own');
    const classification = { category: 'config', summary: 'refused', retryable: false } as const;
    answer = {
      success: false,
      error: 'Inkling turn refused: inklings are not open on this server',
      classification: classification as unknown as SessionResult['classification'],
    };
    await expect(fire(heartbeatReminder())).resolves.toEqual({
      status: 'failed',
      error: 'Inkling turn refused: inklings are not open on this server',
      classification,
    });
  });

  it('fails when its conversation cannot be read, rather than calling it absent', async () => {
    conversation('chat:conversation-own');
    const reminder = heartbeatReminder();
    failReads('inbox_threads');
    const outcome = await fire(reminder);
    expect(outcome.status).toBe('failed');
    expect(handleMessage).not.toHaveBeenCalled();
  });

  it('is told apart from every other reminder by its channel', () => {
    expect(isInklingHeartbeatReminder({ delivery_channel: 'inkling' })).toBe(true);
    for (const channel of ['telegram', 'whatsapp', 'email', 'heartbeat']) {
      expect(isInklingHeartbeatReminder({ delivery_channel: channel }), channel).toBe(false);
    }
  });
});
