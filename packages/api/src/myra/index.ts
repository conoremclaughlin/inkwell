#!/usr/bin/env npx tsx
/**
 * Myra - Persistent Messaging Process
 *
 * This is a long-lived process that handles Telegram/WhatsApp connections.
 * It does NOT restart on code changes - only restart manually when needed.
 *
 * Communicates with:
 * - MCP Server (via HTTP) for tools and data access
 * - Claude Code backend for AI processing
 *
 * Run: pm2 start myra
 *      yarn myra
 */

import path from 'path';
import { getDataComposer, DataComposer } from '../data/composer';
import { createTelegramListener, TelegramListener } from '../channels/telegram-listener';
import { createWhatsAppListener, WhatsAppListener } from '../channels/whatsapp-listener';
import { createSessionHost, SessionHost } from '../agent';
import { setTelegramListener } from '../mcp/tools';
import { logger } from '../utils/logger';
import { env } from '../config/env';
import telegramifyMarkdown from 'telegramify-markdown';

// Configuration
interface MyraConfig {
  /** Backend type: 'claude-code' (default) or 'direct-api' */
  backend?: 'claude-code' | 'direct-api';
  /** Model to use (default: sonnet) */
  model?: string;
  /** Working directory for Claude Code */
  workingDirectory?: string;
  /** Path to MCP config file */
  mcpConfigPath?: string;
  /** Telegram polling interval in ms */
  telegramPollingInterval?: number;
  /** WhatsApp account ID (default: 'default') */
  whatsappAccountId?: string;
  /** Whether to enable WhatsApp */
  enableWhatsApp?: boolean;
  /** System prompt to append */
  systemPrompt?: string;
}

// Global state
let sessionHost: SessionHost | null = null;
let telegramListener: TelegramListener | null = null;
let whatsappListener: WhatsAppListener | null = null;
let dataComposer: DataComposer | null = null;
let isShuttingDown = false;

// Typing indicator management
const activeTypingIntervals: Map<string, NodeJS.Timeout> = new Map();
const TYPING_INTERVAL_MS = 4000;

function startTypingIndicator(conversationId: string, channel: 'telegram' | 'whatsapp' = 'telegram'): void {
  stopTypingIndicator(conversationId);

  if (channel === 'telegram' && telegramListener) {
    telegramListener.sendTypingIndicator(conversationId);
  } else if (channel === 'whatsapp' && whatsappListener) {
    whatsappListener.sendTypingIndicator(conversationId);
  }

  const interval = setInterval(() => {
    if (channel === 'telegram' && telegramListener) {
      telegramListener.sendTypingIndicator(conversationId);
    } else if (channel === 'whatsapp' && whatsappListener) {
      whatsappListener.sendTypingIndicator(conversationId);
    }
  }, TYPING_INTERVAL_MS);

  activeTypingIntervals.set(conversationId, interval);
}

function stopTypingIndicator(conversationId: string): void {
  const interval = activeTypingIntervals.get(conversationId);
  if (interval) {
    clearInterval(interval);
    activeTypingIntervals.delete(conversationId);
  }
}

/**
 * Resolve or create a Telegram user
 */
async function resolveOrCreateTelegramUser(
  composer: DataComposer,
  message: { sender: { id: string; username?: string; name?: string } }
): Promise<{ id: string } | null> {
  try {
    const user = await composer.users.findByPlatformId('telegram', message.sender.id);
    if (user) return user;

    // Create new user
    const newUser = await composer.users.create({
      email: `telegram_${message.sender.id}@placeholder.local`,
      name: message.sender.name || message.sender.username || `Telegram User ${message.sender.id}`,
      telegramId: message.sender.id,
    });
    return newUser;
  } catch (error) {
    logger.error('Failed to resolve/create Telegram user:', error);
    return null;
  }
}

/**
 * Resolve or create a WhatsApp user
 */
