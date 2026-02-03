/**
 * Session Host
 *
 * The main orchestrator that connects:
 * - Input channels (Telegram, terminal, HTTP, etc.)
 * - Agent backends (Claude Code, Direct API)
 * - Response routing via MCP tools
 * - Context persistence
 */

import { EventEmitter } from 'events';
import { logger } from '../utils/logger';
import type { DataComposer } from '../data/composer';
import type { AgentMessage, AgentResponse, ChannelType, ResponseHandler, InjectedContext } from './types';
import { BackendManager, createBackendManager, BackendManagerConfig } from './backend-manager';
import { setResponseCallback, addPendingMessage } from '../mcp/tools/response-handlers';
import { getAgentGateway, type AgentTriggerPayload } from '../channels/agent-gateway';

const COMPACTION_PROMPT = `[SYSTEM: SESSION COMPACTION REQUEST]

Your context window is approaching capacity. This session will be rotated soon.
Please perform the following maintenance tasks:

1. Call \`compact_session\` to convert your session logs into durable memories.
2. Review your recent conversation history for any important context, decisions, insights, or user preferences that may NOT be captured in session logs. Create a SINGLE consolidated summary memory using \`remember\` with topics: ["session-summary"] and salience: "high". Do NOT create separate memories for each item — consolidate everything into one comprehensive summary so the next session can reload it efficiently.
3. Use \`create_task\` to capture any pending work or commitments you haven't completed yet.

IMPORTANT:
- This is an internal system message. Do NOT call send_response.
- Do NOT call end_session — the system handles rotation automatically.
- Complete these tasks silently and efficiently.
- NEVER save sensitive information as memories: API keys, passwords, credit card numbers, payment details, SSNs, or other secrets. Summarize around them.`;

export interface ChannelSender {
  sendMessage(conversationId: string, content: string, options?: {
    replyToMessageId?: string;
    format?: string;
  }): Promise<void>;
}

export interface SessionHostConfig {
  /** Backend manager configuration */
  backend: Partial<BackendManagerConfig>;
  /** Data composer for persistence */
  dataComposer: DataComposer;
  /** Channel senders for routing responses */
  channels?: Partial<Record<ChannelType, ChannelSender>>;
  /** Context cache TTL in milliseconds (default: 5 minutes) */
  contextCacheTtl?: number;
  /** Disable auto-injection of context (default: false) */
  disableContextInjection?: boolean;
  /** Agent ID for identity injection (e.g., "myra", "wren") */
  agentId?: string;
  /** Agent IDs to register trigger handlers for (enables wake-up via trigger_agent) */
  registeredAgents?: string[];
  /** Max input tokens before rotating to a new session (default: 160000, ~80% of 200k) */
  maxContextTokens?: number;
  /** Token threshold to trigger graceful compaction (default: 75% of maxContextTokens) */
  compactionThreshold?: number;
  /** Token threshold for hard rotation safety net (default: 85% of maxContextTokens) */
  hardRotationThreshold?: number;
}

interface CachedContext {
  /** Context without temporal (temporal is always computed fresh) */
  context: Omit<InjectedContext, 'temporal'>;
  /** User's timezone for building fresh temporal context */
  userTimezone: string | null;
  timestamp: Date;
}

export class SessionHost extends EventEmitter {
  private backendManager: BackendManager;
  private channels: Map<ChannelType, ChannelSender> = new Map();
  private dataComposer: DataComposer;
  private messageCounter = 0;

  // Context injection
  private contextCache: Map<string, CachedContext> = new Map();
  private contextCacheTtl: number;
  private disableContextInjection: boolean;
  private agentId: string | undefined;

  // Trigger handlers
  private registeredAgents: string[] = [];

  // Context window management
  private maxContextTokens: number;
  private compactionThreshold: number;
  private hardRotationThreshold: number;
  private compactionInProgress = false;

