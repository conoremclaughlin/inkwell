#!/usr/bin/env npx tsx
/**
 * Inkwell Server
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
import {
  initHeartbeatService,
  stopHeartbeatService,
  processHeartbeat,
  type DueReminder,
} from './services/heartbeat';
import { StrategyService } from './services/strategy.service';
import { getOrchestrator } from './services/sandbox/index.js';
import {
  setResponseCallback,
  hasExplicitResponse,
  clearExplicitResponse,
} from './mcp/tools/response-handlers';
import { getAgentGateway, type AgentTriggerPayload } from './channels/agent-gateway';
import { storedTriggerMedia } from './channels/agent-media';
import { resolveRouteAgentId } from './services/routing/resolve-route';
import { resolveAgentFromMention } from './services/routing/resolve-mention';
import { getHeartbeatProcessingConfig } from './config/heartbeat-flags';
import { classifyError } from '@inklabs/shared';
import { logger } from './utils/logger';
import { getUserFromContext } from './utils/request-context';
import { env } from './config/env';
import {
  shouldSkipSpawn,
  type SessionPollRow,
  type SessionAttachedRow,
} from './services/sessions/trigger-delivery';
import { assignThreadParticipant } from './services/sessions/thread-assignment';
import type { ActivityType } from './data/repositories/activity-stream.repository';
import { resolveTaskGroupForThreadKey } from './services/task-group-resolver';

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
  logger.info('Starting Inkwell Server...');

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
    ...(env.DEFAULT_CLAUDE_MODEL ? { defaultModel: env.DEFAULT_CLAUDE_MODEL } : {}),
    ...(env.DEFAULT_CODEX_MODEL ? { defaultCodexModel: env.DEFAULT_CODEX_MODEL } : {}),
    ...(env.DEFAULT_GEMINI_MODEL ? { defaultGeminiModel: env.DEFAULT_GEMINI_MODEL } : {}),
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
    let routedIdentityId: string | undefined;
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
        routedIdentityId = mentionMatch.sbId;
        logger.debug(`[Route] Resolved agent from @mention`, {
          platform: channel,
          agentId: mentionMatch.agentId,
          sbId: mentionMatch.sbId,
        });
      }
    }

    // If mention didn't match, try channel_routes specificity cascade
    let routeStudioHint: string | null = null;
    let resolvedRouteId: string | null = null;
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
        routedIdentityId = route.sbId;
        routeStudioHint = route.studioHint;
        resolvedRouteId = route.routeId;
        logger.debug(`[Route] Resolved agent from channel_routes`, {
          platform: channel,
          agentId: route.agentId,
          sbId: route.sbId,
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

    // Resolve contact for per-sender session isolation (only when agent has session_scope: 'per_sender')
    let contactId: string | undefined;
    const isExternalChannelForContact =
      channel === 'telegram' ||
      channel === 'whatsapp' ||
      channel === 'discord' ||
      channel === 'slack';
    let agentSessionScope: string | null = null;
    if (isExternalChannelForContact && dataComposer) {
      try {
        let scopeQuery = dataComposer.getClient().from('agent_identities').select('session_scope');
        if (routedIdentityId) {
          scopeQuery = scopeQuery.eq('id', routedIdentityId);
        } else {
          scopeQuery = scopeQuery.eq('user_id', userId).eq('agent_id', routedAgentId);
        }
        const { data: identity } = await scopeQuery.single();
        agentSessionScope = identity?.session_scope || 'global';
      } catch {
        // Fall through — default to global (no isolation)
      }
    }
    if (isExternalChannelForContact && dataComposer && agentSessionScope === 'per_sender') {
      try {
        const platformMap: Record<string, 'telegram' | 'discord' | 'whatsapp' | 'imessage'> = {
          telegram: 'telegram',
          discord: 'discord',
          whatsapp: 'whatsapp',
          slack: 'discord', // Slack uses discord slot
        };
        const contactPlatform = platformMap[channel];
        if (contactPlatform) {
          if (isGroupChat) {
            const groupContact = await dataComposer.repositories.contacts.findOrCreateGroupContact(
              userId,
              channel as 'telegram' | 'discord' | 'whatsapp' | 'slack',
              conversationId,
              { groupName: (metadata as Record<string, unknown>)?.groupName as string | undefined }
            );
            contactId = groupContact.id;
          } else {
            const senderContact = await dataComposer.repositories.contacts.findOrCreateByPlatformId(
              userId,
              contactPlatform,
              sender.id,
              { name: sender.name, username: sender.name }
            );
            contactId = senderContact.id;
          }
        }
      } catch (contactError) {
        // Don't fail message processing if contact resolution fails
        logger.warn('Failed to resolve contact for sender', {
          channel,
          senderId: sender.id,
          error: contactError instanceof Error ? contactError.message : String(contactError),
        });
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
        ...(contactId ? { contactId } : {}),
      },
    };

    // Process through SessionService
    const result = await sessionService!.handleMessage(request);

    // Stamp active session on the channel route so we can verify where
    // messages and heartbeats are landing. Fire-and-forget — don't block response.
    if (resolvedRouteId && result.sessionId && dataComposer) {
      dataComposer
        .getClient()
        .from('channel_routes')
        .update({ active_session_id: result.sessionId })
        .eq('id', resolvedRouteId)
        .then(({ error: stampError }) => {
          if (stampError) {
            logger.warn('[Route] Failed to stamp active_session_id on channel_route', {
              routeId: resolvedRouteId,
              sessionId: result.sessionId,
              error: stampError.message,
            });
          }
        });
    }

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

      clearExplicitResponse(channel, conversationId);
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
      const result = await channelGateway!.sendResponse(response);
      logger.info(`Response routed via callback to ${response.channel}:${response.conversationId}`);
      return result;
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

    // Strategy watchdog branch: reminders created by StrategyService carry
    // metadata.strategyWatchdog=true and route through the strategy service,
    // which builds a task-aware prompt and dispatches to the owner agent in
    // the assigned studio. Generic [HEARTBEAT REMINDER] content won't tell
    // the target what task to work on, so we skip that path entirely.
    const reminderMeta = reminder.metadata || {};
    if (reminderMeta.strategyWatchdog === true && dataComposer) {
      const groupId =
        typeof reminderMeta.groupId === 'string' ? (reminderMeta.groupId as string) : null;
      if (!groupId) {
        logger.warn(
          `[Heartbeat] strategyWatchdog reminder ${reminder.id} has no groupId in metadata, skipping`
        );
        return false;
      }
      try {
        const strategyService = new StrategyService(dataComposer, getOrchestrator());
        const fired = await strategyService.triggerWatchdog(groupId);
        if (fired) {
          logger.info(
            `[Heartbeat] Strategy watchdog fired for group ${groupId} (reminder ${reminder.id})`
          );
        }
        return fired;
      } catch (err) {
        logger.error(
          `[Heartbeat] Strategy watchdog failed for group ${groupId} (reminder ${reminder.id}):`,
          err
        );
        return false;
      }
    }

    // Resolve agent from reminder's sb_id, fall back to server default
    let reminderAgentId = agentId;
    if (reminder.sb_id && dataComposer) {
      const { data: identity } = await dataComposer
        .getClient()
        .from('agent_identities')
        .select('agent_id')
        .eq('id', reminder.sb_id)
        .single();
      if (identity?.agent_id) {
        reminderAgentId = identity.agent_id;
        logger.debug(`[Heartbeat] Resolved agent from sb_id: ${reminderAgentId}`);
      }
    }

    // Resolve studioHint + activeSessionId via cascade:
    //   1. reminder.studio_hint (direct override)
    //   2. channel_routes.studio_hint + active_session_id (matched by delivery channel)
    //   3. agent_identities.studio_hint (agent's default studio)
    //   4. null → resolveStudioId() uses its own cascade (agent studio → main)
    let reminderStudioHint: string | null = null;
    let routeActiveSessionId: string | null = null;

    // Check reminder-level override first
    if (reminder.studio_hint) {
      reminderStudioHint = reminder.studio_hint;
      logger.debug(`[Heartbeat] Using reminder-level studioHint`, {
        studioHint: reminderStudioHint,
        reminderId: reminder.id,
      });
    }

    // Resolve channel_routes for both studioHint and activeSessionId
    if (dataComposer && reminder.delivery_channel) {
      const route = await resolveRouteAgentId(
        dataComposer.getClient(),
        userId,
        reminder.delivery_channel,
        undefined, // platformAccountId — not stored on reminders yet
        reminder.delivery_target || undefined
      );
      if (route) {
        if (!reminderStudioHint && route.studioHint) {
          reminderStudioHint = route.studioHint;
          logger.debug(`[Heartbeat] Resolved studioHint from channel_route`, {
            studioHint: reminderStudioHint,
            deliveryChannel: reminder.delivery_channel,
            deliveryTarget: reminder.delivery_target,
          });
        }
        if (route.activeSessionId && route.agentId === reminderAgentId) {
          routeActiveSessionId = route.activeSessionId;
          logger.info(`[Heartbeat] Using active_session_id from channel_route`, {
            activeSessionId: routeActiveSessionId,
            deliveryChannel: reminder.delivery_channel,
            reminderId: reminder.id,
          });
        } else if (route.activeSessionId && route.agentId !== reminderAgentId) {
          logger.debug(
            `[Heartbeat] Ignoring active_session_id — route agent ${route.agentId} ≠ reminder agent ${reminderAgentId}`,
            {
              routeAgentId: route.agentId,
              reminderAgentId,
              activeSessionId: route.activeSessionId,
            }
          );
        }
      }
    }

    // Fallback to agent identity's default studio
    if (!reminderStudioHint && reminder.sb_id && dataComposer) {
      const { data: identity } = await dataComposer
        .getClient()
        .from('agent_identities')
        .select('studio_hint')
        .eq('id', reminder.sb_id)
        .single();
      if (identity?.studio_hint) {
        reminderStudioHint = identity.studio_hint;
        logger.debug(`[Heartbeat] Using agent default studio`, {
          studioHint: reminderStudioHint,
          sbId: reminder.sb_id,
        });
      }
    }

    // No final fallback — leave null so resolveStudioId() uses its own
    // cascade (agent's own studio → main studio) instead of searching
    // for a studio literally named 'home' which doesn't exist.

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
      channel: 'heartbeat',
      conversationId: `heartbeat:${reminder.id}`,
      sender: { id: 'system', name: 'heartbeat' },
      content: reminderContent,
      metadata: {
        triggerType: 'heartbeat',
        chatType: 'direct',
        ...(reminderStudioHint ? { studioHint: reminderStudioHint } : {}),
        ...(routeActiveSessionId ? { recipientSessionId: routeActiveSessionId } : {}),
      },
    };

    try {
      const result = await sessionService!.handleMessage(request);

      logger.info('[Heartbeat] Delivery result', {
        reminderId: reminder.id,
        agentId: reminderAgentId,
        success: result.success,
        responseCount: result.responses?.length || 0,
        ...(result.error ? { error: result.error } : {}),
        ...(result.finalTextResponse
          ? { responsePreview: result.finalTextResponse.slice(0, 200) }
          : {}),
        ...(result.usage ? { tokens: result.usage } : {}),
      });

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

  async function logInkmail(
    type: ActivityType & `inkmail_${string}`,
    payload: AgentTriggerPayload,
    userId: string,
    extra?: { sessionId?: string; error?: string; deliveryMethod?: string }
  ): Promise<void> {
    try {
      // Tag inkmail with its mission (task group) so cross-agent messages
      // appear on the mission timeline. Strategy triggers carry groupId in
      // metadata; otherwise resolve conservatively from the threadKey
      // (verified task:/strategy: ids or an exact task_groups.thread_key match).
      let taskGroupId =
        payload.metadata && typeof payload.metadata.groupId === 'string' && payload.metadata.groupId
          ? payload.metadata.groupId
          : undefined;
      if (!taskGroupId && payload.threadKey) {
        taskGroupId =
          (await resolveTaskGroupForThreadKey(
            dataComposer!.getClient(),
            userId,
            payload.threadKey
          )) ?? undefined;
      }

      await dataComposer!.repositories.activityStream.logActivity({
        userId,
        agentId: payload.toAgentId,
        type,
        subtype: payload.triggerType,
        content: payload.summary || `Inkmail from ${payload.fromAgentId}`,
        sessionId: extra?.sessionId,
        taskGroupId,
        correlationId: payload.threadMessageId || payload.inboxMessageId,
        payload: {
          fromAgentId: payload.fromAgentId,
          toAgentId: payload.toAgentId,
          threadKey: payload.threadKey || null,
          messageId: payload.threadMessageId || payload.inboxMessageId || null,
          priority: payload.priority || 'normal',
          studioId: payload.studioId || null,
          ...(extra?.deliveryMethod ? { deliveryMethod: extra.deliveryMethod } : {}),
          ...(extra?.error ? { error: extra.error } : {}),
        },
        status:
          type === 'inkmail_dispatch'
            ? 'pending'
            : type === 'inkmail_deliver'
              ? 'completed'
              : 'failed',
      });
    } catch (err) {
      logger.warn('[Inkmail] Failed to log activity', {
        type,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  agentGateway.setDefaultHandler(async (payload: AgentTriggerPayload) => {
    const targetAgentId = payload.toAgentId;

    logger.info(`[Trigger] Received trigger for ${targetAgentId} from ${payload.fromAgentId}`, {
      type: payload.triggerType,
      priority: payload.priority,
      summary: payload.summary,
      studioHint: payload.studioHint,
    });

    // 1. Resolve userId (+ identity hint) from inbox message or auth context.
    //
    // SECURITY: userId determines whose agent config is loaded and which agent
    // gets spawned. It must come from a trusted source — never from caller-supplied
    // tool args. Two trusted sources:
    //   a) The inbox message's recipient_user_id (set server-side at send time)
    //   b) The caller's OAuth token via getUserFromContext()
    //
    // When both are available, we verify they match. A mismatch means someone is
    // trying to trigger another user's agent via a known inbox message ID — this
    // is blocked and logged as a security warning.
    let userId: string | undefined;
    let recipientSbId: string | undefined;

    const authUser = getUserFromContext();
    const authUserId = authUser?.userId;

    if (payload.inboxMessageId) {
      const { data: inboxMsg, error: inboxError } = await dataComposer!
        .getClient()
        .from('agent_inbox')
        .select('recipient_user_id, recipient_sb_id')
        .eq('id', payload.inboxMessageId)
        .single();
      if (inboxError) {
        logger.error('[Trigger] Failed to look up inbox message', {
          inboxMessageId: payload.inboxMessageId,
          error: inboxError.message,
        });
      }

      // SECURITY: verify the inbox message belongs to the authenticated user.
      // Prevents cross-user triggers via guessed/leaked inbox message IDs.
      if (inboxMsg?.recipient_user_id && authUserId && inboxMsg.recipient_user_id !== authUserId) {
        logger.warn(
          '[Trigger] SECURITY: inbox message recipient does not match authenticated user',
          {
            inboxMessageId: payload.inboxMessageId,
            inboxRecipientUserId: inboxMsg.recipient_user_id,
            authUserId,
            targetAgentId,
            fromAgentId: payload.fromAgentId,
          }
        );
        throw new Error('Trigger denied: inbox message does not belong to authenticated user');
      }

      userId = inboxMsg?.recipient_user_id;
      recipientSbId = inboxMsg?.recipient_sb_id || undefined;
    } else if (payload.threadMessageId) {
      // Thread message: resolve user_id via inbox_thread_messages → inbox_threads
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const supabase = dataComposer!.getClient() as any;
      const { data: threadMsg, error: tmError } = await supabase
        .from('inbox_thread_messages')
        .select('thread_id')
        .eq('id', payload.threadMessageId)
        .single();
      if (tmError) {
        logger.error('[Trigger] Failed to look up thread message', {
          threadMessageId: payload.threadMessageId,
          error: tmError.message,
        });
      }
      if (threadMsg?.thread_id) {
        const { data: thread, error: threadError } = await supabase
          .from('inbox_threads')
          .select('user_id')
          .eq('id', threadMsg.thread_id)
          .single();
        if (threadError) {
          logger.error('[Trigger] Failed to look up thread from message', {
            threadId: threadMsg.thread_id,
            error: threadError.message,
          });
        }
        const threadUserId = thread?.user_id as string | undefined;
        if (threadUserId && authUserId && threadUserId !== authUserId) {
          logger.warn('[Trigger] SECURITY: thread owner does not match authenticated user', {
            threadMessageId: payload.threadMessageId,
            threadUserId,
            authUserId,
            targetAgentId,
            fromAgentId: payload.fromAgentId,
          });
          throw new Error('Trigger denied: thread does not belong to authenticated user');
        }
        userId = threadUserId;
      }
    } else if (payload.threadId) {
      // Thread (add_thread_participant): resolve user_id directly from inbox_threads
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: thread, error: threadError } = await (dataComposer!.getClient() as any)
        .from('inbox_threads')
        .select('user_id')
        .eq('id', payload.threadId)
        .single();
      if (threadError) {
        logger.error('[Trigger] Failed to look up thread', {
          threadId: payload.threadId,
          error: threadError.message,
        });
      }
      const threadUserId = thread?.user_id as string | undefined;
      if (threadUserId && authUserId && threadUserId !== authUserId) {
        logger.warn('[Trigger] SECURITY: thread owner does not match authenticated user', {
          threadId: payload.threadId,
          threadUserId,
          authUserId,
          targetAgentId,
          fromAgentId: payload.fromAgentId,
        });
        throw new Error('Trigger denied: thread does not belong to authenticated user');
      }
      userId = threadUserId;
    }

    // Fall back to authenticated user from OAuth context (trigger_agent called directly)
    if (!userId) {
      userId = authUserId;
      if (userId) {
        logger.info(`[Trigger] Resolved userId from auth context for ${targetAgentId}`);
      }
    }

    if (!userId) {
      logger.error(`[Trigger] Cannot process - no userId found for agent ${targetAgentId}`);
      throw new Error(
        'Cannot process trigger without userId (no inbox message and no auth context)'
      );
    }

    await logInkmail('inkmail_dispatch', payload, userId);

    // 2. Resolve and verify target identity for this user
    // Prefer recipient_sb_id from inbox; fallback to user+agent_id with disambiguation.
    let resolvedIdentityId = recipientSbId;
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
          `Inbox recipient_sb_id is invalid for this user (${targetAgentId}). Re-send inbox message.`
        );
      }

      if (identityRow.agent_id !== targetAgentId) {
        throw new Error(
          `Inbox recipient_sb_id targets "${identityRow.agent_id}", not "${targetAgentId}".`
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
        // Disambiguate: prefer workspace-scoped over null-workspace (orphaned)
        const workspaceScoped = identityRows.filter(
          (r: { workspace_id: string | null }) => r.workspace_id != null
        );
        if (workspaceScoped.length === 1) {
          resolvedIdentityId = workspaceScoped[0].id;
          resolvedWorkspaceId = workspaceScoped[0].workspace_id || undefined;
          logger.info(
            `[Trigger] Disambiguated ${targetAgentId}: preferred workspace-scoped identity ${resolvedIdentityId}`
          );
        } else {
          throw new Error(
            `Ambiguous identity for agent "${targetAgentId}" (${identityRows.length} identities, ${workspaceScoped.length} workspace-scoped). Include inboxMessageId with recipient_sb_id or pass metadata.workspaceId.`
          );
        }
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
    if (payload.threadKey) {
      triggerMessage += `\n\nThread: ${payload.threadKey}`;
    }
    triggerMessage += `

---
IMPORTANT: This is a system trigger, NOT a user message on Telegram/WhatsApp.
${payload.threadKey ? `Fetch the thread using get_thread_messages(threadKey: "${payload.threadKey}"). Use send_to_inbox with threadKey to respond.` : 'Check your inbox for the full message using get_inbox.'}
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
        sessionAlias: payload.sessionAlias,
        taskGroupId:
          payload.metadata && typeof payload.metadata.groupId === 'string'
            ? payload.metadata.groupId
            : undefined,
        // Forward repoRoot so session service can resolve working directory / main studio
        ...(payload.metadata?.repoRoot && typeof payload.metadata.repoRoot === 'string'
          ? { repoRoot: payload.metadata.repoRoot }
          : {}),
        // Forward sandbox container name so the session service routes CLI execution into it
        ...(payload.metadata?.sandboxContainerName &&
        typeof payload.metadata.sandboxContainerName === 'string'
          ? { sandboxContainerName: payload.metadata.sandboxContainerName }
          : {}),
      },
    };

    logger.info('[Trigger] Resolved target identity', {
      userId,
      agentId: targetAgentId,
      sbId: resolvedIdentityId,
      workspaceId: resolvedWorkspaceId || null,
    });

    // Check if the routed session is CLI-attached — if so, queue the message
    // for the on-prompt hook instead of spawning a new process.
    // Uses getOrCreateSession to resolve through the SAME routing logic
    // (recipientSessionId → threadKey → route patterns → studio fallback)
    // that handleMessage would use. This ensures CLI-attached delivery
    // respects route patterns, not just the identity workspace.
    try {
      const routedSession = await sessionService!.getOrCreateSession(userId, targetAgentId, {
        threadKey: payload.threadKey,
        alias: payload.sessionAlias,
        studioId: payload.studioId,
        studioHint: payload.studioHint,
        recipientSessionId: payload.recipientSessionId,
        repoRoot:
          payload.metadata?.repoRoot && typeof payload.metadata.repoRoot === 'string'
            ? payload.metadata.repoRoot
            : undefined,
      });

      // Assign the thread to the resolved session via the single sanctioned
      // writer (spec: inkmail-read-state §3a). Explicit anchors overwrite
      // (deliberate retarget); otherwise first assignment is a CAS and a lost
      // race reroutes delivery to the winner. Cross-studio self-sends stamp
      // the TARGET session — under stamped-only polling, an unstamped row is
      // invisible to everyone, so "leave null so both see it" no longer works.
      let deliverySession = routedSession;
      // Assignment integrity (Lumen, PR #460 round 2): a failed stamp must
      // never be swallowed into a routeOnly "success" — with stamped-only
      // polling and no wake coming, an unstamped thread is permanently
      // invisible. Wake dispatches tolerate it (the wake surfaces the
      // message and the next dispatch retries the stamp).
      let assignmentFailure: string | null = null;
      if (payload.threadId && routedSession.id) {
        try {
          const assignment = await assignThreadParticipant(dataComposer!.getClient(), {
            threadId: payload.threadId,
            agentId: targetAgentId,
            candidateSessionId: routedSession.id,
            explicitAnchor: !!payload.explicitRecipientTarget,
            source: 'trigger-handler',
          });
          if (!assignment.stampPersisted) {
            assignmentFailure = `participant stamp not persisted (boundVia=${assignment.boundVia})`;
          }
          if (assignment.rerouted) {
            // A concurrent dispatch (or an existing live binding) won — deliver
            // to the winner, and archive our freshly-created loser candidate so
            // it doesn't linger as an empty routable session.
            const winner = await sessionService!.getSession(assignment.sessionId);
            if (winner) {
              deliverySession = winner;
              const candidateIsFresh =
                routedSession.messageCount === 0 && !routedSession.backendSessionId;
              if (candidateIsFresh && routedSession.id !== winner.id) {
                await sessionService!.endSession(routedSession.id).catch((e) =>
                  logger.warn('[Trigger] Failed to archive loser candidate session', {
                    sessionId: routedSession.id,
                    error: e instanceof Error ? e.message : String(e),
                  })
                );
              }
            }
          }
        } catch (err) {
          assignmentFailure = err instanceof Error ? err.message : String(err);
          logger.warn('[Trigger] Thread assignment failed', {
            threadId: payload.threadId,
            agentId: targetAgentId,
            sessionId: routedSession.id,
            error: assignmentFailure,
          });
        }
      }

      // Routing-only dispatch: assignment IS the entire job — a failed stamp
      // must propagate as a failed trigger (processTrigger returns
      // success:false and the send surfaces it), never a silent success.
      // (spec §3a — trigger controls wake, never addressing.)
      if (payload.routeOnly) {
        if (assignmentFailure) {
          logger.error('[Trigger] routeOnly assignment failed — surfacing to sender', {
            targetAgentId,
            sessionId: deliverySession.id,
            threadKey: payload.threadKey,
            threadId: payload.threadId,
            error: assignmentFailure,
          });
          throw new Error(`routeOnly assignment failed for ${targetAgentId}: ${assignmentFailure}`);
        }
        logger.info('[Trigger] routeOnly — assignment complete, no wake', {
          targetAgentId,
          sessionId: deliverySession.id,
          threadKey: payload.threadKey,
          threadId: payload.threadId,
        });
        await logInkmail('inkmail_deliver', payload, userId, {
          sessionId: deliverySession.id,
          deliveryMethod: 'route_only',
        });
        return;
      }

      // Deliver to the assigned session (may differ from routedSession after
      // a lost claim race).
      if (deliverySession.id !== routedSession.id) {
        request.metadata = {
          ...request.metadata,
          recipientSessionId: deliverySession.id,
        };
      }

      // Check if the routed session has a CLI actively polling or attached.
      // Only the routed session matters — a different session polling can't
      // see threads stamped to this one (get_inbox channelPoll filters by session_id).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: pollRow } = (await (dataComposer!.getClient() as any)
        .from('sessions')
        .select('id, cli_poll_at, studio_id')
        .eq('id', deliverySession.id)
        .maybeSingle()) as { data: SessionPollRow | null };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: attachedRow } = (await (dataComposer!.getClient() as any)
        .from('sessions')
        .select('cli_attached, updated_at')
        .eq('id', deliverySession.id)
        .maybeSingle()) as { data: SessionAttachedRow | null };

      // Clear stale cli_attached flag as a side effect (before the skip decision)
      if (
        attachedRow?.cli_attached &&
        attachedRow.updated_at &&
        Date.now() - new Date(attachedRow.updated_at).getTime() > 10 * 60 * 1000
      ) {
        logger.warn('[Trigger] CLI-attached session is stale, clearing flag', {
          sessionId: deliverySession.id,
          updatedAt: attachedRow.updated_at,
        });
        await dataComposer!
          .getClient()
          .from('sessions')
          .update({ cli_attached: false } as never)
          .eq('id', deliverySession.id);
        attachedRow.cli_attached = false;
      }

      // Strategy triggers (kickoff/watchdog/resume) must always spawn a new
      // session — they are self-addressed (agent triggers itself) and the
      // channel plugin's self-message filter silently drops them. Bypassing
      // shouldSkipSpawn ensures autonomous work actually starts.
      const isStrategyTrigger =
        payload.metadata &&
        typeof payload.metadata.strategyTrigger === 'boolean' &&
        payload.metadata.strategyTrigger;

      const delivery = isStrategyTrigger
        ? { skip: false, source: null, sessionId: null }
        : shouldSkipSpawn(pollRow, attachedRow);

      if (delivery.skip) {
        logger.info(
          `[Trigger] CLI-attached (${delivery.source}) — skipping spawn, channel plugin will deliver`,
          {
            targetAgentId,
            attachedSessionId: delivery.sessionId || deliverySession.id,
            routedSessionId: deliverySession.id,
            studioId: deliverySession.studioId,
            threadKey: payload.threadKey,
          }
        );
        await logInkmail('inkmail_deliver', payload, userId, {
          sessionId: deliverySession.id,
          deliveryMethod: `cli_${delivery.source}`,
        });
        return;
      }

      if (isStrategyTrigger) {
        logger.info('[Trigger] Strategy trigger — bypassing CLI-attached check, forcing spawn', {
          targetAgentId,
          reason: payload.metadata?.reason,
          groupId: payload.metadata?.groupId,
        });
      }
    } catch (err) {
      // If session resolution fails, fall through to normal handleMessage
      logger.debug('[Trigger] CLI-attached check failed, falling through to spawn', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Media resolves ONLY on the spawn path — CLI-attached deliveries (early
    // return above) are text-only via the channel plugin, so snapshotting for
    // them would guarantee orphaned copies (Lumen, review 4900565751).
    // storedTriggerMedia is the single entry point: it looks up the stored
    // row itself and snapshots each validated file; the trigger payload's
    // own metadata is not an input. Flows to the spawn as --attach-file and
    // from there through provider media injection.
    const triggerMedia = await storedTriggerMedia(dataComposer!.getClient() as never, payload);
    if (triggerMedia.length > 0) {
      request.metadata!.media = triggerMedia;
      logger.info('[Trigger] delivering media attachments', {
        count: triggerMedia.length,
        to: targetAgentId,
      });
    }

    const result = await sessionService!.handleMessage(request);

    if (!result.success) {
      logger.error(`[Trigger] SessionService failed for ${targetAgentId}: ${result.error}`);
      throw new Error(result.error || 'SessionService processing failed');
    }

    // Stamp execution_phase → worker_active now that a session is actually running
    const strategyGroupId =
      payload.metadata && typeof payload.metadata.groupId === 'string'
        ? payload.metadata.groupId
        : undefined;
    if (strategyGroupId && payload.metadata?.strategyTrigger) {
      try {
        await dataComposer!
          .getClient()
          .from('task_groups')
          .update({ execution_phase: 'worker_active' } as never)
          .eq('id', strategyGroupId)
          .eq('status', 'active');
        logger.info(`[Trigger] Stamped execution_phase=worker_active on group ${strategyGroupId}`);
      } catch (phaseErr) {
        logger.warn('[Trigger] Failed to stamp execution_phase', {
          groupId: strategyGroupId,
          error: phaseErr instanceof Error ? phaseErr.message : String(phaseErr),
        });
      }
    }

    // 5. Route any responses — wrapped in try-catch because the session already
    // succeeded at this point. A failure here (channel send error, cleanup race)
    // should NOT emit trigger:error or send a "Trigger failed" notification.
    try {
      if (result.responses && result.responses.length > 0) {
        await routeResponses(result.responses);
      }
    } catch (routeErr) {
      logger.error(
        `[Trigger] Response routing failed for ${targetAgentId} (session succeeded):`,
        routeErr
      );
    }

    await logInkmail('inkmail_deliver', payload, userId, { deliveryMethod: 'spawn' });
    logger.info(`[Trigger] Successfully processed trigger for ${targetAgentId}`);
  });
  logger.info('Default agent trigger handler registered (stateless, database-driven)');

  // 7b. Listen for trigger failures — restore inbox message + notify sender
  agentGateway.on(
    'trigger:error',
    async ({
      triggerId,
      payload,
      error,
    }: {
      triggerId: string;
      payload: AgentTriggerPayload;
      error: unknown;
    }) => {
      const errorText = error instanceof Error ? error.message : String(error);
      const classification = classifyError({ errorText });

      // Log full error text — truncateSummary only keeps the first line,
      // which loses stderr content that's critical for diagnosis.
      logger.warn('[TriggerFailure] Processing failure notification', {
        triggerId,
        from: payload.fromAgentId,
        to: payload.toAgentId,
        category: classification.category,
        retryable: classification.retryable,
        inboxMessageId: payload.inboxMessageId,
        threadKey: payload.threadKey,
        errorText: errorText.slice(0, 2000),
      });

      const client = dataComposer?.getClient();
      if (!client) return;

      // 1. Restore inbox message to unread (only for agent_inbox rows — not thread messages)
      if (payload.inboxMessageId) {
        const { error: restoreErr } = await client
          .from('agent_inbox')
          .update({ status: 'unread', read_at: null })
          .eq('id', payload.inboxMessageId)
          .eq('status', 'read');

        if (restoreErr) {
          logger.warn('[TriggerFailure] Failed to restore inbox message', {
            inboxMessageId: payload.inboxMessageId,
            error: restoreErr.message,
          });
        } else {
          logger.info('[TriggerFailure] Restored inbox message to unread', {
            inboxMessageId: payload.inboxMessageId,
          });
        }
      }

      // 2. Notify sender agent (if there is one) — skip if no sender to avoid loops
      if (!payload.fromAgentId) return;

      // Look up the userId from the original source row (needed for sender inbox insert).
      let recipientUserId: string | undefined;
      if (payload.inboxMessageId) {
        const { data: origMsg } = await client
          .from('agent_inbox')
          .select('recipient_user_id')
          .eq('id', payload.inboxMessageId)
          .single();
        recipientUserId = origMsg?.recipient_user_id;
      } else if (payload.threadMessageId) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: threadMsg } = await (client as any)
          .from('inbox_thread_messages')
          .select('thread_id')
          .eq('id', payload.threadMessageId)
          .single();
        if (threadMsg?.thread_id) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const { data: thread } = await (client as any)
            .from('inbox_threads')
            .select('user_id')
            .eq('id', threadMsg.thread_id)
            .single();
          recipientUserId = thread?.user_id;
        }
      } else if (payload.threadId) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: thread } = await (client as any)
          .from('inbox_threads')
          .select('user_id')
          .eq('id', payload.threadId)
          .single();
        recipientUserId = thread?.user_id;
      }

      if (recipientUserId) {
        await logInkmail('inkmail_fail', payload, recipientUserId, {
          error: errorText.slice(0, 2000),
        });
      }

      if (!recipientUserId) {
        logger.warn('[TriggerFailure] Cannot notify sender — no userId from inbox message');
        return;
      }

      const categoryLabel =
        classification.category !== 'unknown' ? ` (${classification.category})` : '';
      const notificationContent = `Trigger to ${payload.toAgentId} failed${categoryLabel}: ${classification.summary}`;

      const { error: insertErr } = await client.from('agent_inbox').insert({
        recipient_user_id: recipientUserId,
        recipient_agent_id: payload.fromAgentId,
        sender_agent_id: payload.toAgentId,
        subject: `Trigger failed: ${payload.toAgentId}`,
        content: notificationContent,
        message_type: 'notification',
        priority: 'high',
        thread_key: payload.threadKey || null,
        metadata: {
          triggerFailure: true,
          triggerId,
          errorCategory: classification.category,
          errorSummary: classification.summary,
          errorDetail: errorText.slice(0, 4000),
          retryable: classification.retryable,
          originalInboxMessageId: payload.inboxMessageId || null,
        },
        // No trigger — avoid infinite failure loops
      });

      if (insertErr) {
        logger.error('[TriggerFailure] Failed to send failure notification to sender', {
          sender: payload.fromAgentId,
          error: insertErr.message,
        });
      } else {
        logger.info('[TriggerFailure] Sent failure notification to sender', {
          sender: payload.fromAgentId,
          category: classification.category,
        });
      }
    }
  );

  // 8. Print status
  printStatus();

  // Ready
  logger.info('');
  logger.info('='.repeat(60));
  logger.info('Inkwell Server is running (SessionService architecture)');
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
 * Graceful shutdown with force-kill timeout.
 * If graceful teardown hangs (open connections, polling loops, etc.),
 * force-exit after 10 seconds so tsx --watch can restart cleanly.
 */
