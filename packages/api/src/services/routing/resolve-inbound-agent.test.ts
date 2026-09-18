/**
 * The routing cascade's precedence, and the thing it kept getting wrong.
 *
 * Every case here turns on the same distinction: a tier can MATCH and still
 * select the server's default SB. The cascade used to ask "is the slug still
 * the default?" to decide whether to keep going, which answered "no one
 * matched" for a mention of Myra or a reply to something Myra wrote — and the
 * next tier then overwrote a correct answer with a different SB. Reported by
 * Lumen on PR #638.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('./resolve-mention', () => ({ resolveAgentFromMention: vi.fn() }));
vi.mock('./resolve-route', () => ({ resolveRouteSlug: vi.fn() }));

import { resolveInboundAgent } from './resolve-inbound-agent';
import { resolveAgentFromMention } from './resolve-mention';
import { resolveRouteSlug } from './resolve-route';

const DEFAULT_SLUG = 'myra';
const CHAT = '-100000000001';
const OTHER_CHAT = '-100000000002';

interface ActivityRow {
  user_id: string;
  type: string;
  platform: string;
  platform_message_id: string | null;
  platform_chat_id: string | null;
  agent_id: string | null;
  sb_id: string | null;
  payload: Record<string, unknown> | null;
  created_at: string;
}

function attributedRow(overrides: Partial<ActivityRow> = {}): ActivityRow {
  return {
    user_id: 'user-1',
    type: 'message_out',
    platform: 'telegram',
    platform_message_id: '4242',
    platform_chat_id: CHAT,
    agent_id: 'wren',
    sb_id: 'sb-wren',
    payload: { authorship: 'session' },
    created_at: '2026-09-15T10:00:00Z',
    ...overrides,
  };
}

/** Filter-applying double, so the real resolver runs against a real query shape. */
function mockClient(rows: ActivityRow[]) {
  const client = {
    from() {
      const predicates: Array<(row: Record<string, unknown>) => boolean> = [];
      const builder = {
        select: () => builder,
        eq(column: string, value: unknown) {
          predicates.push((row) => row[column] === value);
          return builder;
        },
        in(column: string, values: unknown[]) {
          predicates.push((row) => values.includes(row[column]));
          return builder;
        },
        order: () => builder,
        limit(n: number) {
          const matched = rows.filter((row) =>
            predicates.every((p) => p(row as unknown as Record<string, unknown>))
          );
          return Promise.resolve({ data: matched.slice(0, n), error: null });
        },
      };
      return builder;
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return client as any;
}

function route(overrides: Record<string, unknown> = {}) {
  return {
    sbSlug: 'wren',
    sbId: 'sb-wren',
    routeId: 'route-1',
    studioHint: null,
    activeSessionId: null,
    ...overrides,
  };
}

function resolve(options: {
  rows?: ActivityRow[];
  isGroupChat?: boolean;
  conversationId?: string;
  replyToMessageId?: string;
}) {
  return resolveInboundAgent({
    supabase: mockClient(options.rows ?? []),
    userId: 'user-1',
    defaultSlug: DEFAULT_SLUG,
    platform: 'telegram',
    conversationId: options.conversationId ?? CHAT,
    content: 'a message',
    isGroupChat: options.isGroupChat ?? false,
    replyToMessageId: options.replyToMessageId,
  });
}

describe('resolveInboundAgent', () => {
  beforeEach(() => {
    // Call counts are load-bearing below ("did the cascade stop?"), so they
    // must not accumulate across cases.
    vi.clearAllMocks();
    vi.mocked(resolveAgentFromMention).mockResolvedValue(null);
    vi.mocked(resolveRouteSlug).mockResolvedValue(null);
  });

  describe('a tier that matches the default SB still counts as a match', () => {
    it('keeps a mention of the default SB instead of letting a reply overwrite it', async () => {
      vi.mocked(resolveAgentFromMention).mockResolvedValue({
        sbSlug: DEFAULT_SLUG,
        sbId: 'sb-myra',
      });

      const result = await resolve({
        rows: [attributedRow()],
        isGroupChat: true,
        replyToMessageId: '4242',
      });

      expect(result.sbSlug).toBe(DEFAULT_SLUG);
      expect(result.source).toBe('mention');
    });

    it('keeps a reply authored by the default SB instead of falling to the channel route', async () => {
      vi.mocked(resolveRouteSlug).mockResolvedValue(route({ sbSlug: 'wren' }));

      const result = await resolve({
        rows: [attributedRow({ agent_id: DEFAULT_SLUG, sb_id: 'sb-myra' })],
        replyToMessageId: '4242',
      });

      expect(result.sbSlug).toBe(DEFAULT_SLUG);
      expect(result.source).toBe('reply');
      // The old cascade let the route win here while still reporting the reply
      // as resolved — a wrong recipient wearing a correct-looking explanation.
      expect(result.replyRouting).toEqual({ resolved: true });
      expect(result.routeId).toBeNull();
    });

    it('does not consult the channel route once a reply has resolved', async () => {
      await resolve({ rows: [attributedRow()], replyToMessageId: '4242' });

      expect(resolveRouteSlug).not.toHaveBeenCalled();
    });

    it('does not consult reply authorship once a mention has resolved', async () => {
      vi.mocked(resolveAgentFromMention).mockResolvedValue({ sbSlug: 'wren', sbId: 'sb-wren' });

      const result = await resolve({
        rows: [attributedRow({ agent_id: 'lumen', sb_id: 'sb-lumen' })],
        isGroupChat: true,
        replyToMessageId: '4242',
      });

      expect(result.sbSlug).toBe('wren');
      expect(result.replyRouting).toBeUndefined();
    });
  });

  describe('precedence when tiers disagree', () => {
    it('prefers a mention over the reply author', async () => {
      vi.mocked(resolveAgentFromMention).mockResolvedValue({ sbSlug: 'lumen', sbId: 'sb-lumen' });

      const result = await resolve({
        rows: [attributedRow()],
        isGroupChat: true,
        replyToMessageId: '4242',
      });

      expect(result).toMatchObject({ sbSlug: 'lumen', source: 'mention' });
    });

    it('prefers the reply author over the channel route', async () => {
      vi.mocked(resolveRouteSlug).mockResolvedValue(route({ sbSlug: 'lumen', sbId: 'sb-lumen' }));

      const result = await resolve({ rows: [attributedRow()], replyToMessageId: '4242' });

      expect(result).toMatchObject({ sbSlug: 'wren', source: 'reply' });
    });

    it('ignores mentions outside group chats', async () => {
      vi.mocked(resolveAgentFromMention).mockResolvedValue({ sbSlug: 'lumen', sbId: 'sb-lumen' });

      const result = await resolve({ rows: [attributedRow()], replyToMessageId: '4242' });

      expect(resolveAgentFromMention).not.toHaveBeenCalled();
      expect(result).toMatchObject({ sbSlug: 'wren', source: 'reply' });
    });
  });

  describe('falling through', () => {
    it('uses the channel route when the reply cannot be attributed', async () => {
      vi.mocked(resolveRouteSlug).mockResolvedValue(route({ studioHint: 'studio-a' }));

      const result = await resolve({
        rows: [attributedRow({ payload: {} })],
        replyToMessageId: '4242',
      });

      expect(result).toMatchObject({
        sbSlug: 'wren',
        source: 'channel_route',
        studioHint: 'studio-a',
        routeId: 'route-1',
        replyRouting: { resolved: false, reason: 'unattributed_author' },
      });
    });

    it('carries the reason when a reply from another chat finds nothing here', async () => {
      const result = await resolve({
        rows: [attributedRow({ platform_chat_id: OTHER_CHAT })],
        replyToMessageId: '4242',
      });

      expect(result).toMatchObject({
        sbSlug: DEFAULT_SLUG,
        source: 'default',
        replyRouting: { resolved: false, reason: 'no_matching_message' },
      });
    });

    it('omits replyRouting entirely when the message was not a reply', async () => {
      const result = await resolve({ rows: [attributedRow()] });

      expect(result.source).toBe('default');
      expect(result.replyRouting).toBeUndefined();
    });

    it('falls back to the server default when no tier matches', async () => {
      const result = await resolve({});

      expect(result).toMatchObject({ sbSlug: DEFAULT_SLUG, source: 'default' });
      // No identity id: the fallback is a slug from the environment, not a
      // resolved identity row, and claiming one would be a fabrication.
      expect(result.sbId).toBeUndefined();
    });
  });
});
