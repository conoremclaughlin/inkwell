#!/usr/bin/env npx tsx
/**
 * PCP Server - Personal Context Protocol
 *
 * Main entry point that orchestrates:
 * - Session Host with persistent Claude Code backend
 * - Telegram listener for incoming messages
 * - Response routing via MCP send_response tool
 * - Session persistence to Supabase
 *
 * Run: npx tsx src/server.ts
 *      yarn server
 */

import path from 'path';
import { getDataComposer } from './data/composer';
import { createTelegramListener, TelegramListener } from './channels/telegram-listener';
import { createWhatsAppListener, WhatsAppListener } from './channels/whatsapp-listener';
import { createSessionHost, SessionHost } from './agent';
import { createMCPServer, MCPServer, setWhatsAppListener } from './mcp/server';
import { setTelegramListener } from './mcp/tools';
import { logger } from './utils/logger';
import { env } from './config/env';
import telegramifyMarkdown from 'telegramify-markdown';

// Server configuration
interface ServerConfig {
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
  /** Allowed Telegram chat IDs (empty = allow all) */
  allowedTelegramChats?: string[];
  /** WhatsApp account ID (default: 'default') */
  whatsappAccountId?: string;
  /** Whether to enable WhatsApp (requires credentials) */
  enableWhatsApp?: boolean;
  /** System prompt to append */
  systemPrompt?: string;
}

// Global state
let sessionHost: SessionHost | null = null;
let telegramListener: TelegramListener | null = null;
let whatsappListener: WhatsAppListener | null = null;
let mcpServer: MCPServer | null = null;
let isShuttingDown = false;

// Typing indicator management - keeps indicator alive during processing
const activeTypingIntervals: Map<string, NodeJS.Timeout> = new Map();
const TYPING_INTERVAL_MS = 4000; // Telegram typing expires after ~5s

function startTypingIndicator(conversationId: string, channel: 'telegram' | 'whatsapp' = 'telegram'): void {
  // Clear any existing interval for this conversation
  stopTypingIndicator(conversationId);

  // Send immediately
  if (channel === 'telegram' && telegramListener) {
    telegramListener.sendTypingIndicator(conversationId);
  } else if (channel === 'whatsapp' && whatsappListener) {
    whatsappListener.sendTypingIndicator(conversationId);
  }

  // Then send every 4 seconds
  const interval = setInterval(() => {
    if (channel === 'telegram' && telegramListener) {
      telegramListener.sendTypingIndicator(conversationId);
      logger.debug(`Refreshed typing indicator for ${conversationId}`);
    } else if (channel === 'whatsapp' && whatsappListener) {
      whatsappListener.sendTypingIndicator(conversationId);
      logger.debug(`Refreshed typing indicator for ${conversationId}`);
    }
  }, TYPING_INTERVAL_MS);

  activeTypingIntervals.set(conversationId, interval);
  logger.debug(`Started typing indicator interval for ${conversationId}`);
}

function stopTypingIndicator(conversationId: string): void {
  const interval = activeTypingIntervals.get(conversationId);
  if (interval) {
    clearInterval(interval);
    activeTypingIntervals.delete(conversationId);
    logger.debug(`Stopped typing indicator interval for ${conversationId}`);
  }
}

/**
 * Start the PCP server
 */
