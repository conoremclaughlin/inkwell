import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config/env', async () => ({ env: (await import('../test/fake-env')).fakeEnv }));
vi.mock('../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../services/authorization', () => ({ getAuthorizationService: () => ({}) }));
vi.mock('./approval-interceptor', () => ({
  checkApprovalResponse: vi.fn(),
  formatApprovalConfirmation: vi.fn(),
}));
vi.mock('discord.js', () => ({
  Client: class {
    on = vi.fn();
    login = vi.fn(async () => undefined);
    destroy = vi.fn();
  },
  GatewayIntentBits: {},
  REST: class {},
  Routes: {},
}));
vi.mock('@slack/bolt', () => ({
  App: class {
    message = vi.fn();
    error = vi.fn();
    start = vi.fn(async () => undefined);
    stop = vi.fn(async () => undefined);
    client = {
      auth: { test: vi.fn(async () => ({ user_id: 'synthetic-bot', user: 'synthetic-bot' })) },
    };
  },
}));

import { TelegramListener } from './telegram-listener';
import { WhatsAppListener } from './whatsapp-listener';
import { DiscordListener } from './discord-listener';
import { SlackListener } from './slack-listener';

const TTL = 30 * 60_000;
const MAX_CHATS = 256;
const factories = [
  [
    'Telegram',
    () => {
      const listener = new TelegramListener({ token: 'synthetic-token' });
      Object.assign(listener, {
        acquireLock: vi.fn(async () => undefined),
        releaseLock: vi.fn(async () => undefined),
        apiCall: vi.fn(async () => ({ id: 1, username: 'synthetic-bot' })),
        poll: vi.fn(),
      });
      return listener;
    },
  ],
  [
    'WhatsApp',
    () => {
      const listener = new WhatsAppListener({ accountId: 'synthetic-account' });
      Object.assign(listener, { connect: vi.fn(async () => undefined) });
      return listener;
    },
  ],
  ['Discord', () => new DiscordListener({ token: 'synthetic-token', applicationId: '' })],
  ['Slack', () => new SlackListener({ botToken: 'synthetic-token', appToken: 'synthetic-token' })],
] as const;

const message = (chatId: string, messageId = 'synthetic-message', timestamp = new Date()) => ({
  chatId,
  messageId,
  timestamp,
  from: 'Synthetic Sender',
  fromId: 'synthetic-sender',
  text: 'Invented context.',
});

describe.each(factories)('%s ephemeral cache lifetime', (_name, create) => {
  let listener: ReturnType<typeof create>;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('No network in this test')))
    );
    listener = create();
  });
  afterEach(async () => {
    await listener.stop();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('expires untouched chats and deletes their keys without reads or writes', async () => {
    listener['cacheMessage'](message('synthetic-a'));
    listener['cacheMessage'](message('synthetic-b'));
    expect(listener.getCacheStats()).toEqual({ chatCount: 2, totalMessages: 2 });
    await vi.advanceTimersByTimeAsync(TTL + 60_000);
    expect(listener.getCacheStats()).toEqual({ chatCount: 0, totalMessages: 0 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not retain an empty key when an old message expires immediately', () => {
    listener['cacheMessage'](message('synthetic-old', 'old', new Date(Date.now() - TTL)));
    expect(listener.getRecentMessages('synthetic-old')).toEqual([]);
    expect(listener.getCacheStats()).toEqual({ chatCount: 0, totalMessages: 0 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds distinct chats and evicts the least recently used history', () => {
    for (let i = 0; i < MAX_CHATS; i++) listener['cacheMessage'](message(`synthetic-${i}`));
    listener.getRecentMessages('synthetic-0'); // keep this chat recent
    listener['cacheMessage'](message('synthetic-new'));
    expect(listener.getCacheStats()).toEqual({ chatCount: MAX_CHATS, totalMessages: MAX_CHATS });
    expect(listener.getRecentMessages('synthetic-0')).toHaveLength(1);
    expect(listener.getRecentMessages('synthetic-1')).toEqual([]);
  });

  it('preserves the 100-message per-chat limit and newest-last ordering', () => {
    for (let i = 0; i < 105; i++)
      listener['cacheMessage'](message('synthetic-chat', `synthetic-${i}`));
    expect(listener.getCacheStats()).toEqual({ chatCount: 1, totalMessages: 100 });
    expect(listener.getRecentMessages('synthetic-chat', 2).map((m) => m.messageId)).toEqual([
      'synthetic-103',
      'synthetic-104',
    ]);
  });

  it('clears stored data on stop even before a successful listener start', async () => {
    listener['cacheMessage'](message('synthetic-chat'));
    await listener.stop();
    expect(listener.getCacheStats()).toEqual({ chatCount: 0, totalMessages: 0 });
    expect(vi.getTimerCount()).toBe(0);
    listener['cacheMessage'](message('synthetic-late'));
    expect(listener.getCacheStats()).toEqual({ chatCount: 0, totalMessages: 0 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears the sweep timer on stop and can cache again after restart', async () => {
    await listener.start();
    listener['cacheMessage'](message('synthetic-chat'));
    expect(vi.getTimerCount()).toBe(1);
    await listener.stop();
    expect(listener.getCacheStats()).toEqual({ chatCount: 0, totalMessages: 0 });
    expect(vi.getTimerCount()).toBe(0);
    await listener.start();
    listener['cacheMessage'](message('synthetic-new'));
    expect(listener.getCacheStats()).toEqual({ chatCount: 1, totalMessages: 1 });
    expect(vi.getTimerCount()).toBe(1);
  });

  it('clears cache state after a failed start and permits a later retry', async () => {
    const failure = new Error('Synthetic connection failure');
    if (listener instanceof TelegramListener)
      vi.mocked(listener['apiCall']).mockRejectedValueOnce(failure);
    if (listener instanceof WhatsAppListener)
      vi.mocked(listener['connect']).mockRejectedValueOnce(failure);
    if (listener instanceof DiscordListener)
      vi.mocked(listener['client'].login).mockRejectedValueOnce(failure);
    if (listener instanceof SlackListener)
      vi.mocked(listener['app'].start).mockRejectedValueOnce(failure);
    listener['cacheMessage'](message('synthetic-before-failure'));
    await expect(listener.start()).rejects.toThrow(failure);
    expect(listener.getCacheStats()).toEqual({ chatCount: 0, totalMessages: 0 });
    expect(vi.getTimerCount()).toBe(0);
    listener['cacheMessage'](message('synthetic-late'));
    expect(listener.getCacheStats()).toEqual({ chatCount: 0, totalMessages: 0 });
    await listener.start();
    listener['cacheMessage'](message('synthetic-retry'));
    expect(listener.getCacheStats()).toEqual({ chatCount: 1, totalMessages: 1 });
  });

  it('cancels the cleanup timer after explicit deletion of the final chat', () => {
    listener['cacheMessage'](message('synthetic-chat'));
    listener.clearMessageCache('synthetic-chat');
    expect(listener.getCacheStats()).toEqual({ chatCount: 0, totalMessages: 0 });
    expect(vi.getTimerCount()).toBe(0);
  });
});
