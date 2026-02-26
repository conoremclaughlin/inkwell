/**
 * Channel Gateway Tests
 *
 * Tests for message buffering, processing locks, and response routing.
 */

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';

const mockTtsIsEnabled = vi.fn(() => false);
const mockTtsSynthesize = vi.fn();

// Mock the channel listeners before importing gateway
vi.mock('./telegram-listener', () => ({
  createTelegramListener: vi.fn(() => ({
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    onMessage: vi.fn(),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    sendVoice: vi.fn().mockResolvedValue(undefined),
    sendTypingIndicator: vi.fn(),
    on: vi.fn(),
    running: false,
  })),
}));

vi.mock('./whatsapp-listener', () => ({
  createWhatsAppListener: vi.fn(() => ({
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    onMessage: vi.fn(),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    sendTypingIndicator: vi.fn(),
    on: vi.fn(),
    connected: false,
  })),
}));

vi.mock('../mcp/tools/response-handlers', () => ({
  setResponseCallback: vi.fn(),
}));

vi.mock('../utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../config/env', () => ({
  env: {
    TELEGRAM_BOT_TOKEN: 'test-token',
    LOG_LEVEL: 'info',
  },
}));

vi.mock('./text-to-speech', () => ({
  TextToSpeechService: {
    fromEnv: vi.fn(() => ({
      isEnabled: mockTtsIsEnabled,
      synthesize: mockTtsSynthesize,
    })),
  },
}));

// Import after mocks
import { ChannelGateway, type IncomingMessageHandler } from './gateway.js';

