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
  agent_id: string | null;
  sb_id: string | null;
  payload: Record<string, unknown> | null;
  created_at?: string;
}

/**
 * Supabase double that actually APPLIES the filters it is given, against an
 * in-memory table, rather than returning a fixed payload for any query shape.
 *
 * This matters: a double that answers every call with the same rows cannot tell
 * a correct lookup from one that filters on the wrong column, so the test would
 * stay green against a resolver that queries `platform_chat_id` or forgets the
 * `message_out` constraint. Here a wrong column simply matches nothing.
 */
function mockClient(rows: ActivityRow[], error: unknown = null) {
  const builder = {
    filters: {} as Record<string, unknown>,
    table: '',
    descending: false,
    from(table: string) {
      this.table = table;
      return this;
    },
    select() {
      return this;
    },
    eq(column: string, value: unknown) {
      this.filters[column] = value;
      return this;
    },
    order(column: string, opts?: { ascending?: boolean }) {
      this.descending = opts?.ascending === false;
      this.orderColumn = column;
      return this;
    },
    orderColumn: '' as string,
    limit(n: number) {
      if (error) return Promise.resolve({ data: null, error });
      if (this.table !== 'activity_stream') {
        return Promise.resolve({ data: [], error: null });
      }
      const matched = rows.filter((row) =>
        Object.entries(this.filters).every(
          ([column, value]) => (row as unknown as Record<string, unknown>)[column] === value
        )
      );
      const ordered = [...matched].sort((a, b) => {
        const av = String(a.created_at ?? '');
        const bv = String(b.created_at ?? '');
        return this.descending ? bv.localeCompare(av) : av.localeCompare(bv);
      });
      return Promise.resolve({ data: ordered.slice(0, n), error: null });
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return builder as any;
}

/** An outbound row as the gateway writes it once the author is known. */
function attributedRow(overrides: Partial<ActivityRow> = {}): ActivityRow {
  return {
    user_id: 'user-1',
    type: 'message_out',
    platform: 'telegram',
    platform_message_id: '4242',
    agent_id: 'wren',
    sb_id: 'sb-wren',
    payload: { authorship: 'session' },
    created_at: '2026-09-15T10:00:00Z',
    ...overrides,
  };
}

describe('resolveReplyAuthorship', () => {
  it('routes a reply to the SB that authored the message, not the channel owner', async () => {
    const client = mockClient([attributedRow()]);

    const result = await resolveReplyAuthorship(client, 'user-1', 'telegram', '4242');

    expect(result).toEqual({ resolved: true, sbSlug: 'wren', sbId: 'sb-wren' });
  });

  it('reports no_reply_id when the message was not a reply', async () => {
    const client = mockClient([attributedRow()]);

    const result = await resolveReplyAuthorship(client, 'user-1', 'telegram', undefined);

    expect(result).toEqual({ resolved: false, reason: 'no_reply_id' });
  });

  it('reports no_matching_message when no outgoing message carries that id', async () => {
    const client = mockClient([attributedRow({ platform_message_id: '1111' })]);

    const result = await resolveReplyAuthorship(client, 'user-1', 'telegram', '9999');

    expect(result).toEqual({ resolved: false, reason: 'no_matching_message' });
  });

  it('refuses to attribute a row logged before authorship was recorded', async () => {
    // Every outgoing row predating this feature looks exactly like this: the
    // channel owner's slug, no authorship marker. Routing on the slug would
    // send the reply to Myra while claiming it had found the author.
    const client = mockClient([attributedRow({ agent_id: 'myra', sb_id: 'sb-myra', payload: {} })]);

    const result = await resolveReplyAuthorship(client, 'user-1', 'telegram', '4242');

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

    const result = await resolveReplyAuthorship(client, 'user-1', 'telegram', '4242');

    expect(result).toEqual({ resolved: false, reason: 'unattributed_author' });
  });

  it('distinguishes a failed lookup from an absent message', async () => {
    const client = mockClient([], { message: 'connection reset' });

    const result = await resolveReplyAuthorship(client, 'user-1', 'telegram', '4242');

    // 'lookup_failed', never 'no_matching_message' — collapsing the two is what
    // lets a broken query read as "the user replied to nothing".
    expect(result).toEqual({ resolved: false, reason: 'lookup_failed' });
  });

  it('does not attribute a message sent to a different user', async () => {
    const client = mockClient([attributedRow({ user_id: 'user-2' })]);

    const result = await resolveReplyAuthorship(client, 'user-1', 'telegram', '4242');

    expect(result).toEqual({ resolved: false, reason: 'no_matching_message' });
  });

  it('does not attribute an inbound message that happens to share the id', async () => {
    // message_in rows carry platform_message_id too. Matching one would
    // attribute the reply to its sender rather than to any SB.
    const client = mockClient([attributedRow({ type: 'message_in' })]);

    const result = await resolveReplyAuthorship(client, 'user-1', 'telegram', '4242');

    expect(result).toEqual({ resolved: false, reason: 'no_matching_message' });
  });

  it('does not cross channels on a colliding message id', async () => {
    const client = mockClient([attributedRow({ platform: 'discord' })]);

    const result = await resolveReplyAuthorship(client, 'user-1', 'telegram', '4242');

    expect(result).toEqual({ resolved: false, reason: 'no_matching_message' });
  });

  it('prefers the most recent send when an id repeats', async () => {
    const client = mockClient([
      attributedRow({ agent_id: 'lumen', sb_id: 'sb-lumen', created_at: '2026-09-15T09:00:00Z' }),
      attributedRow({ agent_id: 'wren', sb_id: 'sb-wren', created_at: '2026-09-15T11:00:00Z' }),
    ]);

    const result = await resolveReplyAuthorship(client, 'user-1', 'telegram', '4242');

    expect(result).toEqual({ resolved: true, sbSlug: 'wren', sbId: 'sb-wren' });
  });
});
