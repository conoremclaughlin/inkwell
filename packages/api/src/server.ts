#!/usr/bin/env npx tsx
/**
 * PCP Server - Personal Context Protocol
 *
 * Main entry point that orchestrates:
 * - MCP Server with integrated ChannelGateway (Telegram/WhatsApp)
 * - SessionService for stateless, horizontally-scalable session management
 * - Response routing via ChannelGateway
 * - Heartbeat service for scheduled reminders
 *
 * Architecture:
 * - MCP Server owns the ChannelGateway (central channel management)
 * - ChannelGateway handles all Telegram/WhatsApp listeners
 * - SessionService processes messages statelessly (queries DB per-request)
 * - send_response tool calls are captured and routed through ChannelGateway
 *
 * Run: npx tsx src/server.ts
 *      yarn server
 */

import path from 'path';
import { getDataComposer, DataComposer } from './data/composer';
import { createSessionService, SessionService, type SessionServiceConfig } from './services/sessions';
import type { SessionRequest, ChannelResponse, ChannelType } from './services/sessions';
import { createMCPServer, MCPServer, type IncomingMessageHandler, type ChannelGateway } from './mcp/server';
import { initHeartbeatService, processHeartbeat, type DueReminder } from './services/heartbeat';
import { setResponseCallback, hasExplicitResponse } from './mcp/tools/response-handlers';
import { getAgentGateway, type AgentTriggerPayload } from './channels/agent-gateway';
import { logger } from './utils/logger';
import { env } from './config/env';

// Server configuration
interface ServerConfig {
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
  /** Whether to enable WhatsApp (requires credentials) */
  enableWhatsApp?: boolean;
  /** Token threshold for compaction */
  compactionThreshold?: number;
}

// Global state
let sessionService: SessionService | null = null;
let mcpServer: MCPServer | null = null;
let channelGateway: ChannelGateway | null = null;
let dataComposer: DataComposer | null = null;
let isShuttingDown = false;

/**
 * Route responses through the ChannelGateway.
 * This is called after SessionService processes a message and returns responses.
 */