  constructor(config: SessionHostConfig) {
    super();
    this.dataComposer = config.dataComposer;
    this.contextCacheTtl = config.contextCacheTtl ?? 30 * 60 * 1000; // 30 minutes default
    this.disableContextInjection = config.disableContextInjection ?? false;
    this.agentId = config.agentId;
    this.registeredAgents = config.registeredAgents || [];
    this.maxContextTokens = config.maxContextTokens ?? 160000; // ~80% of 200k for Opus
    this.compactionThreshold = config.compactionThreshold ?? Math.floor(this.maxContextTokens * 0.75);
    this.hardRotationThreshold = config.hardRotationThreshold ?? Math.floor(this.maxContextTokens * 0.85);

    // Create backend manager
    this.backendManager = createBackendManager(config.backend);

    // Register channels
    if (config.channels) {
      for (const [channel, sender] of Object.entries(config.channels)) {
        if (sender) {
          this.channels.set(channel as ChannelType, sender);
        }
      }
    }

    // Setup event forwarding from backend manager
    this.setupBackendEvents();
  }

  /**
   * Initialize the session host
   */
  async initialize(): Promise<void> {
    logger.info('Initializing Session Host...');

    // Register the response callback for MCP send_response tool
    setResponseCallback(this.handleResponse.bind(this));

    // Restore Claude session from database (sets sessionId before first message)
    await this.restoreClaudeSession();

    // Initialize backend manager
    await this.backendManager.initialize();

    // Register trigger handlers for configured agents
    this.registerTriggerHandlers();

    // Set response handler on backend manager too
    this.backendManager.setResponseHandler(this.handleResponse.bind(this));

    logger.info('Session Host initialized', {
      backend: this.backendManager.getActiveBackendType(),
      channels: Array.from(this.channels.keys()),
    });

    this.emit('ready');
  }

  /**
   * Shutdown the session host
   */
  async shutdown(): Promise<void> {
    logger.info('Shutting down Session Host...');

    // Unregister trigger handlers
    const gateway = getAgentGateway();
    for (const agentId of this.registeredAgents) {
      gateway.unregisterHandler(agentId);
    }

    await this.backendManager.shutdown();

    logger.info('Session Host shutdown complete');
    this.emit('shutdown');
  }

  /**
   * Register trigger handlers for configured agents.
   * Enables agents to be "woken up" via the trigger_agent tool.
   */
  private registerTriggerHandlers(): void {
    if (this.registeredAgents.length === 0) {
      return;
    }

    const gateway = getAgentGateway();

    for (const agentId of this.registeredAgents) {
      gateway.registerHandler(agentId, this.handleAgentTrigger.bind(this, agentId));
      logger.info(`Trigger handler registered for agent: ${agentId}`);
    }

    logger.info(`Registered trigger handlers for agents: ${this.registeredAgents.join(', ')}`);
  }

  /**
   * Handle a trigger for a specific agent.
   * Fetches inbox message (if provided) and sends to the agent for processing.
   */
  private async handleAgentTrigger(agentId: string, payload: AgentTriggerPayload): Promise<void> {
    logger.info(`Handling trigger for agent: ${agentId}`, {
      from: payload.fromAgentId,
      type: payload.triggerType,
      inboxMessageId: payload.inboxMessageId,
    });

    // Build the trigger message content
    let content = `[TRIGGER from ${payload.fromAgentId}]\nType: ${payload.triggerType}`;

    if (payload.summary) {
      content += `\nSummary: ${payload.summary}`;
    }

    // If inbox message ID provided, fetch it
    if (payload.inboxMessageId) {
      try {
        const supabase = this.dataComposer.getClient();
        const { data: inboxMessage } = await supabase
          .from('agent_inbox')
          .select('*')
          .eq('id', payload.inboxMessageId)
          .single();

        if (inboxMessage) {
          content += `\n\n[INBOX MESSAGE]\nFrom: ${inboxMessage.sender_agent_id || 'user'}`;
          content += `\nSubject: ${inboxMessage.subject}`;
          content += `\nPriority: ${inboxMessage.priority}`;
          content += `\nContent:\n${inboxMessage.content}`;

          // Mark as read
          await supabase
            .from('agent_inbox')
            .update({ status: 'read', read_at: new Date().toISOString() })
            .eq('id', payload.inboxMessageId);
        }
      } catch (error) {
        logger.error('Failed to fetch inbox message:', error);
      }
    }

    // Send to the agent as an "agent" channel message
    // This goes through the normal message handling flow
    await this.handleMessage(
      'agent' as ChannelType,
      `trigger-${agentId}`,
      { id: payload.fromAgentId, name: payload.fromAgentId },
      content,
      {
        metadata: {
          triggerType: payload.triggerType,
          inboxMessageId: payload.inboxMessageId,
          ...payload.metadata,
        },
      }
    );

    this.emit('agent:triggered', { agentId, payload });
  }

