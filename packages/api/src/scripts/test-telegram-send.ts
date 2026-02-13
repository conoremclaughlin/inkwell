#!/usr/bin/env npx tsx
/**
 * Test script to send a Telegram message using Telegram Bot API
 *
 * Usage: npx tsx src/scripts/test-telegram-send.ts
 */

import { env } from '../config/env';

const TELEGRAM_API = 'https://api.telegram.org';

interface TelegramChat {
  id: number;
  type: string;
  username?: string;
  first_name?: string;
}

interface TelegramMessage {
  message_id: number;
  chat: TelegramChat;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
}

interface TelegramApiResponse<T> {
  ok: boolean;
  result: T;
  description?: string;
}

async function telegramApi<T>(
  token: string,
  method: string,
  params?: Record<string, unknown>
): Promise<T> {
  const url = `${TELEGRAM_API}/bot${token}/${method}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: params ? JSON.stringify(params) : undefined,
  });

  const data = (await response.json()) as TelegramApiResponse<T>;
  if (!data.ok) {
    throw new Error(`Telegram API error: ${data.description}`);
  }
  return data.result;
}

async function main() {
  const token = env.TELEGRAM_BOT_TOKEN;

  if (!token) {
    console.error('TELEGRAM_BOT_TOKEN not configured');
    process.exit(1);
  }

  console.log('Fetching recent updates from bot...\n');

  try {
    const updates = await telegramApi<TelegramUpdate[]>(token, 'getUpdates', { limit: 10 });

    if (updates.length === 0) {
      console.log('No recent updates found.');
      console.log('Please send a message to the bot first, then run this script again.');
      process.exit(0);
    }

    // Find unique chats from updates
    const chats = new Map<number, { username?: string; firstName?: string; type: string }>();

    for (const update of updates) {
      const msg = update.message || update.edited_message;
      if (msg?.chat) {
        chats.set(msg.chat.id, {
          username: msg.chat.username,
          firstName: msg.chat.first_name,
          type: msg.chat.type,
        });
      }
    }

    console.log('Found chats:');
    for (const [chatId, info] of chats) {
      console.log(`  - Chat ID: ${chatId}`);
      console.log(`    Username: ${info.username || 'N/A'}`);
      console.log(`    First Name: ${info.firstName || 'N/A'}`);
      console.log(`    Type: ${info.type}`);
      console.log();
    }

    // Send test message to the first chat
    const [targetChatId] = chats.keys();
    if (targetChatId) {
      console.log(`Sending test message to chat ${targetChatId}...`);

      const result = await telegramApi<TelegramMessage>(token, 'sendMessage', {
        chat_id: targetChatId,
        text: '🎉 *Test message from Personal Context Protocol!*\n\nYour Telegram integration is working.',
        parse_mode: 'Markdown',
      });

      console.log(`✅ Message sent! Message ID: ${result.message_id}`);
    }
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

main();