async function shutdown(): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info('\nShutting down Inkwell Server...');

  // Force-kill safety net: if graceful shutdown hangs, exit anyway.
  const forceKillTimer = setTimeout(() => {
    logger.error('Graceful shutdown timed out after 10s — force exiting');
    process.exit(1);
  }, 10_000);
  forceKillTimer.unref(); // Don't let the timer itself keep the process alive

  try {
    // Stop heartbeat cron job (logs internally)
    stopHeartbeatService();

    // Remove agent gateway listeners to release event loop references
    getAgentGateway().removeAllListeners();
    logger.info('Agent gateway listeners removed');

    // Shutdown MCP server (includes ChannelGateway shutdown)
    if (mcpServer) {
      await mcpServer.shutdown();
      logger.info('MCP server stopped');
    }

    logger.info('Shutdown complete');
    clearTimeout(forceKillTimer);
    process.exit(0);
  } catch (error) {
    logger.error('Error during shutdown:', error);
    clearTimeout(forceKillTimer);
    process.exit(1);
  }
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
  workingDirectory: process.env.INK_WORKING_DIR || path.resolve(__dirname, '../../..'),
  mcpConfigPath: process.env.MCP_CONFIG_PATH,
}).catch((error) => {
  logger.error('Failed to start server:', error);
  process.exit(1);
});
