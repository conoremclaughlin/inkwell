/**
 * Activity Stream MCP Tool Handlers
 *
 * Tools for logging and querying the unified activity stream that captures
 * everything an SB (Synthetically-born Being) does: messages, tool calls,
 * agent spawns, state changes, etc.
 */

import { z } from 'zod';
import type { DataComposer } from '../../data/composer';
import { logger } from '../../utils/logger';
import { getEffectiveAgentId } from '../../auth/enforce-identity';
import { resolveUserOrThrow } from '../../services/user-resolver';
import type {
  ActivityType,
  ActivityStatus,
  Json,
} from '../../data/repositories/activity-stream.repository';

// User identification fields (without platform to avoid conflict with activity platform)
// Usually unnecessary — userId and email are auto-resolved from OAuth token.
const userIdentifierFields = {
  userId: z
    .string()
    .uuid()
    .optional()
    .describe('User UUID — usually unnecessary, auto-resolved from OAuth token'),
  email: z
    .string()
    .email()
    .optional()
    .describe('User email — usually unnecessary, auto-resolved from OAuth token'),
  phone: z.string().optional().describe('Phone number in E.164 format (e.g., +14155551234)'),
  platformId: z
    .string()
    .optional()
    .describe(
      'Platform-specific user ID — only needed with userPlatform for platform-based lookup'
    ),
  userPlatform: z
    .enum(['telegram', 'whatsapp', 'discord'])
    .optional()
    .describe('Platform for user lookup (used with platformId)'),
};

// Enum schemas
const activityTypeSchema = z.enum([
  'message_in',
  'message_out',
  'tool_call',
  'tool_result',
  'agent_spawn',
  'agent_complete',
  'state_change',
  'thinking',
  'error',
]);

const activityStatusSchema = z.enum(['pending', 'running', 'completed', 'failed']);

// =====================================================
// SCHEMAS
// =====================================================

export const logActivitySchema = z.object({
  ...userIdentifierFields,
  agentId: z.string().describe('Agent identifier (e.g., "wren", "myra", "benson")'),
  type: activityTypeSchema.describe('Type of activity'),
  content: z.string().describe('Human-readable content/description of the activity'),
  sessionId: z.string().uuid().optional().describe('Session ID if within a session'),
  subtype: z.string().optional().describe('Optional subtype (e.g., tool name for tool_call)'),
  payload: z
    .record(z.unknown())
    .optional()
    .describe('Structured data specific to the activity type'),
  contactId: z
    .string()
    .uuid()
    .optional()
    .describe('Contact ID if activity involves another person'),
  parentId: z.string().uuid().optional().describe('Parent activity ID for hierarchical tracking'),
  correlationId: z
    .string()
    .uuid()
    .optional()
    .describe('Correlation ID for grouping related activities'),
  platform: z
    .string()
    .optional()
    .describe('Activity platform (telegram, discord, whatsapp, slack, etc.)'),
  platformMessageId: z
    .string()
    .optional()
    .describe('Platform-specific message ID for deduplication'),
  platformChatId: z.string().optional().describe('Platform-specific chat/conversation ID'),
  isDm: z.boolean().optional().describe('Whether this is a direct message (default: true)'),
  artifactId: z.string().uuid().optional().describe('Associated artifact ID'),
  childSessionId: z.string().uuid().optional().describe('Child session ID for agent_spawn'),
  status: activityStatusSchema.optional().describe('Activity status (default: completed)'),
});

export const logMessageSchema = z.object({
  ...userIdentifierFields,
  agentId: z.string().describe('Agent identifier'),
  direction: z.enum(['in', 'out']).describe('Message direction: "in" for received, "out" for sent'),
  content: z.string().describe('Message content'),
  sessionId: z.string().uuid().optional().describe('Session ID'),
  contactId: z.string().uuid().optional().describe('Contact ID of the other party'),
  platform: z.string().optional().describe('Activity platform (telegram, discord, etc.)'),
  platformMessageId: z.string().optional().describe('Platform message ID'),
  platformChatId: z.string().optional().describe('Platform chat ID'),
  isDm: z.boolean().optional().describe('Is direct message (default: true)'),
  payload: z.record(z.unknown()).optional().describe('Additional message metadata'),
});

