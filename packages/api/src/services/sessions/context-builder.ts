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
  ContactContext,
  ConstitutionDocs,
  InjectedContext,
  IContextBuilder,
} from './types.js';
import { MemoryRepository } from '../../data/repositories/memory-repository.js';
import { buildKnowledgeSummary } from '../memory/knowledge-summary.js';
import type { Memory } from '../../data/models/memory.js';
import { logger } from '../../utils/logger.js';

/** Matches the `bootstrap` defaults so both paths select the same memories. */
const HIGH_MEMORY_LIMIT = 10;
const HIGH_MEMORY_WINDOW_DAYS = 7;

type DbAgentIdentity = Database['public']['Tables']['agent_identities']['Row'];
type DbUser = Database['public']['Tables']['users']['Row'];
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
    provider: row.provider || undefined,
    workspaceId: row.workspace_id || undefined,
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

function isLowValueRecentMemory(memory: Pick<Memory, 'content' | 'topics'>): boolean {
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
  private readonly memories: MemoryRepository;

  constructor(private supabase: SupabaseClient<Database>) {
    // Reuse the repository so spawned sessions rank memories exactly the way
    // `bootstrap` does — critical tier first, then relevance-scored high tier.
    this.memories = new MemoryRepository(supabase);
  }

  async buildContext(userId: string, agentId: string, session: Session): Promise<InjectedContext> {
    // Fetch all required data in parallel
    // The identity resolves first because it names the workspace whose
    // constitution this session should read. Everything else runs alongside it.
    const [agentIdentity, user, contacts, recentMemories, activeProjects] = await Promise.all([
      this.getAgentIdentity(userId, agentId, session.sbId),
      this.getUser(userId),
      this.getContacts(userId),
      this.getKnowledgeMemories(userId, agentId, session),
      this.getActiveProjects(userId),
    ]);

    if (!agentIdentity) {
      throw new Error(`Agent identity not found: ${agentId} for user ${userId}`);
    }

    if (!user) {
      throw new Error(`User not found: ${userId}`);
    }

    const constitution = await this.getConstitution(userId, agentIdentity.workspaceId);

    const userContext = mapUserContext(user, contacts);
    const temporal = buildTemporalContext(userContext.timezone);

    const filteredRecentMemories = recentMemories.filter((m) => !isLowValueRecentMemory(m));

    const context: InjectedContext = {
      agent: agentIdentity,
      user: userContext,
      temporal,
      constitution,
      recentMemories: filteredRecentMemories.map((m) => ({
        id: m.id,
        content: m.content,
        source: m.source,
        salience: m.salience,
        createdAt: m.createdAt.toISOString(),
      })),
      knowledgeSummary:
        filteredRecentMemories.length > 0
          ? buildKnowledgeSummary(filteredRecentMemories).knowledgeSummary
          : undefined,
      activeProjects: activeProjects.map((p) => ({
        id: p.id,
        name: p.name,
        status: p.status || 'active',
      })),
    };

    // Inject contact identity for per-sender sessions
    if (session.contactId) {
      const contactRow = await this.getContact(session.contactId);
      if (contactRow) {
        const platform = contactRow.telegram_id
          ? 'telegram'
          : contactRow.whatsapp_id
            ? 'whatsapp'
            : contactRow.discord_id
              ? 'discord'
              : contactRow.imessage_id
                ? 'imessage'
                : undefined;
        context.contact = {
          id: contactRow.id,
          name: contactRow.name,
          displayName: contactRow.display_name || undefined,
          type:
            ((contactRow as Record<string, unknown>).type as ContactContext['type']) || 'external',
          platform,
        };
      }
    }

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
      this.getAgentIdentity(userId, agentId, session?.sbId),
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

  async getAgentBackend(
    userId: string,
    agentId: string
  ): Promise<{ backend: string | null; provider: string | null }> {
    const { data, error } = await this.supabase
      .from('agent_identities')
      .select('backend, provider')
      .eq('user_id', userId)
      .eq('agent_id', agentId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') return { backend: null, provider: null };
      logger.error('Error fetching agent backend', { userId, agentId, error });
      return { backend: null, provider: null };
    }

    return {
      backend: data?.backend || null,
      provider: data?.provider || null,
    };
  }

  private async getAgentIdentity(
    userId: string,
    agentId: string,
    sbId?: string
  ): Promise<AgentIdentity | null> {
    if (sbId) {
      const { data: byId, error: byIdError } = await this.supabase
        .from('agent_identities')
        .select('*')
        .eq('id', sbId)
        .eq('user_id', userId)
        .eq('agent_id', agentId)
        .maybeSingle();

      if (byIdError) {
        logger.error('Error fetching agent identity by sbId', {
          userId,
          agentId,
          sbId,
          error: byIdError,
        });
        throw byIdError;
      }

      if (byId) {
        return mapAgentIdentity(byId);
      }

      logger.warn('Session sbId did not resolve; falling back to slug lookup', {
        userId,
        agentId,
        sbId,
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

  /**
   * Memories for a spawned session, selected the way `bootstrap` selects them:
   * the critical tier first, then the relevance-scored high tier.
   *
   * This used to be a flat "10 newest by created_at, any salience" query, which
   * meant a session's whole memory was whatever happened to be written last —
   * usually transient status notes — while durable critical memories never
   * appeared at all.
   */
  private async getKnowledgeMemories(
    userId: string,
    agentId: string,
    session: Session
  ): Promise<Memory[]> {
    try {
      return await this.memories.getKnowledgeMemories(
        userId,
        agentId,
        HIGH_MEMORY_LIMIT,
        HIGH_MEMORY_WINDOW_DAYS,
        { threadKey: session.threadKey, focusText: session.taskDescription },
        session.contactId
      );
    } catch (error) {
      logger.error('Error fetching knowledge memories', { userId, agentId, error });
      return [];
    }
  }

  /**
   * Constitution docs from the database, scoped to the workspace this agent
   * actually belongs to.
   *
   * Scoping matters: an agent in a team workspace must not be handed the
   * personal workspace's values/process/user doc. The agent's own
   * `workspace_id` wins; only when it has none do we fall back to the oldest
   * personal workspace, which is what `bootstrap` does when given no explicit
   * scope. The `user_identity` row is then read within that same scope, with
   * the unscoped (workspace_id IS NULL) row as the legacy fallback.
   *
   * The `~/.ink` filesystem copies are a stale cache and are not consulted —
   * the database is the source of truth.
   */
  private async getConstitution(
    userId: string,
    agentWorkspaceId?: string
  ): Promise<ConstitutionDocs | undefined> {
    try {
      let workspaceId = agentWorkspaceId;

      if (!workspaceId) {
        const { data: personalWorkspace } = await this.supabase
          .from('workspaces')
          .select('id')
          .eq('user_id', userId)
          .eq('type', 'personal')
          .is('archived_at', null)
          .order('created_at', { ascending: true })
          .limit(1)
          .maybeSingle();
        workspaceId = personalWorkspace?.id || undefined;
      }

      const { data: workspace } = workspaceId
        ? await this.supabase
            .from('workspaces')
            .select('shared_values, process')
            .eq('id', workspaceId)
            .eq('user_id', userId)
            .maybeSingle()
        : { data: null };

      // Scope the legacy row to the same workspace. Reading it unscoped would
      // hand this agent whichever row happened to be updated most recently.
      let userIdentity: { user_profile_md: string | null } | null = null;
      if (workspaceId) {
        const { data } = await this.supabase
          .from('user_identity')
          .select('user_profile_md, shared_values_md, process_md')
          .eq('user_id', userId)
          .eq('workspace_id', workspaceId)
          .maybeSingle();
        userIdentity = data;
      }
      if (!userIdentity) {
        const { data } = await this.supabase
          .from('user_identity')
          .select('user_profile_md, shared_values_md, process_md')
          .eq('user_id', userId)
          .is('workspace_id', null)
          .order('updated_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        userIdentity = data;
      }

      const legacy = userIdentity as {
        user_profile_md?: string | null;
        shared_values_md?: string | null;
        process_md?: string | null;
      } | null;

      const docs: ConstitutionDocs = {
        values: workspace?.shared_values || legacy?.shared_values_md || undefined,
        process: workspace?.process || legacy?.process_md || undefined,
        user: legacy?.user_profile_md || undefined,
      };

      return docs.values || docs.process || docs.user ? docs : undefined;
    } catch (error) {
      logger.error('Error fetching constitution', { userId, error });
      return undefined;
    }
  }

  private async getContact(contactId: string): Promise<DbContact | null> {
    const { data, error } = await this.supabase
      .from('contacts')
      .select('*')
      .eq('id', contactId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') return null;
      logger.error('Error fetching contact', { contactId, error });
      return null;
    }

    return data;
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

  // Constitution — the shared docs a session-start hook would otherwise load.
  // Antigravity has no such hook, so without these the agent gets no team
  // process and no user document at all.
  //
  // Heartbeat is deliberately absent: buildIdentityPrompt already carries it in
  // appendSystemPrompt, where it survives compaction. Repeating it here would
  // duplicate the whole document.
  if (context.constitution?.values) {
    sections.push(`## Values
${context.constitution.values}`);
  }
  if (context.constitution?.process) {
    sections.push(`## Process
${context.constitution.process}`);
  }
  if (context.constitution?.user) {
    sections.push(`## About Your Human
${context.constitution.user}`);
  }
  // Temporal context
  sections.push(`## Current Time
${context.temporal.greeting}! It is ${context.temporal.currentTime} on ${context.temporal.currentDate}.`);

  // User context
  sections.push(`## User Context
User timezone: ${context.user.timezone}`);

  // Contact identity for per-sender sessions
  if (context.contact) {
    const c = context.contact;
    const platformNote = c.platform ? ` via ${c.platform}` : '';
    const typeNote = c.type === 'group' ? ' (group chat)' : '';
    sections.push(`## Current Sender
You are talking to **${c.displayName || c.name}**${platformNote}${typeNote}.
This is a contact-scoped session — memories and conversation history are private to this sender.`);
  }

  // What the agent knows. Prefer the budgeted digest; fall back to a raw list
  // only when a caller built the context without one.
  if (context.knowledgeSummary) {
    sections.push(`## What You Know
${context.knowledgeSummary}`);
  } else if (context.recentMemories.length > 0) {
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