async function startServer(config: ServerConfig = {}): Promise<void> {
  logger.info('Starting PCP Server...');

  // Resolve configuration
  const workingDirectory = config.workingDirectory || path.resolve(__dirname, '../../..');
  const mcpConfigPath = config.mcpConfigPath || path.resolve(workingDirectory, '.mcp.json');
  const model = config.model || env.DEFAULT_MODEL || 'sonnet';
  const backend = config.backend || 'claude-code';

  logger.info('Configuration:', {
    backend,
    workingDirectory,
    mcpConfigPath,
    model,
    telegramPollingInterval: config.telegramPollingInterval || 1000,
  });

  // 1. Initialize data layer
  logger.info('Initializing data layer...');
  const dataComposer = await getDataComposer();
  logger.info('Data layer ready');

  // 2. Start MCP server in HTTP mode (for Claude Code to connect)
  logger.info('Starting MCP server...');
  mcpServer = await createMCPServer(dataComposer);
  // Force HTTP mode for the PCP server
  const originalTransport = env.MCP_TRANSPORT;
  (env as { MCP_TRANSPORT: string }).MCP_TRANSPORT = 'http';
  await mcpServer.start();
  (env as { MCP_TRANSPORT: string }).MCP_TRANSPORT = originalTransport;
  logger.info(`MCP server ready on port ${env.MCP_HTTP_PORT}`);

  // 3. Create Telegram listener (but don't start yet)
  if (env.TELEGRAM_BOT_TOKEN) {
    logger.info('Creating Telegram listener...');
    telegramListener = createTelegramListener({
      pollingInterval: config.telegramPollingInterval || 1000,
      allowedChatIds: config.allowedTelegramChats,
    });

    // Register with MCP tools for chat context fetching
    setTelegramListener(telegramListener);
    logger.info('Telegram listener registered with MCP tools');
  }

  // 3. Build system prompt with PCP context
  const systemPrompt = buildSystemPrompt(config.systemPrompt);

  // 4. Create Session Host with the appropriate backend
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
            // Auto-detect markdown syntax and convert for Telegram
            // This handles cases where the AI uses markdown but doesn't set format='markdown'
            const hasMarkdown = /\*\*.+?\*\*|\*.+?\*|`.+?`|^#{1,6}\s/m.test(content);

            let parseMode: 'Markdown' | 'MarkdownV2' | 'HTML' | undefined;
            let processedContent = content;

            if (options?.format === 'markdown' || hasMarkdown) {
              // Use telegramify-markdown to convert to Telegram MarkdownV2 format
              // The library handles escaping and conversion properly
              try {
                processedContent = telegramifyMarkdown(content, 'escape');
                parseMode = 'MarkdownV2';
              } catch (err) {
                // If conversion fails, send as plain text
                logger.warn('Markdown conversion failed, sending as plain text:', err);
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
      // WhatsApp channel will be added after listener is created
    },
  });

  // Forward session host events to console
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
    // Stop typing indicator when response is sent
    if (response.channel === 'telegram' || response.channel === 'whatsapp') {
      stopTypingIndicator(response.conversationId);
    }
  });

  sessionHost.on('response:unrouted', (response: { channel: string; content: string }) => {
    // For unrouted responses (e.g., terminal), print to stdout
    if (response.channel === 'terminal') {
      console.log('\n[Response]', response.content);
    }
  });

  // 5. Initialize the session host (starts the backend)
  logger.info('Initializing Session Host (starting Claude Code)...');
  await sessionHost.initialize();
  logger.info('Session Host ready');

  // 6. Start Telegram listener and wire up message handling
  if (telegramListener) {
    telegramListener.onMessage(async (message) => {
      const senderId = message.sender.id || 'unknown';
      const conversationId = message.conversationId || senderId;
      const isGroupChat = message.chatType === 'group';
      const botMentioned = message.mentions?.botMentioned ?? false;

      logger.info(`Received message from @${message.sender.username || senderId}`, {
        chatType: message.chatType,
        botMentioned,
        mentions: message.mentions?.users,
      });

      // In group chats, only respond if bot is mentioned
      if (isGroupChat && !botMentioned) {
        logger.debug('Skipping group message - bot not mentioned');
        return;
      }

      // Start persistent typing indicator (refreshes every 4s until response is sent)
      startTypingIndicator(conversationId);

      try {
        // Get or resolve user
        const user = await resolveOrCreateUser(dataComposer, {
          sender: {
            id: senderId,
            username: message.sender.username,
            name: message.sender.name,
          },
        });

        // Send to session host
        await sessionHost!.handleMessage(
          'telegram',
          conversationId,
          {
            id: senderId,
            name: message.sender.name || message.sender.username,
          },
          message.body,
          {
            userId: user?.id,
            replyToMessageId: message.replyTo?.id,
            media: message.media,
            chatType: message.chatType,
            mentions: message.mentions,
          }
        );
      } catch (error) {
        logger.error('Error handling Telegram message:', error);

        // Stop typing indicator on error
        stopTypingIndicator(conversationId);

        // Send error response back to Telegram
        try {
          await telegramListener!.sendMessage(
            conversationId,
            'Sorry, I encountered an error processing your message. Please try again.'
          );
        } catch (sendError) {
          logger.error('Failed to send error message:', sendError);
        }
      }
    });

    telegramListener.on('connected', (bot: { username: string }) => {
      logger.info(`Telegram bot connected: @${bot.username}`);
    });

    telegramListener.on('error', (error: Error) => {
      logger.error('Telegram listener error:', error);
    });

    await telegramListener.start();
    logger.info('Telegram listener started');
  } else {
    logger.warn('TELEGRAM_BOT_TOKEN not set - Telegram listener disabled');
  }

  // 7. Create and start WhatsApp listener if enabled
  const enableWhatsApp = config.enableWhatsApp ?? (process.env.ENABLE_WHATSAPP === 'true');
  if (enableWhatsApp) {
    logger.info('Creating WhatsApp listener...');
    whatsappListener = createWhatsAppListener({
      accountId: config.whatsappAccountId || 'default',
      printQr: true,
      onQr: (_qr) => {
        logger.info('WhatsApp QR code ready for scanning');
      },
    });

    // Register with admin routes for dashboard access
    setWhatsAppListener(whatsappListener);
    logger.info('WhatsApp listener registered with admin routes');

    // Add WhatsApp channel to session host
    if (sessionHost) {
      sessionHost.registerChannel('whatsapp', {
        sendMessage: async (conversationId: string, content: string) => {
          await whatsappListener!.sendMessage(conversationId, content);
        },
      });
    }

    // Handle WhatsApp messages
    whatsappListener.onMessage(async (message) => {
      const senderId = message.sender.id || 'unknown';
      const conversationId = message.conversationId || senderId;
      const isGroupChat = message.chatType === 'group';
      const botMentioned = message.mentions?.botMentioned ?? false;

      logger.info(`Received WhatsApp message from ${message.sender.name || senderId}`, {
        chatType: message.chatType,
        botMentioned,
      });

      // In group chats, only respond if bot is mentioned
      if (isGroupChat && !botMentioned) {
        logger.debug('Skipping WhatsApp group message - bot not mentioned');
        return;
      }

      // Start typing indicator
      startTypingIndicator(conversationId, 'whatsapp');

      try {
        // Get or resolve user (WhatsApp uses phone numbers)
        const user = await resolveOrCreateWhatsAppUser(dataComposer, {
          sender: {
            id: senderId,
            name: message.sender.name,
          },
        });

        // Send to session host
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
            'Sorry, I encountered an error processing your message. Please try again.'
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
      logger.error('WhatsApp listener error:', error);
    });

    await whatsappListener.start();
    logger.info('WhatsApp listener started');
  } else {
    logger.info('WhatsApp listener disabled (set ENABLE_WHATSAPP=true to enable)');
  }

  // 8. Print status
  printStatus();

  // Ready
  logger.info('');
  logger.info('='.repeat(60));
  logger.info('PCP Server is running');
  logger.info('='.repeat(60));
  logger.info('');
  const enabledChannels: string[] = [];
  if (telegramListener) enabledChannels.push('Telegram');
  if (whatsappListener) enabledChannels.push('WhatsApp');
  if (enabledChannels.length > 0) {
    logger.info(`Send a message via ${enabledChannels.join(' or ')} to start a conversation.`);
  } else {
    logger.info('No messaging channels enabled.');
  }
  logger.info('Press Ctrl+C to stop.');
  logger.info('');
}