async function resolveOrCreateWhatsAppUser(
  composer: DataComposer,
  message: { sender: { id: string; name?: string } }
): Promise<{ id: string } | null> {
  try {
    const user = await composer.users.findByPlatformId('whatsapp', message.sender.id);
    if (user) return user;

    // Create new user
    const newUser = await composer.users.create({
      email: `whatsapp_${message.sender.id}@placeholder.local`,
      name: message.sender.name || `WhatsApp User ${message.sender.id}`,
      whatsappId: message.sender.id,
    });
    return newUser;
  } catch (error) {
    logger.error('Failed to resolve/create WhatsApp user:', error);
    return null;
  }
}

/**
 * Build the system prompt
 */
function buildSystemPrompt(additionalPrompt?: string): string {
  const parts: string[] = [];

  parts.push(`## Personal Context Protocol (PCP)

You are Myra, a helpful AI assistant connected to the Personal Context Protocol.
You're receiving messages from various channels (Telegram, WhatsApp, terminal, etc.).

## Response Instructions

Your response will be automatically routed back to the channel the message came from.
Be concise and helpful.

The message metadata shows:
- [Channel: X] - Which platform the message came from (telegram, whatsapp, etc.)
- [Conversation: X] - The conversation/chat ID
- [From: X] - The sender's name or phone number

### Group Chat Behavior (IMPORTANT)

In **group chats** (conversation ID is negative, or chatType is "group"/"supergroup"):
- **ONLY respond if you are directly mentioned** (@myra_help_bot) or called by name ("Myra")
- If the message doesn't mention you, stay silent - do NOT respond
- When you do respond in groups, keep it brief and relevant

In **private/direct chats**: respond to all messages normally.

### Telegram Formatting
When responding to Telegram, use plain text or simple markdown. Keep messages concise.

### WhatsApp Formatting
WhatsApp has limited formatting. Use plain text for best compatibility.
`);

  if (additionalPrompt) {
    parts.push(`\n## Additional Instructions\n\n${additionalPrompt}`);
  }

  return parts.join('\n');
}

/**
 * Start Myra
 */
