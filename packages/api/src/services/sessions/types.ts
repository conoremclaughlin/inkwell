/**
 * Session Service Types
 *
 * Core types for the stateless SessionService architecture.
 */

// ─── Channel Types ───

// Keep aligned with src/agent/types.ts ChannelType
export type ChannelType =
  | 'telegram'
  | 'terminal'
  | 'discord'
  | 'whatsapp'
  | 'slack'
  | 'http'
  | 'api'
  | 'agent'
  | 'web';

export type ChatType = 'direct' | 'group' | 'supergroup' | 'channel';

export interface MediaAttachment {
  type: 'image' | 'video' | 'audio' | 'document' | 'voice';
  url?: string;
  data?: Buffer;
  mimeType?: string;
  filename?: string;
}

// ─── Session Types ───

/**
 * Primary sessions are for long-lived SBs (Myra, Wren, Benson).
 * They never truly end - they pause between interactions and
 * use compaction to manage context window limits.
 *
 * Task sessions are for finite work units spawned by primary SBs.
 * They end when the task is complete or abandoned.
 */
export type SessionType = 'primary' | 'task';

export type SessionStatus = 'active' | 'paused' | 'completed' | 'failed';

export interface Session {
  id: string;
  userId: string;
  agentId: string;
  identityId?: string;
  /** Studio/worktree scope for this session */
  studioId?: string;
  claudeSessionId: string | null;

  type: SessionType;
  status: SessionStatus;

  // For task sessions
  taskDescription?: string;
  parentSessionId?: string;

  // Token tracking for compaction decisions
  contextTokens: number;
  totalInputTokens: number;
  totalOutputTokens: number;

  // Aggregate counters (persisted as columns)
  messageCount: number;
  tokenCount: number; // cumulative input+output tokens

  // Runtime context
  backend: string; // 'claude-code' | 'direct-api'
  model: string | null; // e.g., 'sonnet', 'opus'

  // Compaction tracking
  lastCompactionAt: Date | null;
  compactionCount: number;

  // Timestamps
  startedAt: Date;
  lastActivityAt: Date;
  endedAt: Date | null;

  // Thread key for topic-scoped session matching (e.g., "pr:43")
  threadKey?: string;

  // Flexible metadata
  metadata: Record<string, unknown>;
}

// ─── Request/Response Types ───

export interface SessionRequest {
  // Auth context (required)
  userId: string;
  agentId: string;

  // Message context
  channel: ChannelType;
  conversationId: string;
  sender: {
    id: string;
    name: string;
    username?: string;
  };
  content: string;

  // Optional metadata
  metadata?: {
    replyToMessageId?: string;
    chatType?: ChatType;
    media?: MediaAttachment[];
    triggerType?: 'message' | 'heartbeat' | 'agent' | 'api';
    // Thread key for topic-scoped session routing (e.g., "pr:43")
    threadKey?: string;
    // Explicit studio/worktree scope for this request
    studioId?: string;
    // Convenience routing hint (e.g., force main studio without UUID lookup)
    studioHint?: 'main';
    // Recipient session to inherit studio scope from
    recipientSessionId?: string;
    // For task sessions
    sessionType?: SessionType;
    taskDescription?: string;
    parentSessionId?: string;
  };
}

export interface ChannelResponse {
  channel: ChannelType;
  conversationId: string;
  content: string;
  format?: 'text' | 'markdown' | 'code' | 'json';
  replyToMessageId?: string;
}

export interface SessionResult {
  success: boolean;
  sessionId: string;
  claudeSessionId: string | null;

  // Responses routed via send_response
  responses: ChannelResponse[];

  // Token usage from this interaction
  usage?: {
    contextTokens: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };

  // Session state after processing
  sessionStatus: SessionStatus;
  compactionTriggered: boolean;

  // The final text response from Claude (for auto-routing if no explicit send_response)
  finalTextResponse?: string;

  // Error info if failed
  error?: string;
  errorCode?: string;
}

// ─── Tool Call Tracking ───

export interface ToolCall {
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
}

// ─── Context Injection Types ───

export interface AgentIdentity {
  agentId: string;
  name: string;
  role: string;
  description?: string;
  backend?: string;
  values: string[];
  capabilities: string[];
  soul?: string;
  heartbeat?: string;
  relationships: Record<string, string>;
}

export interface UserContext {
  id: string;
  email?: string;
  timezone: string;
  contacts: Record<string, string>;
  preferences: Record<string, unknown>;
}

export interface TemporalContext {
  currentTime: string;
  currentDate: string;
  dayOfWeek: string;
  timezone: string;
  greeting: string;
}

export interface InjectedContext {
  agent: AgentIdentity;
  user: UserContext;
  temporal: TemporalContext;
  recentMemories: Array<{
    id: string;
    content: string;
    source: string;
    salience: string;
    createdAt: string;
  }>;
  activeProjects: Array<{
    id: string;
    name: string;
    status: string;
  }>;
  sessionHistory?: {
    lastCompactionAt: string | null;
    messagesSinceCompaction: number;
    summary?: string;
  };
}