async function routeResponses(responses: ChannelResponse[]): Promise<void> {
  if (!channelGateway) {
    logger.warn('Cannot route responses - ChannelGateway not initialized');
    return;
  }

  for (const response of responses) {
    try {
      await channelGateway.sendResponse(response);
      logger.info(`Response routed to ${response.channel}:${response.conversationId}`, {
        contentLength: response.content.length,
      });
    } catch (error) {
      logger.error(`Failed to route response to ${response.channel}:${response.conversationId}`, error);
    }
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
  const agentId = process.env.AGENT_ID || 'myra';

  logger.info('Configuration:', {
    workingDirectory,
    mcpConfigPath,
    model,
    agentId,
    telegramPollingInterval: config.telegramPollingInterval || 1000,
  });

  // 1. Initialize data layer
  logger.info('Initializing data layer...');
  dataComposer = await getDataComposer();
  logger.info('Data layer ready');

  // 2. Create SessionService (stateless, queries DB per-request)
  logger.info('Creating SessionService...');
  const sessionServiceConfig: Partial<SessionServiceConfig> = {
    defaultWorkingDirectory: workingDirectory,
    mcpConfigPath,
    defaultModel: model,
    compactionThreshold: config.compactionThreshold || 150000,
    responseHandler: async (responses) => routeResponses(responses),
  };
  sessionService = createSessionService(dataComposer.getClient(), sessionServiceConfig);
  logger.info('SessionService ready');

  // 3. Create the incoming message handler
  // This connects the ChannelGateway to the SessionService
  const messageHandler: IncomingMessageHandler = async (
    channel,
    conversationId,
    sender,
    content,
    metadata
  ) => {
    // Resolve userId from channel
    let userId: string | undefined = metadata?.userId;

    if (!userId) {
      try {
        userId = await resolveUserId(channel, sender.id, sender.name);
      } catch (error) {
        logger.error(`Failed to resolve user for ${channel}:${sender.id}`, error);
        return;
      }
    }

    if (!userId) {
      logger.error(`Cannot process message - no userId for ${channel}:${sender.id}`);
      return;
    }

    // Build SessionRequest
    const request: SessionRequest = {
      userId,
      agentId,
      channel: channel as ChannelType,
      conversationId,
      sender: {
        id: sender.id,
        name: sender.name || 'Unknown',
        username: sender.name, // Use name as username for now
      },
      content,
      metadata: {
        replyToMessageId: metadata?.replyToMessageId,
        chatType: metadata?.chatType,
        media: metadata?.media,
        triggerType: 'message',
      },
    };

    // Process through SessionService
    const result = await sessionService!.handleMessage(request);

    // Route any explicit send_response calls
    if (result.responses && result.responses.length > 0) {
      await routeResponses(result.responses);
    }

    // For external channels (telegram/whatsapp), ensure the conversation is released
    // and auto-route the text response if no explicit send_response was called
    const isExternalChannel = channel === 'telegram' || channel === 'whatsapp';
    if (isExternalChannel && channelGateway) {
      // Check if send_response was called via MCP (tracked in response-handlers)
      const hadExplicitResponse = hasExplicitResponse(channel, conversationId);

      if (!hadExplicitResponse && result.finalTextResponse && result.success) {
        // Auto-route Claude's text response back to the originating channel
        logger.info('Auto-routing text response (no explicit send_response called)', {
          channel,
          conversationId,
          responseLength: result.finalTextResponse.length,
        });
        await channelGateway.releaseConversation(
          channel as 'telegram' | 'whatsapp',
          conversationId,
          { content: result.finalTextResponse, format: 'markdown' }
        );
      } else {
        // Just release the conversation (and process any pending messages)
        logger.debug('Explicit send_response detected, skipping auto-forward', {
          channel,
          conversationId,
          hadExplicitResponse,
        });
        await channelGateway.releaseConversation(
          channel as 'telegram' | 'whatsapp',
          conversationId
        );
      }
    }

    if (!result.success) {
      logger.error('SessionService failed to process message', {
        error: result.error,
        sessionId: result.sessionId,
      });
    }
  };

  // 4. Start MCP server with ChannelGateway
  logger.info('Starting MCP server with ChannelGateway...');
  mcpServer = await createMCPServer(dataComposer, {
    getSessionService: () => sessionService,
    channelGateway: {
      enableTelegram: !!env.TELEGRAM_BOT_TOKEN,
      telegramPollingInterval: config.telegramPollingInterval || 1000,
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

  // 5. Get ChannelGateway reference for response routing
  channelGateway = mcpServer.getChannelGateway();
  if (channelGateway) {
    logger.info('ChannelGateway ready', channelGateway.getStatus());

    // Register the response callback so send_response MCP calls route through ChannelGateway
    setResponseCallback(async (response) => {
      const channelResponse: ChannelResponse = {
        channel: response.channel as ChannelType,
        conversationId: response.conversationId,
        content: response.content,
        format: response.format,
        replyToMessageId: response.replyToMessageId,
      };
      await channelGateway!.sendResponse(channelResponse);
      logger.info(`Response routed via callback to ${response.channel}:${response.conversationId}`);
    });
    logger.info('Response callback registered for MCP send_response tool');
  } else {
    logger.warn('ChannelGateway not available - response routing will fail');
  }

  // 6. Initialize heartbeat service for scheduled reminders
  const enableLocalCron = process.env.NODE_ENV !== 'production';
  const heartbeatInterval = process.env.HEARTBEAT_INTERVAL || '*/5 * * * *';

  /**
   * Deliver reminder via SessionService - same stateless flow as all other messages.
   */
  const deliverReminderViaSession = async (reminder: DueReminder): Promise<boolean> => {
    // Resolve the userId from the reminder
    const userId = reminder.user_id;

    const reminderContent = `[HEARTBEAT REMINDER]
Title: ${reminder.title}
Description: ${reminder.description || 'No description'}
Delivery: ${reminder.delivery_channel} → ${reminder.delivery_target || 'default'}

---
IMPORTANT: This reminder was triggered by the heartbeat service.
Refer to your HEARTBEAT identity document for how to handle scheduled tasks.
If you need to message a user on Telegram, use send_response with:
- channel: "${reminder.delivery_channel}"
- conversationId: "${reminder.delivery_target}"

Do NOT just respond here — you MUST explicitly call send_response to reach external channels.`;

    const request: SessionRequest = {
      userId,
      agentId,
      channel: 'agent',
      conversationId: `heartbeat:${reminder.id}`,
      sender: { id: 'system', name: 'heartbeat' },
      content: reminderContent,
      metadata: {
        triggerType: 'heartbeat',
        chatType: 'direct',
      },
    };

    try {
      const result = await sessionService!.handleMessage(request);

      // Route any responses
      if (result.responses && result.responses.length > 0) {
        await routeResponses(result.responses);
      }

      return result.success;
    } catch (error) {
      logger.error(`Failed to deliver reminder ${reminder.id}:`, error);
      return false;
    }
  };

  initHeartbeatService({
    interval: heartbeatInterval,
    enableLocalCron,
    onHeartbeat: async () => {
      logger.info('Heartbeat tick — processing due reminders');
      const stats = await processHeartbeat(deliverReminderViaSession);
      logger.info('Heartbeat complete', stats);
    },
  });
  logger.info(`Heartbeat service started (interval: ${heartbeatInterval}, local cron: ${enableLocalCron})`);

  // 7. Register default trigger handler for stateless, database-driven agent routing
  // This handles triggers for ANY agent by looking up config from the database
  const agentGateway = getAgentGateway();
  agentGateway.setDefaultHandler(async (payload: AgentTriggerPayload) => {
    const targetAgentId = payload.toAgentId;

    logger.info(`[Trigger] Received trigger for ${targetAgentId} from ${payload.fromAgentId}`, {
      type: payload.triggerType,
      priority: payload.priority,
      summary: payload.summary,
    });

    // 1. Verify agent exists (either in agent_identities or known agents list)
    const { data: agentIdentity } = await dataComposer!.getClient()
      .from('agent_identities')
      .select('agent_id')
      .eq('agent_id', targetAgentId)
      .limit(1);

    // Allow known agents even if not in agent_identities table yet
    const knownAgents = ['myra', 'wren', 'benson'];
    const isKnownAgent = knownAgents.includes(targetAgentId);
    const existsInDb = agentIdentity && agentIdentity.length > 0;

    if (!existsInDb && !isKnownAgent) {
      logger.error(`[Trigger] Unknown agent: ${targetAgentId}`);
      throw new Error(`Unknown agent: ${targetAgentId}`);
    }

    // 2. Resolve userId from inbox message (required for stateless processing)
    let userId: string | undefined;
    if (payload.inboxMessageId) {
      const { data: inboxMsg } = await dataComposer!.getClient()
        .from('agent_inbox')
        .select('recipient_user_id')
        .eq('id', payload.inboxMessageId)
        .single();
      userId = inboxMsg?.recipient_user_id;
    }

    if (!userId) {
      logger.error(`[Trigger] Cannot process - no userId found for agent ${targetAgentId}`);
      throw new Error('Cannot process trigger without userId (inbox message required)');
    }

    // 3. Build trigger message
    let triggerMessage = `[TRIGGER from ${payload.fromAgentId}]
Type: ${payload.triggerType}`;
    if (payload.summary) {
      triggerMessage += `\nSummary: ${payload.summary}`;
    }
    if (payload.metadata && Object.keys(payload.metadata).length > 0) {
      triggerMessage += `\nContext:\n${JSON.stringify(payload.metadata, null, 2)}`;
    }
    triggerMessage += `

---
IMPORTANT: This is a system trigger, NOT a user message on Telegram/WhatsApp.
Check your inbox for the full message using get_inbox.
If you need to message a user, use send_response with the appropriate channel and conversationId.`;

    // 4. Process via SessionService (stateless - looks up session from DB)
    const request: SessionRequest = {
      userId,
      agentId: targetAgentId,
      channel: 'agent',
      conversationId: `trigger:${targetAgentId}`,
      sender: { id: payload.fromAgentId, name: payload.fromAgentId },
      content: triggerMessage,
      metadata: {
        triggerType: 'agent',
        chatType: 'direct',
      },
    };

    const result = await sessionService!.handleMessage(request);

    // 5. Route any responses
    if (result.responses && result.responses.length > 0) {
      await routeResponses(result.responses);
    }

    if (!result.success) {
      logger.error(`[Trigger] SessionService failed for ${targetAgentId}:`, result.error);
      throw new Error(result.error || 'SessionService processing failed');
    }

    logger.info(`[Trigger] Successfully processed trigger for ${targetAgentId}`);
  });
  logger.info('Default agent trigger handler registered (stateless, database-driven)');

  // 8. Print status
  printStatus();

  // Ready
  logger.info('');
  logger.info('='.repeat(60));
  logger.info('PCP Server is running (SessionService architecture)');
  logger.info('='.repeat(60));
  logger.info('');

  const status = channelGateway?.getStatus();
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
 * Resolve userId from channel and sender info.
 * Creates user if not exists.
 */
async function resolveUserId(
  channel: string,
  senderId: string,
  senderName?: string
): Promise<string | undefined> {
  if (!dataComposer) return undefined;

  try {
    if (channel === 'telegram') {
      // Try to find by Telegram ID
      let user = await dataComposer.repositories.users.findByTelegramId(parseInt(senderId, 10));

      if (!user) {
        // Create new user
        user = await dataComposer.repositories.users.create({
          telegram_id: parseInt(senderId, 10),
          first_name: senderName?.split(' ')[0],
          last_name: senderName?.split(' ').slice(1).join(' ') || undefined,
        });
        logger.info(`Created new Telegram user: ${user.id}`);
      }

      return user.id;
    } else if (channel === 'whatsapp') {
      // WhatsApp IDs are phone numbers
      let user = await dataComposer.repositories.users.findByPhoneNumber(senderId);

      if (!user) {
        user = await dataComposer.repositories.users.create({
          phone_number: senderId,
          first_name: senderName?.split(' ')[0],
          last_name: senderName?.split(' ').slice(1).join(' ') || undefined,
        });
        logger.info(`Created new WhatsApp user: ${user.id}`);
      }

      return user.id;
    }
  } catch (error) {
    logger.error('Failed to resolve user:', error);
  }

  return undefined;
}

/**
 * Print server status
 */
function printStatus(): void {
  logger.info('');
  logger.info('='.repeat(60));
  logger.info('Server Status');
  logger.info('='.repeat(60));
  logger.info(`  Architecture: SessionService (stateless)`);
  logger.info(`  Agent ID: ${process.env.AGENT_ID || 'myra'}`);
  logger.info(`  MCP Port: ${env.MCP_HTTP_PORT}`);

  const status = channelGateway?.getStatus();
  if (status) {
    logger.info(`  Telegram: ${status.telegram.enabled ? (status.telegram.connected ? 'Connected' : 'Enabled') : 'Disabled'}`);
    logger.info(`  WhatsApp: ${status.whatsapp.enabled ? (status.whatsapp.connected ? 'Connected' : 'Awaiting QR') : 'Disabled'}`);
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
  model: env.DEFAULT_MODEL || 'sonnet',
  workingDirectory: process.env.PCP_WORKING_DIR || path.resolve(__dirname, '../../..'),
  mcpConfigPath: process.env.MCP_CONFIG_PATH,
}).catch((error) => {
  logger.error('Failed to start server:', error);
  process.exit(1);
});