export const getActivitySchema = z.object({
  ...userIdentifierFields,
  sessionId: z.string().uuid().optional().describe('Filter by session'),
  agentId: z.string().optional().describe('Filter by agent'),
  types: z.array(activityTypeSchema).optional().describe('Filter by activity types'),
  contactId: z.string().uuid().optional().describe('Filter by contact'),
  platform: z.string().optional().describe('Filter by activity platform'),
  platformChatId: z.string().optional().describe('Filter by platform chat'),
  correlationId: z.string().uuid().optional().describe('Filter by correlation ID'),
  parentId: z.string().uuid().optional().describe('Filter by parent activity'),
  since: z.string().datetime().optional().describe('Activities after this time (ISO 8601)'),
  until: z.string().datetime().optional().describe('Activities before this time (ISO 8601)'),
  limit: z.number().min(1).max(100).optional().describe('Max results (default: 50)'),
  offset: z.number().min(0).optional().describe('Offset for pagination'),
});

export const getConversationHistorySchema = z.object({
  ...userIdentifierFields,
  contactId: z.string().uuid().optional().describe('Filter by contact'),
  platform: z.string().optional().describe('Filter by activity platform'),
  platformChatId: z.string().optional().describe('Filter by platform chat'),
  isDm: z.boolean().optional().describe('Filter by DM status'),
  limit: z.number().min(1).max(100).optional().describe('Max messages (default: 50)'),
  offset: z.number().min(0).optional().describe('Offset for pagination'),
  since: z.string().datetime().optional().describe('Messages after this time'),
  until: z.string().datetime().optional().describe('Messages before this time'),
});

export const getSessionContextSchema = z.object({
  ...userIdentifierFields,
  sessionId: z.string().uuid().optional().describe('Session to get context for'),
  contactId: z.string().uuid().optional().describe('Contact for conversation context'),
  platform: z.string().optional().describe('Activity platform for chat context'),
  platformChatId: z.string().optional().describe('Platform chat for context'),
  limit: z.number().min(1).max(50).optional().describe('Max activities (default: 20)'),
});

// Helper to extract user identifier from params
function extractUserIdentifier(params: {
  userId?: string;
  email?: string;
  phone?: string;
  platformId?: string;
  userPlatform?: 'telegram' | 'whatsapp' | 'discord';
}) {
  return {
    userId: params.userId,
    email: params.email,
    phone: params.phone,
    platformId: params.platformId,
    platform: params.userPlatform,
  };
}

// =====================================================
// HANDLERS
// =====================================================

export async function handleLogActivity(args: unknown, dataComposer: DataComposer) {
  const params = logActivitySchema.parse(args);
  const { user, resolvedBy } = await resolveUserOrThrow(
    extractUserIdentifier(params),
    dataComposer
  );

  const activity = await dataComposer.repositories.activityStream.logActivity({
    userId: user.id,
    agentId: getEffectiveAgentId(params.agentId) ?? params.agentId,
    type: params.type as ActivityType,
    content: params.content,
    sessionId: params.sessionId,
    subtype: params.subtype,
    payload: params.payload as Json,
    contactId: params.contactId,
    parentId: params.parentId,
    correlationId: params.correlationId,
    platform: params.platform,
    platformMessageId: params.platformMessageId,
    platformChatId: params.platformChatId,
    isDm: params.isDm,
    artifactId: params.artifactId,
    childSessionId: params.childSessionId,
    status: params.status as ActivityStatus,
  });

  logger.info(`Activity logged for user ${user.id}`, {
    activityId: activity.id,
    type: activity.type,
    agentId: activity.agentId,
  });

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {
            success: true,
            message: 'Activity logged successfully',
            user: { id: user.id, resolvedBy },
            activity: {
              id: activity.id,
              type: activity.type,
              agentId: activity.agentId,
              createdAt: activity.createdAt.toISOString(),
            },
          },
          null,
          2
        ),
      },
    ],
  };
}

export async function handleLogMessage(args: unknown, dataComposer: DataComposer) {
  const params = logMessageSchema.parse(args);
  const { user, resolvedBy } = await resolveUserOrThrow(
    extractUserIdentifier(params),
    dataComposer
  );

  const activity = await dataComposer.repositories.activityStream.logMessage({
    userId: user.id,
    agentId: getEffectiveAgentId(params.agentId) ?? params.agentId,
    direction: params.direction,
    content: params.content,
    sessionId: params.sessionId,
    contactId: params.contactId,
    platform: params.platform,
    platformMessageId: params.platformMessageId,
    platformChatId: params.platformChatId,
    isDm: params.isDm,
    payload: params.payload as Json,
  });

  logger.info(`Message logged for user ${user.id}`, {
    activityId: activity.id,
    direction: params.direction,
    platform: params.platform,
  });

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {
            success: true,
            message: `${params.direction === 'in' ? 'Inbound' : 'Outbound'} message logged`,
            user: { id: user.id, resolvedBy },
            activity: {
              id: activity.id,
              type: activity.type,
              platform: activity.platform,
              createdAt: activity.createdAt.toISOString(),
            },
          },
          null,
          2
        ),
      },
    ],
  };
}

