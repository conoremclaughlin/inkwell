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
import { createSessionHost, SessionHost } from './agent';
import { createMCPServer, MCPServer } from './mcp/server';
import { logger } from './utils/logger';
import { env } from './config/env';

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
  /** System prompt to append */
  systemPrompt?: string;
}

// Global state
let sessionHost: SessionHost | null = null;
let telegramListener: TelegramListener | null = null;
let mcpServer: MCPServer | null = null;
let isShuttingDown = false;

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
    channels: telegramListener ? {
      telegram: {
        sendMessage: async (conversationId, content, options) => {
          await telegramListener!.sendMessage(conversationId, content, {
            replyToMessageId: options?.replyToMessageId,
            parseMode: options?.format === 'markdown' ? 'Markdown' : undefined,
          });
        },
      },
    } : {},
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

      logger.info(`Received message from @${message.sender.username || senderId}`);

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
          }
        );
      } catch (error) {
        logger.error('Error handling Telegram message:', error);

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

  // 7. Print status
  printStatus();

  // Ready
  logger.info('');
  logger.info('='.repeat(60));
  logger.info('PCP Server is running');
  logger.info('='.repeat(60));
  logger.info('');
  logger.info('Send a message via Telegram to start a conversation.');
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
You're receiving messages from various channels (Telegram, terminal, etc.).

## Response Instructions

Simply respond to messages conversationally. Your response will be automatically
routed back to the channel the message came from. Be concise and helpful.

The message metadata shows:
- [Channel: X] - Which platform the message came from
- [Conversation: X] - The conversation/chat ID
- [From: X] - The sender's name

## Available MCP Tools

### PCP Tools (mcp__pcp__*)
Context management:
- save_context - Save context summaries
- get_context - Retrieve context
- save_project, list_projects, get_project - Manage projects
- set_focus, get_focus - Track current working context

Task management:
- create_task, list_tasks, update_task, complete_task - Manage tasks
- get_task_stats - Get task statistics

Link management:
- save_link, search_links, tag_link - Manage saved links

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
