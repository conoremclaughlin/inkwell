import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './supabase/types';
import { createSupabaseClient } from './supabase/client';
import { UsersRepository } from './repositories/users.repository';
import { LinksRepository } from './repositories/links.repository';
import { NotesRepository } from './repositories/notes.repository';
import { RemindersRepository } from './repositories/reminders.repository';
import { ConversationsRepository } from './repositories/conversations.repository';
import { ContextRepository } from './repositories/context.repository';
import { ProjectsRepository } from './repositories/projects.repository';
import { SessionFocusRepository } from './repositories/session-focus.repository';
import { ProjectTasksRepository } from './repositories/project-tasks.repository';
import { MemoryRepository } from './repositories/memory-repository';
import { ActivityStreamRepository } from './repositories/activity-stream.repository';
import { StudiosRepository } from './repositories/studios.repository';
import { WorkspacesRepository } from './repositories/workspaces.repository';
import { logger } from '../utils/logger';

export class DataComposer {
  private supabaseClient: SupabaseClient<Database>;

  public repositories: {
    users: UsersRepository;
    links: LinksRepository;
    notes: NotesRepository;
    reminders: RemindersRepository;
    conversations: ConversationsRepository;
    context: ContextRepository;
    projects: ProjectsRepository;
    sessionFocus: SessionFocusRepository;
    tasks: ProjectTasksRepository;
    memory: MemoryRepository;
    activityStream: ActivityStreamRepository;
    studios: StudiosRepository;
    workspaces: WorkspacesRepository;
  };

  private constructor(supabaseClient: SupabaseClient<Database>) {
    this.supabaseClient = supabaseClient;

    // Initialize all repositories with the shared client
    this.repositories = {
      users: new UsersRepository(supabaseClient),
      links: new LinksRepository(supabaseClient),
      notes: new NotesRepository(supabaseClient),
      reminders: new RemindersRepository(supabaseClient),
      conversations: new ConversationsRepository(supabaseClient),
      context: new ContextRepository(supabaseClient),
      projects: new ProjectsRepository(supabaseClient),
      sessionFocus: new SessionFocusRepository(supabaseClient),
      tasks: new ProjectTasksRepository(supabaseClient),
      memory: new MemoryRepository(supabaseClient),
      activityStream: new ActivityStreamRepository(supabaseClient),
      studios: new StudiosRepository(supabaseClient),
      workspaces: new WorkspacesRepository(supabaseClient),
    };

    logger.info('Data composer initialized with all repositories');
  }

  /**
   * Initialize the data composer
   * This creates the Supabase client and all repositories
   */
  static async initialize(): Promise<DataComposer> {
    try {
      const supabaseClient = createSupabaseClient();

      // Test the connection
      const { error } = await supabaseClient.from('users').select('count').limit(0);

      if (error) {
        throw new Error(`Database connection test failed: ${error.message}`);
      }

      logger.info('Database connection test successful');

      return new DataComposer(supabaseClient);
    } catch (error) {
      logger.error('Failed to initialize data composer:', error);
      throw error;
    }
  }

  /**
   * Get the underlying Supabase client
   * Use this sparingly - prefer using repositories instead
   */
  getClient(): SupabaseClient<Database> {
    return this.supabaseClient;
  }

  /**
   * Health check for the database connection
   */
  async healthCheck(): Promise<boolean> {
    try {
      const { error } = await this.supabaseClient.from('users').select('count').limit(0);
      return !error;
    } catch {
      return false;
    }
  }
}

// Singleton instance
let dataComposerInstance: DataComposer | null = null;

/**
 * Get or create the data composer singleton
 */
export async function getDataComposer(): Promise<DataComposer> {
  if (!dataComposerInstance) {
    dataComposerInstance = await DataComposer.initialize();
  }
  return dataComposerInstance;
}

/**
 * Reset the data composer singleton (useful for testing)
 */
export function resetDataComposer(): void {
  dataComposerInstance = null;
}
