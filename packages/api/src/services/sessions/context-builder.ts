/**
 * Context Builder
 *
 * Builds the injected context for agent messages.
 * Queries database for identity, memories, projects, etc.
 */

import { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../../data/supabase/types.js';
import type {
  Session,
  AgentIdentity,
  UserContext,
  TemporalContext,
  InjectedContext,
  IContextBuilder,
} from './types.js';
import { logger } from '../../utils/logger.js';

type DbAgentIdentity = Database['public']['Tables']['agent_identities']['Row'];
type DbUser = Database['public']['Tables']['users']['Row'];
type DbMemory = Database['public']['Tables']['memories']['Row'];
type DbProject = Database['public']['Tables']['projects']['Row'];
type DbContact = Database['public']['Tables']['contacts']['Row'];

/**
 * Map database agent identity to domain type.
 */
function mapAgentIdentity(row: DbAgentIdentity): AgentIdentity {
  return {
    agentId: row.agent_id,
    name: row.name,
    role: row.role,
    description: row.description || undefined,
    backend: row.backend || undefined,
    values: Array.isArray(row.values) ? (row.values as string[]) : [],
    capabilities: Array.isArray(row.capabilities) ? (row.capabilities as string[]) : [],
    soul: row.soul || undefined,
    heartbeat: row.heartbeat || undefined,
    relationships: (row.relationships as Record<string, string>) || {},
  };
}

/**
 * Map database user to UserContext.
 */
function mapUserContext(row: DbUser, contacts: DbContact[]): UserContext {
  const contactsMap: Record<string, string> = {};
  for (const contact of contacts) {
    contactsMap[contact.name] = contact.id;
  }

  return {
    id: row.id,
    email: row.email || undefined,
    timezone: row.timezone || 'UTC',
    contacts: contactsMap,
    preferences: (row.preferences as Record<string, unknown>) || {},
  };
}

/**
 * Build temporal context for current time in user's timezone.
 */

function isLowValueRecentMemory(memory: DbMemory): boolean {
  const content = (memory.content || '').trim();
  const topics = Array.isArray(memory.topics) ? memory.topics : [];

  if (/^Session entered phase:/i.test(content)) return true;
  if (topics.includes('session-phase') && /^\[[^\]]+\]\s*$/.test(content)) return true;
  if (/^\[complete\]\s+Equivalent of end_session/i.test(content)) return true;

  return false;
}

function buildTemporalContext(timezone: string): TemporalContext {
  const now = new Date();

  // Format time in user's timezone
  const timeFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZoneName: 'short',
  });

  const dateFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  const dayFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'long',
  });

  const hourFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    hour12: false,
  });

  const hour = parseInt(hourFormatter.format(now), 10);
  let greeting = 'Hello';
  if (hour >= 5 && hour < 12) {
    greeting = 'Good morning';
  } else if (hour >= 12 && hour < 17) {
    greeting = 'Good afternoon';
  } else if (hour >= 17 && hour < 21) {
    greeting = 'Good evening';
  } else {
    greeting = 'Good night';
  }

  return {
    currentTime: timeFormatter.format(now),
    currentDate: dateFormatter.format(now),
    dayOfWeek: dayFormatter.format(now),
    timezone,
    greeting,
  };
}

export class ContextBuilder implements IContextBuilder {
  constructor(private supabase: SupabaseClient<Database>) {}

  async buildContext(userId: string, agentId: string, session: Session): Promise<InjectedContext> {
    // Fetch all required data in parallel
    const [agentIdentity, user, contacts, recentMemories, activeProjects] = await Promise.all([
      this.getAgentIdentity(userId, agentId, session.identityId),
      this.getUser(userId),
      this.getContacts(userId),
      this.getRecentMemories(userId, agentId),
      this.getActiveProjects(userId),
    ]);

    if (!agentIdentity) {
      throw new Error(`Agent identity not found: ${agentId} for user ${userId}`);
    }

    if (!user) {
      throw new Error(`User not found: ${userId}`);
    }

    const userContext = mapUserContext(user, contacts);
    const temporal = buildTemporalContext(userContext.timezone);

    const filteredRecentMemories = recentMemories.filter((m) => !isLowValueRecentMemory(m));

    const context: InjectedContext = {
      agent: agentIdentity,
      user: userContext,
      temporal,
      recentMemories: filteredRecentMemories.map((m) => ({
        id: m.id,
        content: m.content,
        source: m.source,
        salience: m.salience,
        createdAt: m.created_at || new Date().toISOString(),
      })),
      activeProjects: activeProjects.map((p) => ({
        id: p.id,
        name: p.name,
        status: p.status || 'active',
      })),
    };

    // Add session history if there's compaction data
    if (session.compactionCount > 0) {
      context.sessionHistory = {
        lastCompactionAt: session.lastCompactionAt?.toISOString() || null,
        messagesSinceCompaction: 0, // Would need message counting
        summary: undefined, // Could add last compaction summary
      };
    }

    return context;
  }

  async buildMinimalContext(
    userId: string,
    agentId: string,
    session?: Session
  ): Promise<Pick<InjectedContext, 'temporal' | 'agent'>> {
    const [agentIdentity, user] = await Promise.all([
      this.getAgentIdentity(userId, agentId, session?.identityId),
      this.getUser(userId),
    ]);

    if (!agentIdentity) {
      throw new Error(`Agent identity not found: ${agentId} for user ${userId}`);
    }

    const timezone = user?.timezone || 'UTC';
    const temporal = buildTemporalContext(timezone);

    return {
      agent: agentIdentity,
      temporal,
    };
  }

