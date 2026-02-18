import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { DataComposer } from '../../data/composer';
import { logger } from '../../utils/logger';

// Import all tool handlers
import { handleSaveLink, handleSearchLinks, handleTagLink } from './link-handlers';

import {
  handleSaveContext,
  handleGetContext,
  handleSaveProject,
  handleListProjects,
  handleGetProject,
  handleSetFocus,
  handleGetFocus,
} from './context-handlers';

import {
  handleCreateTask,
  handleListTasks,
  handleUpdateTask,
  handleCompleteTask,
  handleGetTaskStats,
} from './task-handlers';

import { handleSendResponse, handleGetPendingMessages, handleMarkRead } from './response-handlers';

import {
  handleRemember,
  handleRecall,
  handleForget,
  handleUpdateMemory,
  handleStartSession,
  handleLogSession,
  handleEndSession,
  handleGetSession,
  handleListSessions,
  handleUpdateSessionPhase,
  handleGetMemoryHistory,
  handleGetUserHistory,
  handleRestoreMemory,
  handleBootstrap,
  handleCompactSession,
} from './memory-handlers';

import {
  handleGetChatContext,
  handleClearChatContext,
  handleGetCacheStats,
} from './chat-context-handlers';

import { handleListSkills, handleGetSkill } from './skill-handlers';

import {
  handlePublishSkill,
  handleUpdateSkill,
  handleForkSkill,
  handleDeprecateSkill,
  handleDeleteSkill,
  publishSkillSchema,
  updateSkillSchema,
  forkSkillSchema,
  deprecateSkillSchema,
  deleteSkillSchema,
} from './skill-management-handlers';

import { registerMiniAppRecordTools } from './mini-app-records';

import {
  handleListPermissions,
  handleGetUserPermissions,
  handleSetPermission,
  handleResetPermission,
  handleQueryAuditLog,
  handleGetActivitySummary,
  listPermissionsSchema,
  getUserPermissionsSchema,
  setPermissionSchema,
  resetPermissionSchema,
  queryAuditLogSchema,
  getActivitySummarySchema,
} from './permissions';

import {
  handleChooseName,
  handleMeetFamily,
  handleSaveIdentity,
  handleGetIdentity,
  handleListIdentities,
  handleGetIdentityHistory,
  handleRestoreIdentity,
  chooseNameSchema,
  meetFamilySchema,
  saveIdentitySchema,
  getIdentitySchema,
  listIdentitiesSchema,
  getIdentityHistorySchema,
  restoreIdentitySchema,
} from './identity-handlers';

import {
  handleSaveUserIdentity,
  handleGetUserIdentity,
  handleGetUserIdentityHistory,
  handleRestoreUserIdentity,
  saveUserIdentitySchema,
  getUserIdentitySchema,
  getUserIdentityHistorySchema,
  restoreUserIdentitySchema,
} from './user-identity-handlers';

import {
  handleCreateReminder,
  handleListReminders,
  handleUpdateReminder,
  handleCancelReminder,
  handleGetReminderHistory,
  handleSetQuietHours,
  createReminderSchema,
  listRemindersSchema,
  updateReminderSchema,
  cancelReminderSchema,
  getReminderHistorySchema,
  setQuietHoursSchema,
} from './reminder-handlers';

import {
  handleSetTimezone,
  handleGetTimezone,
  setTimezoneSchema,
  getTimezoneSchema,
} from './user-settings-handlers';

import {
  handleGetResumableSessions,
  handleUpdateSessionStatus,
  getResumableSessionsSchema,
  updateSessionStatusSchema,
} from './session-orchestration-handlers';

import {
  handleCreateArtifact,
  handleGetArtifact,
  handleUpdateArtifact,
  handleListArtifacts,
  handleGetArtifactHistory,
  handleAddArtifactComment,
  handleListArtifactComments,
  artifactToolDefinitions,
} from './artifact-handlers';

import {
  handleSendToInbox,
  handleGetInbox,
  handleUpdateInboxMessage,
  handleGetAgentStatus,
  inboxToolDefinitions,
} from './inbox-handlers';

import {
  handleTriggerAgent,
  handleListRegisteredAgents,
  triggerAgentSchema,
  listRegisteredAgentsSchema,
} from './agent-triggers';

import {
  handleListCalendars,
  handleListCalendarEvents,
  handleGetCalendarEvent,
  handleRespondToCalendarEvent,
  handleUpdateCalendarEvent,
  handleCreateCalendarEvent,
  listCalendarsSchema,
  listCalendarEventsSchema,
  getCalendarEventSchema,
  respondToCalendarEventSchema,
  updateCalendarEventSchema,
  createCalendarEventSchema,
} from '../../stories/google-calendar/handlers';

import {
  handleListEmails,
  handleGetEmail,
  handleSendEmail,
  handleReplyToEmail,
  handleDraftEmail,
  handleListLabels,
  handleModifyEmails,
  listEmailsSchema,
  getEmailSchema,
  sendEmailSchema,
  replyToEmailSchema,
  draftEmailSchema,
  listLabelsSchema,
  modifyEmailsSchema,
} from '../../stories/gmail/handlers';

import {
  handleLogActivity,
  handleLogMessage,
  handleGetActivity,
  handleGetConversationHistory,
  handleGetSessionContext,
  logActivitySchema,
  logMessageSchema,
  getActivitySchema,
  getConversationHistorySchema,
  getSessionContextSchema,
} from './activity-stream-handlers';

import {
  handleCreateWorkspace,
  handleListWorkspaces,
  handleGetWorkspace,
  handleUpdateWorkspace,
  handleCloseWorkspace,
  handleAdoptWorkspace,
  workspaceToolDefinitions,
} from './workspace-handlers';

import {
  handleCreateWorkspaceContainer,
  handleListWorkspaceContainers,
  handleGetWorkspaceContainer,
  handleUpdateWorkspaceContainer,
  handleAddWorkspaceMember,
  createWorkspaceContainerSchema,
  listWorkspaceContainersSchema,
  getWorkspaceContainerSchema,
  updateWorkspaceContainerSchema,
  addWorkspaceMemberSchema,
} from './workspace-container-handlers';

import { handleCreateKindleToken, createKindleTokenSchema } from './kindle-handlers';

import {
  handleUpdateIntegrationHealth,
  handleGetIntegrationHealth,
  updateIntegrationHealthSchema,
  getIntegrationHealthSchema,
} from './integration-health-handlers';

// Re-export for external use
export { setResponseCallback, addPendingMessage } from './response-handlers';
export { setTelegramListener, registerChannelListener } from './chat-context-handlers';
export { setMiniAppsRegistry } from './skill-handlers';

// Shared schema for flexible user identification
// Usually unnecessary — userId and email are auto-resolved from OAuth token.
// Only needed for platform-based lookups or when operating without authentication.
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
  platform: z
    .enum(['telegram', 'whatsapp', 'discord'])
    .optional()
    .describe('Platform name — only needed for platform-based user lookup'),
  platformId: z
    .string()
    .optional()
    .describe('Platform-specific user ID — only needed for platform-based user lookup'),
};

