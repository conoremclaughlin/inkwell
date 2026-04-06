/**
 * Public API exports for @inklabs/api
 *
 * This file exports all public APIs that can be used by consumers of this package.
 */

// Data layer
export { DataComposer, getDataComposer } from './data/composer';
export type { Database } from './data/supabase/types';

// Repositories
export { LinksRepository } from './data/repositories/links.repository';
export { NotesRepository } from './data/repositories/notes.repository';
export { ProjectTasksRepository as TasksRepository } from './data/repositories/project-tasks.repository';
export { RemindersRepository } from './data/repositories/reminders.repository';
export { ConversationsRepository } from './data/repositories/conversations.repository';
export { UsersRepository } from './data/repositories/users.repository';

// Models
export type { User } from './data/models/user.model';
export type { Link } from './data/models/link.model';
export type { Note } from './data/models/note.model';
export type { Task } from './data/models/task.model';
export type { Reminder } from './data/models/reminder.model';
export type { Conversation } from './data/models/conversation.model';

// User resolution
export { resolveUser, resolveUserOrThrow, userIdentifierSchema } from './services/user-resolver';

// Channel integration (clawdbot bridge)
export * from './channels';

// MCP server
export { MCPServer, createMCPServer } from './mcp/server';

// Configuration
export { env } from './config/env';
export { MCP_SERVER_NAME, MCP_SERVER_VERSION } from './config/constants';

// Utilities
export { logger } from './utils/logger';