  async getAgentBackend(userId: string, agentId: string): Promise<string | null> {
    const { data, error } = await this.supabase
      .from('agent_identities')
      .select('backend')
      .eq('user_id', userId)
      .eq('agent_id', agentId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') return null;
      logger.error('Error fetching agent backend', { userId, agentId, error });
      return null;
    }

    return data?.backend || null;
  }

  private async getAgentIdentity(
    userId: string,
    agentId: string,
    identityId?: string
  ): Promise<AgentIdentity | null> {
    if (identityId) {
      const { data: byId, error: byIdError } = await this.supabase
        .from('agent_identities')
        .select('*')
        .eq('id', identityId)
        .eq('user_id', userId)
        .eq('agent_id', agentId)
        .maybeSingle();

      if (byIdError) {
        logger.error('Error fetching agent identity by identityId', {
          userId,
          agentId,
          identityId,
          error: byIdError,
        });
        throw byIdError;
      }

      if (byId) {
        return mapAgentIdentity(byId);
      }

      logger.warn('Session identityId did not resolve; falling back to slug lookup', {
        userId,
        agentId,
        identityId,
      });
    }

    const { data, error } = await this.supabase
      .from('agent_identities')
      .select('*')
      .eq('user_id', userId)
      .eq('agent_id', agentId)
      .order('updated_at', { ascending: false });

    if (error) {
      logger.error('Error fetching agent identity', { userId, agentId, error });
      throw error;
    }

    if (!data || data.length === 0) {
      logger.warn('Agent identity not found', { userId, agentId });
      return null;
    }

    let chosen = data[0];
    if (data.length > 1) {
      const scoped = data.find((row) => row.workspace_id !== null);
      if (scoped) {
        chosen = scoped;
      }
      logger.warn('Multiple agent identities found; choosing deterministic row', {
        userId,
        agentId,
        chosenIdentityId: chosen.id,
        candidateCount: data.length,
      });
    }

    return mapAgentIdentity(chosen);
  }

  private async getUser(userId: string): Promise<DbUser | null> {
    const { data, error } = await this.supabase.from('users').select('*').eq('id', userId).single();

    if (error) {
      if (error.code === 'PGRST116') {
        return null;
      }
      logger.error('Error fetching user', { userId, error });
      throw error;
    }

    return data;
  }

  private async getContacts(userId: string): Promise<DbContact[]> {
    const { data, error } = await this.supabase
      .from('contacts')
      .select('*')
      .eq('user_id', userId)
      .limit(100);

    if (error) {
      logger.error('Error fetching contacts', { userId, error });
      return [];
    }

    return data || [];
  }

  private async getRecentMemories(
    userId: string,
    agentId: string,
    limit: number = 10
  ): Promise<DbMemory[]> {
    // Get memories for this agent + shared memories (agentId = null)
    const { data, error } = await this.supabase
      .from('memories')
      .select('*')
      .eq('user_id', userId)
      .or(`agent_id.eq.${agentId},agent_id.is.null`)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      logger.error('Error fetching recent memories', { userId, agentId, error });
      return [];
    }

    return data || [];
  }

  private async getActiveProjects(userId: string): Promise<DbProject[]> {
    const { data, error } = await this.supabase
      .from('projects')
      .select('*')
      .eq('user_id', userId)
      .eq('status', 'active')
      .limit(10);

    if (error) {
      logger.error('Error fetching active projects', { userId, error });
      return [];
    }

    return data || [];
  }
}

/**
 * Format injected context as a string for inclusion in messages.
 */
export function formatInjectedContext(context: InjectedContext): string {
  const sections: string[] = [];

  // Agent identity section
  sections.push(`## Agent Identity
You are **${context.agent.name}** (agent ID: \`${context.agent.agentId}\`).
Role: ${context.agent.role}
${context.agent.description ? `\n${context.agent.description}` : ''}`);

  // Add soul if present
  if (context.agent.soul) {
    sections.push(`### Soul
${context.agent.soul}`);
  }

  // Temporal context
  sections.push(`## Current Time
${context.temporal.greeting}! It is ${context.temporal.currentTime} on ${context.temporal.currentDate}.`);

  // User context
  sections.push(`## User Context
User timezone: ${context.user.timezone}`);

  // Recent memories (if any)
  if (context.recentMemories.length > 0) {
    const memoryList = context.recentMemories
      .map((m) => `- [${m.salience}] ${m.content}`)
      .join('\n');
    sections.push(`## Recent Memories
${memoryList}`);
  }

  // Active projects (if any)
  if (context.activeProjects.length > 0) {
    const projectList = context.activeProjects.map((p) => `- ${p.name} (${p.status})`).join('\n');
    sections.push(`## Active Projects
${projectList}`);
  }

  // Session history (if compacted before)
  if (context.sessionHistory) {
    sections.push(`## Session History
Last compaction: ${context.sessionHistory.lastCompactionAt || 'Never'}
Messages since compaction: ${context.sessionHistory.messagesSinceCompaction}`);
  }

  return sections.join('\n\n');
}