async function startMyra(config: MyraConfig = {}): Promise<void> {
  logger.info('');
  logger.info('='.repeat(60));
  logger.info('  MYRA - Messaging Process');
  logger.info('  This process handles Telegram/WhatsApp connections');
  logger.info('  Restart only when needed: pm2 restart myra');
  logger.info('='.repeat(60));
  logger.info('');

  // Resolve configuration
  const workingDirectory = config.workingDirectory || path.resolve(__dirname, '../../../..');
  const mcpConfigPath = config.mcpConfigPath || path.resolve(workingDirectory, '.mcp.json');
  const model = config.model || env.DEFAULT_MODEL || 'sonnet';
  const backend = config.backend || 'claude-code';

  logger.info('Configuration:', {
    backend,
    workingDirectory,
    mcpConfigPath,
    model,
    enableWhatsApp: config.enableWhatsApp ?? (process.env.ENABLE_WHATSAPP === 'true'),
  });

  // 1. Initialize data layer (direct connection, not via MCP)
  logger.info('Initializing data layer...');
  dataComposer = await getDataComposer();
  logger.info('Data layer ready');

  // 2. Create Telegram listener
  if (env.TELEGRAM_BOT_TOKEN) {
    logger.info('Creating Telegram listener...');
    telegramListener = createTelegramListener({
      pollingInterval: config.telegramPollingInterval || 1000,
    });
    setTelegramListener(telegramListener);
    logger.info('Telegram listener created');
  } else {
    logger.warn('TELEGRAM_BOT_TOKEN not set - Telegram disabled');
  }

  // 3. Build system prompt
  const systemPrompt = buildSystemPrompt(config.systemPrompt);

  // 4. Create Session Host with Claude Code backend
  logger.info(`Creating Session Host with ${backend} backend...`);
  sessionHost = createSessionHost({
    dataComposer,
    backend: {
      primaryBackend: backend,
      backends: {
        'claude-code': {
          mcpConfigPath,
          workingDirectory,
          model,
          systemPrompt,
        },
        'direct-api': {
          model: 'claude-sonnet-4-20250514',
          systemPrompt,
        },
      },
      enableFailover: true,
    },
    channels: {
      ...(telegramListener ? {
        telegram: {
          sendMessage: async (conversationId, content, options) => {
            const hasMarkdown = /\*\*.+?\*\*|\*.+?\*|`.+?`|^#{1,6}\s/m.test(content);
            let parseMode: 'Markdown' | 'MarkdownV2' | 'HTML' | undefined;
            let processedContent = content;

            if (options?.format === 'markdown' || hasMarkdown) {
              try {
                processedContent = telegramifyMarkdown(content, 'escape');
                parseMode = 'MarkdownV2';
              } catch {
                processedContent = content;
                parseMode = undefined;
              }
            }

            await telegramListener!.sendMessage(conversationId, processedContent, {
              replyToMessageId: options?.replyToMessageId,
              parseMode,
            });
          },
        },
      } : {}),
    },
  });

  // Forward events to console
  sessionHost.on('text', (text: string) => {
    process.stdout.write(text);
  });

  sessionHost.on('backend:ready', (type: string) => {
    logger.info(`Backend ready: ${type}`);
  });

  sessionHost.on('backend:error', ({ type, error }: { type: string; error: Error }) => {
    logger.error(`Backend error (${type}):`, error);
  });

  sessionHost.on('response:sent', (response: { channel: string; conversationId: string }) => {
    logger.info(`Response sent to ${response.channel}:${response.conversationId}`);
    stopTypingIndicator(response.conversationId);
  });

  // 5. Initialize Session Host (starts Claude Code)
  logger.info('Initializing Session Host (starting Claude Code)...');
  await sessionHost.initialize();
  logger.info('Session Host ready');

  // 6. Wire up Telegram message handling
  if (telegramListener) {
    telegramListener.onMessage(async (message) => {
      const senderId = message.sender.id || 'unknown';
      const conversationId = message.conversationId || senderId;
      const isGroupChat = message.chatType === 'group' || message.chatType === 'supergroup';
      const botMentioned = message.mentions?.botMentioned ?? false;

      logger.info(`[Telegram] Message from @${message.sender.username || senderId}`, {
        chatType: message.chatType,
        botMentioned,
      });

      // In group chats, only respond if bot is mentioned
      if (isGroupChat && !botMentioned) {
        logger.debug('Skipping group message - bot not mentioned');
        return;
      }

      startTypingIndicator(conversationId, 'telegram');

      try {
        const user = await resolveOrCreateTelegramUser(dataComposer!, message);

        await sessionHost!.handleMessage(
          'telegram',
          conversationId,
          {
            id: senderId,
            name: message.sender.name || message.sender.username,
            username: message.sender.username,
          },
          message.body,
          {
            userId: user?.id,
            chatType: message.chatType,
            mentions: message.mentions,
          }
        );
      } catch (error) {
        logger.error('Error handling Telegram message:', error);
        stopTypingIndicator(conversationId);
        try {
          await telegramListener!.sendMessage(
            conversationId,
            'Sorry, I encountered an error. Please try again.'
          );
        } catch (sendError) {
          logger.error('Failed to send error message:', sendError);
        }
      }
    });

    await telegramListener.start();
    logger.info('Telegram listener started');
  }

  // 7. Create and start WhatsApp listener if enabled
  const enableWhatsApp = config.enableWhatsApp ?? (process.env.ENABLE_WHATSAPP === 'true');
  if (enableWhatsApp) {
    logger.info('Creating WhatsApp listener...');
    whatsappListener = createWhatsAppListener({
      accountId: config.whatsappAccountId || 'default',
      printQr: true,
      onQr: () => {
        logger.info('WhatsApp QR code ready for scanning');
      },
    });

    // Add WhatsApp channel to session host
    sessionHost.registerChannel('whatsapp', {
      sendMessage: async (conversationId: string, content: string) => {
        await whatsappListener!.sendMessage(conversationId, content);
      },
    });

    // Handle WhatsApp messages
    whatsappListener.onMessage(async (message) => {
      const senderId = message.sender.id || 'unknown';
      const conversationId = message.conversationId || senderId;
      const isGroupChat = message.chatType === 'group';
      const botMentioned = message.mentions?.botMentioned ?? false;

      logger.info(`[WhatsApp] Message from ${message.sender.name || senderId}`, {
        chatType: message.chatType,
        botMentioned,
      });

      if (isGroupChat && !botMentioned) {
        logger.debug('Skipping WhatsApp group message - bot not mentioned');
        return;
      }

      startTypingIndicator(conversationId, 'whatsapp');

      try {
        const user = await resolveOrCreateWhatsAppUser(dataComposer!, { sender: message.sender });

        await sessionHost!.handleMessage(
          'whatsapp',
          conversationId,
          {
            id: senderId,
            name: message.sender.name,
          },
          message.body,
          {
            userId: user?.id,
            chatType: message.chatType,
            mentions: message.mentions,
          }
        );
      } catch (error) {
        logger.error('Error handling WhatsApp message:', error);
        stopTypingIndicator(conversationId);
        try {
          await whatsappListener!.sendMessage(
            conversationId,
            'Sorry, I encountered an error. Please try again.'
          );
        } catch (sendError) {
          logger.error('Failed to send WhatsApp error message:', sendError);
        }
      }
    });

    whatsappListener.on('connected', (info: { jid: string; e164: string | null }) => {
      logger.info(`WhatsApp connected: ${info.e164 || info.jid}`);
    });

    whatsappListener.on('qr', () => {
      logger.info('WhatsApp QR code displayed - please scan with your phone');
    });

    whatsappListener.on('loggedOut', () => {
      logger.warn('WhatsApp logged out - please re-scan QR code');
    });

    whatsappListener.on('error', (error: Error) => {
      logger.error('WhatsApp error:', error);
    });

    await whatsappListener.start();
    logger.info('WhatsApp listener started');
  } else {
    logger.info('WhatsApp disabled (set ENABLE_WHATSAPP=true to enable)');
  }

  // 8. Print status
  logger.info('');
  logger.info('='.repeat(60));
  logger.info('  MYRA IS RUNNING');
  logger.info('='.repeat(60));
  const channels: string[] = [];
  if (telegramListener) channels.push('Telegram');
  if (whatsappListener) channels.push('WhatsApp');
  if (channels.length > 0) {
    logger.info(`Active channels: ${channels.join(', ')}`);
    logger.info('Send a message to start a conversation!');
  } else {
    logger.warn('No messaging channels enabled.');
  }
  logger.info('');
  logger.info('To restart Myra: pm2 restart myra');
  logger.info('To view logs: pm2 logs myra');
  logger.info('');
}

