import { describe, it, expect } from 'vitest';
import { validateTelegramChatId } from './telegram-chat-id.js';

describe('validateTelegramChatId', () => {
  it('accepts numeric DM chat ids', () => {
    expect(validateTelegramChatId('726555973')).toBeNull();
  });

  it('accepts negative group/channel ids', () => {
    expect(validateTelegramChatId('-1001234567890')).toBeNull();
  });

  it('accepts @usernames', () => {
    expect(validateTelegramChatId('@some_channel')).toBeNull();
  });

  it('rejects symbolic labels with a recovery hint', () => {
    const error = validateTelegramChatId('myra-telegram');
    expect(error).toContain('myra-telegram');
    expect(error).toContain('get_conversation_history');
  });

  it('rejects empty and malformed ids', () => {
    expect(validateTelegramChatId('')).not.toBeNull();
    expect(validateTelegramChatId('@ab')).not.toBeNull(); // too short for a username
    expect(validateTelegramChatId('123abc')).not.toBeNull();
    expect(validateTelegramChatId('conor')).not.toBeNull();
  });
});