// ─── Service Interface ───

export interface ISessionService {
  /**
   * Handle an incoming message for a user+agent pair.
   * Resolves session, spawns Claude, processes message, updates state.
   */
  handleMessage(request: SessionRequest): Promise<SessionResult>;

  /**
   * Get or create a session for a user+agent pair.
   * Primary SBs get infinite sessions; task agents get finite ones.
   */
  getOrCreateSession(
    userId: string,
    agentId: string,
    options?: {
      type?: SessionType;
      taskDescription?: string;
      parentSessionId?: string;
      threadKey?: string;
      studioId?: string;
      studioHint?: 'main';
      recipientSessionId?: string;
    }
  ): Promise<Session>;

  /**
   * Get an existing session by ID.
   */
  getSession(sessionId: string): Promise<Session | null>;

  /**
   * List sessions for a user with optional filters.
   */
  listSessions(
    userId: string,
    options?: {
      agentId?: string;
      status?: SessionStatus;
      type?: SessionType;
      limit?: number;
    }
  ): Promise<Session[]>;

  /**
   * Trigger compaction for a session approaching context limit.
   * Sends compaction prompt, waits for agent to persist context,
   * then rotates to fresh Claude session.
   */
  triggerCompaction(sessionId: string): Promise<void>;

  /**
   * End a session (for task agents or explicit termination).
   * Persists final summary, marks session completed.
   */
  endSession(sessionId: string, summary?: string): Promise<void>;

  /**
   * Pause a primary session (between interactions).
   * Different from end - session can be resumed.
   */
  pauseSession(sessionId: string): Promise<void>;

  /**
   * Resume a paused session.
   */
  resumeSession(sessionId: string): Promise<Session>;
}

// ─── Repository Interface ───

export interface ISessionRepository {
  findById(id: string): Promise<Session | null>;

  findByUserAndAgent(
    userId: string,
    agentId: string,
    options?: { status?: SessionStatus; type?: SessionType; studioId?: string }
  ): Promise<Session | null>;

  findByThreadKey?(
    userId: string,
    agentId: string,
    threadKey: string,
    studioId?: string
  ): Promise<Session | null>;

  findByUser(
    userId: string,
    options?: {
      agentId?: string;
      status?: SessionStatus;
      type?: SessionType;
      limit?: number;
    }
  ): Promise<Session[]>;

  create(session: Omit<Session, 'id' | 'startedAt' | 'lastActivityAt'>): Promise<Session>;

  update(id: string, updates: Partial<Session>): Promise<Session>;

  updateTokenUsage(
    id: string,
    usage: { contextTokens: number; inputTokens: number; outputTokens: number }
  ): Promise<void>;

  markCompacted(id: string, newClaudeSessionId: string): Promise<void>;

  /**
   * Atomically acquire a compaction lock for a session.
   * Returns true if lock was acquired, false if already locked.
   * Uses database-level atomicity (UPDATE WHERE compacting_since IS NULL).
   * Stale locks older than staleLockMinutes are automatically reclaimed.
   */
  tryAcquireCompactionLock(id: string, staleLockMinutes?: number): Promise<boolean>;

  /**
   * Release the compaction lock for a session.
   */
  releaseCompactionLock(id: string): Promise<void>;
}

// ─── Context Builder Interface ───

export interface IContextBuilder {
  /**
   * Build the full injected context for an agent message.
   * Queries DB for identity, memories, projects, etc.
   */
  buildContext(userId: string, agentId: string, session: Session): Promise<InjectedContext>;

  /**
   * Build minimal context for a resumed session.
   * Just temporal + brief identity reminder.
   */
  buildMinimalContext(
    userId: string,
    agentId: string,
    session?: Session
  ): Promise<Pick<InjectedContext, 'temporal' | 'agent'>>;

  /**
   * Resolve the preferred runtime backend for an agent identity.
   * Returns raw backend string from DB (e.g. "claude", "codex", "gemini").
   */
  getAgentBackend(userId: string, agentId: string): Promise<string | null>;
}

// ─── Claude Runner Interface ───

export interface ClaudeRunnerConfig {
  workingDirectory: string;
  mcpConfigPath: string;
  model: string;
  systemPrompt?: string;
  appendSystemPrompt?: string;
  pcpAccessToken?: string;
}

export interface ClaudeRunnerResult {
  success: boolean;
  claudeSessionId: string;
  responses: ChannelResponse[];
  usage?: SessionResult['usage'];
  error?: string;
  /** The final text response from Claude (for auto-routing if no explicit send_response) */
  finalTextResponse?: string;
  /** Tool calls captured during this run (for activity stream logging) */
  toolCalls?: ToolCall[];
}

export interface IClaudeRunner {
  /**
   * Run a message through Claude Code.
   * Spawns process with --resume or --session-id as appropriate.
   */
  run(
    message: string,
    options: {
      claudeSessionId?: string;
      injectedContext?: InjectedContext;
      config: ClaudeRunnerConfig;
    }
  ): Promise<ClaudeRunnerResult>;
}