export async function handleGetActivity(args: unknown, dataComposer: DataComposer) {
  const params = getActivitySchema.parse(args);
  const { user, resolvedBy } = await resolveUserOrThrow(
    extractUserIdentifier(params),
    dataComposer
  );

  const activities = await dataComposer.repositories.activityStream.getActivity(user.id, {
    sessionId: params.sessionId,
    agentId: params.agentId,
    types: params.types as ActivityType[],
    contactId: params.contactId,
    platform: params.platform,
    platformChatId: params.platformChatId,
    correlationId: params.correlationId,
    parentId: params.parentId,
    since: params.since ? new Date(params.since) : undefined,
    until: params.until ? new Date(params.until) : undefined,
    limit: params.limit,
    offset: params.offset,
  });

  logger.debug(`Retrieved ${activities.length} activities for user ${user.id}`);

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {
            success: true,
            user: { id: user.id, resolvedBy },
            count: activities.length,
            activities: activities.map((a) => ({
              id: a.id,
              type: a.type,
              subtype: a.subtype,
              agentId: a.agentId,
              content: a.content,
              platform: a.platform,
              contactId: a.contactId,
              sessionId: a.sessionId,
              payload: a.payload ?? undefined,
              status: a.status,
              createdAt: a.createdAt.toISOString(),
              completedAt: a.completedAt?.toISOString(),
              durationMs: a.durationMs,
            })),
          },
          null,
          2
        ),
      },
    ],
  };
}

export async function handleGetConversationHistory(args: unknown, dataComposer: DataComposer) {
  const params = getConversationHistorySchema.parse(args);
  const { user, resolvedBy } = await resolveUserOrThrow(
    extractUserIdentifier(params),
    dataComposer
  );

  const messages = await dataComposer.repositories.activityStream.getConversationHistory(user.id, {
    contactId: params.contactId,
    platform: params.platform,
    platformChatId: params.platformChatId,
    isDm: params.isDm,
    limit: params.limit,
    offset: params.offset,
    since: params.since ? new Date(params.since) : undefined,
    until: params.until ? new Date(params.until) : undefined,
  });

  logger.info(`Retrieved ${messages.length} messages for user ${user.id}`);

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {
            success: true,
            user: { id: user.id, resolvedBy },
            count: messages.length,
            messages: messages.map((m) => ({
              id: m.id,
              type: m.type,
              direction: m.type === 'message_in' ? 'in' : 'out',
              content: m.content,
              agentId: m.agentId,
              platform: m.platform,
              platformMessageId: m.platformMessageId,
              contactId: m.contactId,
              isDm: m.isDm,
              createdAt: m.createdAt.toISOString(),
            })),
          },
          null,
          2
        ),
      },
    ],
  };
}

export async function handleGetSessionContext(args: unknown, dataComposer: DataComposer) {
  const params = getSessionContextSchema.parse(args);
  const { user, resolvedBy } = await resolveUserOrThrow(
    extractUserIdentifier(params),
    dataComposer
  );

  const activities = await dataComposer.repositories.activityStream.getSessionResumptionContext(
    user.id,
    {
      sessionId: params.sessionId,
      contactId: params.contactId,
      platform: params.platform,
      platformChatId: params.platformChatId,
      limit: params.limit,
    }
  );

  logger.debug(`Retrieved ${activities.length} activities for session context`, {
    userId: user.id,
    sessionId: params.sessionId,
  });

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {
            success: true,
            user: { id: user.id, resolvedBy },
            count: activities.length,
            context: activities.map((a) => ({
              id: a.id,
              type: a.type,
              subtype: a.subtype,
              agentId: a.agentId,
              content: a.content,
              platform: a.platform,
              contactId: a.contactId,
              createdAt: a.createdAt.toISOString(),
            })),
          },
          null,
          2
        ),
      },
    ],
  };
}
