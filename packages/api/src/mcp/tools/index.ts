import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { DataComposer } from '../../data/composer';
import { logger } from '../../utils/logger';

// Import all tool handlers
import {
  handleSaveLink,
  handleSearchLinks,
  handleTagLink,
} from './link-handlers';

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

import {
  handleSendResponse,
  handleGetPendingMessages,
  handleMarkRead,
} from './response-handlers';

// Re-export for external use
export { setResponseCallback, addPendingMessage } from './response-handlers';

// Shared schema for flexible user identification
// Users can be identified by: userId, email, phone, or platform+platformId
const userIdentifierFields = {
  userId: z.string().uuid().optional().describe('User UUID (if known)'),
  email: z.string().email().optional().describe('User email address'),
  phone: z.string().optional().describe('Phone number in E.164 format (e.g., +14155551234)'),
  platform: z.enum(['telegram', 'whatsapp', 'discord']).optional().describe('Platform name for lookup'),
  platformId: z.string().optional().describe('Platform-specific user ID or username'),
};

export function registerAllTools(server: McpServer, dataComposer: DataComposer): void {
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
        source: z.enum(['telegram', 'whatsapp', 'discord', 'api']).optional().describe('Source platform'),
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
        contextType: z.enum(['user', 'assistant', 'project', 'session', 'relationship']).describe('Type of context'),
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
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: error instanceof Error ? error.message : 'Unknown error' }) }],
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
        contextType: z.enum(['user', 'assistant', 'project', 'session', 'relationship']).optional().describe('Filter by type'),
        contextKey: z.string().optional().describe('Filter by key'),
      },
    },
    async (args) => {
      try {
        return await handleGetContext(args, dataComposer);
      } catch (error) {
        logger.error('Error in get_context:', error);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: error instanceof Error ? error.message : 'Unknown error' }) }],
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
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: error instanceof Error ? error.message : 'Unknown error' }) }],
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
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: error instanceof Error ? error.message : 'Unknown error' }) }],
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
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: error instanceof Error ? error.message : 'Unknown error' }) }],
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
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: error instanceof Error ? error.message : 'Unknown error' }) }],
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
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: error instanceof Error ? error.message : 'Unknown error' }) }],
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
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: error instanceof Error ? error.message : 'Unknown error' }) }],
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
        activeOnly: z.boolean().optional().default(false).describe('Only show pending/in_progress tasks'),
        limit: z.number().optional().default(50),
      },
    },
    async (args) => {
      try {
        return await handleListTasks(args, dataComposer);
      } catch (error) {
        logger.error('Error in list_tasks:', error);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: error instanceof Error ? error.message : 'Unknown error' }) }],
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
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: error instanceof Error ? error.message : 'Unknown error' }) }],
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
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: error instanceof Error ? error.message : 'Unknown error' }) }],
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
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: error instanceof Error ? error.message : 'Unknown error' }) }],
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
        channel: z.enum(['telegram', 'terminal', 'discord', 'whatsapp', 'http', 'api'])
          .describe('Channel to send the response to'),
        conversationId: z.string()
          .describe('Conversation ID to route the response to'),
        content: z.string()
          .describe('The response content to send'),
        format: z.enum(['text', 'markdown', 'code', 'json']).optional()
          .describe('Format of the response content'),
        replyToMessageId: z.string().optional()
          .describe('Message ID to reply to (for threading)'),
      },
    },
    async (args) => {
      try {
        return await handleSendResponse(args, dataComposer);
      } catch (error) {
        logger.error('Error in send_response:', error);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: error instanceof Error ? error.message : 'Unknown error' }) }],
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
        channel: z.enum(['telegram', 'terminal', 'discord', 'whatsapp', 'http', 'api', 'all']).optional()
          .default('all')
          .describe('Filter by channel (default: all)'),
        limit: z.number().min(1).max(50).optional()
          .default(10)
          .describe('Maximum messages to return'),
        since: z.string().datetime().optional()
          .describe('Only messages after this timestamp'),
      },
    },
    async (args) => {
      try {
        return await handleGetPendingMessages(args, dataComposer);
      } catch (error) {
        logger.error('Error in get_pending_messages:', error);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: error instanceof Error ? error.message : 'Unknown error' }) }],
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
        messageIds: z.array(z.string())
          .describe('Message IDs to mark as read'),
      },
    },
    async (args) => {
      try {
        return await handleMarkRead(args, dataComposer);
      } catch (error) {
        logger.error('Error in mark_messages_read:', error);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: error instanceof Error ? error.message : 'Unknown error' }) }],
          isError: true,
        };
      }
    }
  );

  logger.info('All MCP tools registered');
}
