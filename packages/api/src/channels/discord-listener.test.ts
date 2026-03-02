/**
 * Discord Listener Tests
 *
 * Tests the DiscordListener class focusing on:
 * - Message handling (auth, mention detection, conversion)
 * - DM command handling
 * - Message splitting for Discord's 2000-char limit
 * - Slash command conversion
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';

// Mock discord.js before importing DiscordListener
const mockLogin = vi.fn().mockResolvedValue('token');
const mockDestroy = vi.fn();
const mockFetch = vi.fn();
const mockSend = vi.fn().mockResolvedValue(undefined);
const mockSendTyping = vi.fn().mockResolvedValue(undefined);

// Track event handlers registered via client.on()
const eventHandlers = new Map<string, Function>();

const mockClientUser = {
  id: '999888777',
  username: 'TestBot',
  displayName: 'Test Bot',
};

vi.mock('discord.js', () => {
  // Use a class so `new Client()` works as expected
  class MockClient {
    login = mockLogin;
    destroy = mockDestroy;
    user = mockClientUser;
    isReady = () => true;
    channels = { fetch: mockFetch };
    guilds = { cache: new Map() };
    on(event: string, handler: Function) {
      eventHandlers.set(event, handler);
      return this;
    }
  }

  class MockREST {
    setToken() {
      return this;
    }
    put = vi.fn().mockResolvedValue(undefined);
  }

  return {
    Client: MockClient,
    GatewayIntentBits: {
      Guilds: 1,
      GuildMessages: 2,
      MessageContent: 4,
      GuildMembers: 8,
      DirectMessages: 16,
    },
    REST: MockREST,
    Routes: {
      applicationCommands: vi.fn().mockReturnValue('/applications/commands'),
    },
  };
});

// Mock authorization service
const mockAuthService = {
  isGroupAuthorized: vi.fn(),
  isUserTrusted: vi.fn(),
  generateChallengeCode: vi.fn(),
  authorizeGroupWithCode: vi.fn(),
  addTrustedUser: vi.fn(),
  revokeGroup: vi.fn(),
  listAuthorizedGroups: vi.fn(),
  listTrustedUsers: vi.fn(),
};

vi.mock('../services/authorization', () => ({
  getAuthorizationService: () => mockAuthService,
}));

// Mock env
vi.mock('../config/env', () => ({
  env: {
    DISCORD_BOT_TOKEN: 'test-token',
    DISCORD_APPLICATION_ID: 'test-app-id',
  },
}));

// Mock logger
vi.mock('../utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { DiscordListener, createDiscordListener } from './discord-listener';

/**
 * Create a mock Discord.js Collection (extends Map with .map() and other methods)
 */
function createMockCollection<K, V>(entries: [K, V][] = []) {
  const map = new Map<K, V>(entries);
  return Object.assign(map, {
    map: <R>(fn: (value: V, key: K, collection: Map<K, V>) => R): R[] => {
      const results: R[] = [];
      for (const [k, v] of map) {
        results.push(fn(v, k, map));
      }
      return results;
    },
  });
}

// Helper to create a mock Discord message
function createMockMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '12345',
    content: 'Hello bot',
    createdTimestamp: Date.now(),
    author: {
      id: '111222333',
      bot: false,
      username: 'testuser',
      displayName: 'Test User',
    },
    guild: {
      id: '444555666',
      name: 'Test Server',
    },
    channel: {
      id: '777888999',
      name: 'general',
      send: mockSend,
      sendTyping: mockSendTyping,
      messages: { fetch: vi.fn() },
    },
    channelId: '777888999',
    attachments: new Map(),
    mentions: {
      users: createMockCollection(),
      has: vi.fn().mockReturnValue(false),
    },
    reference: null,
    ...overrides,
  };
}

