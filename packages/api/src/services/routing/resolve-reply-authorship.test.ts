import { describe, it, expect, vi } from 'vitest';
import { resolveReplyAuthorship } from './resolve-reply-authorship';

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

interface ActivityRow {
  user_id: string;
  type: string;
  platform: string;
  platform_message_id: string | null;
  platform_chat_id: string | null;
  agent_id: string | null;
  sb_id: string | null;
  session_id: string | null;
  payload: Record<string, unknown> | null;
  created_at?: string;
}

interface SessionRow {
  id: string;
  user_id: string;
  ended_at: string | null;
}

/**
 * Supabase double that actually APPLIES the filters it is given, against
 * in-memory tables, rather than returning a fixed payload for any query shape.
 *
 * This matters: a double that answers every call with the same rows cannot tell
 * a correct lookup from one that filters on the wrong column, so the test would
 * stay green against a resolver that queries `platform_chat_id` or forgets the
 * `message_out` constraint. Here a wrong column simply matches nothing — and a
 * session read that forgets to scope by user finds another user's session.
 *
 * Each `from()` gets its own builder, so the activity lookup's filters cannot
 * leak into the session lookup that follows it.
 */
function mockClient(
  rows: ActivityRow[],
  options: { error?: unknown; sessions?: SessionRow[]; sessionError?: unknown } = {}
) {
  const tables: Record<string, Array<Record<string, unknown>>> = {
    activity_stream: rows as unknown as Array<Record<string, unknown>>,
    sessions: (options.sessions ?? [openSession()]) as unknown as Array<Record<string, unknown>>,
  };
  const errors: Record<string, unknown> = {
    activity_stream: options.error ?? null,
    sessions: options.sessionError ?? null,
  };

  return {
    from(table: string) {
      const filters: Array<(row: Record<string, unknown>) => boolean> = [];
      let descending = false;
      let orderColumn = '';
      const matched = () => (tables[table] ?? []).filter((row) => filters.every((p) => p(row)));

      const builder = {
        select() {
          return builder;
        },
        eq(column: string, value: unknown) {
          filters.push((row) => row[column] === value);
          return builder;
        },
        in(column: string, values: unknown[]) {
          filters.push((row) => values.includes(row[column]));
          return builder;
        },
        order(column: string, opts?: { ascending?: boolean }) {
          descending = opts?.ascending === false;
          orderColumn = column;
          return builder;
        },
        limit(n: number) {
          if (errors[table]) return Promise.resolve({ data: null, error: errors[table] });
          // Sort by the column the resolver actually asked for. Sorting by
          // created_at regardless would keep "prefers the most recent send"
          // green against a resolver that ordered on some other column.
          const ordered = [...matched()].sort((a, b) => {
            const av = String(a[orderColumn] ?? '');
            const bv = String(b[orderColumn] ?? '');
            return descending ? bv.localeCompare(av) : av.localeCompare(bv);
          });
          return Promise.resolve({ data: ordered.slice(0, n), error: null });
        },
        maybeSingle() {
          if (errors[table]) return Promise.resolve({ data: null, error: errors[table] });
          const found = matched();
          if (found.length > 1) {
            return Promise.resolve({ data: null, error: { message: 'multiple rows returned' } });
          }
          return Promise.resolve({ data: found[0] ?? null, error: null });
        },
      };
      return builder;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function openSession(overrides: Partial<SessionRow> = {}): SessionRow {
  return { id: 'session-wren', user_id: 'user-1', ended_at: null, ...overrides };
}

/** The resolved result for an author whose open session wrote the message. */
function authored(sbSlug: string, sbId: string, sessionId: string) {
  return { resolved: true, sbSlug, sbId, session: { routable: true, sessionId } };
}

/** The chat a reply arrives in, and an unrelated one that reuses message ids. */
const CHAT = '-100000000001';
const OTHER_CHAT = '-100000000002';

/** An outbound row as the gateway writes it once the author is known. */
function attributedRow(overrides: Partial<ActivityRow> = {}): ActivityRow {
  return {
    user_id: 'user-1',
    type: 'message_out',
    platform: 'telegram',
    platform_message_id: '4242',
    platform_chat_id: CHAT,
    agent_id: 'wren',
    sb_id: 'sb-wren',
    session_id: 'session-wren',
    payload: { authorship: 'session' },
    created_at: '2026-09-15T10:00:00Z',
    ...overrides,
  };
}

describe('resolveReplyAuthorship', () => {
  it('routes a reply to the SB that authored the message, not the channel owner', async () => {
    const client = mockClient([attributedRow()]);

    const result = await resolveReplyAuthorship(client, 'user-1', 'telegram', CHAT, '4242');

    expect(result).toEqual(authored('wren', 'sb-wren', 'session-wren'));
  });

  describe('the session that wrote the message', () => {
    it('is the anchor while it is open, not merely the SB', async () => {
      // Two of the author's sessions are open. Only the row's own session wrote
      // the message; the other is what general reuse would pick by recency.
      const client = mockClient([attributedRow({ session_id: 'session-checkin' })], {
        sessions: [
          openSession({ id: 'session-checkin' }),
          openSession({ id: 'session-newest-elsewhere' }),
        ],
      });

      const result = await resolveReplyAuthorship(client, 'user-1', 'telegram', CHAT, '4242');

      expect(result).toEqual(authored('wren', 'sb-wren', 'session-checkin'));
    });

    it('is not an anchor once it has ended, and says so', async () => {
      const client = mockClient([attributedRow()], {
        sessions: [openSession({ ended_at: '2026-09-20T12:00:00Z' })],
      });

      const result = await resolveReplyAuthorship(client, 'user-1', 'telegram', CHAT, '4242');

      // Still the author: the SB takes the reply, just not in that session.
      expect(result).toEqual({
        resolved: true,
        sbSlug: 'wren',
        sbId: 'sb-wren',
        session: { routable: false, reason: 'session_ended', sessionId: 'session-wren' },
      });
    });

    it('reads a nulled session column as a missing session', async () => {
      // The foreign key is ON DELETE SET NULL, so a deleted session leaves an
      // attributed row with no session_id.
      const client = mockClient([attributedRow({ session_id: null })]);

      const result = await resolveReplyAuthorship(client, 'user-1', 'telegram', CHAT, '4242');

      expect(result).toMatchObject({
        resolved: true,
        sbSlug: 'wren',
        session: { routable: false, reason: 'session_missing', sessionId: null },
      });
    });

    it('reads a session id with no session row as missing', async () => {
      const client = mockClient([attributedRow({ session_id: 'session-gone' })]);

      const result = await resolveReplyAuthorship(client, 'user-1', 'telegram', CHAT, '4242');

      expect(result).toMatchObject({
        resolved: true,
        session: { routable: false, reason: 'session_missing', sessionId: 'session-gone' },
      });
    });

    it("never anchors to another user's session of the same id", async () => {
      // The session read is scoped by user. Unscoped, a row naming a session
      // another user owns would become the anchor.
      const client = mockClient([attributedRow()], {
        sessions: [openSession({ user_id: 'user-2' })],
      });

      const result = await resolveReplyAuthorship(client, 'user-1', 'telegram', CHAT, '4242');

      expect(result).toMatchObject({
        resolved: true,
        session: { routable: false, reason: 'session_missing' },
      });
    });

    it('distinguishes a failed session read from a missing session', async () => {
      const client = mockClient([attributedRow()], {
        sessionError: { message: 'connection reset' },
      });

      const result = await resolveReplyAuthorship(client, 'user-1', 'telegram', CHAT, '4242');

      expect(result).toEqual({
        resolved: true,
        sbSlug: 'wren',
        sbId: 'sb-wren',
        session: {
          routable: false,
          reason: 'session_lookup_failed',
          sessionId: 'session-wren',
        },
      });
    });
  });

  it('reports no_reply_id when the message was not a reply', async () => {
    const client = mockClient([attributedRow()]);

    const result = await resolveReplyAuthorship(client, 'user-1', 'telegram', CHAT, undefined);

    expect(result).toEqual({ resolved: false, reason: 'no_reply_id' });
  });

  it('reports no_matching_message when no outgoing message carries that id', async () => {
    const client = mockClient([attributedRow({ platform_message_id: '1111' })]);

    const result = await resolveReplyAuthorship(client, 'user-1', 'telegram', CHAT, '9999');

    expect(result).toEqual({ resolved: false, reason: 'no_matching_message' });
  });

  it('refuses to attribute a row logged before authorship was recorded', async () => {
    // Every outgoing row predating this feature looks exactly like this: the
    // channel owner's slug, no authorship marker. Routing on the slug would
    // send the reply to Myra while claiming it had found the author.
    const client = mockClient([attributedRow({ agent_id: 'myra', sb_id: 'sb-myra', payload: {} })]);

    const result = await resolveReplyAuthorship(client, 'user-1', 'telegram', CHAT, '4242');

    expect(result).toEqual({ resolved: false, reason: 'unattributed_author' });
  });

  it('refuses to attribute a row explicitly marked unattributed', async () => {
    const client = mockClient([
      attributedRow({
        agent_id: 'myra',
        sb_id: 'sb-myra',
        payload: { authorship: 'unattributed' },
      }),
    ]);

    const result = await resolveReplyAuthorship(client, 'user-1', 'telegram', CHAT, '4242');

    expect(result).toEqual({ resolved: false, reason: 'unattributed_author' });
  });

  it('distinguishes a failed lookup from an absent message', async () => {
    const client = mockClient([], { error: { message: 'connection reset' } });

    const result = await resolveReplyAuthorship(client, 'user-1', 'telegram', CHAT, '4242');

    // 'lookup_failed', never 'no_matching_message' — collapsing the two is what
    // lets a broken query read as "the user replied to nothing".
    expect(result).toEqual({ resolved: false, reason: 'lookup_failed' });
  });

  it('does not attribute a message sent to a different user', async () => {
    const client = mockClient([attributedRow({ user_id: 'user-2' })]);

    const result = await resolveReplyAuthorship(client, 'user-1', 'telegram', CHAT, '4242');

    expect(result).toEqual({ resolved: false, reason: 'no_matching_message' });
  });

  it('does not attribute an inbound message that happens to share the id', async () => {
    // message_in rows carry platform_message_id too. Matching one would
    // attribute the reply to its sender rather than to any SB.
    const client = mockClient([attributedRow({ type: 'message_in' })]);

    const result = await resolveReplyAuthorship(client, 'user-1', 'telegram', CHAT, '4242');

    expect(result).toEqual({ resolved: false, reason: 'no_matching_message' });
  });

  it('does not cross channels on a colliding message id', async () => {
    const client = mockClient([attributedRow({ platform: 'discord' })]);

    const result = await resolveReplyAuthorship(client, 'user-1', 'telegram', CHAT, '4242');

    expect(result).toEqual({ resolved: false, reason: 'no_matching_message' });
  });

  it('does not attribute a row from a different chat that reuses the id', async () => {
    // Telegram guarantees message_id uniqueness only inside a chat
    // (https://core.telegram.org/bots/api#message). Answering a reply in one
    // chat with an author from another is the wrong-recipient bug this tier was
    // built to remove, one column over — and it reports itself as resolved.
    const client = mockClient([attributedRow({ platform_chat_id: OTHER_CHAT })]);

    const result = await resolveReplyAuthorship(client, 'user-1', 'telegram', CHAT, '4242');

    expect(result).toEqual({ resolved: false, reason: 'no_matching_message' });
  });

  it('picks the row from the chat the reply arrived in when both chats hold the id', async () => {
    // Newest-first does not disambiguate chats: here the unrelated chat's row is
    // the more recent one, so recency alone would answer with 'lumen'.
    const client = mockClient(
      [
        attributedRow({ agent_id: 'wren', sb_id: 'sb-wren', created_at: '2026-09-15T09:00:00Z' }),
        attributedRow({
          platform_chat_id: OTHER_CHAT,
          agent_id: 'lumen',
          sb_id: 'sb-lumen',
          session_id: 'session-lumen',
          created_at: '2026-09-15T11:00:00Z',
        }),
      ],
      { sessions: [openSession(), openSession({ id: 'session-lumen' })] }
    );

    const result = await resolveReplyAuthorship(client, 'user-1', 'telegram', CHAT, '4242');

    expect(result).toEqual(authored('wren', 'sb-wren', 'session-wren'));
  });

  it('matches a prefixed stored chat id against a bare inbound one', async () => {
    // Inbound conversation ids arrive bare; an outgoing send addressed as
    // `telegram:<id>` stores the prefixed form. Comparing the two literally
    // finds nothing and reads as "replied to a message we never sent".
    const client = mockClient([attributedRow({ platform_chat_id: `telegram:${CHAT}` })]);

    const result = await resolveReplyAuthorship(client, 'user-1', 'telegram', CHAT, '4242');

    expect(result).toEqual(authored('wren', 'sb-wren', 'session-wren'));
  });

  it('matches a bare stored chat id against a prefixed inbound one', async () => {
    const client = mockClient([attributedRow()]);

    const result = await resolveReplyAuthorship(
      client,
      'user-1',
      'telegram',
      `telegram:${CHAT}`,
      '4242'
    );

    expect(result).toEqual(authored('wren', 'sb-wren', 'session-wren'));
  });

  it('normalizing the chat id does not make a different chat match', async () => {
    // The prefix tolerance must not become a wildcard: `telegram:<other>` and
    // `<chat>` are still different conversations.
    const client = mockClient([attributedRow({ platform_chat_id: `telegram:${OTHER_CHAT}` })]);

    const result = await resolveReplyAuthorship(client, 'user-1', 'telegram', CHAT, '4242');

    expect(result).toEqual({ resolved: false, reason: 'no_matching_message' });
  });

  it('refuses rather than matching unscoped when the conversation is unknown', async () => {
    const client = mockClient([attributedRow()]);

    const result = await resolveReplyAuthorship(client, 'user-1', 'telegram', undefined, '4242');

    expect(result).toEqual({ resolved: false, reason: 'no_conversation_scope' });
  });

  it('prefers the most recent send when an id repeats', async () => {
    const client = mockClient(
      [
        attributedRow({
          agent_id: 'lumen',
          sb_id: 'sb-lumen',
          session_id: 'session-lumen',
          created_at: '2026-09-15T09:00:00Z',
        }),
        attributedRow({ agent_id: 'wren', sb_id: 'sb-wren', created_at: '2026-09-15T11:00:00Z' }),
      ],
      { sessions: [openSession(), openSession({ id: 'session-lumen' })] }
    );

    const result = await resolveReplyAuthorship(client, 'user-1', 'telegram', CHAT, '4242');

    expect(result).toEqual(authored('wren', 'sb-wren', 'session-wren'));
  });
});
