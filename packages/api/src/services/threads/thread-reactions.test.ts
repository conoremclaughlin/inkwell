/**
 * Reactions on thread messages (ink://specs/inkling-reactions): the emoji
 * rule, the summary shape, the reader, and every guard on the write, against
 * the in-memory FakePostgrest with the table's constraints and guard trigger
 * mirrored (test/fake-reactions-db.ts).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { FakePostgrest, type Row } from '../../test/fake-postgrest';
import { withReactionsTable, withUuidCanonicalization } from '../../test/fake-reactions-db';
import { userPrincipal, type SbPrincipal } from '../principals';
import { InklingThreadRefusedError } from '../inklings/inkling-thread-gate';
import {
  REACTION_CHOICES,
  REACTION_LIMIT_PER_REACTOR,
  REACTION_LIMIT_TOKEN,
  REACTIONS_TABLE,
  ReactionRefusedError,
  isReactionEmoji,
  loadReactions,
  reactToMessage,
  summarizeReactions,
  type ReactRequest,
  type ReactionRow,
} from './thread-reactions';

const ME = '11111111-1111-4111-8111-111111111111';
const SOMEONE = '22222222-2222-4222-8222-222222222222';
const WS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_WS = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OWNER_TEST_INKLING = { client: 'inkling-mobile', named: false, ownerTest: true };

let db: FakePostgrest;
let seq = 0;
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function sb(slug: string, metadata: Row = {}, workspaceId = WS): SbPrincipal {
  const row = db.seed('agent_identities', {
    id: uuid(++seq),
    agent_id: slug,
    user_id: ME,
    workspace_id: workspaceId,
    metadata,
  });
  return { kind: 'sb', sbId: row.id as string, sbSlug: slug, userId: ME, workspaceId };
}

function thread(key: string, members: Array<SbPrincipal | string>, workspaceId = WS): Row {
  const t = db.seed('inbox_threads', {
    id: uuid(++seq),
    thread_key: key,
    workspace_id: workspaceId,
    status: 'open',
    updated_at: db.now(),
  });
  for (const m of members) {
    db.seed('inbox_thread_participants', {
      thread_id: t.id,
      sb_id: typeof m === 'string' ? null : m.sbId,
      user_id: typeof m === 'string' ? m : null,
    });
  }
  return t;
}

function message(t: Row): Row {
  return db.seed('inbox_thread_messages', {
    id: uuid(++seq),
    thread_id: t.id,
    sender_kind: 'system',
    content: 'hello',
  });
}

let wren: SbPrincipal;
let lumen: SbPrincipal;
let pip: SbPrincipal;
let team: Row;
let teamMessage: Row;
let inklingThread: Row;
let inklingMessage: Row;
let background: Row;
let backgroundMessage: Row;

beforeEach(() => {
  db = withReactionsTable(new FakePostgrest());
  seq = 0;
  wren = sb('wren');
  lumen = sb('lumen');
  pip = sb('pip', OWNER_TEST_INKLING);
  team = thread('thread:team', [wren, lumen, ME]);
  teamMessage = message(team);
  inklingThread = thread('chat:pip', [pip, ME]);
  inklingMessage = message(inklingThread);
  background = thread('thread:background', [wren]);
  backgroundMessage = message(background);
  vi.stubEnv('INKLING_OWNER_TEST_USER_ID', ME);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const asMe = userPrincipal(ME);

function react(overrides: Partial<ReactRequest> & Pick<ReactRequest, 'reactor'>) {
  return reactToMessage(db, {
    workspaceId: WS,
    threadKey: team.thread_key as string,
    messageId: teamMessage.id as string,
    emoji: '👍',
    ...overrides,
  });
}

async function refusal(promise: Promise<unknown>): Promise<{ status: number; code: string }> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ReactionRefusedError) return { status: error.status, code: error.code };
    throw error;
  }
  throw new Error('expected a refusal, got an answer');
}

describe('isReactionEmoji', () => {
  // The contract's cases, as the app's test has them (b6f0295a, ee0f59a2),
  // spelled by code point so no invisible character can be lost in a copy.
  it.each([
    ['❤️ heart with presentation selector', '\u{2764}\u{FE0F}'],
    ['❤ bare heart', '\u{2764}'],
    ['👍', '\u{1F44D}'],
    ['👍🏽 with a skin tone', '\u{1F44D}\u{1F3FD}'],
    ['🙏', '\u{1F64F}'],
    ['🇮🇪 flag', '\u{1F1EE}\u{1F1EA}'],
    ['👨‍👩‍👧 ZWJ family', '\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}'],
  ])('accepts %s', (_label, emoji) => {
    expect(isReactionEmoji(emoji)).toBe(true);
  });

  it.each([
    ['漢字', '\u{6F22}\u{5B57}'],
    ['a bidi override alone', '\u{202E}'],
    ['a bidi override before a heart', '\u{202E}\u{2764}\u{FE0F}'],
    ['a keycap', '1\u{FE0F}\u{20E3}'],
    ['a letter', 'a'],
    ['two hearts and a letter', '\u{2764}\u{FE0F}\u{2764}\u{FE0F}x'],
    ['👍 and a trailing space', '\u{1F44D} '],
  ])('refuses %s', (_label, emoji) => {
    expect(isReactionEmoji(emoji)).toBe(false);
  });

  it('accepts every choice the app offers', () => {
    for (const emoji of REACTION_CHOICES) expect(isReactionEmoji(emoji)).toBe(true);
  });

  it.each([
    ['empty', ''],
    ['two flags', '\u{1F1EE}\u{1F1EA}\u{1F1EB}\u{1F1F7}'],
    ['a tag sequence', '\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}'],
    ['a text presentation selector', '\u{2764}\u{FE0E}'],
    ['two skin tones', '\u{1F44D}\u{1F3FD}\u{1F3FD}'],
  ])('refuses %s, beyond the contract’s list', (_label, emoji) => {
    expect(isReactionEmoji(emoji)).toBe(false);
  });

  it('holds the 16 UTF-16 unit bound on a sequence the pattern accepts', () => {
    // 👨🏻‍👩🏻‍👧🏻‍❤ is 16 units; with ❤’s presentation selector it is 17.
    const sixteen =
      '\u{1F468}\u{1F3FB}\u{200D}\u{1F469}\u{1F3FB}\u{200D}\u{1F467}\u{1F3FB}\u{200D}\u{2764}';
    expect(sixteen.length).toBe(16);
    expect(isReactionEmoji(sixteen)).toBe(true);
    expect(isReactionEmoji(`${sixteen}\u{FE0F}`)).toBe(false);
  });

  it.each([null, undefined, 1, {}, ['\u{1F44D}']])('refuses a non-string (%s)', (value) => {
    expect(isReactionEmoji(value)).toBe(false);
  });
});

describe('summarizeReactions', () => {
  const row = (
    id: string,
    emoji: string,
    at: string,
    reactor: Partial<ReactionRow>
  ): ReactionRow => ({
    id,
    message_id: 'm',
    reactor_user_id: null,
    reactor_sb_id: null,
    emoji,
    created_at: at,
    ...reactor,
  });

  it('is [] with no reactions', () => {
    expect(summarizeReactions([], { kind: 'user', id: ME })).toEqual([]);
  });

  it('groups by emoji, by first reaction time and then emoji, reactors in the order they reacted', () => {
    const rows = [
      row('r4', '😂', '2026-10-04T00:00:04Z', { reactor_sb_id: 'sb-1' }),
      row('r2', '👍', '2026-10-04T00:00:02Z', { reactor_sb_id: 'sb-1' }),
      row('r1', '❤️', '2026-10-04T00:00:01Z', { reactor_user_id: ME }),
      row('r3', '❤️', '2026-10-04T00:00:03Z', { reactor_sb_id: 'sb-1' }),
      // Same first time as 👍: the emoji breaks the tie ('🙏' sorts after '👍').
      row('r5', '🙏', '2026-10-04T00:00:02Z', { reactor_user_id: SOMEONE }),
    ];
    expect(summarizeReactions(rows, { kind: 'user', id: ME })).toEqual([
      {
        emoji: '❤️',
        count: 2,
        reactors: [
          { kind: 'user', id: ME },
          { kind: 'sb', id: 'sb-1' },
        ],
        mine: true,
      },
      { emoji: '👍', count: 1, reactors: [{ kind: 'sb', id: 'sb-1' }], mine: false },
      { emoji: '🙏', count: 1, reactors: [{ kind: 'user', id: SOMEONE }], mine: false },
      { emoji: '😂', count: 1, reactors: [{ kind: 'sb', id: 'sb-1' }], mine: false },
    ]);
  });

  it('decides `mine` by kind and id: an SB viewer is not the person with the same id', () => {
    const rows = [row('r1', '👍', '2026-10-04T00:00:01Z', { reactor_user_id: 'x' })];
    expect(summarizeReactions(rows, { kind: 'sb', id: 'x' })[0].mine).toBe(false);
    expect(summarizeReactions(rows, { kind: 'user', id: 'x' })[0].mine).toBe(true);
    expect(summarizeReactions(rows, null)[0].mine).toBe(false);
  });
});

describe('loadReactions', () => {
  it('answers [] for every message asked about that has none', async () => {
    const result = await loadReactions(db, [teamMessage.id as string, 'no-such'], null);
    expect(result.get(teamMessage.id as string)).toEqual([]);
    expect(result.get('no-such')).toEqual([]);
  });

  it('reads past a server row cap smaller than its page', async () => {
    db.maxRows = 3;
    for (let i = 0; i < 10; i++) {
      db.seed(REACTIONS_TABLE, {
        message_id: teamMessage.id,
        reactor_user_id: uuid(1000 + i),
        reactor_sb_id: null,
        emoji: '👍',
      });
    }
    const [summary] = (await loadReactions(db, [teamMessage.id as string], null)).get(
      teamMessage.id as string
    )!;
    expect(summary.count).toBe(10);
  });

  it('splits a long list of message ids across requests', async () => {
    db.maxInList = 100;
    const ids = Array.from({ length: 250 }, (_, i) => uuid(5000 + i));
    db.seed(REACTIONS_TABLE, {
      message_id: ids[249],
      reactor_user_id: ME,
      reactor_sb_id: null,
      emoji: '😮',
    });
    const result = await loadReactions(db, ids, { kind: 'user', id: ME });
    expect(result.size).toBe(250);
    expect(result.get(ids[249])).toEqual([
      { emoji: '😮', count: 1, reactors: [{ kind: 'user', id: ME }], mine: true },
    ]);
  });

  it('fails loudly rather than answering "none" when the read fails', async () => {
    db.maxInList = 0;
    await expect(loadReactions(db, [teamMessage.id as string], null)).rejects.toThrow(
      /Failed to read reactions/
    );
  });
});

describe('reactToMessage', () => {
  it('adds a member SB’s reaction and answers with the message’s reactions as it sees them', async () => {
    const answer = await react({ reactor: wren });
    expect(answer).toEqual({
      messageId: teamMessage.id,
      reactions: [{ emoji: '👍', count: 1, reactors: [{ kind: 'sb', id: wren.sbId }], mine: true }],
    });
    const [stored] = db.rows(REACTIONS_TABLE);
    expect(stored).toMatchObject({
      message_id: teamMessage.id,
      thread_id: team.id,
      workspace_id: WS,
      reactor_sb_id: wren.sbId,
      reactor_user_id: null,
      emoji: '👍',
    });
  });

  it('adds a member person’s reaction, mine for them and not for another member', async () => {
    await react({ reactor: wren });
    const answer = await react({ reactor: asMe });
    expect(answer.reactions).toEqual([
      {
        emoji: '👍',
        count: 2,
        reactors: [
          { kind: 'sb', id: wren.sbId },
          { kind: 'user', id: ME },
        ],
        mine: true,
      },
    ]);
    expect((await react({ reactor: lumen, emoji: '❤️' })).reactions[0].mine).toBe(false);
  });

  it('adding again changes nothing and answers the same', async () => {
    const first = await react({ reactor: wren });
    const again = await react({ reactor: wren });
    expect(again).toEqual(first);
    expect(db.rows(REACTIONS_TABLE)).toHaveLength(1);
  });

  it('removes only the reactor’s own reaction, and removing one that is not there is a no-op', async () => {
    await react({ reactor: wren });
    await react({ reactor: lumen });
    const answer = await react({ reactor: wren, remove: true });
    expect(answer.reactions).toEqual([
      { emoji: '👍', count: 1, reactors: [{ kind: 'sb', id: lumen.sbId }], mine: false },
    ]);
    const again = await react({ reactor: wren, remove: true });
    expect(again).toEqual(answer);
    // A different emoji of my own is untouched by removing this one.
    await react({ reactor: wren, emoji: '😂' });
    await react({ reactor: wren, remove: true });
    expect(db.rows(REACTIONS_TABLE).map((r) => [r.reactor_sb_id, r.emoji])).toEqual([
      [lumen.sbId, '👍'],
      [wren.sbId, '😂'],
    ]);
  });

  it.each([
    ['a malformed emoji', { emoji: 'yes' }, 'invalid_emoji'],
    ['a malformed message id', { messageId: 'not-an-id' }, 'invalid_message_id'],
    ['no thread key', { threadKey: '' }, 'invalid_thread_key'],
  ])('refuses %s with 400', async (_label, overrides, code) => {
    expect(await refusal(react({ reactor: wren, ...overrides }))).toEqual({ status: 400, code });
    expect(db.rows(REACTIONS_TABLE)).toHaveLength(0);
  });

  it('answers 404 for a thread key with no thread in the caller’s workspace', async () => {
    thread('thread:elsewhere', [wren], OTHER_WS);
    for (const threadKey of ['thread:nope', 'thread:elsewhere']) {
      expect(await refusal(react({ reactor: wren, threadKey }))).toEqual({
        status: 404,
        code: 'thread_not_found',
      });
    }
  });

  it('answers 404 for a message that is not in the named thread', async () => {
    expect(
      await refusal(react({ reactor: wren, messageId: backgroundMessage.id as string }))
    ).toEqual({ status: 404, code: 'message_not_found' });
    expect(await refusal(react({ reactor: wren, messageId: uuid(999_999) }))).toEqual({
      status: 404,
      code: 'message_not_found',
    });
  });

  it('refuses a person in a background thread (not a member) with 403', async () => {
    expect(
      await refusal(
        react({
          reactor: asMe,
          threadKey: background.thread_key as string,
          messageId: backgroundMessage.id as string,
        })
      )
    ).toEqual({ status: 403, code: 'background_thread' });
    expect(db.rows(REACTIONS_TABLE)).toHaveLength(0);
  });

  it('refuses an SB that is not a member with 403', async () => {
    expect(
      await refusal(
        react({
          reactor: lumen,
          threadKey: background.thread_key as string,
          messageId: backgroundMessage.id as string,
        })
      )
    ).toEqual({ status: 403, code: 'not_a_member' });
    expect(db.rows(REACTIONS_TABLE)).toHaveLength(0);
  });

  describe('in an inkling’s conversation', () => {
    const inInklingThread = (reactor: ReactRequest['reactor'], extra: Partial<ReactRequest> = {}) =>
      react({
        reactor,
        threadKey: inklingThread.thread_key as string,
        messageId: inklingMessage.id as string,
        ...extra,
      });

    it('lets the owner react, since the reactor is the person', async () => {
      const answer = await inInklingThread(asMe, { emoji: '❤️' });
      expect(answer.reactions).toEqual([
        { emoji: '❤️', count: 1, reactors: [{ kind: 'user', id: ME }], mine: true },
      ]);
    });

    // The inkling itself: #738's gate decides, as it does for the inkling's
    // reply. It may act only in a conversation it is already in, with its
    // owner and none but the owner's own inklings.
    it('lets the inkling react in its own conversation', async () => {
      const answer = await inInklingThread(pip, { emoji: '❤️' });
      expect(answer.reactions).toEqual([
        { emoji: '❤️', count: 1, reactors: [{ kind: 'sb', id: pip.sbId }], mine: true },
      ]);
    });

    it('refuses the inkling once another SB is in its conversation', async () => {
      db.seed('inbox_thread_participants', { thread_id: inklingThread.id, sb_id: wren.sbId });
      expect(await refusal(inInklingThread(pip))).toEqual({
        status: 403,
        code: 'inkling_thread_refused',
      });
      expect(db.rows(REACTIONS_TABLE)).toHaveLength(0);
    });

    it('refuses the inkling in a conversation its owner has left', async () => {
      await db
        .from('inbox_thread_participants')
        .delete()
        .eq('thread_id', inklingThread.id as string)
        .eq('user_id', ME);
      expect(await refusal(inInklingThread(pip))).toEqual({
        status: 403,
        code: 'inkling_thread_refused',
      });
      expect(db.rows(REACTIONS_TABLE)).toHaveLength(0);
    });

    it('refuses the inkling while inklings are closed on this server', async () => {
      vi.stubEnv('INKLING_OWNER_TEST_USER_ID', '');
      expect(await refusal(inInklingThread(pip))).toEqual({
        status: 403,
        code: 'inklings_disabled',
      });
      expect(db.rows(REACTIONS_TABLE)).toHaveLength(0);
    });

    it('leaves the inkling to the gate: what the gate refuses is refused', async () => {
      const refusing = vi.fn(async () => {
        throw new InklingThreadRefusedError('inkling_thread_refused', 'refused by the gate');
      });
      const refused = await refusal(
        reactToMessage(
          db,
          {
            workspaceId: WS,
            threadKey: inklingThread.thread_key as string,
            messageId: inklingMessage.id as string,
            emoji: '👍',
            reactor: pip,
          },
          { inklingGate: refusing }
        )
      );
      expect(refused).toEqual({ status: 403, code: 'inkling_thread_refused' });
      expect(refusing).toHaveBeenCalledWith(db, {
        sender: pip,
        participantSbs: [],
        existingThreadId: inklingThread.id,
      });
      expect(db.rows(REACTIONS_TABLE)).toHaveLength(0);
    });

    it('asks the gate, which refuses another person who is somehow a member', async () => {
      db.seed('inbox_thread_participants', { thread_id: inklingThread.id, user_id: SOMEONE });
      expect(await refusal(inInklingThread(userPrincipal(SOMEONE)))).toEqual({
        status: 403,
        code: 'inkling_thread_refused',
      });
    });

    it('asks the gate for an SB too: another SB in the conversation is refused', async () => {
      db.seed('inbox_thread_participants', { thread_id: inklingThread.id, sb_id: wren.sbId });
      expect(await refusal(inInklingThread(wren))).toEqual({
        status: 403,
        code: 'inkling_thread_refused',
      });
      expect(db.rows(REACTIONS_TABLE)).toHaveLength(0);
    });

    it('refuses everyone while inklings are closed on this server', async () => {
      vi.stubEnv('INKLING_OWNER_TEST_USER_ID', '');
      expect(await refusal(inInklingThread(asMe))).toEqual({
        status: 403,
        code: 'inklings_disabled',
      });
    });

    it('passes the gate the reactor and the existing thread', async () => {
      const gate = vi.fn(async () => {});
      await reactToMessage(
        db,
        {
          workspaceId: WS,
          threadKey: inklingThread.thread_key as string,
          messageId: inklingMessage.id as string,
          emoji: '👍',
          reactor: asMe,
        },
        { inklingGate: gate }
      );
      expect(gate).toHaveBeenCalledWith(db, {
        sender: asMe,
        participantSbs: [],
        existingThreadId: inklingThread.id,
      });
    });
  });

  describe('a message id in another case than the database spells it (Lumen, #741 r1)', () => {
    // PostgreSQL accepts a UUID in any case and answers in lowercase. The
    // seeded ids above are all digits, where case cannot matter.
    const LETTERED = 'abcdefab-cdef-4abc-8def-abcdefabcdef';
    let lettered: Row;
    beforeEach(() => {
      withUuidCanonicalization(db);
      lettered = db.seed('inbox_thread_messages', {
        id: LETTERED,
        thread_id: team.id,
        sender_kind: 'system',
        content: 'hello again',
      });
    });
    const upper = () => String(lettered.id).toUpperCase();
    const mine = (emoji: string, reactor = wren) => ({
      emoji,
      count: 1,
      reactors: [{ kind: 'sb', id: reactor.sbId }],
      mine: true,
    });

    it('answers an add with what it stored, under the canonical id', async () => {
      const answer = await react({ reactor: wren, messageId: upper(), emoji: '👍' });
      expect(answer).toEqual({ messageId: LETTERED, reactions: [mine('👍')] });
      expect(db.rows(REACTIONS_TABLE).map((r) => r.message_id)).toEqual([LETTERED]);
    });

    it('answers an idempotent add with what is already there', async () => {
      await react({ reactor: wren, messageId: LETTERED, emoji: '👍' });
      const answer = await react({ reactor: wren, messageId: upper(), emoji: '👍' });
      expect(answer).toEqual({ messageId: LETTERED, reactions: [mine('👍')] });
      expect(db.rows(REACTIONS_TABLE)).toHaveLength(1);
    });

    it('answers a removal with the reactions that remain', async () => {
      await react({ reactor: wren, messageId: LETTERED, emoji: '👍' });
      await react({ reactor: wren, messageId: LETTERED, emoji: '❤️' });
      const answer = await react({ reactor: wren, messageId: upper(), emoji: '👍', remove: true });
      expect(answer).toEqual({ messageId: LETTERED, reactions: [mine('❤️')] });
      expect(db.rows(REACTIONS_TABLE).map((r) => r.emoji)).toEqual(['❤️']);
    });

    it('answers the same for the canonical spelling (the control)', async () => {
      const answer = await react({ reactor: wren, messageId: LETTERED, emoji: '👍' });
      expect(answer).toEqual({ messageId: LETTERED, reactions: [mine('👍')] });
    });
  });

  describe('the per-reactor limit', () => {
    const six = ['❤️', '👍', '😂', '😮', '😢', '🙏'];

    it('takes six emoji from one reactor and refuses a seventh with 409', async () => {
      for (const emoji of six) await react({ reactor: wren, emoji });
      expect(await refusal(react({ reactor: wren, emoji: '🎉' }))).toEqual({
        status: 409,
        code: 'reaction_limit',
      });
      expect(db.rows(REACTIONS_TABLE)).toHaveLength(6);
    });

    it('still lets that reactor re-add one it has, and another reactor add a seventh emoji', async () => {
      for (const emoji of six) await react({ reactor: wren, emoji });
      expect((await react({ reactor: wren, emoji: '😂' })).reactions).toHaveLength(6);
      expect((await react({ reactor: lumen, emoji: '🎉' })).reactions).toHaveLength(7);
    });
  });

  it('answers 404 when the message is deleted between the lookup and the insert', async () => {
    const originalFrom = db.from.bind(db);
    db.from = (table: string) => {
      if (table === REACTIONS_TABLE) {
        db.tables.inbox_thread_messages = db
          .rows('inbox_thread_messages')
          .filter((m) => m.id !== teamMessage.id);
      }
      return originalFrom(table);
    };
    expect(await refusal(react({ reactor: wren }))).toEqual({
      status: 404,
      code: 'message_not_found',
    });
  });

  it('throws on any other insert failure rather than answering as if it stored', async () => {
    const originalFrom = db.from.bind(db);
    db.from = (table: string) => {
      const query = originalFrom(table);
      if (table === REACTIONS_TABLE) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (query as any).insert = () =>
          Promise.resolve({ data: null, error: { code: '42501', message: 'permission denied' } });
      }
      return query;
    };
    await expect(react({ reactor: wren })).rejects.toThrow(/Failed to add the reaction/);
  });

  it('writes nothing but thread_message_reactions: no message, thread, participant or read pointer', async () => {
    const threadBefore = { ...team };
    const messagesBefore = db.rows('inbox_thread_messages').length;
    await react({ reactor: wren });
    await react({ reactor: asMe, emoji: '❤️' });
    await react({ reactor: wren, remove: true });
    await refusal(react({ reactor: wren, emoji: 'nope' }));
    const writes = db.log.filter((entry) => entry.op !== 'select');
    expect(writes.length).toBeGreaterThan(0);
    expect(new Set(writes.map((entry) => entry.table))).toEqual(new Set([REACTIONS_TABLE]));
    expect(db.rows('inbox_threads').find((t) => t.id === team.id)).toEqual(threadBefore);
    expect(db.rows('inbox_thread_messages')).toHaveLength(messagesBefore);
  });
});

describe('the guard trigger and this module agree', () => {
  it('names the same limit token and the same limit', async () => {
    const migration = await readFile(
      path.resolve(
        __dirname,
        '../../../../../supabase/migrations/20261004095944_thread_message_reactions.sql'
      ),
      'utf8'
    );
    expect(migration).toContain(`'${REACTION_LIMIT_TOKEN}:`);
    expect(migration).toContain(`IF v_others >= ${REACTION_LIMIT_PER_REACTOR} THEN`);
  });
});