describe('DiscordListener', () => {
  let listener: DiscordListener;

  beforeEach(() => {
    vi.clearAllMocks();
    eventHandlers.clear();
    listener = new DiscordListener({ token: 'test-token', applicationId: 'test-app-id' });
  });

  describe('construction', () => {
    it('should create with explicit config', () => {
      const l = new DiscordListener({ token: 'my-token', applicationId: 'my-app' });
      expect(l).toBeDefined();
      expect(l.running).toBe(false);
      expect(l.connected).toBe(false);
    });

    it('should fall back to env token when config token is empty', () => {
      // Empty string falls through to env.DISCORD_BOT_TOKEN ('test-token' from mock)
      const l = new DiscordListener({ token: '' });
      expect(l).toBeDefined();
    });
  });

  describe('createDiscordListener factory', () => {
    it('should create a DiscordListener instance', () => {
      const l = createDiscordListener({ token: 'test', applicationId: 'app' });
      expect(l).toBeInstanceOf(DiscordListener);
    });
  });

  describe('start/stop', () => {
    it('should login and emit connected on start', async () => {
      const connectedSpy = vi.fn();
      listener.on('connected', connectedSpy);

      await listener.start();

      expect(mockLogin).toHaveBeenCalledWith('test-token');
      expect(listener.running).toBe(true);
      expect(connectedSpy).toHaveBeenCalledWith({
        username: 'TestBot',
        id: '999888777',
      });
    });

    it('should set running to false on stop', async () => {
      await listener.start();
      await listener.stop();

      expect(listener.running).toBe(false);
      expect(mockDestroy).toHaveBeenCalled();
    });

    it('should warn if already running', async () => {
      await listener.start();
      await listener.start(); // second call
      // Should not throw, just warn
      expect(listener.running).toBe(true);
    });
  });

  describe('message handling - authorization', () => {
    let messageHandler: Function;

    beforeEach(async () => {
      const callback = vi.fn();
      listener.onMessage(callback);
      await listener.start();
      messageHandler = eventHandlers.get('messageCreate')!;
    });

    it('should ignore bot messages', async () => {
      const msg = createMockMessage({
        author: { ...(createMockMessage().author as object), bot: true },
      });
      await messageHandler(msg);

      expect(mockAuthService.isGroupAuthorized).not.toHaveBeenCalled();
      expect(mockAuthService.isUserTrusted).not.toHaveBeenCalled();
    });

    it('should check group authorization for guild messages', async () => {
      mockAuthService.isGroupAuthorized.mockResolvedValue(null);

      const msg = createMockMessage();
      await messageHandler(msg);

      expect(mockAuthService.isGroupAuthorized).toHaveBeenCalledWith('discord', '444555666');
    });

    it('should silently ignore messages in unauthorized guilds', async () => {
      mockAuthService.isGroupAuthorized.mockResolvedValue(null);

      const callback = vi.fn();
      listener.onMessage(callback);

      const msg = createMockMessage({ content: 'hello' });
      await messageHandler(msg);

      expect(callback).not.toHaveBeenCalled();
    });

    it('should handle /authorize command in unauthorized guilds', async () => {
      mockAuthService.isGroupAuthorized.mockResolvedValue(null);
      mockAuthService.authorizeGroupWithCode.mockResolvedValue({ success: true });

      mockFetch.mockResolvedValue({
        send: mockSend,
        sendTyping: mockSendTyping,
      });

      const msg = createMockMessage({ content: '/authorize ABC123' });
      await messageHandler(msg);

      expect(mockAuthService.authorizeGroupWithCode).toHaveBeenCalledWith(
        'discord',
        '444555666',
        'Test Server',
        'ABC123'
      );
    });

    it('should check DM trust for non-guild messages', async () => {
      mockAuthService.isUserTrusted.mockResolvedValue(null);

      const msg = createMockMessage({ guild: null });
      await messageHandler(msg);

      expect(mockAuthService.isUserTrusted).toHaveBeenCalledWith('discord', '111222333');
    });

    it('should silently ignore DMs from untrusted users', async () => {
      mockAuthService.isUserTrusted.mockResolvedValue(null);

      const callback = vi.fn();
      listener.onMessage(callback);

      const msg = createMockMessage({ guild: null });
      await messageHandler(msg);

      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe('message handling - authorized group messages', () => {
    let messageHandler: Function;
    let callback: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
      callback = vi.fn();
      listener.onMessage(callback);
      await listener.start();
      messageHandler = eventHandlers.get('messageCreate')!;
    });

    it('should pass authorized group messages through even without bot mention', async () => {
      mockAuthService.isGroupAuthorized.mockResolvedValue({ id: '1', status: 'active' });

      const msg = createMockMessage({
        content: 'hello everyone',
        mentions: {
          users: createMockCollection(),
          has: vi.fn().mockReturnValue(false),
        },
      });
      await messageHandler(msg);

      expect(callback).toHaveBeenCalledTimes(1);
      const inbound = callback.mock.calls[0][0];
      expect(inbound.body).toBe('hello everyone');
      expect(inbound.mentions).toEqual({
        users: [],
        botMentioned: false,
      });
    });

    it('should process authorized group messages with direct @mention', async () => {
      mockAuthService.isGroupAuthorized.mockResolvedValue({ id: '1', status: 'active' });

      const msg = createMockMessage({
        content: '<@999888777> split $50',
        mentions: {
          users: createMockCollection([['999888777', mockClientUser]]),
          has: vi.fn().mockReturnValue(true),
        },
      });
      await messageHandler(msg);

      expect(callback).toHaveBeenCalled();
      // Should strip the mention from body
      const inbound = callback.mock.calls[0][0];
      expect(inbound.body).toBe('split $50');
    });

    it('should process messages mentioning bot name (case-insensitive)', async () => {
      mockAuthService.isGroupAuthorized.mockResolvedValue({ id: '1', status: 'active' });

      const msg = createMockMessage({
        content: 'hey testbot can you help?',
        mentions: {
          users: createMockCollection(),
          has: vi.fn().mockReturnValue(false),
        },
      });
      await messageHandler(msg);

      expect(callback).toHaveBeenCalled();
    });
  });

  describe('message conversion', () => {
    let messageHandler: Function;
    let callback: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
      callback = vi.fn();
      listener.onMessage(callback);
      await listener.start();
      messageHandler = eventHandlers.get('messageCreate')!;
    });

    it('should convert guild message to InboundMessage', async () => {
      mockAuthService.isGroupAuthorized.mockResolvedValue({ id: '1', status: 'active' });

      const msg = createMockMessage({
        content: '<@999888777> what is the weather?',
        mentions: {
          users: createMockCollection([['999888777', mockClientUser]]),
          has: vi.fn().mockReturnValue(true),
        },
      });
      await messageHandler(msg);

      const inbound = callback.mock.calls[0][0];
      expect(inbound.platform).toBe('discord');
      expect(inbound.chatType).toBe('group');
      expect(inbound.sender.id).toBe('111222333');
      expect(inbound.sender.username).toBe('testuser');
      expect(inbound.conversationId).toBe('777888999');
      expect(inbound.groupSubject).toBe('Test Server');
      expect(inbound.body).toBe('what is the weather?');
      expect(inbound.rawBody).toBe('<@999888777> what is the weather?');
    });

    it('should convert DM to InboundMessage', async () => {
      mockAuthService.isUserTrusted.mockResolvedValue({ id: '1', trustLevel: 'admin' });

      const msg = createMockMessage({
        guild: null,
        content: 'hello',
        mentions: {
          users: createMockCollection(),
          has: vi.fn().mockReturnValue(false),
        },
      });
      await messageHandler(msg);

      const inbound = callback.mock.calls[0][0];
      expect(inbound.chatType).toBe('direct');
      expect(inbound.groupSubject).toBeUndefined();
    });
  });

  describe('DM commands', () => {
    let messageHandler: Function;

    beforeEach(async () => {
      listener.onMessage(vi.fn());
      await listener.start();
      messageHandler = eventHandlers.get('messageCreate')!;

      // All DM commands require trusted user
      mockAuthService.isUserTrusted.mockResolvedValue({ id: '1', trustLevel: 'admin' });
      mockFetch.mockResolvedValue({
        send: mockSend,
        sendTyping: mockSendTyping,
      });
    });

    it('should handle /generate-group-code', async () => {
      mockAuthService.generateChallengeCode.mockResolvedValue('XY7Z9K');

      const msg = createMockMessage({ guild: null, content: '/generate-group-code' });
      await messageHandler(msg);

      expect(mockAuthService.generateChallengeCode).toHaveBeenCalledWith('discord', '111222333');
    });

    it('should handle /groupcode alias', async () => {
      mockAuthService.generateChallengeCode.mockResolvedValue('ABC123');

      const msg = createMockMessage({ guild: null, content: '/groupcode' });
      await messageHandler(msg);

      expect(mockAuthService.generateChallengeCode).toHaveBeenCalled();
    });

    it('should handle /list-groups', async () => {
      mockAuthService.listAuthorizedGroups.mockResolvedValue([
        { platformGroupId: '123', groupName: 'Server A', authorizationMethod: 'challenge_code' },
      ]);

      const msg = createMockMessage({ guild: null, content: '/list-groups' });
      await messageHandler(msg);

      expect(mockAuthService.listAuthorizedGroups).toHaveBeenCalledWith('discord');
    });

    it('should handle /list-trusted', async () => {
      mockAuthService.listTrustedUsers.mockResolvedValue([
        { platformUserId: '456', trustLevel: 'admin' },
      ]);

      const msg = createMockMessage({ guild: null, content: '/list-trusted' });
      await messageHandler(msg);

      expect(mockAuthService.listTrustedUsers).toHaveBeenCalledWith('discord');
    });

    it('should handle /add-trusted', async () => {
      mockAuthService.addTrustedUser.mockResolvedValue({ success: true });

      const msg = createMockMessage({ guild: null, content: '/add-trusted 789 admin' });
      await messageHandler(msg);

      expect(mockAuthService.addTrustedUser).toHaveBeenCalledWith(
        'discord',
        '789',
        'admin',
        '111222333'
      );
    });

    it('should handle /revoke-group', async () => {
      mockAuthService.revokeGroup.mockResolvedValue({ success: true });

      const msg = createMockMessage({ guild: null, content: '/revoke-group 444555666' });
      await messageHandler(msg);

      expect(mockAuthService.revokeGroup).toHaveBeenCalledWith('discord', '444555666', '111222333');
    });
  });

  describe('sendMessage', () => {
    beforeEach(async () => {
      listener.onMessage(vi.fn());
      await listener.start();
    });

    it('should send message to channel', async () => {
      mockFetch.mockResolvedValue({
        send: mockSend,
      });

      await listener.sendMessage('777888999', 'Hello!');

      expect(mockFetch).toHaveBeenCalledWith('777888999');
      expect(mockSend).toHaveBeenCalledWith('Hello!');
    });

    it('should strip discord: prefix from conversationId', async () => {
      mockFetch.mockResolvedValue({
        send: mockSend,
      });

      await listener.sendMessage('discord:777888999', 'Hello!');

      expect(mockFetch).toHaveBeenCalledWith('777888999');
    });

    it('should split long messages', async () => {
      mockFetch.mockResolvedValue({
        send: mockSend,
      });

      // Create a message longer than 2000 chars
      const longMessage = 'A'.repeat(1500) + '\n' + 'B'.repeat(1500);

      await listener.sendMessage('777888999', longMessage);

      expect(mockSend).toHaveBeenCalledTimes(2);
      // First chunk should be <= 2000
      expect(mockSend.mock.calls[0][0].length).toBeLessThanOrEqual(2000);
      expect(mockSend.mock.calls[1][0].length).toBeLessThanOrEqual(2000);
    });
  });

  describe('ephemeral message cache', () => {
    it('should return empty array for unknown chat', () => {
      const messages = listener.getRecentMessages('unknown-chat');
      expect(messages).toEqual([]);
    });

    it('should return cache stats', () => {
      const stats = listener.getCacheStats();
      expect(stats).toEqual({ chatCount: 0, totalMessages: 0 });
    });

    it('should clear cache for a chat', () => {
      // clearMessageCache should not throw even for non-existent chats
      listener.clearMessageCache('some-chat');
      expect(listener.getCacheStats().chatCount).toBe(0);
    });
  });

  describe('typing indicator', () => {
    beforeEach(async () => {
      listener.onMessage(vi.fn());
      await listener.start();
    });

    it('should send typing indicator', async () => {
      mockFetch.mockResolvedValue({
        sendTyping: mockSendTyping,
      });

      await listener.sendTypingIndicator('777888999');

      expect(mockFetch).toHaveBeenCalledWith('777888999');
      expect(mockSendTyping).toHaveBeenCalled();
    });

    it('should handle typing indicator errors gracefully', async () => {
      mockFetch.mockRejectedValue(new Error('Channel not found'));

      // Should not throw
      await listener.sendTypingIndicator('invalid-channel');
    });
  });
});
