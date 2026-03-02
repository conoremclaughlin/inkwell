// Application constants

export const APP_NAME = 'Personal Context Protocol';
export const APP_VERSION = '1.0.0';
export const APP_DESCRIPTION =
  'MCP server for managing personal context across messaging platforms';

// MCP Server metadata
export const MCP_SERVER_NAME = 'personal-context-protocol';
export const MCP_SERVER_VERSION = '1.0.0';
export const MCP_SERVER_DESCRIPTION = `Personal Context Protocol (PCP) - Persistent memory and context management for AI agents.

## User Identification
Most tools require identifying a user. You can use ANY ONE of these methods:
- userId: Direct UUID (e.g., "00000000-0000-0000-0000-000000000000")
- email: Email address (e.g., "user@example.com")
- phone: E.164 format (e.g., "+14155551234")
- platform + platformId: Platform name (telegram/whatsapp/discord) with user ID

## Core Capabilities
- **Memory**: remember, recall, forget - Long-term memory with semantic search
- **Sessions**: update_session_phase, get_session, list_sessions - Track and inspect session state
- **Bootstrap**: bootstrap - Initialize agent with user context, identity, and recent memories
- **Gmail**: list_emails, get_email, send_email, modify_emails - Full Gmail integration
- **Calendar**: list_calendars, list_calendar_events - Google Calendar access
- **Reminders**: create_reminder, list_reminders - Scheduled notifications
- **Tasks**: create_task, list_tasks, update_task - Project task management

## Important
- Call bootstrap() at session start to load identity and context
- Use remember() to persist important information across sessions
- Use send_response() to route messages back to users on external channels`;

// API configuration
export const API_PREFIX = '/api/v1';

// Pagination defaults
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

// Rate limiting
export const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
export const RATE_LIMIT_MAX_REQUESTS = 100; // requests per window

// Platform types
export const PLATFORMS = {
  TELEGRAM: 'telegram',
  WHATSAPP: 'whatsapp',
  DISCORD: 'discord',
  API: 'api',
} as const;

// Task statuses
export const TASK_STATUS = {
  PENDING: 'pending',
  IN_PROGRESS: 'in_progress',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
} as const;

// Task priorities
export const TASK_PRIORITY = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  URGENT: 'urgent',
} as const;

// Reminder statuses
export const REMINDER_STATUS = {
  PENDING: 'pending',
  SENT: 'sent',
  CANCELLED: 'cancelled',
} as const;

// Message types
export const MESSAGE_TYPE = {
  TEXT: 'text',
  LINK: 'link',
  COMMAND: 'command',
  SYSTEM: 'system',
} as const;