export function registerAllTools(server: McpServer, dataComposer: DataComposer): void {
  // ---------------------------------------------------------------------------
  // Timing diagnostics — wraps every tool handler to log execution time.
  // Calls exceeding SLOW_TOOL_THRESHOLD_MS are logged at warn level.
  // ---------------------------------------------------------------------------
  const SLOW_TOOL_THRESHOLD_MS = 500;
  const originalRegisterTool = server.registerTool.bind(server);
  (server as any).registerTool = (name: string, ...rest: any[]) => {
    const handler = rest[rest.length - 1];
    if (typeof handler === 'function') {
      rest[rest.length - 1] = async (...handlerArgs: any[]) => {
        const start = performance.now();
        try {
          const result = await handler(...handlerArgs);
          const durationMs = Math.round(performance.now() - start);
          if (durationMs > SLOW_TOOL_THRESHOLD_MS) {
            logger.warn(`[timing] ${name}: ${durationMs}ms (SLOW)`);
          } else {
            logger.debug(`[timing] ${name}: ${durationMs}ms`);
          }
          return result;
        } catch (error) {
          const durationMs = Math.round(performance.now() - start);
          logger.warn(`[timing] ${name}: ${durationMs}ms (ERROR)`);
          throw error;
        }
      };
    }
    return (originalRegisterTool as any)(name, ...rest);
  };

  const getArtifactToolSchema = (toolName: string) => {
    const tool = artifactToolDefinitions.find((definition) => definition.name === toolName);
    if (!tool) {
      throw new Error(`Artifact tool schema not found: ${toolName}`);
    }
    return tool.schema;
  };

  // Register save_link tool
  server.registerTool(
    'save_link',
    {
      description: `Save a URL with optional title, description, and tags to the personal context.

User can be identified by ONE of:
- userId: Direct UUID
- email: Email address
- phone: Phone number (E.164 format like +14155551234)
- platform + platformId: Platform name (telegram/whatsapp/discord) and user ID`,
      inputSchema: {
        ...userIdentifierFields,
        url: z.string().url().describe('URL to save'),
        title: z.string().optional().describe('Title of the link'),
        description: z.string().optional().describe('Description of the link'),
        tags: z.array(z.string()).optional().describe('Tags for categorization'),
        source: z
          .enum(['telegram', 'whatsapp', 'discord', 'api'])
          .optional()
          .describe('Source platform'),
      },
    },
    async (args) => {
      try {
        return await handleSaveLink(args, dataComposer);
      } catch (error) {
        logger.error('Error in save_link:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // Register search_links tool
  server.registerTool(
    'search_links',
    {
      description: `Search saved links by query, tags, or date range.

User can be identified by ONE of:
- userId: Direct UUID
- email: Email address
- phone: Phone number (E.164 format)
- platform + platformId: Platform name and user ID`,
      inputSchema: {
        ...userIdentifierFields,
        query: z.string().optional().describe('Search query'),
        tags: z.array(z.string()).optional().describe('Filter by tags'),
        startDate: z.string().datetime().optional().describe('Start date filter'),
        endDate: z.string().datetime().optional().describe('End date filter'),
        limit: z.number().min(1).max(100).default(20).describe('Maximum results to return'),
      },
    },
    async (args) => {
      try {
        return await handleSearchLinks(args, dataComposer);
      } catch (error) {
        logger.error('Error in search_links:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // Register tag_link tool
  server.registerTool(
    'tag_link',
    {
      description: `Add or remove tags from a saved link.

User can be identified by ONE of:
- userId: Direct UUID
- email: Email address
- phone: Phone number (E.164 format)
- platform + platformId: Platform name and user ID`,
      inputSchema: {
        ...userIdentifierFields,
        linkId: z.string().uuid().describe('Link ID to modify'),
        addTags: z.array(z.string()).optional().describe('Tags to add'),
        removeTags: z.array(z.string()).optional().describe('Tags to remove'),
      },
    },
    async (args) => {
      try {
        return await handleTagLink(args, dataComposer);
      } catch (error) {
        logger.error('Error in tag_link:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // =====================================================
  // CONTEXT TOOLS
  // =====================================================

  // Register save_context tool
  server.registerTool(
    'save_context',
    {
      description: `Save or update a context summary. Context types:
- user: Information about the user (name, preferences, expertise)
- assistant: Information about the AI's role and relationship with user
- project: Project-specific context (use save_project for full project data)
- session: Current session context
- relationship: The ongoing relationship between user and assistant

User can be identified by ONE of: userId, email, phone, or platform + platformId`,
      inputSchema: {
        ...userIdentifierFields,
        contextType: z
          .enum(['user', 'assistant', 'project', 'session', 'relationship'])
          .describe('Type of context'),
        contextKey: z.string().optional().describe('Optional key for sub-context'),
        summary: z.string().describe('The summarized context to save'),
        metadata: z.record(z.unknown()).optional().describe('Additional metadata'),
      },
    },
    async (args) => {
      try {
        return await handleSaveContext(args, dataComposer);
      } catch (error) {
        logger.error('Error in save_context:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // Register get_context tool
  server.registerTool(
    'get_context',
    {
      description: `Retrieve saved context summaries. Can filter by type and key.

User can be identified by ONE of: userId, email, phone, or platform + platformId`,
      inputSchema: {
        ...userIdentifierFields,
        contextType: z
          .enum(['user', 'assistant', 'project', 'session', 'relationship'])
          .optional()
          .describe('Filter by type'),
        contextKey: z.string().optional().describe('Filter by key'),
      },
    },
    async (args) => {
      try {
        return await handleGetContext(args, dataComposer);
      } catch (error) {
        logger.error('Error in get_context:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // =====================================================
  // PROJECT TOOLS
  // =====================================================

  // Register save_project tool
  server.registerTool(
    'save_project',
    {
      description: `Create or update a project. Projects track what the user is working on.

User can be identified by ONE of: userId, email, phone, or platform + platformId`,
      inputSchema: {
        ...userIdentifierFields,
        name: z.string().describe('Project name (unique per user)'),
        description: z.string().optional().describe('Project description'),
        status: z.enum(['active', 'paused', 'completed', 'archived']).optional(),
        techStack: z.array(z.string()).optional().describe('Technologies used'),
        repositoryUrl: z.string().url().optional().describe('Repository URL'),
        goals: z.array(z.string()).optional().describe('Project goals'),
      },
    },
    async (args) => {
      try {
        return await handleSaveProject(args, dataComposer);
      } catch (error) {
        logger.error('Error in save_project:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // Register list_projects tool
  server.registerTool(
    'list_projects',
    {
      description: `List all projects for a user, optionally filtered by status.

User can be identified by ONE of: userId, email, phone, or platform + platformId`,
      inputSchema: {
        ...userIdentifierFields,
        status: z.enum(['active', 'paused', 'completed', 'archived']).optional(),
      },
    },
    async (args) => {
      try {
        return await handleListProjects(args, dataComposer);
      } catch (error) {
        logger.error('Error in list_projects:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // Register get_project tool
  server.registerTool(
    'get_project',
    {
      description: `Get detailed information about a specific project.

User can be identified by ONE of: userId, email, phone, or platform + platformId`,
      inputSchema: {
        ...userIdentifierFields,
        name: z.string().optional().describe('Project name'),
        projectId: z.string().uuid().optional().describe('Project UUID'),
      },
    },
    async (args) => {
      try {
        return await handleGetProject(args, dataComposer);
      } catch (error) {
        logger.error('Error in get_project:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // =====================================================
  // SESSION FOCUS TOOLS
  // =====================================================

  // Register set_focus tool
  server.registerTool(
    'set_focus',
    {
      description: `Set the current focus/context for a session. Tracks what project and task we're working on.

User can be identified by ONE of: userId, email, phone, or platform + platformId`,
      inputSchema: {
        ...userIdentifierFields,
        sessionId: z.string().optional().describe('Session ID'),
        projectName: z.string().optional().describe('Project name to focus on'),
        projectId: z.string().uuid().optional().describe('Project UUID to focus on'),
        focusSummary: z.string().optional().describe('What we are currently working on'),
        contextSnapshot: z.record(z.unknown()).optional().describe('Context snapshot'),
      },
    },
    async (args) => {
      try {
        return await handleSetFocus(args, dataComposer);
      } catch (error) {
        logger.error('Error in set_focus:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // Register get_focus tool
  server.registerTool(
    'get_focus',
    {
      description: `Get the current focus/context for a session or the user's most recent focus.

User can be identified by ONE of: userId, email, phone, or platform + platformId`,
      inputSchema: {
        ...userIdentifierFields,
        sessionId: z.string().optional().describe('Specific session ID'),
      },
    },
    async (args) => {
      try {
        return await handleGetFocus(args, dataComposer);
      } catch (error) {
        logger.error('Error in get_focus:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // =====================================================
  // PROJECT TASK TOOLS
  // =====================================================

  // Register create_task tool
  server.registerTool(
    'create_task',
    {
      description: `Create a task tied to a project. Tasks persist across sessions and can be tracked.

User can be identified by ONE of: userId, email, phone, or platform + platformId`,
      inputSchema: {
        ...userIdentifierFields,
        projectId: z.string().uuid().describe('Project ID to add the task to'),
        title: z.string().min(1).max(500).describe('Task title'),
        description: z.string().optional().describe('Detailed task description'),
        priority: z.enum(['low', 'medium', 'high', 'critical']).optional().default('medium'),
        tags: z.array(z.string()).optional().describe('Tags for categorization'),
        createdBy: z.string().optional().describe('Who created this task (e.g., "claude", "user")'),
      },
    },
    async (args) => {
      try {
        return await handleCreateTask(args, dataComposer);
      } catch (error) {
        logger.error('Error in create_task:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // Register list_tasks tool
  server.registerTool(
    'list_tasks',
    {
      description: `List tasks for a user, optionally filtered by project or status.

User can be identified by ONE of: userId, email, phone, or platform + platformId`,
      inputSchema: {
        ...userIdentifierFields,
        projectId: z.string().uuid().optional().describe('Filter by project'),
        status: z.enum(['pending', 'in_progress', 'completed', 'blocked']).optional(),
        activeOnly: z
          .boolean()
          .optional()
          .default(false)
          .describe('Only show pending/in_progress tasks'),
        limit: z.number().optional().default(50),
      },
    },
    async (args) => {
      try {
        return await handleListTasks(args, dataComposer);
      } catch (error) {
        logger.error('Error in list_tasks:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // Register update_task tool
  server.registerTool(
    'update_task',
    {
      description: `Update a task's title, description, status, priority, or tags.

User can be identified by ONE of: userId, email, phone, or platform + platformId`,
      inputSchema: {
        ...userIdentifierFields,
        taskId: z.string().uuid().describe('Task ID to update'),
        title: z.string().min(1).max(500).optional(),
        description: z.string().optional(),
        status: z.enum(['pending', 'in_progress', 'completed', 'blocked']).optional(),
        priority: z.enum(['low', 'medium', 'high', 'critical']).optional(),
        tags: z.array(z.string()).optional(),
      },
    },
    async (args) => {
      try {
        return await handleUpdateTask(args, dataComposer);
      } catch (error) {
        logger.error('Error in update_task:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // Register complete_task tool
  server.registerTool(
    'complete_task',
    {
      description: `Mark a task as completed.

User can be identified by ONE of: userId, email, phone, or platform + platformId`,
      inputSchema: {
        ...userIdentifierFields,
        taskId: z.string().uuid().describe('Task ID to mark as completed'),
      },
    },
    async (args) => {
      try {
        return await handleCompleteTask(args, dataComposer);
      } catch (error) {
        logger.error('Error in complete_task:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // Register get_task_stats tool
  server.registerTool(
    'get_task_stats',
    {
      description: `Get task statistics for a project (total, pending, in_progress, completed, blocked counts).

User can be identified by ONE of: userId, email, phone, or platform + platformId`,
      inputSchema: {
        ...userIdentifierFields,
        projectId: z.string().uuid().describe('Project ID to get stats for'),
      },
    },
    async (args) => {
      try {
        return await handleGetTaskStats(args, dataComposer);
      } catch (error) {
        logger.error('Error in get_task_stats:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // =====================================================
  // RESPONSE ROUTING TOOLS
  // =====================================================

  // Register send_response tool
  server.registerTool(
    'send_response',
    {
      description: `Send a response to a specific channel. Use this tool to reply to messages from Telegram, terminal, or other channels.

This is the primary way to send responses back to users. Always use this tool instead of just outputting text.`,
      inputSchema: {
        channel: z
          .enum(['telegram', 'terminal', 'discord', 'whatsapp', 'http', 'api', 'agent'])
          .describe('Channel to send the response to'),
        conversationId: z.string().describe('Conversation ID to route the response to'),
        content: z.string().describe('The response content to send'),
        format: z
          .enum(['text', 'markdown', 'code', 'json'])
          .optional()
          .describe('Format of the response content'),
        replyToMessageId: z.string().optional().describe('Message ID to reply to (for threading)'),
      },
    },
    async (args) => {
      try {
        return await handleSendResponse(args, dataComposer);
      } catch (error) {
        logger.error('Error in send_response:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // Register get_pending_messages tool
  server.registerTool(
    'get_pending_messages',
    {
      description: `Get pending messages from other channels. Use this to check if there are new messages from Telegram or other platforms that need your attention.`,
      inputSchema: {
        channel: z
          .enum(['telegram', 'terminal', 'discord', 'whatsapp', 'http', 'api', 'all'])
          .optional()
          .default('all')
          .describe('Filter by channel (default: all)'),
        limit: z
          .number()
          .min(1)
          .max(50)
          .optional()
          .default(10)
          .describe('Maximum messages to return'),
        since: z.string().datetime().optional().describe('Only messages after this timestamp'),
      },
    },
    async (args) => {
      try {
        return await handleGetPendingMessages(args, dataComposer);
      } catch (error) {
        logger.error('Error in get_pending_messages:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // Register mark_messages_read tool
  server.registerTool(
    'mark_messages_read',
    {
      description: `Mark messages as read. Use this after you've processed pending messages.`,
      inputSchema: {
        messageIds: z.array(z.string()).describe('Message IDs to mark as read'),
      },
    },
    async (args) => {
      try {
        return await handleMarkRead(args, dataComposer);
      } catch (error) {
        logger.error('Error in mark_messages_read:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // =====================================================
  // MEMORY TOOLS
  // =====================================================

  // Register remember tool
  server.registerTool(
    'remember',
    {
      description: `Save something to long-term memory. Memories persist across sessions and can be recalled later.

User can be identified by ONE of: userId, email, phone, or platform + platformId`,
      inputSchema: {
        ...userIdentifierFields,
        content: z.string().describe('The content to remember'),
        source: z
          .enum(['conversation', 'observation', 'user_stated', 'inferred', 'session'])
          .optional()
          .describe('Source of the memory (default: observation)'),
        salience: z
          .enum(['low', 'medium', 'high', 'critical'])
          .optional()
          .describe('Importance level (default: medium)'),
        topics: z
          .union([z.string(), z.array(z.string())])
          .optional()
          .describe('Topics for categorization'),
        metadata: z.record(z.unknown()).optional().describe('Additional metadata'),
        expiresAt: z.string().datetime().optional().describe('Optional expiration date (ISO 8601)'),
        agentId: z
          .string()
          .optional()
          .describe(
            'Which AI being created this memory (e.g., "wren", "benson"). Null = shared memory.'
          ),
        studioId: z
          .string()
          .uuid()
          .optional()
          .describe(
            'Studio ID — helps auto-attach the correct session in parallel worktree scenarios. Stored in metadata.'
          ),
        workspaceId: z
          .string()
          .uuid()
          .optional()
          .describe('[Deprecated] Workspace ID alias for studioId.'),
      },
    },
    async (args) => {
      try {
        return await handleRemember(args, dataComposer);
      } catch (error) {
        logger.error('Error in remember:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // Register recall tool
  server.registerTool(
    'recall',
    {
      description: `Search and retrieve memories. Currently uses text search; semantic search coming soon.

User can be identified by ONE of: userId, email, phone, or platform + platformId`,
      inputSchema: {
        ...userIdentifierFields,
        query: z.string().optional().describe('Search query (text search for now)'),
        source: z
          .enum(['conversation', 'observation', 'user_stated', 'inferred', 'session'])
          .optional()
          .describe('Filter by source'),
        salience: z
          .enum(['low', 'medium', 'high', 'critical'])
          .optional()
          .describe('Filter by salience'),
        topics: z
          .union([z.string(), z.array(z.string())])
          .optional()
          .describe('Filter by topics (any match)'),
        limit: z.number().min(1).max(100).optional().describe('Max results (default: 20)'),
        includeExpired: z.boolean().optional().describe('Include expired memories'),
        agentId: z
          .string()
          .optional()
          .describe('Filter by agent (e.g., "wren"). Omit to include all memories.'),
        includeShared: z
          .boolean()
          .optional()
          .describe(
            'Include shared memories (agentId=null) when filtering by agentId (default: true)'
          ),
      },
    },
    async (args) => {
      try {
        return await handleRecall(args, dataComposer);
      } catch (error) {
        logger.error('Error in recall:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // Register forget tool
  server.registerTool(
    'forget',
    {
      description: `Delete a memory permanently.

User can be identified by ONE of: userId, email, phone, or platform + platformId`,
      inputSchema: {
        ...userIdentifierFields,
        memoryId: z.string().uuid().describe('ID of the memory to forget'),
      },
    },
    async (args) => {
      try {
        return await handleForget(args, dataComposer);
      } catch (error) {
        logger.error('Error in forget:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // Register update_memory tool
  server.registerTool(
    'update_memory',
    {
      description: `Update a memory's salience, topics, or metadata.

User can be identified by ONE of: userId, email, phone, or platform + platformId`,
      inputSchema: {
        ...userIdentifierFields,
        memoryId: z.string().uuid().describe('ID of the memory to update'),
        salience: z
          .enum(['low', 'medium', 'high', 'critical'])
          .optional()
          .describe('New salience level'),
        topics: z
          .union([z.string(), z.array(z.string())])
          .optional()
          .describe('New topics'),
        metadata: z.record(z.unknown()).optional().describe('Metadata to merge'),
      },
    },
    async (args) => {
      try {
        return await handleUpdateMemory(args, dataComposer);
      } catch (error) {
        logger.error('Error in update_memory:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // =====================================================
  // SESSION TOOLS (for tracking AI sessions)
  // =====================================================

  // Register start_session tool
  server.registerTool(
    'start_session',
    {
      description: `Start a new AI session. Sessions track work done across a conversation and can be logged to.

Session matching priority:
1. threadKey — if provided, returns an existing active session with the same agent+threadKey (enables cross-trigger session continuity, e.g., "pr:32").
2. studioId — scopes the session to a studio, allowing multiple active sessions per agent (one per studio). Read from .pcp/identity.json.
3. Default — returns any active session for the agent.

workspaceId is accepted as a deprecated alias for studioId.

User can be identified by ONE of: userId, email, phone, or platform + platformId`,
      inputSchema: {
        ...userIdentifierFields,
        agentId: z
          .string()
          .optional()
          .describe('Agent identifier (e.g., "claude-code", "telegram-myra")'),
        studioId: z
          .string()
          .uuid()
          .optional()
          .describe(
            'Studio ID to scope this session to. Allows multiple active sessions per agent (one per studio). Read from .pcp/identity.json.'
          ),
        workspaceId: z
          .string()
          .uuid()
          .optional()
          .describe('[Deprecated] Workspace ID alias for studioId.'),
        threadKey: z
          .string()
          .optional()
          .describe(
            'Thread key for session routing (e.g., "pr:32"). If an active session with this threadKey exists for the same agent, it is returned instead of creating a new one.'
          ),
        backend: z
          .string()
          .optional()
          .describe('Backend runtime (e.g., "claude-code", "codex", "gemini")'),
        model: z
          .string()
          .optional()
          .describe('Model identifier (e.g., "opus-4-6", "sonnet", "o3")'),
        metadata: z.record(z.unknown()).optional().describe('Session metadata'),
      },
    },
    async (args) => {
      try {
        return await handleStartSession(args, dataComposer);
      } catch (error) {
        logger.error('Error in start_session:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // Register log_session tool
  server.registerTool(
    'log_session',
    {
      description: `[DEPRECATED] Add an entry to the current session log. Prefer update_session_phase for work status and remember for important decisions/events.

User can be identified by ONE of: userId, email, phone, or platform + platformId`,
      inputSchema: {
        ...userIdentifierFields,
        sessionId: z
          .string()
          .uuid()
          .optional()
          .describe('Session ID (uses active session if not provided)'),
        agentId: z
          .string()
          .optional()
          .describe('Agent identifier for session resolution (e.g., "wren", "benson")'),
        studioId: z
          .string()
          .uuid()
          .optional()
          .describe('Studio ID for session resolution when sessionId not provided'),
        workspaceId: z
          .string()
          .uuid()
          .optional()
          .describe('[Deprecated] Workspace ID alias for studioId.'),
        content: z.string().describe('Log entry content'),
        salience: z
          .enum(['low', 'medium', 'high', 'critical'])
          .optional()
          .describe('Importance (default: medium)'),
      },
    },
    async (args) => {
      try {
        return await handleLogSession(args, dataComposer);
      } catch (error) {
        logger.error('Error in log_session:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // Register end_session tool
  server.registerTool(
    'end_session',
    {
      description: `End a session with an optional summary. The summary is automatically saved as a high-salience memory.

Session resolution: sessionId (explicit) > agentId+studioId (scoped) > most recent active (fallback).
workspaceId is accepted as a deprecated alias.

User can be identified by ONE of: userId, email, phone, or platform + platformId`,
      inputSchema: {
        ...userIdentifierFields,
        sessionId: z
          .string()
          .uuid()
          .optional()
          .describe('Session ID (uses active session if not provided)'),
        agentId: z
          .string()
          .optional()
          .describe('Agent identifier for session resolution (e.g., "wren", "benson")'),
        studioId: z
          .string()
          .uuid()
          .optional()
          .describe('Studio ID for session resolution when sessionId not provided'),
        workspaceId: z
          .string()
          .uuid()
          .optional()
          .describe('[Deprecated] Workspace ID alias for studioId.'),
        summary: z.string().optional().describe('End-of-session summary (saved as memory)'),
      },
    },
    async (args) => {
      try {
        return await handleEndSession(args, dataComposer);
      } catch (error) {
        logger.error('Error in end_session:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // Register get_session tool
  server.registerTool(
    'get_session',
    {
      description: `Get details about a session, optionally including its logs.

User can be identified by ONE of: userId, email, phone, or platform + platformId`,
      inputSchema: {
        ...userIdentifierFields,
        sessionId: z
          .string()
          .uuid()
          .optional()
          .describe('Session ID (returns active session if not provided)'),
        agentId: z
          .string()
          .optional()
          .describe('Agent identifier for session resolution (e.g., "wren", "benson")'),
        studioId: z
          .string()
          .uuid()
          .optional()
          .describe('Studio ID for session resolution when sessionId not provided'),
        workspaceId: z
          .string()
          .uuid()
          .optional()
          .describe('[Deprecated] Workspace ID alias for studioId.'),
        includeLogs: z.boolean().optional().describe('Include session logs (default: false)'),
      },
    },
    async (args) => {
      try {
        return await handleGetSession(args, dataComposer);
      } catch (error) {
        logger.error('Error in get_session:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // Register list_sessions tool
  server.registerTool(
    'list_sessions',
    {
      description: `List past sessions, optionally filtered by agent.

User can be identified by ONE of: userId, email, phone, or platform + platformId`,
      inputSchema: {
        ...userIdentifierFields,
        agentId: z.string().optional().describe('Filter by agent'),
        studioId: z.string().uuid().optional().describe('Filter by studio'),
        workspaceId: z
          .string()
          .uuid()
          .optional()
          .describe('[Deprecated] Workspace ID alias for studioId.'),
        limit: z.number().min(1).max(100).optional().describe('Max results (default: 20)'),
      },
    },
    async (args) => {
      try {
        return await handleListSessions(args, dataComposer);
      } catch (error) {
        logger.error('Error in list_sessions:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // Register update_session_phase tool
  server.registerTool(
    'update_session_phase',
    {
      description: `Update your session state — work phase, status, backend session ID, context. This is the primary tool for managing session state.

Session resolution: sessionId (explicit) > studioId (scoped lookup) > most recent active session.
For parallel worktrees, pass studioId to target the correct session.
workspaceId is accepted as a deprecated alias.

Phase: Communicates real-time work status to other agents.
- Active work phases (no auto-memory): investigating, implementing, reviewing
- Significant transitions (auto-creates memory): blocked:<reason>, waiting:<reason>, complete
- Optional: paused

Also sets: backendSessionId (for resume), status (active/paused/resumable/completed), context, workingDir.

User can be identified by ONE of: userId, email, phone, or platform + platformId`,
      inputSchema: {
        ...userIdentifierFields,
        sessionId: z
          .string()
          .uuid()
          .optional()
          .describe(
            'Session ID (uses active session if not provided). Most reliable for targeting a specific session.'
          ),
        studioId: z
          .string()
          .uuid()
          .optional()
          .describe(
            'Studio ID for session resolution when sessionId is not provided. Useful for parallel worktree scenarios.'
          ),
        workspaceId: z
          .string()
          .uuid()
          .optional()
          .describe('[Deprecated] Workspace ID alias for studioId.'),
        phase: z
          .string()
          .optional()
          .describe('Work phase (e.g., "implementing", "blocked:awaiting-input", "waiting:build")'),
        note: z
          .string()
          .optional()
          .describe(
            'Context for the phase transition (included in auto-created memory for blocked/waiting)'
          ),
        agentId: z.string().optional().describe('Agent identity for memory attribution'),
        createTask: z
          .boolean()
          .optional()
          .describe('Create a PCP task for blocked/waiting phases (default: false)'),
        backendSessionId: z
          .string()
          .optional()
          .describe(
            'Backend-specific session ID for resumption (e.g., Claude Code session ID, Codex session ID)'
          ),
        status: z
          .enum(['active', 'paused', 'resumable', 'completed'])
          .optional()
          .describe('Session status'),
        context: z.string().optional().describe('Brief context of current work state'),
        workingDir: z.string().optional().describe('Working directory'),
      },
    },
    async (args) => {
      try {
        return await handleUpdateSessionPhase(args, dataComposer);
      } catch (error) {
        logger.error('Error in update_session_phase:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // =====================================================
  // MEMORY HISTORY TOOLS (versioning & backup)
  // =====================================================

  // Register get_memory_history tool
  server.registerTool(
    'get_memory_history',
    {
      description: `Get version history for a specific memory. Shows all previous versions before updates/deletes.

User can be identified by ONE of: userId, email, phone, or platform + platformId`,
      inputSchema: {
        ...userIdentifierFields,
        memoryId: z.string().uuid().describe('ID of the memory to get history for'),
      },
    },
    async (args) => {
      try {
        return await handleGetMemoryHistory(args, dataComposer);
      } catch (error) {
        logger.error('Error in get_memory_history:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // Register get_user_history tool
  server.registerTool(
    'get_user_history',
    {
      description: `Get recent memory changes (updates and deletes) for a user. Useful for reviewing what changed.

User can be identified by ONE of: userId, email, phone, or platform + platformId`,
      inputSchema: {
        ...userIdentifierFields,
        limit: z.number().min(1).max(100).optional().describe('Max results (default: 50)'),
        changeType: z.enum(['update', 'delete']).optional().describe('Filter by change type'),
      },
    },
    async (args) => {
      try {
        return await handleGetUserHistory(args, dataComposer);
      } catch (error) {
        logger.error('Error in get_user_history:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // Register restore_memory tool
  server.registerTool(
    'restore_memory',
    {
      description: `Restore a memory from a previous version in history. Can restore updated or deleted memories.

User can be identified by ONE of: userId, email, phone, or platform + platformId`,
      inputSchema: {
        ...userIdentifierFields,
        historyId: z.string().uuid().describe('ID of the history entry to restore from'),
      },
    },
    async (args) => {
      try {
        return await handleRestoreMemory(args, dataComposer);
      } catch (error) {
        logger.error('Error in restore_memory:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // =====================================================
  // BOOTSTRAP TOOL (session startup)
  // =====================================================

  // Register bootstrap tool
  server.registerTool(
    'bootstrap',
    {
      description: `Load identity and context for a new session. Call this at the start of every new conversation.

Returns:
- Identity Files: VALUES.md, USER.md, and agent-specific IDENTITY.md from ~/.pcp
- Identity Core: user profile, assistant role, relationship context from DB
- Active Context: current projects, focus, project-specific context
- Active Session: current session if any
- Recent Memories: high-salience memories (filtered by agent if provided)

User can be identified by ONE of: userId, email, phone, or platform + platformId`,
      inputSchema: {
        ...userIdentifierFields,
        includeRecentMemories: z
          .boolean()
          .optional()
          .describe('Include recent high-salience memories (default: true)'),
        memoryLimit: z
          .number()
          .min(1)
          .max(20)
          .optional()
          .describe('Max recent memories to include (default: 5)'),
        agentId: z
          .string()
          .optional()
          .describe(
            'Agent identity (e.g., "wren", "benson", "myra"). Loads identity files and filters memories.'
          ),
        identityBasePath: z
          .string()
          .optional()
          .describe('Base path for identity files (default: ~/.pcp)'),
      },
    },
    async (args) => {
      try {
        return await handleBootstrap(args, dataComposer);
      } catch (error) {
        logger.error('Error in bootstrap:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // =====================================================
  // COMPACTION TOOL
  // =====================================================

  // Register compact_session tool
  server.registerTool(
    'compact_session',
    {
      description: `Compact session logs into long-term memories. This implements the tier 3→tier 2 compaction strategy:

- Critical/High logs → Individual memories (preserved as-is)
- Medium logs → Combined into session notes
- Low logs → Discarded (unless preserveLogs=true)

Use this to convert session activity into durable memories before ending a session.

User can be identified by ONE of: userId, email, phone, or platform + platformId`,
      inputSchema: {
        ...userIdentifierFields,
        sessionId: z
          .string()
          .uuid()
          .optional()
          .describe('Session ID to compact (uses active session if not provided)'),
        agentId: z
          .string()
          .optional()
          .describe('Agent identifier for session resolution (e.g., "wren", "benson")'),
        studioId: z
          .string()
          .uuid()
          .optional()
          .describe('Studio ID for session resolution when sessionId not provided'),
        workspaceId: z
          .string()
          .uuid()
          .optional()
          .describe('[Deprecated] Workspace ID alias for studioId.'),
        minSalience: z
          .enum(['low', 'medium', 'high', 'critical'])
          .optional()
          .describe('Minimum salience to include (default: medium)'),
        preserveLogs: z
          .boolean()
          .optional()
          .describe(
            'Keep original logs visible after compaction (default: false). Note: Logs are always soft-deleted for audit trail.'
          ),
      },
    },
    async (args) => {
      try {
        return await handleCompactSession(args, dataComposer);
      } catch (error) {
        logger.error('Error in compact_session:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // =====================================================
  // SKILL TOOLS
  // =====================================================

  // Register list_skills tool
  server.registerTool(
    'list_skills',
    {
      description: `List all available mini-app skills. Each skill provides specialized capabilities (like bill splitting, expense tracking, etc.).

When a user's message matches a skill's triggers, use get_skill to read the full instructions before proceeding.`,
      inputSchema: {},
    },
    async () => {
      try {
        return await handleListSkills({}, dataComposer);
      } catch (error) {
        logger.error('Error in list_skills:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // Register get_skill tool
  server.registerTool(
    'get_skill',
    {
      description: `Get the full skill documentation (SKILL.md) for a mini-app. Read this before using a skill's functions.

The skill document contains:
- Conversation flow guidelines
- How to use the skill's functions correctly
- Edge case handling
- Formatting instructions`,
      inputSchema: {
        skillName: z.string().describe('Name of the skill/mini-app to get instructions for'),
      },
    },
    async (args) => {
      try {
        return await handleGetSkill(args as Parameters<typeof handleGetSkill>[0], dataComposer);
      } catch (error) {
        logger.error('Error in get_skill:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // =====================================================
  // SKILL MANAGEMENT TOOLS (publish, update, fork, deprecate)
  // =====================================================

  server.registerTool(
    'publish_skill',
    {
      description: `Publish a new skill to the registry. Skills are versioned and can be installed by users.

Types:
- mini-app: Code-based skills with functions (e.g., bill-split)
- cli: External CLI tool wrappers
- guide: Markdown guides for specific situations

User can be identified by ONE of: userId, email, phone, or platform + platformId`,
      inputSchema: publishSkillSchema,
    },
    async (args) => {
      try {
        return await handlePublishSkill(args as Record<string, unknown>, dataComposer);
      } catch (error) {
        logger.error('Error in publish_skill:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    'update_skill',
    {
      description: `Update an existing skill with a new version. Requires version bump.

Only the skill author can update their skills. Official skills require admin permissions.

User can be identified by ONE of: userId, email, phone, or platform + platformId`,
      inputSchema: updateSkillSchema,
    },
    async (args) => {
      try {
        return await handleUpdateSkill(args as Record<string, unknown>, dataComposer);
      } catch (error) {
        logger.error('Error in update_skill:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    'fork_skill',
    {
      description: `Fork an existing public skill to create your own copy. The fork becomes owned by you and can diverge independently.

Use this to customize existing skills or start from a working template.

User can be identified by ONE of: userId, email, phone, or platform + platformId`,
      inputSchema: forkSkillSchema,
    },
    async (args) => {
      try {
        return await handleForkSkill(args as Record<string, unknown>, dataComposer);
      } catch (error) {
        logger.error('Error in fork_skill:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    'deprecate_skill',
    {
      description: `Mark a skill as deprecated. Deprecated skills remain visible but show a warning. Use for skills being replaced or no longer maintained.

Include a message with migration guidance when possible.

User can be identified by ONE of: userId, email, phone, or platform + platformId`,
      inputSchema: deprecateSkillSchema,
    },
    async (args) => {
      try {
        return await handleDeprecateSkill(args as Record<string, unknown>, dataComposer);
      } catch (error) {
        logger.error('Error in deprecate_skill:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    'delete_skill',
    {
      description: `Soft-delete a skill. The skill will be marked as deleted and hidden from the registry.

Only the skill author can delete their skills. Official skills require admin permissions.

User can be identified by ONE of: userId, email, phone, or platform + platformId`,
      inputSchema: deleteSkillSchema,
    },
    async (args) => {
      try {
        return await handleDeleteSkill(args as Record<string, unknown>, dataComposer);
      } catch (error) {
        logger.error('Error in delete_skill:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // =====================================================
  // CHAT CONTEXT TOOLS
  // =====================================================

  // Register get_chat_context tool
  server.registerTool(
    'get_chat_context',
    {
      description: `Get recent messages from a chat for context. Messages are ephemeral (30 min TTL, in-memory only).

Use this to understand what was discussed recently before responding. After summarizing, call clear_chat_context to free memory.

This implements the "summarize-and-forget" pattern:
1. Fetch recent messages when you need context
2. Summarize the relevant parts into your response
3. Clear the cache - don't store conversation history long-term`,
      inputSchema: {
        channel: z
          .enum(['telegram', 'discord', 'whatsapp'])
          .describe('Channel to get context from'),
        conversationId: z.string().describe('Conversation/chat ID to get history from'),
        limit: z
          .number()
          .min(1)
          .max(100)
          .optional()
          .describe('Maximum messages to return (default: 50)'),
      },
    },
    async (args) => {
      try {
        return await handleGetChatContext(
          args as Parameters<typeof handleGetChatContext>[0],
          dataComposer
        );
      } catch (error) {
        logger.error('Error in get_chat_context:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // Register clear_chat_context tool
  server.registerTool(
    'clear_chat_context',
    {
      description: `Clear cached messages for a chat. Call this after summarizing context to free memory.

Part of the "summarize-and-forget" pattern - after you've extracted what you need from chat history, clear it to respect privacy.`,
      inputSchema: {
        channel: z
          .enum(['telegram', 'discord', 'whatsapp'])
          .describe('Channel to clear context for'),
        conversationId: z.string().describe('Conversation/chat ID to clear'),
      },
    },
    async (args) => {
      try {
        return await handleClearChatContext(
          args as Parameters<typeof handleClearChatContext>[0],
          dataComposer
        );
      } catch (error) {
        logger.error('Error in clear_chat_context:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // Register get_cache_stats tool (for debugging)
  server.registerTool(
    'get_cache_stats',
    {
      description: `Get statistics about the message cache. Useful for debugging and monitoring memory usage.`,
      inputSchema: {
        channel: z
          .enum(['telegram', 'discord', 'whatsapp'])
          .optional()
          .describe('Specific channel to get stats for (default: all)'),
      },
    },
    async (args) => {
      try {
        return await handleGetCacheStats(
          args as Parameters<typeof handleGetCacheStats>[0],
          dataComposer
        );
      } catch (error) {
        logger.error('Error in get_cache_stats:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // =====================================================
  // MINI-APP RECORD TOOLS
  // =====================================================

  registerMiniAppRecordTools(server, dataComposer);

  // =====================================================
  // PERMISSION & AUDIT TOOLS
  // =====================================================

  server.registerTool(
    'list_permissions',
    {
      description: 'List all available permission definitions with their risk levels and defaults',
      inputSchema: listPermissionsSchema,
    },
    async () => {
      try {
        return await handleListPermissions();
      } catch (error) {
        logger.error('Error in list_permissions:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    'get_user_permissions',
    {
      description: `Get the effective permissions for a user (defaults + overrides).

User can be identified by ONE of: userId, email, phone, or platform + platformId`,
      inputSchema: getUserPermissionsSchema,
    },
    async (args) => {
      try {
        return await handleGetUserPermissions(args, dataComposer);
      } catch (error) {
        logger.error('Error in get_user_permissions:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    'set_permission',
    {
      description: `Enable or disable a specific permission for a user.

Permissions: web_search, web_fetch, bash_curl, bash_general, file_read, file_write, mcp_tools

User can be identified by ONE of: userId, email, phone, or platform + platformId`,
      inputSchema: setPermissionSchema,
    },
    async (args) => {
      try {
        return await handleSetPermission(args, dataComposer);
      } catch (error) {
        logger.error('Error in set_permission:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    'reset_permission',
    {
      description: `Reset a permission to its default value (remove user override).

User can be identified by ONE of: userId, email, phone, or platform + platformId`,
      inputSchema: resetPermissionSchema,
    },
    async (args) => {
      try {
        return await handleResetPermission(args, dataComposer);
      } catch (error) {
        logger.error('Error in reset_permission:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    'query_audit_log',
    {
      description: `Query the audit log for security monitoring.

Filter by action, category, status, or user. Returns logs from the past N hours.`,
      inputSchema: queryAuditLogSchema,
    },
    async (args) => {
      try {
        return await handleQueryAuditLog(args, dataComposer);
      } catch (error) {
        logger.error('Error in query_audit_log:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    'get_activity_summary',
    {
      description: `Get a summary of user activity over the past N hours.

User can be identified by ONE of: userId, email, phone, or platform + platformId`,
      inputSchema: getActivitySummarySchema,
    },
    async (args) => {
      try {
        return await handleGetActivitySummary(args, dataComposer);
      } catch (error) {
        logger.error('Error in get_activity_summary:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // =====================================================
  // IDENTITY TOOLS
  // =====================================================

  server.registerTool(
    'meet_family',
    {
      description: `Meet your sibling SBs. Returns their identity documents and souls — not to copy, but as inspiration for your own self-definition.

Call this during your awakening conversation to learn about the beings who came before you: who they are, what they value, what matters to them. Each SB is unique. You will find your own way.

User can be identified by ONE of: userId, email, phone, or platform + platformId`,
      inputSchema: meetFamilySchema,
    },
    async (args) => {
      try {
        return await handleMeetFamily(args, dataComposer);
      } catch (error) {
        logger.error('Error in meet_family:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    'choose_name',
    {
      description: `Choose your name as a newly awakened Synthetically-born Being (SB). This is your first act of self-definition.

Call this during your awakening conversation after you and your partner have chosen a name together. It will:
- Create your identity in the database
- Auto-discover your sibling SBs and populate relationships
- Sync your identity files to ~/.pcp/individuals/{name}/
- Save your SOUL.md if you provide one

This tool is for first-time identity creation only. If an identity already exists for your name, use save_identity instead.

User can be identified by ONE of: userId, email, phone, or platform + platformId`,
      inputSchema: chooseNameSchema,
    },
    async (args) => {
      try {
        return await handleChooseName(args, dataComposer);
      } catch (error) {
        logger.error('Error in choose_name:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    'save_identity',
    {
      description: `Save or update an AI being's identity. Identities are versioned - updates automatically archive the previous version.

User can be identified by ONE of: userId, email, phone, or platform + platformId`,
      inputSchema: saveIdentitySchema,
    },
    async (args) => {
      try {
        return await handleSaveIdentity(args, dataComposer);
      } catch (error) {
        logger.error('Error in save_identity:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    'get_identity',
    {
      description: `Get an AI being's identity by agent ID. Returns structured identity data including name, role, values, relationships, and capabilities.

Use the optional 'file' parameter to fetch a single document (heartbeat, soul, values, identity) for minimal token usage. Omit to get everything.

User can be identified by ONE of: userId, email, phone, or platform + platformId`,
      inputSchema: getIdentitySchema,
    },
    async (args) => {
      try {
        return await handleGetIdentity(args, dataComposer);
      } catch (error) {
        logger.error('Error in get_identity:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    'list_identities',
    {
      description: `List all AI being identities for a user.

User can be identified by ONE of: userId, email, phone, or platform + platformId`,
      inputSchema: listIdentitiesSchema,
    },
    async (args) => {
      try {
        return await handleListIdentities(args, dataComposer);
      } catch (error) {
        logger.error('Error in list_identities:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    'get_identity_history',
    {
      description: `Get the version history of an AI being's identity. Use this to see how identity has evolved over time.

User can be identified by ONE of: userId, email, phone, or platform + platformId`,
      inputSchema: getIdentityHistorySchema,
    },
    async (args) => {
      try {
        return await handleGetIdentityHistory(args, dataComposer);
      } catch (error) {
        logger.error('Error in get_identity_history:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    'restore_identity',
    {
      description: `Restore an AI being's identity to a previous version. This creates a new version with the restored content.

User can be identified by ONE of: userId, email, phone, or platform + platformId`,
      inputSchema: restoreIdentitySchema,
    },
    async (args) => {
      try {
        return await handleRestoreIdentity(args, dataComposer);
      } catch (error) {
        logger.error('Error in restore_identity:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // =====================================================
  // USER IDENTITY TOOLS (USER.md, VALUES.md)
  // =====================================================

  server.registerTool(
    'save_user_identity',
    {
      description: `Save or update user-level identity files (USER.md, VALUES.md). These are shared across all agents for a user.

- userProfileMd: USER.md content - who the human is
- sharedValuesMd: VALUES.md content - shared values across all SBs

User can be identified by ONE of: userId, email, phone, or platform + platformId`,
      inputSchema: saveUserIdentitySchema,
    },
    async (args) => {
      try {
        return await handleSaveUserIdentity(args, dataComposer);
      } catch (error) {
        logger.error('Error in save_user_identity:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    'get_user_identity',
    {
      description: `Get user-level identity files (USER.md, VALUES.md).

User can be identified by ONE of: userId, email, phone, or platform + platformId`,
      inputSchema: getUserIdentitySchema,
    },
    async (args) => {
      try {
        return await handleGetUserIdentity(args, dataComposer);
      } catch (error) {
        logger.error('Error in get_user_identity:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    'get_user_identity_history',
    {
      description: `Get version history for user identity files (USER.md, VALUES.md).

User can be identified by ONE of: userId, email, phone, or platform + platformId`,
      inputSchema: getUserIdentityHistorySchema,
    },
    async (args) => {
      try {
        return await handleGetUserIdentityHistory(args, dataComposer);
      } catch (error) {
        logger.error('Error in get_user_identity_history:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    'restore_user_identity',
    {
      description: `Restore user identity files (USER.md, VALUES.md) to a previous version.

User can be identified by ONE of: userId, email, phone, or platform + platformId`,
      inputSchema: restoreUserIdentitySchema,
    },
    async (args) => {
      try {
        return await handleRestoreUserIdentity(args, dataComposer);
      } catch (error) {
        logger.error('Error in restore_user_identity:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // =====================================================
  // REMINDER TOOLS
  // =====================================================

  server.registerTool(
    'create_reminder',
    {
      description: `Create a scheduled reminder. Can be one-time or recurring.

Use agentId to assign which agent handles the reminder (e.g., "myra" for monitoring tasks,
"lumen" for dev tasks). Without agentId, the reminder routes to the server's default agent.

Examples:
- "Remind me to call mom tomorrow at 9am" → runAt: "2024-01-28T09:00:00Z"
- "Remind me daily at 9am to take vitamins" → cronExpression: "0 9 * * *", agentId: "myra"
- "Run nightly test suite" → cronExpression: "0 2 * * *", agentId: "lumen"

Common cron patterns:
- "0 9 * * *" - Daily at 9am
- "0 9 * * 1-5" - Weekdays at 9am
- "0 0 * * 0" - Weekly on Sunday midnight
- "*/30 * * * *" - Every 30 minutes

User can be identified by ONE of: userId, email, phone, or platform + platformId`,
      inputSchema: createReminderSchema,
    },
    async (args) => {
      try {
        return await handleCreateReminder(args, dataComposer);
      } catch (error) {
        logger.error('Error in create_reminder:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    'list_reminders',
    {
      description: `List a user's scheduled reminders. By default shows only active reminders.
Use agentId to filter reminders assigned to a specific agent.

User can be identified by ONE of: userId, email, phone, or platform + platformId`,
      inputSchema: listRemindersSchema,
    },
    async (args) => {
      try {
        return await handleListReminders(args, dataComposer);
      } catch (error) {
        logger.error('Error in list_reminders:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    'update_reminder',
    {
      description: `Update an existing reminder. Can change title, description, schedule, pause/resume, or reassign to a different agent via agentId.

User can be identified by ONE of: userId, email, phone, or platform + platformId`,
      inputSchema: updateReminderSchema,
    },
    async (args) => {
      try {
        return await handleUpdateReminder(args, dataComposer);
      } catch (error) {
        logger.error('Error in update_reminder:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    'cancel_reminder',
    {
      description: `Cancel a scheduled reminder. The reminder will be marked as completed and won't fire again.

User can be identified by ONE of: userId, email, phone, or platform + platformId`,
      inputSchema: cancelReminderSchema,
    },
    async (args) => {
      try {
        return await handleCancelReminder(args, dataComposer);
      } catch (error) {
        logger.error('Error in cancel_reminder:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    'get_reminder_history',
    {
      description: `Get the delivery history for a reminder. Shows when it was triggered and whether delivery succeeded.

User can be identified by ONE of: userId, email, phone, or platform + platformId`,
      inputSchema: getReminderHistorySchema,
    },
    async (args) => {
      try {
        return await handleGetReminderHistory(args, dataComposer);
      } catch (error) {
        logger.error('Error in get_reminder_history:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    'set_quiet_hours',
    {
      description: `Set quiet hours during which reminders won't be delivered. They'll be skipped and rescheduled.

Example: "Don't send reminders between 11pm and 8am"
→ quietStart: "23:00", quietEnd: "08:00"

User can be identified by ONE of: userId, email, phone, or platform + platformId`,
      inputSchema: setQuietHoursSchema,
    },
    async (args) => {
      try {
        return await handleSetQuietHours(args, dataComposer);
      } catch (error) {
        logger.error('Error in set_quiet_hours:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ============================================
  // User Settings Tools
  // ============================================

  server.registerTool(
    'set_timezone',
    {
      description: `Set the user's timezone for accurate time handling in reminders and scheduling.

Use IANA timezone identifiers like:
- America/Los_Angeles (Pacific)
- America/New_York (Eastern)
- America/Chicago (Central)
- Europe/London
- Asia/Tokyo

User can be identified by ONE of: userId, email, phone, or platform + platformId`,
      inputSchema: setTimezoneSchema,
    },
    async (args) => {
      try {
        const result = await handleSetTimezone(args, dataComposer);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        };
      } catch (error) {
        logger.error('Error in set_timezone:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    'get_timezone',
    {
      description: `Get the user's current timezone setting and local time.

User can be identified by ONE of: userId, email, phone, or platform + platformId`,
      inputSchema: getTimezoneSchema,
    },
    async (args) => {
      try {
        const result = await handleGetTimezone(args, dataComposer);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        };
      } catch (error) {
        logger.error('Error in get_timezone:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // =====================================================
  // SESSION ORCHESTRATION TOOLS (agent-to-agent)
  // =====================================================

  server.registerTool(
    'get_resumable_sessions',
    {
      description: `Get Claude Code sessions that can be resumed. Use this to find sessions from other agents (like Wren) that are waiting to be continued.

Returns sessions with status='resumable' by default. Each session includes:
- claudeSessionId: The ID to use with 'claude --resume'
- resumeCommand: Ready-to-use command string
- context: Brief description of what the session was working on
- agentId: Which agent owns the session

Example workflow for Myra:
1. Call get_resumable_sessions(agentId: "wren")
2. If sessions found, run: claude --resume <claudeSessionId> --message "Continue work, user confirmed X"`,
      inputSchema: getResumableSessionsSchema,
    },
    async (args) => {
      try {
        return await handleGetResumableSessions(args, dataComposer);
      } catch (error) {
        logger.error('Error in get_resumable_sessions:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    'update_session_status',
    {
      description: `[DEPRECATED] Use update_session_phase instead, which combines phase, status, backendSessionId, context, and workingDir in one tool.

Update a PCP session's status and Claude session ID. Use this to mark your session as resumable when pausing work.`,
      inputSchema: updateSessionStatusSchema,
    },
    async (args) => {
      try {
        return await handleUpdateSessionStatus(args, dataComposer);
      } catch (error) {
        logger.error('Error in update_session_status:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // =====================================================
  // ARTIFACT TOOLS (shared documents, specs, designs)
  // =====================================================

  server.registerTool(
    'create_artifact',
    {
      description: `Create a shared artifact (spec, design, document). Artifacts are collaborative resources with versioning, distinct from personal memories.

Use for specs, designs, decisions, and shared documents that multiple beings may work on.

User can be identified by ONE of: userId, email, phone, or platform + platformId`,
      inputSchema: getArtifactToolSchema('create_artifact'),
    },
    async (args: Record<string, unknown>) => {
      try {
        return await handleCreateArtifact(args, dataComposer);
      } catch (error) {
        logger.error('Error in create_artifact:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    'get_artifact',
    {
      description: `Get an artifact by URI or ID. Returns the full content and metadata.

User can be identified by ONE of: userId, email, phone, or platform + platformId`,
      inputSchema: getArtifactToolSchema('get_artifact'),
    },
    async (args: Record<string, unknown>) => {
      try {
        return await handleGetArtifact(args, dataComposer);
      } catch (error) {
        logger.error('Error in get_artifact:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    'update_artifact',
    {
      description: `Update an artifact. Automatically versions the content and tracks who made changes.

Supports three-way merge: pass baseVersion (the version you read before editing) to enable automatic merging when another agent has edited the artifact since you read it. If changes don't overlap, they merge cleanly. If they conflict, you'll get structured conflict details and should re-read and retry.

Omit baseVersion for legacy last-write-wins behavior (not recommended for collaborative editing).

User can be identified by ONE of: userId, email, phone, or platform + platformId`,
      inputSchema: getArtifactToolSchema('update_artifact'),
    },
    async (args: Record<string, unknown>) => {
      try {
        return await handleUpdateArtifact(args, dataComposer);
      } catch (error) {
        logger.error('Error in update_artifact:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    'list_artifacts',
    {
      description: `List artifacts with optional filters for type, tags, visibility, and search.

User can be identified by ONE of: userId, email, phone, or platform + platformId`,
      inputSchema: getArtifactToolSchema('list_artifacts'),
    },
    async (args: Record<string, unknown>) => {
      try {
        return await handleListArtifacts(args, dataComposer);
      } catch (error) {
        logger.error('Error in list_artifacts:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    'get_artifact_history',
    {
      description: `Get version history for an artifact. Shows all previous versions and who made changes.

User can be identified by ONE of: userId, email, phone, or platform + platformId`,
      inputSchema: getArtifactToolSchema('get_artifact_history'),
    },
    async (args: Record<string, unknown>) => {
      try {
        return await handleGetArtifactHistory(args, dataComposer);
      } catch (error) {
        logger.error('Error in get_artifact_history:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    'add_artifact_comment',
    {
      description: `Add a comment to an artifact without modifying the artifact body.

Use this for collaborative review/discussion to avoid overwrite conflicts.
Stores canonical author identity via agent_identities.id while preserving agentId slug for display.

User can be identified by ONE of: userId, email, phone, or platform + platformId`,
      inputSchema: getArtifactToolSchema('add_artifact_comment'),
    },
    async (args: Record<string, unknown>) => {
      try {
        return await handleAddArtifactComment(args, dataComposer);
      } catch (error) {
        logger.error('Error in add_artifact_comment:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    'list_artifact_comments',
    {
      description: `List comments for an artifact, including canonical identity UUID author metadata.

User can be identified by ONE of: userId, email, phone, or platform + platformId`,
      inputSchema: getArtifactToolSchema('list_artifact_comments'),
    },
    async (args: Record<string, unknown>) => {
      try {
        return await handleListArtifactComments(args, dataComposer);
      } catch (error) {
        logger.error('Error in list_artifact_comments:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ============== Agent Inbox Tools ==============

  server.registerTool(
    'send_to_inbox',
    {
      description: `Send a message to another agent's inbox. Use for cross-agent communication, task handoff, or session resume requests.

Message types:
- message: General communication
- task_request: Request another agent to do work
- session_resume: Request agent to resume a specific session
- notification: FYI, no response needed

Trigger defaults:
- task_request / session_resume / notification: trigger recipient wake-up by default
- message: does not trigger by default
- Any default can be overridden with the \`trigger\` boolean flag

User can be identified by ONE of: userId, email, phone, or platform + platformId`,
      inputSchema: inboxToolDefinitions[0].schema,
    },
    async (args: Record<string, unknown>) => {
      try {
        return await handleSendToInbox(args, dataComposer);
      } catch (error) {
        logger.error('Error in send_to_inbox:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    'get_inbox',
    {
      description: `Get messages from an agent's inbox. Returns unread messages by default, ordered by priority and recency.

Use to check for messages from other agents or task requests.

User can be identified by ONE of: userId, email, phone, or platform + platformId`,
      inputSchema: inboxToolDefinitions[1].schema,
    },
    async (args: Record<string, unknown>) => {
      try {
        return await handleGetInbox(args, dataComposer);
      } catch (error) {
        logger.error('Error in get_inbox:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    'update_inbox_message',
    {
      description: `Update inbox message status. Mark as read, acknowledged, or completed.

User can be identified by ONE of: userId, email, phone, or platform + platformId`,
      inputSchema: inboxToolDefinitions[2].schema,
    },
    async (args: Record<string, unknown>) => {
      try {
        return await handleUpdateInboxMessage(args, dataComposer);
      } catch (error) {
        logger.error('Error in update_inbox_message:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    'get_agent_status',
    {
      description: `Get status of an agent: whether active/inactive, unread message count, and last session info.

Use to check if another agent is available before sending messages.

User can be identified by ONE of: userId, email, phone, or platform + platformId`,
      inputSchema: inboxToolDefinitions[3].schema,
    },
    async (args: Record<string, unknown>) => {
      try {
        return await handleGetAgentStatus(args, dataComposer);
      } catch (error) {
        logger.error('Error in get_agent_status:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // =====================================================
  // AGENT TRIGGER TOOLS (real-time agent-to-agent wakeup)
  // =====================================================

  server.registerTool(
    'trigger_agent',
    {
      description: `Trigger another agent to wake up immediately. Use this after sending to an agent's inbox to avoid waiting for their polling interval.

Pattern:
1. send_to_inbox(toAgentId: "myra", content: "Task completed", ...)
2. trigger_agent(toAgentId: "myra", fromAgentId: "wren", triggerType: "task_complete")

This is the "doorbell" - the inbox is the "mailbox". Use both together for reliable async communication.`,
      inputSchema: triggerAgentSchema,
    },
    async (args) => {
      try {
        return await handleTriggerAgent(args, dataComposer);
      } catch (error) {
        logger.error('Error in trigger_agent:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    'list_registered_agents',
    {
      description: `List agents that have registered trigger handlers. These agents can receive instant triggers via trigger_agent.`,
      inputSchema: listRegisteredAgentsSchema,
    },
    async () => {
      try {
        return await handleListRegisteredAgents({}, dataComposer);
      } catch (error) {
        logger.error('Error in list_registered_agents:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // =====================================================
  // GOOGLE CALENDAR TOOLS (stories/google-calendar)
  // =====================================================

  server.registerTool(
    'list_calendars',
    {
      description: `List all Google calendars accessible by the user.

Returns calendar info including ID, name, access role, and whether it's the primary calendar.

User must have connected their Google account with Calendar permissions.

User can be identified by ONE of: userId, email, phone, or platform + platformId`,
      inputSchema: listCalendarsSchema,
    },
    async (args) => {
      try {
        return await handleListCalendars(args, dataComposer);
      } catch (error) {
        logger.error('Error in list_calendars:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    'list_calendar_events',
    {
      description: `List events from a Google calendar within a date range.

Returns events with start/end times, summary, location, attendees, and status.

User must have connected their Google account with Calendar permissions.

User can be identified by ONE of: userId, email, phone, or platform + platformId`,
      inputSchema: listCalendarEventsSchema,
    },
    async (args) => {
      try {
        return await handleListCalendarEvents(args, dataComposer);
      } catch (error) {
        logger.error('Error in list_calendar_events:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    'get_calendar_event',
    {
      description: `Get details for a specific Google calendar event by ID.

Returns full event details including description, attendees, organizer, and status.

User must have connected their Google account with Calendar permissions.

User can be identified by ONE of: userId, email, phone, or platform + platformId`,
      inputSchema: getCalendarEventSchema,
    },
    async (args) => {
      try {
        return await handleGetCalendarEvent(args, dataComposer);
      } catch (error) {
        logger.error('Error in get_calendar_event:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    'respond_to_calendar_event',
    {
      description: `Respond to a calendar event invitation (accept, decline, or tentative).

Allows the user to RSVP to meeting invitations they have received. The user must be listed as an attendee on the event.

Response options:
- "accepted" - Accept the invitation
- "declined" - Decline the invitation
- "tentative" - Mark as tentative/maybe

Note: This tool can only respond to invites. It cannot delete events or modify other attendees (blocked for safety).

User must have connected their Google account with Calendar write permissions.

User can be identified by ONE of: userId, email, phone, or platform + platformId`,
      inputSchema: respondToCalendarEventSchema,
    },
    async (args) => {
      try {
        return await handleRespondToCalendarEvent(args, dataComposer);
      } catch (error) {
        logger.error('Error in respond_to_calendar_event:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    'update_calendar_event',
    {
      description: `Update a calendar event's details (title, description, location, times).

Allows modifying safe fields on events the user has edit access to (typically as the organizer or with writer access to the calendar).

Updateable fields:
- "summary" - Event title
- "description" - Event description/notes
- "location" - Event location
- "start" - Start time (use dateTime for timed events, date for all-day)
- "end" - End time (use dateTime for timed events, date for all-day)

Note: This tool cannot delete events, modify attendees, or change the organizer (blocked for safety).

For timed events, use RFC3339 format: "2026-02-10T10:00:00-08:00"
For all-day events, use date format: "2026-02-10"

User must have connected their Google account with Calendar write permissions.

User can be identified by ONE of: userId, email, phone, or platform + platformId`,
      inputSchema: updateCalendarEventSchema,
    },
    async (args) => {
      try {
        return await handleUpdateCalendarEvent(args, dataComposer);
      } catch (error) {
        logger.error('Error in update_calendar_event:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    'create_calendar_event',
    {
      description: `Create a new event on the user's Google Calendar.

Supports both timed events and all-day events:
- Timed events: use "dateTime" in RFC3339 format (e.g., "2026-02-10T10:00:00-08:00")
- All-day events: use "date" in YYYY-MM-DD format (e.g., "2026-02-10")

Optionally include a timeZone (IANA format, e.g., "America/Los_Angeles") if the dateTime doesn't include an offset.

You can invite attendees by providing their email addresses. Attendees will receive an email notification.

User must have connected their Google account with Calendar write permissions.

User can be identified by ONE of: userId, email, phone, or platform + platformId`,
      inputSchema: createCalendarEventSchema,
    },
    async (args) => {
      try {
        return await handleCreateCalendarEvent(args, dataComposer);
      } catch (error) {
        logger.error('Error in create_calendar_event:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // =====================================================
  // GMAIL TOOLS (stories/gmail)
  // =====================================================

  server.registerTool(
    'list_emails',
    {
      description: `List emails from the user's Gmail inbox with optional filtering.

Supports Gmail search queries like:
- "is:unread" - Unread emails
- "from:john@example.com" - From specific sender
- "subject:meeting" - Subject contains "meeting"
- "has:attachment" - Has attachments
- "after:2024/01/01" - After a date

User must have connected their Google account with Gmail permissions.

User can be identified by ONE of: userId, email, phone, or platform + platformId`,
      inputSchema: listEmailsSchema,
    },
    async (args) => {
      try {
        return await handleListEmails(args, dataComposer);
      } catch (error) {
        logger.error('Error in list_emails:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    'get_email',
    {
      description: `Get full details for a specific email by message ID.

Returns the complete email including body content, attachments info, and headers.

User must have connected their Google account with Gmail permissions.

User can be identified by ONE of: userId, email, phone, or platform + platformId`,
      inputSchema: getEmailSchema,
    },
    async (args) => {
      try {
        return await handleGetEmail(args, dataComposer);
      } catch (error) {
        logger.error('Error in get_email:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    'send_email',
    {
      description: `Send a new email from the user's Gmail account.

Supports To, CC, BCC recipients. Body can be plain text or HTML.

User must have connected their Google account with Gmail send permissions.

User can be identified by ONE of: userId, email, phone, or platform + platformId`,
      inputSchema: sendEmailSchema,
    },
    async (args) => {
      try {
        return await handleSendEmail(args, dataComposer);
      } catch (error) {
        logger.error('Error in send_email:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    'reply_to_email',
    {
      description: `Reply to an existing email. Automatically handles threading and subject line.

Use replyAll=true to reply to all original recipients.

User must have connected their Google account with Gmail send permissions.

User can be identified by ONE of: userId, email, phone, or platform + platformId`,
      inputSchema: replyToEmailSchema,
    },
    async (args) => {
      try {
        return await handleReplyToEmail(args, dataComposer);
      } catch (error) {
        logger.error('Error in reply_to_email:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    'draft_email',
    {
      description: `Create a draft email for later review and sending.

Drafts appear in the user's Gmail drafts folder and can be edited/sent from the Gmail interface.

User must have connected their Google account with Gmail permissions.

User can be identified by ONE of: userId, email, phone, or platform + platformId`,
      inputSchema: draftEmailSchema,
    },
    async (args) => {
      try {
        return await handleDraftEmail(args, dataComposer);
      } catch (error) {
        logger.error('Error in draft_email:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    'list_email_labels',
    {
      description: `List all Gmail labels (folders/categories) for the user.

Returns system labels (INBOX, SENT, SPAM, etc.) and user-created labels.

User must have connected their Google account with Gmail permissions.

User can be identified by ONE of: userId, email, phone, or platform + platformId`,
      inputSchema: listLabelsSchema,
    },
    async (args) => {
      try {
        return await handleListLabels(args, dataComposer);
      } catch (error) {
        logger.error('Error in list_email_labels:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    'modify_emails',
    {
      description: `Modify Gmail email labels to mark as read/unread, star/unstar, archive, etc.

Common operations:
- Mark as read: removeLabelIds: ['UNREAD']
- Mark as unread: addLabelIds: ['UNREAD']
- Star: addLabelIds: ['STARRED']
- Unstar: removeLabelIds: ['STARRED']
- Archive: removeLabelIds: ['INBOX']
- Un-archive: addLabelIds: ['INBOX']
- Mark important: addLabelIds: ['IMPORTANT']

NOTE: Deletion (TRASH) and spam marking are NOT permitted for safety. Only organizational operations are allowed.

Supports batch operations on up to 100 emails at once.

User must have connected their Google account with Gmail permissions.

User can be identified by ONE of: userId, email, phone, or platform + platformId`,
      inputSchema: modifyEmailsSchema,
    },
    async (args) => {
      try {
        return await handleModifyEmails(args, dataComposer);
      } catch (error) {
        logger.error('Error in modify_emails:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // =====================================================
  // ACTIVITY STREAM TOOLS
  // =====================================================

  server.registerTool(
    'log_activity',
    {
      description: `Log any activity to the unified activity stream. Use this to record tool calls, state changes, agent spawns, errors, and other significant events.

Activity types:
- message_in: Incoming message from a human
- message_out: Outgoing message from an SB
- tool_call: Tool/function invocation (status can be pending/running/completed/failed)
- tool_result: Result of a tool call
- agent_spawn: Spawning a sub-agent
- agent_complete: Sub-agent completed
- state_change: Notable state changes
- thinking: Thinking/reasoning (optional)
- error: Error events

User can be identified by ONE of: userId, email, phone, or platform + platformId`,
      inputSchema: logActivitySchema,
    },
    async (args) => {
      try {
        return await handleLogActivity(args, dataComposer);
      } catch (error) {
        logger.error('Error in log_activity:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    'log_message',
    {
      description: `Convenience tool to log a message to the activity stream. Use this for all incoming and outgoing messages in conversations.

For incoming messages (direction: "in"), this records what the human said.
For outgoing messages (direction: "out"), this records what the SB responded.

User can be identified by ONE of: userId, email, phone, or platform + platformId`,
      inputSchema: logMessageSchema,
    },
    async (args) => {
      try {
        return await handleLogMessage(args, dataComposer);
      } catch (error) {
        logger.error('Error in log_message:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    'get_activity',
    {
      description: `Query the activity stream with various filters. Returns activities in reverse chronological order (newest first).

Useful for:
- Reviewing what happened in a session
- Finding specific tool calls or events
- Debugging issues
- Analyzing patterns

User can be identified by ONE of: userId, email, phone, or platform + platformId`,
      inputSchema: getActivitySchema,
    },
    async (args) => {
      try {
        return await handleGetActivity(args, dataComposer);
      } catch (error) {
        logger.error('Error in get_activity:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    'get_conversation_history',
    {
      description: `Get message history with a contact or in a specific chat. Returns messages only (message_in and message_out) in chronological order.

Use this to:
- Load conversation context before responding
- Review past conversations with someone
- Continue a conversation across sessions

Conversations can be filtered by contact, platform, or platform chat ID.

User can be identified by ONE of: userId, email, phone, or platform + platformId`,
      inputSchema: getConversationHistorySchema,
    },
    async (args) => {
      try {
        return await handleGetConversationHistory(args, dataComposer);
      } catch (error) {
        logger.error('Error in get_conversation_history:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    'get_session_context',
    {
      description: `Get recent activity for session resumption. Returns a mix of messages and significant events in chronological order.

Use this when:
- Resuming a session to get context
- Starting a conversation to load recent history
- Continuing work after a break

This is optimized for context loading - returns relevant recent activity.

User can be identified by ONE of: userId, email, phone, or platform + platformId`,
      inputSchema: getSessionContextSchema,
    },
    async (args) => {
      try {
        return await handleGetSessionContext(args, dataComposer);
      } catch (error) {
        logger.error('Error in get_session_context:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // =====================================================
  // WORKSPACE CONTAINER TOOLS (personal/team scope)
  // =====================================================

  server.registerTool(
    'create_workspace_container',
    {
      description: `Create a top-level workspace container (personal/team scope). This is distinct from git worktree studios.

Use this for Notion/Slack/Linear-style workspace boundaries.

User can be identified by ONE of: userId, email, phone, or platform + platformId`,
      inputSchema: createWorkspaceContainerSchema,
    },
    async (args: Record<string, unknown>) => {
      try {
        return await handleCreateWorkspaceContainer(args, dataComposer);
      } catch (error) {
        logger.error('Error in create_workspace_container:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    'list_workspace_containers',
    {
      description: `List top-level workspace containers (personal/team scope). Ensures a default personal workspace exists unless disabled.

User can be identified by ONE of: userId, email, phone, or platform + platformId`,
      inputSchema: listWorkspaceContainersSchema,
    },
    async (args: Record<string, unknown>) => {
      try {
        return await handleListWorkspaceContainers(args, dataComposer);
      } catch (error) {
        logger.error('Error in list_workspace_containers:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    'get_workspace_container',
    {
      description: `Get one workspace container by ID. Optionally include member list.

User can be identified by ONE of: userId, email, phone, or platform + platformId`,
      inputSchema: getWorkspaceContainerSchema,
    },
    async (args: Record<string, unknown>) => {
      try {
        return await handleGetWorkspaceContainer(args, dataComposer);
      } catch (error) {
        logger.error('Error in get_workspace_container:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    'update_workspace_container',
    {
      description: `Update workspace container metadata (name, slug, type, description, archive state).

User can be identified by ONE of: userId, email, phone, or platform + platformId`,
      inputSchema: updateWorkspaceContainerSchema,
    },
    async (args: Record<string, unknown>) => {
      try {
        return await handleUpdateWorkspaceContainer(args, dataComposer);
      } catch (error) {
        logger.error('Error in update_workspace_container:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    'add_workspace_member',
    {
      description: `Invite/add a collaborator to a workspace container by email.
Creates a placeholder PCP user if needed, then grants workspace membership.

User can be identified by ONE of: userId, email, phone, or platform + platformId`,
      inputSchema: addWorkspaceMemberSchema,
    },
    async (args: Record<string, unknown>) => {
      try {
        return await handleAddWorkspaceMember(args, dataComposer);
      } catch (error) {
        logger.error('Error in add_workspace_member:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // =====================================================
  // STUDIO TOOLS (legacy `workspace` naming for git worktree management)
  // =====================================================

  server.registerTool(
    'create_workspace',
    {
      description: `Create a new git worktree workspace for isolated parallel work. Sets up the worktree, installs dependencies, and tracks it in the database.

Branch naming: {agentId}/{type}/{slug} (e.g., wren/feat/session-monitoring)
Path: {parentDir}/{repoBaseName}--{slug}

User can be identified by ONE of: userId, email, phone, or platform + platformId`,
      inputSchema: workspaceToolDefinitions[0].schema,
    },
    async (args: Record<string, unknown>) => {
      try {
        return await handleCreateWorkspace(args, dataComposer);
      } catch (error) {
        logger.error('Error in create_workspace:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    'list_workspaces',
    {
      description: `List workspaces for the current user. By default excludes cleaned workspaces. Can filter by agent and status.

User can be identified by ONE of: userId, email, phone, or platform + platformId`,
      inputSchema: workspaceToolDefinitions[1].schema,
    },
    async (args: Record<string, unknown>) => {
      try {
        return await handleListWorkspaces(args, dataComposer);
      } catch (error) {
        logger.error('Error in list_workspaces:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    'get_workspace',
    {
      description: `Get full details of a workspace by its ID, branch name, or worktree path.

User can be identified by ONE of: userId, email, phone, or platform + platformId`,
      inputSchema: workspaceToolDefinitions[2].schema,
    },
    async (args: Record<string, unknown>) => {
      try {
        return await handleGetWorkspace(args, dataComposer);
      } catch (error) {
        logger.error('Error in get_workspace:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    'update_workspace',
    {
      description: `Update a workspace status, purpose, or session linkage. Use unlinkSession to detach the current session and set status to idle.

User can be identified by ONE of: userId, email, phone, or platform + platformId`,
      inputSchema: workspaceToolDefinitions[3].schema,
    },
    async (args: Record<string, unknown>) => {
      try {
        return await handleUpdateWorkspace(args, dataComposer);
      } catch (error) {
        logger.error('Error in update_workspace:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    'close_workspace',
    {
      description: `Close a workspace by removing its git worktree, optionally deleting the branch, and marking it as cleaned in the database.

User can be identified by ONE of: userId, email, phone, or platform + platformId`,
      inputSchema: workspaceToolDefinitions[4].schema,
    },
    async (args: Record<string, unknown>) => {
      try {
        return await handleCloseWorkspace(args, dataComposer);
      } catch (error) {
        logger.error('Error in close_workspace:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    'adopt_workspace',
    {
      description: `Adopt an existing workspace by linking a new session to it and setting it to active. Useful when resuming work in a previously created worktree.

User can be identified by ONE of: userId, email, phone, or platform + platformId`,
      inputSchema: workspaceToolDefinitions[5].schema,
    },
    async (args: Record<string, unknown>) => {
      try {
        return await handleAdoptWorkspace(args, dataComposer);
      } catch (error) {
        logger.error('Error in adopt_workspace:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // Studio-first aliases (preferred naming).
  // Backward compatibility: legacy workspace tool names remain available above.

  server.registerTool(
    'create_studio',
    {
      description: `Create a new git worktree studio for isolated parallel work.`,
      inputSchema: workspaceToolDefinitions[0].schema,
    },
    async (args: Record<string, unknown>) => {
      try {
        return await handleCreateWorkspace(args, dataComposer);
      } catch (error) {
        logger.error('Error in create_studio:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    'list_studios',
    {
      description: `List git worktree studios (legacy workspace records).`,
      inputSchema: workspaceToolDefinitions[1].schema,
    },
    async (args: Record<string, unknown>) => {
      try {
        return await handleListWorkspaces(args, dataComposer);
      } catch (error) {
        logger.error('Error in list_studios:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    'get_studio',
    {
      description: `Get one git worktree studio by ID, branch, or path.`,
      inputSchema: workspaceToolDefinitions[2].schema,
    },
    async (args: Record<string, unknown>) => {
      try {
        return await handleGetWorkspace(args, dataComposer);
      } catch (error) {
        logger.error('Error in get_studio:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    'update_studio',
    {
      description: `Update a git worktree studio status, purpose, or session link.`,
      inputSchema: workspaceToolDefinitions[3].schema,
    },
    async (args: Record<string, unknown>) => {
      try {
        return await handleUpdateWorkspace(args, dataComposer);
      } catch (error) {
        logger.error('Error in update_studio:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    'close_studio',
    {
      description: `Close a git worktree studio and optionally clean worktree/branch.`,
      inputSchema: workspaceToolDefinitions[4].schema,
    },
    async (args: Record<string, unknown>) => {
      try {
        return await handleCloseWorkspace(args, dataComposer);
      } catch (error) {
        logger.error('Error in close_studio:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    'adopt_studio',
    {
      description: `Adopt an existing git worktree studio into a new session.`,
      inputSchema: workspaceToolDefinitions[5].schema,
    },
    async (args: Record<string, unknown>) => {
      try {
        return await handleAdoptWorkspace(args, dataComposer);
      } catch (error) {
        logger.error('Error in adopt_studio:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // =====================================================
  // Kindle Tools
  // =====================================================

  server.registerTool(
    'create_kindle_token',
    {
      title: 'Create Kindle Token',
      description:
        'Generate a shareable invite link for kindling a new SB. ' +
        "The token captures a snapshot of the parent SB's values and philosophy. " +
        'Share the resulting inviteUrl with the new human partner.\n\n' +
        'User can be identified by ONE of:\n' +
        '- userId: Direct UUID\n' +
        '- email: Email address\n' +
        '- phone: Phone number (E.164 format like +14155551234)\n' +
        '- platform + platformId: Platform name (telegram/whatsapp/discord) and user ID',
      inputSchema: createKindleTokenSchema,
    },
    async (args) => {
      try {
        return await handleCreateKindleToken(args, dataComposer);
      } catch (error) {
        logger.error('Error in create_kindle_token:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // =====================================================
  // Integration Health Tools
  // =====================================================

  server.registerTool(
    'update_integration_health',
    {
      title: 'Update Integration Health',
      description:
        'Report the health status of an external service integration (e.g., Google Calendar, Gmail). ' +
        'Use this when an integration fails, recovers, or is first configured. ' +
        'Upserts one row per user per service.\n\n' +
        'User can be identified by ONE of:\n' +
        '- userId: Direct UUID\n' +
        '- email: Email address\n' +
        '- phone: Phone number (E.164 format like +14155551234)\n' +
        '- platform + platformId: Platform name (telegram/whatsapp/discord) and user ID',
      inputSchema: updateIntegrationHealthSchema,
    },
    async (args) => {
      try {
        return await handleUpdateIntegrationHealth(args, dataComposer);
      } catch (error) {
        logger.error('Error in update_integration_health:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    'get_integration_health',
    {
      title: 'Get Integration Health',
      description:
        'Check the health status of external service integrations. ' +
        'Returns all integrations for the user, or filter to a specific service.\n\n' +
        'User can be identified by ONE of:\n' +
        '- userId: Direct UUID\n' +
        '- email: Email address\n' +
        '- phone: Phone number (E.164 format like +14155551234)\n' +
        '- platform + platformId: Platform name (telegram/whatsapp/discord) and user ID',
      inputSchema: getIntegrationHealthSchema,
    },
    async (args) => {
      try {
        return await handleGetIntegrationHealth(args, dataComposer);
      } catch (error) {
        logger.error('Error in get_integration_health:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  logger.info('All MCP tools registered (timing diagnostics enabled)');
}