describe('ChannelGateway', () => {
  let gateway: ChannelGateway;

  beforeEach(() => {
    vi.useFakeTimers();
    mockTtsIsEnabled.mockReturnValue(false);
    mockTtsSynthesize.mockReset();
    gateway = new ChannelGateway({
      enableTelegram: false,
      enableWhatsApp: false,
      messageBufferDelayMs: 2000,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  describe('Message Buffering', () => {
    it('should buffer messages within the delay window', async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      gateway.setMessageHandler(handler);

      // Access private method via any cast for testing
      const bufferMessage = (gateway as any).bufferMessage.bind(gateway);

      // Send first message
      bufferMessage('telegram', 'chat123', { id: 'user1', name: 'Test' }, 'Hello');

      // Handler should not be called yet
      expect(handler).not.toHaveBeenCalled();

      // Send second message within buffer window
      bufferMessage('telegram', 'chat123', { id: 'user1', name: 'Test' }, 'World');

      // Still not called
      expect(handler).not.toHaveBeenCalled();

      // Advance timers past buffer delay
      await vi.advanceTimersByTimeAsync(2100);

      // Now handler should be called once with combined message
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(
        'telegram',
        'chat123',
        { id: 'user1', name: 'Test' },
        'Hello\n\nWorld',
        expect.any(Object)
      );
    });

    it('should combine messages from same conversation', async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      gateway.setMessageHandler(handler);

      const bufferMessage = (gateway as any).bufferMessage.bind(gateway);

      // Send three rapid messages
      bufferMessage('telegram', 'chat123', { id: 'user1' }, 'Message 1');
      bufferMessage('telegram', 'chat123', { id: 'user1' }, 'Message 2');
      bufferMessage('telegram', 'chat123', { id: 'user1' }, 'Message 3');

      await vi.advanceTimersByTimeAsync(2100);

      expect(handler).toHaveBeenCalledTimes(1);
      const callArgs = handler.mock.calls[0];
      expect(callArgs[3]).toBe('Message 1\n\nMessage 2\n\nMessage 3');
    });

    it('should keep separate buffers for different conversations', async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      gateway.setMessageHandler(handler);

      const bufferMessage = (gateway as any).bufferMessage.bind(gateway);

      // Messages to two different conversations
      bufferMessage('telegram', 'chat1', { id: 'user1' }, 'Chat 1 message');
      bufferMessage('telegram', 'chat2', { id: 'user2' }, 'Chat 2 message');

      await vi.advanceTimersByTimeAsync(2100);

      // Should be called twice, once per conversation
      expect(handler).toHaveBeenCalledTimes(2);
    });

    it('should reset buffer timer on new message', async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      gateway.setMessageHandler(handler);

      const bufferMessage = (gateway as any).bufferMessage.bind(gateway);

      // First message
      bufferMessage('telegram', 'chat123', { id: 'user1' }, 'First');

      // Wait 1.5 seconds (not enough to flush)
      await vi.advanceTimersByTimeAsync(1500);
      expect(handler).not.toHaveBeenCalled();

      // Second message resets timer
      bufferMessage('telegram', 'chat123', { id: 'user1' }, 'Second');

      // Wait another 1.5 seconds (total 3s from first, but only 1.5s from second)
      await vi.advanceTimersByTimeAsync(1500);
      expect(handler).not.toHaveBeenCalled();

      // Wait remaining time
      await vi.advanceTimersByTimeAsync(600);
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('should bypass buffering when delay is 0', async () => {
      const noBufferGateway = new ChannelGateway({
        enableTelegram: false,
        enableWhatsApp: false,
        messageBufferDelayMs: 0,
      });

      const handler = vi.fn().mockResolvedValue(undefined);
      noBufferGateway.setMessageHandler(handler);

      const bufferMessage = (noBufferGateway as any).bufferMessage.bind(noBufferGateway);

      bufferMessage('telegram', 'chat123', { id: 'user1' }, 'Immediate');

      // Should be called immediately without waiting
      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe('Processing Lock', () => {
    it('should queue messages when conversation is processing', async () => {
      const handler = vi.fn().mockImplementation(async () => {
        // Simulate slow processing
        await new Promise((resolve) => setTimeout(resolve, 5000));
      });
      gateway.setMessageHandler(handler);

      const bufferMessage = (gateway as any).bufferMessage.bind(gateway);
      const processingConversations = (gateway as any).processingConversations;
      const pendingBuffers = (gateway as any).pendingBuffers;

      // First message starts processing
      bufferMessage('telegram', 'chat123', { id: 'user1' }, 'First batch');
      await vi.advanceTimersByTimeAsync(2100);

      // Should be processing now
      expect(processingConversations.has('telegram:chat123')).toBe(true);

      // Second message arrives while processing
      bufferMessage('telegram', 'chat123', { id: 'user1' }, 'Queued message');
      await vi.advanceTimersByTimeAsync(2100);

      // Should be in pending buffer, not calling handler again yet
      expect(handler).toHaveBeenCalledTimes(1);
      expect(pendingBuffers.has('telegram:chat123')).toBe(true);
    });

    it('should merge multiple pending messages', async () => {
      let resolveFirstCall: () => void;
      const firstCallPromise = new Promise<void>((resolve) => {
        resolveFirstCall = resolve;
      });

      const handler = vi.fn().mockImplementationOnce(async () => {
        await firstCallPromise;
      });
      gateway.setMessageHandler(handler);

      const bufferMessage = (gateway as any).bufferMessage.bind(gateway);
      const pendingBuffers = (gateway as any).pendingBuffers;

      // First message
      bufferMessage('telegram', 'chat123', { id: 'user1' }, 'First');
      await vi.advanceTimersByTimeAsync(2100);

      // Multiple messages while processing
      bufferMessage('telegram', 'chat123', { id: 'user1' }, 'Pending 1');
      await vi.advanceTimersByTimeAsync(2100);

      bufferMessage('telegram', 'chat123', { id: 'user1' }, 'Pending 2');
      await vi.advanceTimersByTimeAsync(2100);

      // Check pending buffer has merged messages
      const pending = pendingBuffers.get('telegram:chat123');
      expect(pending).toBeDefined();
      expect(pending.messages.length).toBe(2);
    });

    it('should process pending messages after response sent', async () => {
      // This test verifies the processPendingMessages flow
      const processingConversations = (gateway as any).processingConversations;
      const pendingBuffers = (gateway as any).pendingBuffers;

      // Manually set up state as if first batch completed
      processingConversations.add('telegram:chat123');
      pendingBuffers.set('telegram:chat123', {
        channel: 'telegram',
        conversationId: 'chat123',
        sender: { id: 'user1' },
        messages: [
          { content: 'Pending 1', timestamp: new Date() },
          { content: 'Pending 2', timestamp: new Date() },
        ],
        metadata: {},
      });

      const handler = vi.fn().mockResolvedValue(undefined);
      gateway.setMessageHandler(handler);

      // Trigger processPendingMessages
      const processPendingMessages = (gateway as any).processPendingMessages.bind(gateway);
      await processPendingMessages('telegram', 'chat123');

      // Handler should be called with combined pending messages
      expect(handler).toHaveBeenCalledWith(
        'telegram',
        'chat123',
        { id: 'user1' },
        'Pending 1\n\nPending 2',
        expect.any(Object)
      );
    });

    it('should release lock when no pending messages', async () => {
      const processingConversations = (gateway as any).processingConversations;

      // Set up as if processing completed with no pending
      processingConversations.add('telegram:chat123');

      const processPendingMessages = (gateway as any).processPendingMessages.bind(gateway);
      await processPendingMessages('telegram', 'chat123');

      // Lock should be released
      expect(processingConversations.has('telegram:chat123')).toBe(false);
    });
  });

  describe('Processing Lock Error Recovery', () => {
    it('should release processing lock when handler throws in flushBuffer', async () => {
      const handler = vi.fn().mockRejectedValue(new Error('Handler crashed'));
      gateway.setMessageHandler(handler);

      const bufferMessage = (gateway as any).bufferMessage.bind(gateway);
      const processingConversations = (gateway as any).processingConversations;

      // Send a message that will trigger flushBuffer
      bufferMessage('telegram', 'chat123', { id: 'user1' }, 'Test message');
      await vi.advanceTimersByTimeAsync(2100);

      // Handler was called and threw
      expect(handler).toHaveBeenCalledTimes(1);

      // Processing lock should be released despite the error
      expect(processingConversations.has('telegram:chat123')).toBe(false);
    });

    it('should release processing lock when forwardToHandler catches error', async () => {
      const handler = vi.fn().mockRejectedValue(new Error('Handler failed'));
      gateway.setMessageHandler(handler);

      const forwardToHandler = (gateway as any).forwardToHandler.bind(gateway);
      const processingConversations = (gateway as any).processingConversations;

      // Manually set processing lock (as flushBuffer would)
      processingConversations.add('telegram:chat456');

      // Call forwardToHandler directly — it should catch the error and release lock
      await forwardToHandler('telegram', 'chat456', { id: 'user1' }, 'Test message', {});

      // Lock should be released
      expect(processingConversations.has('telegram:chat456')).toBe(false);
    });

    it('should allow new messages after error recovery', async () => {
      let callCount = 0;
      const handler = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) throw new Error('First call fails');
        // Second call succeeds
      });
      gateway.setMessageHandler(handler);

      const bufferMessage = (gateway as any).bufferMessage.bind(gateway);
      const processingConversations = (gateway as any).processingConversations;

      // First message — handler throws
      bufferMessage('telegram', 'chat123', { id: 'user1' }, 'Failing message');
      await vi.advanceTimersByTimeAsync(2100);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(processingConversations.has('telegram:chat123')).toBe(false);

      // Second message — should succeed since lock was released
      bufferMessage('telegram', 'chat123', { id: 'user1' }, 'Recovery message');
      await vi.advanceTimersByTimeAsync(2100);

      expect(handler).toHaveBeenCalledTimes(2);
    });
  });

  describe('Buffer Key Generation', () => {
    it('should generate unique keys per channel and conversation', () => {
      const getBufferKey = (gateway as any).getBufferKey.bind(gateway);

      expect(getBufferKey('telegram', '123')).toBe('telegram:123');
      expect(getBufferKey('whatsapp', '456')).toBe('whatsapp:456');
      expect(getBufferKey('telegram', '123')).not.toBe(getBufferKey('whatsapp', '123'));
    });
  });

  describe('Media Handling', () => {
    it('should combine media from multiple buffered messages', async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      gateway.setMessageHandler(handler);

      const bufferMessage = (gateway as any).bufferMessage.bind(gateway);

      // Messages with media
      bufferMessage('telegram', 'chat123', { id: 'user1' }, 'With image', {
        media: [{ type: 'image', path: '/tmp/img1.jpg' }],
      });
      bufferMessage('telegram', 'chat123', { id: 'user1' }, 'With video', {
        media: [{ type: 'video', path: '/tmp/vid1.mp4' }],
      });

      await vi.advanceTimersByTimeAsync(2100);

      expect(handler).toHaveBeenCalledWith(
        'telegram',
        'chat123',
        { id: 'user1' },
        'With image\n\nWith video',
        expect.objectContaining({
          media: [
            { type: 'image', path: '/tmp/img1.jpg' },
            { type: 'video', path: '/tmp/vid1.mp4' },
          ],
        })
      );
    });
  });

  describe('Telegram Voice Replies', () => {
    it('sends a voice reply when explicitly requested in metadata', async () => {
      mockTtsIsEnabled.mockReturnValue(true);
      const cleanup = vi.fn().mockResolvedValue(undefined);
      mockTtsSynthesize.mockResolvedValue({
        filePath: '/tmp/reply.ogg',
        contentType: 'audio/ogg',
        filename: 'reply.ogg',
        cleanup,
      });

      const sendVoice = vi.fn().mockResolvedValue(undefined);
      const sendMessage = vi.fn().mockResolvedValue(undefined);
      (gateway as any).telegramListener = {
        sendVoice,
        sendMessage,
      };

      await gateway.sendResponse({
        channel: 'telegram',
        conversationId: 'chat123',
        content: 'Here is your response',
        metadata: { voiceReply: true },
      });

      expect(mockTtsSynthesize).toHaveBeenCalledWith({ text: 'Here is your response' });
      expect(sendVoice).toHaveBeenCalledTimes(1);
      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(cleanup).toHaveBeenCalledTimes(1);
    });

    it('cleans pending voice reply flag when conversation is released without a response', async () => {
      const key = (gateway as any).getBufferKey('telegram', 'chat999');
      (gateway as any).pendingVoiceReplyConversations.add(key);

      await gateway.releaseConversation('telegram', 'chat999');

      expect((gateway as any).pendingVoiceReplyConversations.has(key)).toBe(false);
    });
  });
});

describe('Gateway Status', () => {
  it('should report correct status when not started', () => {
    const gateway = new ChannelGateway({
      enableTelegram: true,
      enableWhatsApp: true,
    });

    const status = gateway.getStatus();

    expect(status.started).toBe(false);
    expect(status.telegram.enabled).toBe(true);
    expect(status.whatsapp.enabled).toBe(true);
  });
});

describe('isAgentMentioned', () => {
  let gateway: ChannelGateway;

  beforeEach(() => {
    gateway = new ChannelGateway({
      enableTelegram: false,
      enableWhatsApp: false,
    });
  });

  const isAgentMentioned = (
    gw: ChannelGateway,
    text: string,
    mentions?: { users: string[]; botMentioned: boolean }
  ) => (gw as any).isAgentMentioned(text, mentions);

  it('returns true when botMentioned is true', () => {
    expect(isAgentMentioned(gateway, 'hello', { users: [], botMentioned: true })).toBe(true);
  });

  it('returns false with no mentions and no known agent names', () => {
    expect(isAgentMentioned(gateway, 'hello world', { users: [], botMentioned: false })).toBe(
      false
    );
  });

  it('returns false with no mentions argument', () => {
    expect(isAgentMentioned(gateway, 'hello world')).toBe(false);
  });

  it('returns true when mentioned username matches a known agent name', () => {
    gateway.setKnownAgentNames(['wren', 'myra', 'benson']);
    expect(
      isAgentMentioned(gateway, 'hello', { users: ['@wren'], botMentioned: false })
    ).toBe(true);
  });

  it('matches mentioned usernames case-insensitively', () => {
    gateway.setKnownAgentNames(['wren']);
    expect(
      isAgentMentioned(gateway, 'hello', { users: ['WREN'], botMentioned: false })
    ).toBe(true);
  });

  it('strips @ prefix from mentioned usernames', () => {
    gateway.setKnownAgentNames(['myra']);
    expect(
      isAgentMentioned(gateway, 'hello', { users: ['@myra'], botMentioned: false })
    ).toBe(true);
  });

  it('returns true when agent name appears in message text', () => {
    gateway.setKnownAgentNames(['wren', 'myra']);
    expect(
      isAgentMentioned(gateway, 'hey wren, can you help?', { users: [], botMentioned: false })
    ).toBe(true);
  });

  it('uses word boundaries for text matching', () => {
    gateway.setKnownAgentNames(['wren']);
    // "wrench" should NOT match "wren"
    expect(
      isAgentMentioned(gateway, 'pass me the wrench', { users: [], botMentioned: false })
    ).toBe(false);
  });

  it('skips text matching for very short agent names (< 3 chars)', () => {
    gateway.setKnownAgentNames(['ab']);
    // "ab" is too short for text matching (would cause false positives)
    expect(
      isAgentMentioned(gateway, 'the ab test worked', { users: [], botMentioned: false })
    ).toBe(false);
  });

  it('returns false when mentioned username does not match any agent', () => {
    gateway.setKnownAgentNames(['wren', 'myra']);
    expect(
      isAgentMentioned(gateway, 'hello', { users: ['someuser'], botMentioned: false })
    ).toBe(false);
  });

  it('handles multiple mentioned usernames', () => {
    gateway.setKnownAgentNames(['wren', 'myra']);
    expect(
      isAgentMentioned(gateway, 'hello', {
        users: ['randomuser', 'myra'],
        botMentioned: false,
      })
    ).toBe(true);
  });

  it('safely handles agent names with regex metacharacters', () => {
    gateway.setKnownAgentNames(['agent+1', 'bot.v2']);
    // Should not throw, and should match literally
    expect(
      isAgentMentioned(gateway, 'hey agent+1!', { users: [], botMentioned: false })
    ).toBe(true);
    expect(
      isAgentMentioned(gateway, 'ask bot.v2 about it', { users: [], botMentioned: false })
    ).toBe(true);
    // "+" unescaped would match "agent1" — escaped should NOT
    expect(
      isAgentMentioned(gateway, 'hey agent1 help', { users: [], botMentioned: false })
    ).toBe(false);
  });
});

describe('Activity Stream Integration', () => {
  let gateway: ChannelGateway;
  let mockLogMessage: Mock;
  let mockDataComposer: any;

  let mockFindByPlatformId: Mock;

  beforeEach(() => {
    vi.useFakeTimers();
    mockLogMessage = vi.fn().mockResolvedValue({ id: 'activity-123' });
    mockFindByPlatformId = vi.fn().mockResolvedValue(null);
    mockDataComposer = {
      repositories: {
        activityStream: {
          logMessage: mockLogMessage,
        },
        users: {
          findByPlatformId: mockFindByPlatformId,
        },
      },
    };
    gateway = new ChannelGateway({
      enableTelegram: false,
      enableWhatsApp: false,
      messageBufferDelayMs: 0, // Disable buffering for simpler tests
      dataComposer: mockDataComposer,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  describe('Incoming Messages', () => {
    it('should log incoming message to activity stream when userId is provided', async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      gateway.setMessageHandler(handler);

      const forwardToHandler = (gateway as any).forwardToHandler.bind(gateway);

      await forwardToHandler(
        'telegram',
        'chat123',
        { id: 'sender456', name: 'Test User' },
        'Hello from user',
        { userId: 'user-uuid-123', chatType: 'direct' }
      );

      expect(mockLogMessage).toHaveBeenCalledTimes(1);
      expect(mockLogMessage).toHaveBeenCalledWith({
        userId: 'user-uuid-123',
        agentId: 'myra',
        direction: 'in',
        content: 'Hello from user',
        platform: 'telegram',
        platformChatId: 'chat123',
        isDm: true,
        payload: {
          senderName: 'Test User',
          senderId: 'sender456',
        },
      });
    });

    it('should set isDm to false for group chats', async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      gateway.setMessageHandler(handler);

      const forwardToHandler = (gateway as any).forwardToHandler.bind(gateway);

      await forwardToHandler('telegram', 'group123', { id: 'sender456' }, 'Hello group', {
        userId: 'user-uuid-123',
        chatType: 'group',
      });

      expect(mockLogMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          isDm: false,
        })
      );
    });

    it('should resolve userId from platform + sender ID when not in metadata (Telegram flow)', async () => {
      // This is the core regression test: Telegram never passes userId in metadata.
      // The gateway must resolve it from platform + sender ID.
      mockFindByPlatformId.mockResolvedValueOnce({ id: 'resolved-user-uuid' });

      const handler = vi.fn().mockResolvedValue(undefined);
      gateway.setMessageHandler(handler);

      const forwardToHandler = (gateway as any).forwardToHandler.bind(gateway);

      await forwardToHandler(
        'telegram',
        'chat123',
        { id: 'telegram-sender-789' },
        'Hello from Telegram',
        { chatType: 'direct' } // No userId — just like real Telegram messages
      );

      // Should have resolved user from platform ID
      expect(mockFindByPlatformId).toHaveBeenCalledWith('telegram', 'telegram-sender-789');

      // Should log to activity stream with resolved userId
      expect(mockLogMessage).toHaveBeenCalledTimes(1);
      expect(mockLogMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'resolved-user-uuid',
          direction: 'in',
          content: 'Hello from Telegram',
          platform: 'telegram',
          platformChatId: 'chat123',
        })
      );

      // Should pass resolved userId to handler in enriched metadata
      expect(handler).toHaveBeenCalledWith(
        'telegram',
        'chat123',
        { id: 'telegram-sender-789' },
        'Hello from Telegram',
        expect.objectContaining({ userId: 'resolved-user-uuid' })
      );
    });

    it('should not log when userId cannot be resolved from platform ID', async () => {
      // User not found in database — can't log to activity stream
      mockFindByPlatformId.mockResolvedValueOnce(null);

      const handler = vi.fn().mockResolvedValue(undefined);
      gateway.setMessageHandler(handler);

      const forwardToHandler = (gateway as any).forwardToHandler.bind(gateway);

      await forwardToHandler(
        'telegram',
        'chat123',
        { id: 'unknown-sender' },
        'Hello',
        {} // No userId, and user not in DB
      );

      expect(mockFindByPlatformId).toHaveBeenCalledWith('telegram', 'unknown-sender');
      expect(mockLogMessage).not.toHaveBeenCalled();
    });

    it('should still forward message even if activity logging fails', async () => {
      mockLogMessage.mockRejectedValueOnce(new Error('DB error'));
      const handler = vi.fn().mockResolvedValue(undefined);
      gateway.setMessageHandler(handler);

      const forwardToHandler = (gateway as any).forwardToHandler.bind(gateway);

      await forwardToHandler('telegram', 'chat123', { id: 'sender456' }, 'Hello', {
        userId: 'user-uuid-123',
      });

      // Handler should still be called despite logging error
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('should store userId in conversationUserMap for later outbound logging', async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      gateway.setMessageHandler(handler);

      const forwardToHandler = (gateway as any).forwardToHandler.bind(gateway);

      await forwardToHandler('telegram', 'chat123', { id: 'sender456' }, 'Hello', {
        userId: 'user-uuid-123',
      });

      // Access the module-level conversationUserMap via the gateway's context
      // We can verify this by checking outbound logging works
      const sendTelegramMessage = (gateway as any).sendTelegramMessage.bind(gateway);

      // Mock telegram listener for outbound
      (gateway as any).telegramListener = {
        sendMessage: vi.fn().mockResolvedValue(undefined),
      };

      await sendTelegramMessage('chat123', 'Reply message');

      // Should have logged outbound message using stored userId
      expect(mockLogMessage).toHaveBeenCalledTimes(2);
      expect(mockLogMessage).toHaveBeenLastCalledWith({
        userId: 'user-uuid-123',
        agentId: 'myra',
        direction: 'out',
        content: 'Reply message',
        platform: 'telegram',
        platformChatId: 'chat123',
        isDm: true,
      });
    });
  });

  describe('Outgoing Messages', () => {
    it('should log outgoing Telegram message using userId resolved from incoming', async () => {
      // Simulate the real Telegram round-trip:
      // 1. Incoming message with no userId → gateway resolves from platform ID
      // 2. Outgoing response → gateway uses cached userId from conversationUserMap
      mockFindByPlatformId.mockResolvedValueOnce({ id: 'resolved-user-uuid' });

      const handler = vi.fn().mockResolvedValue(undefined);
      gateway.setMessageHandler(handler);

      const forwardToHandler = (gateway as any).forwardToHandler.bind(gateway);
      await forwardToHandler(
        'telegram',
        'chat123',
        { id: 'sender456' },
        'Incoming',
        { chatType: 'direct' } // No userId — resolved from platform ID
      );

      // Now send outgoing message
      (gateway as any).telegramListener = {
        sendMessage: vi.fn().mockResolvedValue(undefined),
      };

      const sendTelegramMessage = (gateway as any).sendTelegramMessage.bind(gateway);
      await sendTelegramMessage('chat123', 'Outgoing reply');

      expect(mockLogMessage).toHaveBeenCalledTimes(2);
      expect(mockLogMessage).toHaveBeenLastCalledWith(
        expect.objectContaining({
          userId: 'resolved-user-uuid',
          direction: 'out',
          content: 'Outgoing reply',
          platform: 'telegram',
        })
      );
    });

    it('should not log outgoing message when userId is not in conversationUserMap', async () => {
      (gateway as any).telegramListener = {
        sendMessage: vi.fn().mockResolvedValue(undefined),
      };

      const sendTelegramMessage = (gateway as any).sendTelegramMessage.bind(gateway);
      await sendTelegramMessage('unknown-chat', 'Message');

      // No incoming message was processed for this chat, so no userId in map
      expect(mockLogMessage).not.toHaveBeenCalled();
    });
  });
});