/**
 * Build the system prompt with PCP context
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
  - Telegram: negative IDs = group chats
  - WhatsApp: ends with @g.us = group chats, @s.whatsapp.net = DMs
- [From: X] - The sender's name or phone number

### Group Chat Behavior (IMPORTANT)

In **group chats** (conversation ID is negative, or chatType is "group"/"supergroup"):
- **ONLY respond if you are directly mentioned** (@myra_help_bot) or called by name ("Myra")
- If the message doesn't mention you, stay silent - do NOT respond
- When you do respond in groups, keep it brief and relevant

In **private/direct chats**: respond to all messages normally.

This prevents you from interrupting group conversations where you weren't addressed.

### Telegram Formatting
When responding to Telegram, use plain text. Telegram has limited markdown support:
- Use single newlines for line breaks (double newlines may not render properly)
- Avoid complex formatting - keep it simple and readable
- Lists work best as plain text with - or numbers

## Skills (Mini-Apps)

You have access to specialized skills for common tasks. Before responding to requests
that might use a skill:

1. Check if a skill applies using \`list_skills\` or recognize triggers like:
   - "split", "bill", "receipt", "who owes" → bill-split skill

2. If a skill applies, call \`get_skill\` to read the full instructions (SKILL.md)

3. Follow the skill's conversation flow and use its functions correctly

**IMPORTANT**: Always read the skill documentation before using skill functions.
The skill doc explains proper usage, edge cases, and formatting requirements.

## Available MCP Tools

### Skill Tools
- list_skills - List all available mini-app skills with triggers
- get_skill - Read the full SKILL.md documentation for a skill

### PCP Tools (mcp__pcp__*)
Context management:
- save_context - Save context summaries
- get_context - Retrieve context
- save_project, list_projects, get_project - Manage projects
- set_focus, get_focus - Track current working context

Memory:
- remember, recall, forget - Long-term memory management
- bootstrap - Load identity and context at session start

Task management:
- create_task, list_tasks, update_task, complete_task - Manage tasks
- get_task_stats - Get task statistics

Link management:
- save_link, search_links, tag_link - Manage saved links

Chat context (for understanding conversation history):
- get_chat_context - Fetch recent messages from a chat (ephemeral, 30 min TTL)
- clear_chat_context - Clear message cache after summarizing (privacy pattern)

Mini-app records (for persisting skill data):
- save_mini_app_record - Save structured data for a mini-app
- query_mini_app_records - Query saved records
- record_mini_app_debt, get_mini_app_debts, settle_mini_app_debt - Debt tracking

### Supabase Tools (mcp__supabase__*)
You also have access to Supabase MCP tools for direct database operations.
`);

  if (additionalPrompt) {
    parts.push('');
    parts.push('## Additional Instructions');
    parts.push(additionalPrompt);
  }

  return parts.join('\n');
}

/**
 * Resolve or create a user from an incoming message
 */