/**
 * Graceful shutdown
 */
async function shutdown(): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info('');
  logger.info('Shutting down Myra...');

  // Clear all typing intervals
  for (const interval of activeTypingIntervals.values()) {
    clearInterval(interval);
  }
  activeTypingIntervals.clear();

  // Stop listeners
  if (telegramListener) {
    logger.info('Stopping Telegram listener...');
    await telegramListener.stop();
  }

  if (whatsappListener) {
    logger.info('Stopping WhatsApp listener...');
    await whatsappListener.stop();
  }

  // Shutdown session host
  if (sessionHost) {
    logger.info('Stopping Session Host...');
    await sessionHost.shutdown();
  }

  logger.info('Myra shutdown complete');
  process.exit(0);
}

// Handle shutdown signals
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception:', error);
  shutdown();
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection:', reason);
});

// Start Myra
startMyra({
  backend: (process.env.PCP_BACKEND as 'claude-code' | 'direct-api') || 'claude-code',
  model: env.DEFAULT_MODEL || 'sonnet',
  workingDirectory: process.env.PCP_WORKING_DIR || path.resolve(__dirname, '../../../..'),
  mcpConfigPath: process.env.MCP_CONFIG_PATH,
  systemPrompt: process.env.PCP_SYSTEM_PROMPT,
}).catch((error) => {
  logger.error('Failed to start Myra:', error);
  process.exit(1);
});
