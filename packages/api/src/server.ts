#!/usr/bin/env npx tsx
/**
 * PCP Server - Personal Context Protocol
 *
 * Main entry point that orchestrates:
 * - MCP Server with integrated ChannelGateway (Telegram/WhatsApp)
 * - Session Host with persistent Claude Code backend
 * - Response routing via MCP send_response tool (direct, no HTTP round-trip)
 * - Session persistence to Supabase
 *
 * Architecture:
 * - MCP Server owns the ChannelGateway (central channel management)
 * - ChannelGateway handles all Telegram/WhatsApp listeners
 * - Session Host processes messages and manages AI backend
 * - send_response tool routes directly through ChannelGateway
 *
 * Run: npx tsx src/server.ts
 *      yarn server
 */

import path from 'path';
import { getDataComposer } from './data/composer';
import { getAgentGateway, type TriggerCallback } from './channels/agent-gateway';
import { createSessionHost, SessionHost } from './agent';
import { createMCPServer, MCPServer, type IncomingMessageHandler } from './mcp/server';
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
  /** WhatsApp account ID (default: 'default') */
  whatsappAccountId?: string;
  /** Whether to enable WhatsApp (requires credentials) */
  enableWhatsApp?: boolean;
  /** System prompt to append */
  systemPrompt?: string;
  /** Agent ID for this server instance (for trigger handling) */
  agentId?: string;
  /** Trigger handler callback (called when another agent triggers this one) */
  onAgentTrigger?: TriggerCallback;
}

// Global state
let sessionHost: SessionHost | null = null;
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

  // 2. Build system prompt with PCP context
  const systemPrompt = buildSystemPrompt(config.systemPrompt);

  // 3. Create Session Host with the appropriate backend (but don't initialize yet)
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
    // Note: Channels are registered via ChannelGateway's response callback
    // No need to manually register channel senders here
    channels: {},
    // Register trigger handlers for known agents (enables wake-up via trigger_agent)
    registeredAgents: ['myra'],
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

  // 4. Create the incoming message handler
  // This connects the ChannelGateway to the SessionHost
  const messageHandler: IncomingMessageHandler = async (
    channel,
    conversationId,
    sender,
    content,
    metadata
  ) => {
    // Resolve or create user based on channel
    let userId: string | undefined = metadata?.userId;

    if (!userId) {
      try {
        if (channel === 'telegram') {
          const user = await resolveOrCreateUser(dataComposer, {
            sender: { id: sender.id, name: sender.name },
          });
          userId = user?.id;
        } else if (channel === 'whatsapp') {
          const user = await resolveOrCreateWhatsAppUser(dataComposer, {
            sender: { id: sender.id, name: sender.name },
          });
          userId = user?.id;
        }
      } catch (error) {
        logger.error(`Failed to resolve user for ${channel}:${sender.id}`, error);
      }
    }

    // Forward to session host
    await sessionHost!.handleMessage(
      channel,
      conversationId,
      sender,
      content,
      {
        userId,
        replyToMessageId: metadata?.replyToMessageId,
        media: metadata?.media,
        chatType: metadata?.chatType,
        mentions: metadata?.mentions,
      }
    );
  };

  // 5. Start MCP server with ChannelGateway
  // The gateway now owns Telegram/WhatsApp listeners and routes responses directly
  logger.info('Starting MCP server with ChannelGateway...');
  mcpServer = await createMCPServer(dataComposer, {
    channelGateway: {
      enableTelegram: !!env.TELEGRAM_BOT_TOKEN,
      telegramPollingInterval: config.telegramPollingInterval || 1000,
      allowedTelegramChats: config.allowedTelegramChats,
      enableWhatsApp: config.enableWhatsApp ?? (process.env.ENABLE_WHATSAPP === 'true'),
      whatsappAccountId: config.whatsappAccountId || 'default',
      printWhatsAppQr: true,
    },
    messageHandler,
  });

  // Force HTTP mode for the PCP server
  const originalTransport = env.MCP_TRANSPORT;
  (env as { MCP_TRANSPORT: string }).MCP_TRANSPORT = 'http';
  await mcpServer.start();
  (env as { MCP_TRANSPORT: string }).MCP_TRANSPORT = originalTransport;
  logger.info(`MCP server ready on port ${env.MCP_HTTP_PORT}`);

  // 5b. Register ChannelGateway's send methods with SessionHost
  // This allows send_response tool calls to route through the gateway
  const gateway = mcpServer.getChannelGateway();
  if (gateway) {
    // Create channel sender adapters that wrap gateway.sendResponse
    if (gateway.getStatus().telegram.enabled) {
      sessionHost.registerChannel('telegram', {
        sendMessage: async (conversationId, content, options) => {
          await gateway.sendResponse({
            channel: 'telegram',
            conversationId,
            content,
            format: options?.format as 'text' | 'markdown' | 'code' | 'json' | undefined,
            replyToMessageId: options?.replyToMessageId,
          });
        },
      });
    }
    if (gateway.getStatus().whatsapp.enabled) {
      sessionHost.registerChannel('whatsapp', {
        sendMessage: async (conversationId, content, options) => {
          await gateway.sendResponse({
            channel: 'whatsapp',
            conversationId,
            content,
            format: options?.format as 'text' | 'markdown' | 'code' | 'json' | undefined,
            replyToMessageId: options?.replyToMessageId,
          });
        },
      });
    }
    logger.info('ChannelGateway senders registered with SessionHost');
  }

  // 6. Initialize the session host (starts the backend)
  logger.info('Initializing Session Host (starting Claude Code)...');
  await sessionHost.initialize();
  logger.info('Session Host ready');

  // 7. Register agent trigger handler (if configured)
  if (config.agentId && config.onAgentTrigger) {
    const agentGateway = getAgentGateway();
    agentGateway.registerHandler(config.agentId, config.onAgentTrigger);
    logger.info(`Agent trigger handler registered for: ${config.agentId}`);
  }

  // 8. Print status
  printStatus();

  // Ready
  logger.info('');
  logger.info('='.repeat(60));
  logger.info('PCP Server is running');
  logger.info('='.repeat(60));
  logger.info('');

  const status = gateway?.getStatus();
  const enabledChannels: string[] = [];
  if (status?.telegram.enabled) enabledChannels.push('Telegram');
  if (status?.whatsapp.enabled) enabledChannels.push('WhatsApp');

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
 * Resolve or create a user from an incoming Telegram message
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
  logger.info(`  Channels: ${health.channels.join(', ') || 'via ChannelGateway'}`);

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

  // Shutdown session host
  if (sessionHost) {
    await sessionHost.shutdown();
    logger.info('Session host stopped');
  }

  // Shutdown MCP server (includes ChannelGateway shutdown)
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