  /**
   * Register a channel sender
   */
  registerChannel(channel: ChannelType, sender: ChannelSender): void {
    this.channels.set(channel, sender);
    logger.info(`Channel registered: ${channel}`);
  }

  /**
   * Get injected context for a user (with caching)
   */
  private async getInjectedContext(
    userId?: string,
    platform?: string,
    platformId?: string,
    platformChatId?: string
  ): Promise<InjectedContext | undefined> {
    // Need at least one identifier
    if (!userId && !platformId) {
      return undefined;
    }

    // Cache key based on available identifiers
    const cacheKey = userId || `${platform}:${platformId}`;

    // Check cache for stable context (user, projects, memories, etc.)
    const cached = this.contextCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp.getTime() < this.contextCacheTtl) {
      logger.debug(`Context cache hit for ${cacheKey}`);
      // Return cached context with FRESH temporal and conversation history
      const conversationHistory = await this.fetchConversationHistory(
        cached.context.user?.id,
        platform,
        platformChatId
      );
      return {
        ...cached.context,
        temporal: this.buildTemporalContext(cached.userTimezone),
        conversationHistory,
      };
    }

    try {
      // Resolve user
      let resolvedUserId = userId;
      if (!resolvedUserId && platform && platformId) {
        const user = await this.dataComposer.repositories.users.findByPlatformId(
          platform as 'telegram' | 'whatsapp' | 'discord',
          platformId
        );
        resolvedUserId = user?.id;
      }

      if (!resolvedUserId) {
        logger.debug(`Could not resolve user for context injection: ${cacheKey}`);
        return undefined;
      }

      // Fetch context components in parallel (including user for timezone and agent identity)
      const supabase = this.dataComposer.getClient();
      const agentIdentityPromise = this.agentId
        ? supabase
            .from('agent_identities')
            .select('agent_id, name, role, description, values, capabilities')
            .eq('user_id', resolvedUserId)
            .eq('agent_id', this.agentId)
            .single()
            .then(({ data }) => data)
        : Promise.resolve(null);

      const [userRecord, contexts, projects, focus, recentMemories, agentIdentity] = await Promise.all([
        this.dataComposer.repositories.users.findById(resolvedUserId),
        this.dataComposer.repositories.context.findAllByUser(resolvedUserId),
        this.dataComposer.repositories.projects.findAllByUser(resolvedUserId, 'active'),
        this.dataComposer.repositories.sessionFocus.findLatestByUser(resolvedUserId),
        this.dataComposer.repositories.memory.recall(resolvedUserId, undefined, {
          salience: 'high',
          limit: 5,
        }),
        agentIdentityPromise,
      ]);

      // Build injected context
      const userContext = contexts.find((c) => c.context_type === 'user' && !c.context_key);
      const assistantContext = contexts.find((c) => c.context_type === 'assistant' && !c.context_key);
      const relationshipContext = contexts.find((c) => c.context_type === 'relationship' && !c.context_key);

      const injectedContext: InjectedContext = {
        user: userContext
          ? {
              id: resolvedUserId,
              summary: userContext.summary,
              metadata: userContext.metadata as Record<string, unknown>,
            }
          : { id: resolvedUserId },
        assistant: assistantContext
          ? {
              summary: assistantContext.summary,
              metadata: assistantContext.metadata as Record<string, unknown>,
            }
          : undefined,
        relationship: relationshipContext
          ? { summary: relationshipContext.summary }
          : undefined,
        activeProjects: projects.map((p) => ({
          id: p.id,
          name: p.name,
          description: p.description || undefined,
          status: p.status,
        })),
        currentFocus: focus
          ? {
              projectId: focus.project_id || undefined,
              summary: focus.focus_summary || undefined,
            }
          : undefined,
        recentMemories: recentMemories.map((m) => ({
          content: m.content,
          source: m.source,
          topics: m.topics,
        })),
        agentIdentity: agentIdentity
          ? {
              agentId: agentIdentity.agent_id,
              name: agentIdentity.name,
              role: agentIdentity.role,
              description: agentIdentity.description || undefined,
              values: (agentIdentity.values as string[] | null) || undefined,
              capabilities: (agentIdentity.capabilities as string[] | null) || undefined,
            }
          : undefined,
        // Temporal is added fresh (not from cache)
        temporal: this.buildTemporalContext(userRecord?.timezone),
        // Conversation history is also fetched fresh (changes with each message)
        conversationHistory: await this.fetchConversationHistory(resolvedUserId, platform, platformChatId),
      };

      // Cache everything EXCEPT temporal and conversationHistory (these change between messages!)
      const { temporal: _temporal, conversationHistory: _history, ...contextWithoutDynamic } = injectedContext;
      this.contextCache.set(cacheKey, {
        context: contextWithoutDynamic,
        userTimezone: userRecord?.timezone || null,
        timestamp: new Date(),
      });

      logger.info(`Context injected for user ${resolvedUserId}`, {
        hasUser: !!userContext,
        hasAssistant: !!assistantContext,
        hasAgentIdentity: !!agentIdentity,
        agentId: this.agentId,
        projectCount: projects.length,
        memoryCount: recentMemories.length,
        conversationHistoryCount: injectedContext.conversationHistory?.length || 0,
      });

      return injectedContext;
    } catch (error) {
      logger.error('Failed to get injected context:', error);
      return undefined;
    }
  }

  /**
   * Clear context cache for a user (useful after context updates)
   */
  clearContextCache(userId?: string, platform?: string, platformId?: string): void {
    if (userId) {
      this.contextCache.delete(userId);
    }
    if (platform && platformId) {
      this.contextCache.delete(`${platform}:${platformId}`);
    }
  }

  /**
   * Handle an incoming message from any channel
   */
  async handleMessage(
    channel: ChannelType,
    conversationId: string,
    sender: { id: string; name?: string },
    content: string,
    options?: {
      userId?: string;
      projectId?: string;
      sessionId?: string;
      replyToMessageId?: string;
      metadata?: Record<string, unknown>;
      media?: Array<{ type: 'image' | 'video' | 'audio' | 'document'; url?: string; path?: string }>;
      chatType?: 'direct' | 'group' | 'channel';
      mentions?: { users: string[]; botMentioned: boolean };
    }
  ): Promise<void> {
    this.messageCounter++;
    const messageId = `msg-${Date.now()}-${this.messageCounter}`;

    const message: AgentMessage = {
      id: messageId,
      channel,
      conversationId,
      sender,
      content,
      timestamp: new Date(),
      media: options?.media,
      chatType: options?.chatType,
      mentions: options?.mentions,
      context: {
        userId: options?.userId,
        projectId: options?.projectId,
        sessionId: options?.sessionId,
        replyToMessageId: options?.replyToMessageId,
      },
      metadata: options?.metadata,
    };

    logger.info(`Handling message from ${channel}:${conversationId}`, {
      messageId,
      sender: sender.id,
      contentPreview: content.substring(0, 50),
    });

    // Add to pending messages for cross-channel visibility
    addPendingMessage({
      id: messageId,
      channel,
      conversationId,
      sender,
      content,
      timestamp: new Date(),
      read: false,
    });

    // Persist the incoming message
    await this.persistMessage(message, 'user');

    // Auto-inject context if enabled and we can identify the user
    if (!this.disableContextInjection) {
      const userId = options?.userId;
      const platformId = sender.id;
      const platform = this.mapChannelToPlatform(channel);

      message.injectedContext = await this.getInjectedContext(userId, platform, platformId, conversationId);
    }

    // Send to the agent backend
    try {
      await this.backendManager.sendMessage(message);
      this.emit('message:sent', message);
    } catch (error) {
      logger.error('Error sending message to backend:', error);
      this.emit('message:error', { message, error });

      // Send error response back to channel
      const errorContent = 'Sorry, I encountered an error processing your message. Please try again.';
      await this.sendToChannel(channel, conversationId, errorContent);
    }
  }

  /**
   * Handle a response from the agent (via MCP send_response tool)
   */
  private handleResponse: ResponseHandler = async (response: AgentResponse) => {
    logger.info(`Routing response to ${response.channel}:${response.conversationId}`, {
      contentLength: response.content.length,
      format: response.format,
    });

    // Send to the appropriate channel
    await this.sendToChannel(
      response.channel,
      response.conversationId,
      response.content,
      {
        replyToMessageId: response.replyToMessageId,
        format: response.format,
      }
    );

    // Persist the response
    await this.persistResponse(response);

    this.emit('response:sent', response);
  };

  /**
   * Send a message to a specific channel
   */
  private async sendToChannel(
    channel: ChannelType,
    conversationId: string,
    content: string,
    options?: {
      replyToMessageId?: string;
      format?: string;
    }
  ): Promise<void> {
    const sender = this.channels.get(channel);

    if (!sender) {
      logger.warn(`No sender registered for channel: ${channel}`);
      // Emit event so external handlers can pick it up
      this.emit('response:unrouted', { channel, conversationId, content, options });
      return;
    }

    try {
      await sender.sendMessage(conversationId, content, options);
      logger.info(`Response sent to ${channel}:${conversationId}`);
    } catch (error) {
      logger.error(`Failed to send to ${channel}:`, error);
      this.emit('response:error', { channel, conversationId, content, error });
    }
  }

  /**
   * Map channel type to platform for persistence
   * Some channels (http, terminal) map to 'api' for storage
   */
  private mapChannelToPlatform(channel: ChannelType): string {
    switch (channel) {
      case 'http':
      case 'terminal':
      case 'api':
        return 'api';
      default:
        return channel;
    }
  }

  /**
   * Build temporal context with current time in user's timezone
   */
  private buildTemporalContext(userTimezone?: string | null): InjectedContext['temporal'] {
    const now = new Date();
    const timezone = userTimezone || 'UTC';

    // Format local time in a human-readable way
    const localTime = now.toLocaleString('en-US', {
      timeZone: timezone,
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    });

    return {
      currentTimeUtc: now.toISOString(),
      userTimezone: timezone,
      localTime,
    };
  }

  /**
   * Fetch recent conversation history from the activity stream
   * This provides continuity across session restarts
   */
  private async fetchConversationHistory(
    userId?: string,
    platform?: string,
    platformChatId?: string
  ): Promise<InjectedContext['conversationHistory']> {
    if (!userId) {
      return undefined;
    }

    try {
      const history = await this.dataComposer.repositories.activityStream.getConversationHistory(
        userId,
        {
          platform,
          platformChatId,
          limit: 20, // Last 20 messages for context
        }
      );

      if (history.length === 0) {
        return undefined;
      }

      return history.map((activity) => ({
        direction: activity.type === 'message_in' ? 'in' as const : 'out' as const,
        content: activity.content,
        timestamp: activity.createdAt.toISOString(),
        platform: activity.platform || undefined,
      }));
    } catch (error) {
      logger.warn('Failed to fetch conversation history:', error);
      return undefined;
    }
  }

  /**
   * Persist an incoming message
   */
  private async persistMessage(message: AgentMessage, _type: 'user' | 'assistant'): Promise<void> {
    try {
      const platform = this.mapChannelToPlatform(message.channel);

      // Get or create conversation
      let conversation = await this.dataComposer.repositories.conversations
        .findConversationByPlatformId(platform, message.conversationId);

      if (!conversation && message.context?.userId) {
        conversation = await this.dataComposer.repositories.conversations.createConversation({
          user_id: message.context.userId,
          // Cast to any to handle extended channel types not in the Platform enum
          platform: platform as never,
          platform_conversation_id: message.conversationId,
        });
      }

      if (conversation && message.context?.userId) {
        await this.dataComposer.repositories.conversations.createMessage({
          conversation_id: conversation.id,
          user_id: message.context.userId,
          content: message.content,
          message_type: 'text', // Use 'text' as default message type
          platform_message_id: message.id,
        });
      }
    } catch (error) {
      logger.error('Failed to persist message:', error);
      // Don't throw - persistence failure shouldn't block message handling
    }
  }

  /**
   * Persist an outgoing response
   */
  private async persistResponse(response: AgentResponse): Promise<void> {
    try {
      const platform = this.mapChannelToPlatform(response.channel);

      const conversation = await this.dataComposer.repositories.conversations
        .findConversationByPlatformId(platform, response.conversationId);

      if (conversation) {
        await this.dataComposer.repositories.conversations.createMessage({
          conversation_id: conversation.id,
          user_id: conversation.user_id,
          content: response.content,
          message_type: 'text', // Use 'text' as default message type
        });
      }
    } catch (error) {
      logger.error('Failed to persist response:', error);
    }
  }

  /**
   * Get backend health information
   */
  getHealth(): {
    ready: boolean;
    backend: ReturnType<BackendManager['getAllHealth']>;
    channels: ChannelType[];
  } {
    return {
      ready: this.backendManager.getActiveBackend()?.isReady() || false,
      backend: this.backendManager.getAllHealth(),
      channels: Array.from(this.channels.keys()),
    };
  }

  /**
   * Get the current session ID
   */
  getSessionId(): string | null {
    return this.backendManager.getSessionId();
  }

  /**
   * Switch to a different backend
   */
  async switchBackend(type: 'claude-code' | 'direct-api'): Promise<void> {
    await this.backendManager.switchBackend(type);
  }

  /**
   * Persist the Claude Code session ID to the sessions table so it survives server restarts.
   * Finds the most recent active session for this agent and updates its claude_session_id.
   */
  private async persistClaudeSessionId(claudeSessionId: string): Promise<void> {
    if (!this.agentId) return;

    try {
      const supabase = this.dataComposer.getClient();

      // Find the most recent active session for this agent
      const { data: session } = await supabase
        .from('sessions')
        .select('id')
        .eq('agent_id', this.agentId)
        .is('ended_at', null)
        .order('started_at', { ascending: false })
        .limit(1)
        .single();

      if (session) {
        await supabase
          .from('sessions')
          .update({ claude_session_id: claudeSessionId, status: 'active' })
          .eq('id', session.id);
        logger.info('Persisted Claude session ID', { claudeSessionId, pcpSessionId: session.id });
      } else {
        logger.debug('No active PCP session found to persist Claude session ID — agent may not have called start_session yet', {
          agentId: this.agentId,
        });
      }
    } catch (error) {
      logger.warn('Failed to persist Claude session ID:', error);
    }
  }

  /**
   * Send a compaction message to the agent before rotating the session.
   * The agent processes this within its current context window, calling MCP tools
   * (compact_session, remember, create_task) to persist important context, then
   * the session is rotated regardless of success or failure.
   */
  private async sendCompactionMessage(): Promise<void> {
    this.compactionInProgress = true;
    this.emit('session:compactionStarted', { agentId: this.agentId });

    logger.info('Compaction threshold reached, sending compaction message to agent', {
      agentId: this.agentId,
    });

    const compactionMessage: AgentMessage = {
      id: `compaction-${Date.now()}`,
      channel: 'agent' as ChannelType,
      conversationId: `compaction-${this.agentId}`,
      sender: { id: 'system', name: 'System' },
      content: COMPACTION_PROMPT,
      timestamp: new Date(),
      metadata: { isInternal: true, isCompaction: true },
    };

    try {
      // Send directly to backend — bypasses handleMessage() pipeline
      // (no persistence, no pending queue, no context injection)
      await this.backendManager.sendMessage(compactionMessage);

      logger.info('Compaction complete, rotating session', { agentId: this.agentId });
      this.emit('session:compactionComplete', { agentId: this.agentId });
    } catch (error) {
      logger.error('Compaction failed, rotating session anyway', { error, agentId: this.agentId });
      this.emit('session:compactionFailed', { agentId: this.agentId, error });
    }

    // Always rotate after compaction attempt (success or failure)
    await this.rotateSession();
  }

  /**
   * Rotate to a new Claude session when context window is approaching limits.
   * Marks the current session as completed in the DB, clears the backend session ID,
   * and clears the context cache so fresh context is injected on the next message.
   */
  private async rotateSession(): Promise<void> {
    this.compactionInProgress = false;
    if (!this.agentId) return;

    try {
      const supabase = this.dataComposer.getClient();

      // Mark current session as completed in the DB
      const { data: currentSession } = await supabase
        .from('sessions')
        .select('id')
        .eq('agent_id', this.agentId)
        .is('ended_at', null)
        .order('started_at', { ascending: false })
        .limit(1)
        .single();

      if (currentSession) {
        await supabase
          .from('sessions')
          .update({ status: 'completed', ended_at: new Date().toISOString() })
          .eq('id', currentSession.id);
        logger.info('Marked current session as completed for rotation', { sessionId: currentSession.id });
      }

      // Clear session on the backend — next message starts a fresh Claude session
      this.backendManager.clearSession();

      // Clear context cache so fresh context is injected
      this.contextCache.clear();

      logger.info('Session rotated — next message will start a fresh context', { agentId: this.agentId });
      this.emit('session:rotated', { agentId: this.agentId });
    } catch (error) {
      logger.error('Failed to rotate session:', error);
    }
  }

  /**
   * On startup, restore the Claude Code session ID from the database so --resume works across restarts.
   */
  private async restoreClaudeSession(): Promise<void> {
    if (!this.agentId) return;

    try {
      const supabase = this.dataComposer.getClient();

      const { data: session } = await supabase
        .from('sessions')
        .select('claude_session_id')
        .eq('agent_id', this.agentId)
        .is('ended_at', null)
        .not('claude_session_id', 'is', null)
        .order('started_at', { ascending: false })
        .limit(1)
        .single();

      if (session?.claude_session_id) {
        const resumed = await this.backendManager.resumeSession(session.claude_session_id);
        if (resumed) {
          logger.info('Restored Claude session from database', {
            claudeSessionId: session.claude_session_id,
            agentId: this.agentId,
          });
        }
      } else {
        logger.info('No resumable Claude session found in database', { agentId: this.agentId });
      }
    } catch (error) {
      logger.warn('Failed to restore Claude session from database:', error);
    }
  }

  private setupBackendEvents(): void {
    this.backendManager.on('backend:ready', (type) => {
      this.emit('backend:ready', type);
    });

    this.backendManager.on('backend:error', (data) => {
      this.emit('backend:error', data);
    });

    this.backendManager.on('backend:exit', (data) => {
      this.emit('backend:exit', data);
    });

    this.backendManager.on('backend:failover', (type) => {
      logger.warn(`Backend failed over to: ${type}`);
      this.emit('backend:failover', type);
    });

    this.backendManager.on('text', (text) => {
      this.emit('text', text);
    });

    this.backendManager.on('result', (result) => {
      this.emit('result', result);
    });

    // Handle responses from backend (via stdout parsing)
    this.backendManager.on('response', async (response: AgentResponse) => {
      logger.info(`Received response from backend for ${response.channel}:${response.conversationId}`);
      await this.handleResponse(response);
    });

    // Persist Claude session ID to database when captured
    this.backendManager.on('session:captured', async (sessionId: string) => {
      await this.persistClaudeSessionId(sessionId);
    });

    // Monitor token usage for context window rotation (two-phase: compaction then rotation)
    this.backendManager.on('session:usage', async (usage: {
      inputTokens: number;
      outputTokens: number;
      messageInputTokens: number;
      messageOutputTokens: number;
    }) => {
      // Skip if compaction is already in progress — sendCompactionMessage owns the rotation lifecycle
      if (this.compactionInProgress) return;

      if (usage.inputTokens >= this.hardRotationThreshold) {
        // Safety net: hard rotate if tokens exceed the higher threshold
        logger.warn('Hard rotation threshold exceeded, rotating immediately', {
          inputTokens: usage.inputTokens,
          hardRotationThreshold: this.hardRotationThreshold,
          agentId: this.agentId,
        });
        await this.rotateSession();
      } else if (usage.inputTokens >= this.compactionThreshold) {
        // Graceful: ask the agent to save context before rotating
        logger.info('Compaction threshold reached', {
          inputTokens: usage.inputTokens,
          compactionThreshold: this.compactionThreshold,
          agentId: this.agentId,
        });
        await this.sendCompactionMessage();
      }
    });
  }
}

/**
 * Create a session host instance
 */
export function createSessionHost(config: SessionHostConfig): SessionHost {
  return new SessionHost(config);
}