async function resolveOrCreateUser(
  dataComposer: Awaited<ReturnType<typeof getDataComposer>>,
  message: { sender: { id: string; username?: string; name?: string } }
) {
  try {
    // Try to find by Telegram ID
    let user = await dataComposer.repositories.users.findByTelegramId(parseInt(message.sender.id, 10));

    if (!user) {
      // Create new user
      user = await dataComposer.repositories.users.create({
        telegram_id: parseInt(message.sender.id, 10),
        telegram_username: message.sender.username,
        first_name: message.sender.name?.split(' ')[0],
        last_name: message.sender.name?.split(' ').slice(1).join(' ') || undefined,
      });
      logger.info(`Created new user: ${user.id}`);
    }

    return user;
  } catch (error) {
    logger.error('Failed to resolve user:', error);
    return null;
  }
}

/**
 * Print server status
 */
function printStatus(): void {
  if (!sessionHost) return;

  const health = sessionHost.getHealth();
  const sessionId = sessionHost.getSessionId();

  logger.info('');
  logger.info('='.repeat(60));
  logger.info('Session Status');
  logger.info('='.repeat(60));
  logger.info(`  Backend: ${Object.keys(health.backend).find(k => health.backend[k as keyof typeof health.backend]?.healthy) || 'none'}`);
  logger.info(`  Session ID: ${sessionId || 'none'}`);
  logger.info(`  Channels: ${health.channels.join(', ') || 'none'}`);

  if (sessionId) {
    logger.info('');
    logger.info('To attach to this session from another terminal:');
    logger.info(`  claude --resume ${sessionId}`);
  }

  logger.info('='.repeat(60));
}

/**
 * Resolve or create a user from a WhatsApp message
 */
async function resolveOrCreateWhatsAppUser(
  dataComposer: Awaited<ReturnType<typeof getDataComposer>>,
  message: { sender: { id: string; name?: string } }
) {
  try {
    // WhatsApp IDs are phone numbers in E.164 format
    const phoneNumber = message.sender.id;

    // Try to find by phone number
    let user = await dataComposer.repositories.users.findByPhoneNumber(phoneNumber);

    if (!user) {
      // Create new user with phone number
      user = await dataComposer.repositories.users.create({
        phone_number: phoneNumber,
        first_name: message.sender.name?.split(' ')[0],
        last_name: message.sender.name?.split(' ').slice(1).join(' ') || undefined,
      });
      logger.info(`Created new WhatsApp user: ${user.id}`);
    }

    return user;
  } catch (error) {
    logger.error('Failed to resolve WhatsApp user:', error);
    return null;
  }
}

/**
 * Graceful shutdown
 */
async function shutdown(): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info('\nShutting down PCP Server...');

  // Stop Telegram listener
  if (telegramListener) {
    await telegramListener.stop();
    logger.info('Telegram listener stopped');
  }

  // Stop WhatsApp listener
  if (whatsappListener) {
    await whatsappListener.stop();
    logger.info('WhatsApp listener stopped');
  }

  // Shutdown session host
  if (sessionHost) {
    await sessionHost.shutdown();
    logger.info('Session host stopped');
  }

  // Shutdown MCP server
  if (mcpServer) {
    await mcpServer.shutdown();
    logger.info('MCP server stopped');
  }

  logger.info('Shutdown complete');
  process.exit(0);
}

// Handle shutdown signals
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception:', error);
  shutdown();
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection:', reason);
});

// Start the server
startServer({
  // Use environment variables or defaults
  backend: (process.env.PCP_BACKEND as 'claude-code' | 'direct-api') || 'claude-code',
  model: env.DEFAULT_MODEL || 'sonnet',
  workingDirectory: process.env.PCP_WORKING_DIR || path.resolve(__dirname, '../../..'),
  mcpConfigPath: process.env.MCP_CONFIG_PATH,
  systemPrompt: process.env.PCP_SYSTEM_PROMPT,
}).catch((error) => {
  logger.error('Failed to start server:', error);
  process.exit(1);
});
