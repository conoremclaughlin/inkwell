/**
 * Outgoing Telegram attribution
 *
 * Every SB reaches Conor through one Telegram bot. Before this, each outgoing
 * row was stamped with the channel owner's slug ('myra') and no platform
 * message id — so a message Wren wrote was recorded as Myra's, and there was
 * nothing to correlate a reply against. Both facts were dropped on the same two
 * lines, and the result looked like a perfectly ordinary conversation.
 *
 * These tests pin the write half of reply routing: the outgoing row must carry
 * WHO wrote it and WHICH Telegram message it became.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('./telegram-listener', () => ({
  createTelegramListener: vi.fn(),
}));
vi.mock('./whatsapp-listener', () => ({ createWhatsAppListener: vi.fn() }));
vi.mock('./discord-listener', () => ({ createDiscordListener: vi.fn() }));
vi.mock('./slack-listener', () => ({ createSlackListener: vi.fn() }));
vi.mock('../mcp/tools/response-handlers', () => ({ setResponseCallback: vi.fn() }));
vi.mock('../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../config/env', () => ({
  env: { TELEGRAM_BOT_TOKEN: 'test-token', LOG_LEVEL: 'info' },
}));
vi.mock('./text-to-speech', () => ({
  TextToSpeechService: { fromEnv: vi.fn(() => ({ isEnabled: () => false, synthesize: vi.fn() })) },
}));

import { ChannelGateway } from './gateway.js';

const CHAT_ID = '12345';
const USER_ID = 'user-1';

interface SessionRow {
  agent_id: string | null;
  sb_id: string | null;
}

/**
 * Minimal DataComposer double. `sessions` is keyed by id so a lookup for an
 * unknown session returns nothing, the way the real query does.
 */
function createDataComposer(sessions: Record<string, SessionRow>) {
  const logMessage = vi.fn().mockResolvedValue({ id: 'activity-1' });

  const client = {
    from: (table: string) => ({
      select: () => ({
        eq: (_column: string, value: string) => ({
          maybeSingle: () =>
            Promise.resolve(
              table === 'sessions' && sessions[value]
                ? { data: sessions[value], error: null }
                : { data: null, error: null }
            ),
        }),
      }),
    }),
  };

  const dataComposer = {
    getClient: () => client,
    repositories: {
      activityStream: { logMessage },
      conversations: {
        findConversationByPlatformId: vi.fn().mockResolvedValue({ user_id: USER_ID }),
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  return { dataComposer, logMessage };
}

describe('outgoing Telegram attribution', () => {
  let gateway: ChannelGateway;
  let logMessage: ReturnType<typeof vi.fn>;
  let sendMessage: ReturnType<typeof vi.fn>;

  function build(sessions: Record<string, SessionRow>) {
    const composed = createDataComposer(sessions);
    logMessage = composed.logMessage;
    gateway = new ChannelGateway({
      enableTelegram: false,
      enableWhatsApp: false,
      dataComposer: composed.dataComposer,
    });
    // Telegram returns the id of the message it created; the gateway must keep it.
    sendMessage = vi.fn().mockResolvedValue('4242');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).telegramListener = { sendMessage };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("records the authoring SB, not the channel owner, when the session is Wren's", async () => {
    build({ 'session-wren': { agent_id: 'wren', sb_id: 'sb-wren' } });

    await gateway.sendResponse({
      channel: 'telegram',
      conversationId: CHAT_ID,
      content: 'PR #608 is merge-ready. Want me to merge it?',
      sessionId: 'session-wren',
    });

    expect(logMessage).toHaveBeenCalledTimes(1);
    const logged = logMessage.mock.calls[0]![0];
    expect(logged.sbSlug).toBe('wren');
    expect(logged.sbId).toBe('sb-wren');
  });

  it('stamps the Telegram message id a reply will arrive with', async () => {
    build({ 'session-wren': { agent_id: 'wren', sb_id: 'sb-wren' } });

    await gateway.sendResponse({
      channel: 'telegram',
      conversationId: CHAT_ID,
      content: 'hello',
      sessionId: 'session-wren',
    });

    const logged = logMessage.mock.calls[0]![0];
    // Without this there is nothing to correlate an inbound reply against, and
    // the reply falls to whoever owns the channel.
    expect(logged.platformMessageId).toBe('4242');
  });

  it('marks the row as attributed so a reply may route on it', async () => {
    build({ 'session-wren': { agent_id: 'wren', sb_id: 'sb-wren' } });

    await gateway.sendResponse({
      channel: 'telegram',
      conversationId: CHAT_ID,
      content: 'hello',
      sessionId: 'session-wren',
    });

    expect(logMessage.mock.calls[0]![0].payload).toMatchObject({ authorship: 'session' });
  });

  it('marks a send with no session as unattributed rather than claiming an author', async () => {
    build({});

    // Heartbeat and proactive sends have no session. The owner's slug is still
    // recorded for display, but the row must not read as a real attribution.
    await gateway.sendResponse({
      channel: 'telegram',
      conversationId: CHAT_ID,
      content: 'heartbeat check-in',
    });

    const logged = logMessage.mock.calls[0]![0];
    expect(logged.payload).toMatchObject({ authorship: 'unattributed' });
    expect(logged.sbId).toBeUndefined();
  });

  it('marks an unresolvable session as unattributed rather than guessing', async () => {
    build({ 'session-wren': { agent_id: 'wren', sb_id: 'sb-wren' } });

    await gateway.sendResponse({
      channel: 'telegram',
      conversationId: CHAT_ID,
      content: 'hello',
      sessionId: 'session-that-no-longer-exists',
    });

    expect(logMessage.mock.calls[0]![0].payload).toMatchObject({ authorship: 'unattributed' });
  });

  it('still records the message when Telegram returns no id', async () => {
    build({ 'session-wren': { agent_id: 'wren', sb_id: 'sb-wren' } });
    sendMessage.mockResolvedValue(undefined);

    await gateway.sendResponse({
      channel: 'telegram',
      conversationId: CHAT_ID,
      content: 'hello',
      sessionId: 'session-wren',
    });

    const logged = logMessage.mock.calls[0]![0];
    // Attribution is independent of the id: we know who wrote it either way.
    // The reply simply has nothing to match on, which resolves as
    // no_matching_message rather than a wrong author.
    expect(logged.sbSlug).toBe('wren');
    expect(logged.platformMessageId).toBeUndefined();
  });
});
