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
import {
  createSessionService,
  SessionService,
  type SessionServiceConfig,
} from './services/sessions';
import type { SessionRequest, ChannelResponse, ChannelType } from './services/sessions';
import {
  createMCPServer,
  MCPServer,
  type IncomingMessageHandler,
  type ChannelGateway,
} from './mcp/server';
import type { GatewayChannel } from './channels/gateway';
import { initHeartbeatService, processHeartbeat, type DueReminder } from './services/heartbeat';
import { setResponseCallback, hasExplicitResponse } from './mcp/tools/response-handlers';
import { getAgentGateway, type AgentTriggerPayload } from './channels/agent-gateway';
import { resolveRouteAgentId } from './services/routing/resolve-route';
import { resolveAgentFromMention } from './services/routing/resolve-mention';
import { getHeartbeatProcessingConfig } from './config/heartbeat-flags';
import { logger } from './utils/logger';
import { env } from './config/env';

// Server configuration
interface ServerConfig {
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
      logger.error(
        `Failed to route response to ${response.channel}:${response.conversationId}`,
        error
      );
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
  const agentId = process.env.AGENT_ID || 'myra';

  logger.info('Configuration:', {
    workingDirectory,
    mcpConfigPath,
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

    // Resolve agent: mention → channel_routes → AGENT_ID env fallback
    let routedAgentId = agentId;
    const isGroupChat = metadata?.chatType === 'group' || metadata?.chatType === 'channel';

    // For group chats, try mention-based routing first
    // Always call for group chats — text matching works even without platform mentions
    // (e.g., WhatsApp has no native @mentions, Slack bot mention excluded from users array)
    if (isGroupChat) {
      const mentionMatch = await resolveAgentFromMention(
        dataComposer!.getClient(),
        userId,
        content,
        metadata?.mentions?.users ?? []
      );
      if (mentionMatch) {
        routedAgentId = mentionMatch.agentId;
        logger.debug(`[Route] Resolved agent from @mention`, {
          platform: channel,
          agentId: mentionMatch.agentId,
          identityId: mentionMatch.identityId,
        });
      }
    }

    // If mention didn't match, try channel_routes specificity cascade
    let routeStudioHint: string | null = null;
    if (routedAgentId === agentId) {
      const route = await resolveRouteAgentId(
        dataComposer!.getClient(),
        userId,
        channel,
        metadata?.platformAccountId,
        conversationId
      );
      if (route) {
        routedAgentId = route.agentId;
        routeStudioHint = route.studioHint;
        logger.debug(`[Route] Resolved agent from channel_routes`, {
          platform: channel,
          agentId: route.agentId,
          identityId: route.identityId,
          routeId: route.routeId,
          studioHint: route.studioHint,
        });
      } else {
        logger.warn(
          `[Route] No channel_route found for ${channel}, falling back to AGENT_ID=${agentId}`,
          { userId, platform: channel, conversationId }
        );
      }
    }

    // Build SessionRequest
    const request: SessionRequest = {
      userId,
      agentId: routedAgentId,
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
        ...(routeStudioHint ? { studioHint: routeStudioHint } : {}),
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
    const isExternalChannel =
      channel === 'telegram' ||
      channel === 'whatsapp' ||
      channel === 'discord' ||
      channel === 'slack';
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
        await channelGateway.releaseConversation(channel as GatewayChannel, conversationId, {
          content: result.finalTextResponse,
          format: 'markdown',
        });
      } else {
        // Just release the conversation (and process any pending messages)
        logger.debug('Explicit send_response detected, skipping auto-forward', {
          channel,
          conversationId,
          hadExplicitResponse,
        });
        await channelGateway.releaseConversation(channel as GatewayChannel, conversationId);
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
  const enableTelegram =
    process.env.ENABLE_TELEGRAM === 'true'
      ? true
      : process.env.ENABLE_TELEGRAM === 'false'
        ? false
        : !!env.TELEGRAM_BOT_TOKEN;
  mcpServer = await createMCPServer(dataComposer, {
    getSessionService: () => sessionService,
    channelGateway: {
      enableTelegram,
      telegramPollingInterval: config.telegramPollingInterval || 1000,
      enableWhatsApp: config.enableWhatsApp ?? process.env.ENABLE_WHATSAPP === 'true',
      whatsappAccountId: config.whatsappAccountId || 'default',
      printWhatsAppQr: true,
      enableDiscord: process.env.ENABLE_DISCORD === 'true',
      enableSlack: process.env.ENABLE_SLACK === 'true',
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

    // Load known agent names for dynamic mention detection in group chats
    try {
      const { data: identities } = await dataComposer!
        .getClient()
        .from('agent_identities')
        .select('agent_id, name');
      if (identities && identities.length > 0) {
        const names = new Set<string>();
        for (const identity of identities) {
          names.add(identity.agent_id);
          if (identity.name) names.add(identity.name);
        }
        channelGateway.setKnownAgentNames([...names]);
      }
    } catch (err) {
      logger.warn('Failed to load agent names for mention detection:', err);
    }

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
  // Useful for secondary/local dev servers where we want API/MCP without
  // participating in global reminder delivery.
  const { enabled: heartbeatServiceEnabled, flags: heartbeatServiceFlags } =
    getHeartbeatProcessingConfig();
  const enableLocalCron =
    process.env.ENABLE_LOCAL_CRON !== undefined
      ? process.env.ENABLE_LOCAL_CRON === 'true'
      : process.env.NODE_ENV !== 'production';
  const heartbeatInterval = process.env.HEARTBEAT_INTERVAL || '*/5 * * * *';

  logger.info('Heartbeat service flags evaluated', {
    heartbeatServiceEnabled,
    ...heartbeatServiceFlags,
  });

  /**
   * Deliver reminder via SessionService - same stateless flow as all other messages.
   */
  const deliverReminderViaSession = async (reminder: DueReminder): Promise<boolean> => {
    const userId = reminder.user_id;

    // Resolve agent from reminder's identity_id, fall back to server default
    let reminderAgentId = agentId;
    if (reminder.identity_id && dataComposer) {
      const { data: identity } = await dataComposer
        .getClient()
        .from('agent_identities')
        .select('agent_id')
        .eq('id', reminder.identity_id)
        .single();
      if (identity?.agent_id) {
        reminderAgentId = identity.agent_id;
        logger.debug(`[Heartbeat] Resolved agent from identity_id: ${reminderAgentId}`);
      }
    }

    // Resolve studioHint from channel_routes for the delivery channel + target
    // delivery_target is the chat/conversation ID (e.g., Telegram chat ID)
    // This enables per-chat routing for multi-user scenarios
    let reminderStudioHint: string | null = null;
    if (dataComposer && reminder.delivery_channel) {
      const route = await resolveRouteAgentId(
        dataComposer.getClient(),
        userId,
        reminder.delivery_channel,
        undefined, // platformAccountId — not stored on reminders yet
        reminder.delivery_target || undefined
      );
      if (route?.studioHint) {
        reminderStudioHint = route.studioHint;
        logger.debug(`[Heartbeat] Resolved studioHint from channel_route`, {
          studioHint: reminderStudioHint,
          deliveryChannel: reminder.delivery_channel,
          deliveryTarget: reminder.delivery_target,
        });
      }
    }

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
      agentId: reminderAgentId,
      channel: 'agent',
      conversationId: `heartbeat:${reminder.id}`,
      sender: { id: 'system', name: 'heartbeat' },
      content: reminderContent,
      metadata: {
        triggerType: 'heartbeat',
        chatType: 'direct',
        ...(reminderStudioHint ? { studioHint: reminderStudioHint } : {}),
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

  if (heartbeatServiceEnabled) {
    initHeartbeatService({
      interval: heartbeatInterval,
      enableLocalCron,
      onHeartbeat: async () => {
        logger.info('Heartbeat tick — processing due reminders');
        const stats = await processHeartbeat(deliverReminderViaSession);
        logger.info('Heartbeat complete', stats);
      },
    });
    logger.info(
      `Heartbeat service started (interval: ${heartbeatInterval}, local cron: ${enableLocalCron})`
    );
  } else {
    logger.warn(
      'Heartbeat service disabled via env (ENABLE_HEARTBEATS or ENABLE_REMINDERS set to a false-like value). Scheduled reminders will not be processed on this server.'
    );
  }

  // 7. Register default trigger handler for stateless, database-driven agent routing
  // This handles triggers for ANY agent by looking up config from the database
  const agentGateway = getAgentGateway();
  agentGateway.setDefaultHandler(async (payload: AgentTriggerPayload) => {
    const targetAgentId = payload.toAgentId;

    logger.info(`[Trigger] Received trigger for ${targetAgentId} from ${payload.fromAgentId}`, {
      type: payload.triggerType,
      priority: payload.priority,
      summary: payload.summary,
      studioHint: payload.studioHint,
    });

    // 1. Resolve userId (+ identity hint) from inbox message (required for stateless processing)
    let userId: string | undefined;
    let recipientIdentityId: string | undefined;
    if (payload.inboxMessageId) {
      const { data: inboxMsg, error: inboxError } = await dataComposer!
        .getClient()
        .from('agent_inbox')
        .select('recipient_user_id, recipient_identity_id')
        .eq('id', payload.inboxMessageId)
        .single();
      if (inboxError) {
        logger.error('[Trigger] Failed to look up inbox message', {
          inboxMessageId: payload.inboxMessageId,
          error: inboxError.message,
        });
      }
      userId = inboxMsg?.recipient_user_id;
      recipientIdentityId = inboxMsg?.recipient_identity_id || undefined;
    }

    if (!userId) {
      logger.error(`[Trigger] Cannot process - no userId found for agent ${targetAgentId}`);
      throw new Error('Cannot process trigger without userId (inbox message required)');
    }

    // 2. Resolve and verify target identity for this user
    // Prefer recipient_identity_id from inbox; fallback to user+agent_id with disambiguation.
    let resolvedIdentityId = recipientIdentityId;
    let resolvedWorkspaceId: string | undefined;
    const metadataWorkspaceId =
      payload.metadata &&
      typeof payload.metadata.workspaceId === 'string' &&
      payload.metadata.workspaceId.length > 0
        ? payload.metadata.workspaceId
        : undefined;

    if (resolvedIdentityId) {
      const { data: identityRow } = await dataComposer!
        .getClient()
        .from('agent_identities')
        .select('id, agent_id, workspace_id')
        .eq('id', resolvedIdentityId)
        .eq('user_id', userId)
        .maybeSingle();

      if (!identityRow) {
        throw new Error(
          `Inbox recipient_identity_id is invalid for this user (${targetAgentId}). Re-send inbox message.`
        );
      }

      if (identityRow.agent_id !== targetAgentId) {
        throw new Error(
          `Inbox recipient_identity_id targets "${identityRow.agent_id}", not "${targetAgentId}".`
        );
      }

      resolvedWorkspaceId = identityRow.workspace_id || undefined;
    } else {
      let identityQuery = dataComposer!
        .getClient()
        .from('agent_identities')
        .select('id, workspace_id')
        .eq('user_id', userId)
        .eq('agent_id', targetAgentId);

      if (metadataWorkspaceId) {
        identityQuery = identityQuery.eq('workspace_id', metadataWorkspaceId);
      }

      const { data: identityRows, error: identityError } = await identityQuery;
      if (identityError) {
        throw new Error(
          `Failed to resolve target identity for ${targetAgentId}: ${identityError.message}`
        );
      }

      if (!identityRows || identityRows.length === 0) {
        logger.error(`[Trigger] Unknown agent for user: ${targetAgentId}`, {
          userId,
          workspaceId: metadataWorkspaceId || null,
        });
        throw new Error(
          `Unknown agent for user: ${targetAgentId}. Register in agent_identities first.`
        );
      }

      if (identityRows.length > 1) {
        throw new Error(
          `Ambiguous identity for agent "${targetAgentId}" (multiple workspace-scoped identities). Include inboxMessageId with recipient_identity_id or pass metadata.workspaceId.`
        );
      } else {
        resolvedIdentityId = identityRows[0].id;
        resolvedWorkspaceId = identityRows[0].workspace_id || undefined;
      }
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
If you need to message a user, use send_response with the appropriate channel and conversationId.
When you complete a task_request, mark it as completed using update_inbox_message(messageId, status: "completed").`;

    // 4. Process via SessionService (stateless - looks up session from DB)
    const request: SessionRequest = {
      userId,
      agentId: targetAgentId,
      channel: 'agent',
      conversationId: payload.threadKey
        ? `trigger:${targetAgentId}:${payload.threadKey}`
        : `trigger:${targetAgentId}`,
      sender: { id: payload.fromAgentId, name: payload.fromAgentId },
      content: triggerMessage,
      metadata: {
        triggerType: 'agent',
        chatType: 'direct',
        threadKey: payload.threadKey,
        studioId: payload.studioId,
        studioHint: payload.studioHint,
        recipientSessionId: payload.recipientSessionId,
      },
    };

    logger.info('[Trigger] Resolved target identity', {
      userId,
      agentId: targetAgentId,
      identityId: resolvedIdentityId,
      workspaceId: resolvedWorkspaceId || null,
    });

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
  if (status?.discord.enabled) enabledChannels.push('Discord');
  if (status?.slack.enabled) enabledChannels.push('Slack');

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
    } else if (channel === 'discord') {
      let user = await dataComposer.repositories.users.findByDiscordId(senderId);

      if (!user) {
        user = await dataComposer.repositories.users.create({
          discord_id: senderId,
          first_name: senderName?.split(' ')[0],
          last_name: senderName?.split(' ').slice(1).join(' ') || undefined,
        });
        logger.info(`Created new Discord user: ${user.id}`);
      }

      return user.id;
    } else if (channel === 'slack') {
      let user = await dataComposer.repositories.users.findBySlackId(senderId);

      if (!user) {
        user = await dataComposer.repositories.users.create({
          slack_id: senderId,
          first_name: senderName?.split(' ')[0],
          last_name: senderName?.split(' ').slice(1).join(' ') || undefined,
        });
        logger.info(`Created new Slack user: ${user.id}`);
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
    logger.info(
      `  Telegram: ${status.telegram.enabled ? (status.telegram.connected ? 'Connected' : 'Enabled') : 'Disabled'}`
    );
    logger.info(
      `  WhatsApp: ${status.whatsapp.enabled ? (status.whatsapp.connected ? 'Connected' : 'Awaiting QR') : 'Disabled'}`
    );
    logger.info(
      `  Discord: ${status.discord.enabled ? (status.discord.connected ? 'Connected' : 'Enabled') : 'Disabled'}`
    );
    logger.info(
      `  Slack: ${status.slack.enabled ? (status.slack.connected ? 'Connected' : 'Enabled') : 'Disabled'}`
    );
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
  workingDirectory: process.env.PCP_WORKING_DIR || path.resolve(__dirname, '../../..'),
  mcpConfigPath: process.env.MCP_CONFIG_PATH,
}).catch((error) => {
  logger.error('Failed to start server:', error);
  process.exit(1);
});
