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
  | 'heartbeat'
  | 'web';

export type ChatType = 'direct' | 'group' | 'supergroup' | 'channel';

export interface MediaAttachment {
  type: 'image' | 'video' | 'audio' | 'document' | 'voice';
  path?: string;
  url?: string;
  data?: Buffer;
  contentType?: string;
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

export type SessionLifecycle = 'running' | 'idle' | 'completed' | 'failed';

/** @deprecated Use SessionLifecycle */
export type SessionStatus = 'active' | 'paused' | 'completed' | 'failed';

/**
 * Last cumulative usage seen from a backend that reports running thread
 * totals (Codex `turn.completed.usage` carries `ThreadTokenUsage.total`).
 *
 * Scoped to `backendSessionId` because the totals reset whenever the backend
 * thread changes — resume onto a new thread, compaction, or a fresh run. A
 * checkpoint from a different thread must never be diffed against.
 */
/**
 * One model's accumulated contribution to a session. `costUSD` is the
 * backend's own cost figure, which answers the spend question directly
 * instead of requiring a price table here.
 */
export interface ModelUsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /**
   * The backend's own cost figure. Optional: tokens can be readable while
   * cost is not reported, and publishing 0 there would make a summed cost
   * silently under-report (Lumen, PR #500 round 2).
   */
  costUSD?: number;
  /**
   * True when at least one contribution to `costUSD` did not report a cost, so
   * the figure is a LOWER BOUND rather than the total. Without this, a mixed
   * run publishes a subtotal that reads as complete — the same false certainty
   * as a zero, one level up (Lumen, PR #500 round 3).
   */
  costPartial?: boolean;
  canonicalModel?: string;
}

export interface UsageCheckpoint {
  backendSessionId: string | null;
  inputTokens: number;
  outputTokens: number;
}

export interface Session {
  id: string;
  userId: string;
  agentId: string;
  sbId?: string;
  /** Studio/worktree scope for this session */
  studioId?: string;
  /** Contact scope for per-sender session isolation */
  contactId?: string;
  /** Backend-specific session ID for resume (Claude Code, Codex thread UUID, Gemini session) */
  backendSessionId: string | null;

  type: SessionType;
  /** Runtime lifecycle: running, idle, completed, failed */
  lifecycle: SessionLifecycle;
  /** @deprecated Use lifecycle */
  status: SessionStatus;

  // For task sessions
  taskDescription?: string;
  parentSessionId?: string;

  // Token tracking for compaction decisions
  contextTokens: number;
  totalInputTokens: number;
  totalOutputTokens: number;

  /**
   * Cache breakdown of `totalInputTokens` — NOT additional tokens. Cached
   * input bills at a different rate from fresh input (reads 0.1x, writes
   * 1.25x), so cost attribution needs the split, while context-window math
   * needs the total. Only backends that report caching populate these.
   */
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;

  /**
   * Per-model totals for this session, keyed exactly as the backend reported
   * them. Authoritative for "which models actually ran and what did they
   * cost" — it covers subagents, aliases and mid-session model changes, none
   * of which the single `model` column can express. Keys are never merged
   * here; grouping (e.g. by canonicalModel) belongs to the reporting layer.
   */
  modelUsage?: Record<string, ModelUsageTotals>;

  /**
   * Last cumulative usage observed from a backend that reports running
   * thread totals rather than per-turn deltas (Codex). Used to diff
   * successive reports; see SessionRepository.updateTokenUsage.
   */
  usageCheckpoint?: UsageCheckpoint;

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

  // Human-readable alias for explicit routing (e.g., "main", "review")
  alias?: string;

  // Whether a CLI process with a channel plugin is attached to this session
  cliAttached?: boolean;

  // Flexible metadata
  metadata: Record<string, unknown>;
}

// ─── Multimodal Content Types ───

export interface ImageContent {
  type: 'image';
  source: 'base64';
  mediaType: string;
  data: string;
}

export type ContentBlock = { type: 'text'; text: string } | ImageContent;

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
    studioHint?: string;
    // Contact scope for per-sender session isolation
    contactId?: string;
    // Recipient session to inherit studio scope from
    recipientSessionId?: string;
    // Target a session by alias (e.g., "main", "review")
    sessionAlias?: string;
    // For task sessions
    sessionType?: SessionType;
    taskDescription?: string;
    parentSessionId?: string;
    // Root repo path for cross-project 'main' studio resolution
    repoRoot?: string;
    // Task group ID for strategy lifecycle correlation
    taskGroupId?: string;
    // Docker container name for sandboxed strategy execution
    sandboxContainerName?: string;
  };
}

export interface ChannelResponse {
  channel: ChannelType;
  conversationId: string;
  content: string;
  format?: 'text' | 'markdown' | 'code' | 'json';
  replyToMessageId?: string;
  metadata?: Record<string, unknown>;
  /** Media attachments (images, videos, documents) to send alongside text */
  media?: import('../../agent/types').OutboundMedia[];
  /**
   * Which SB authored this response. Mirrors `AgentResponse.agentId`.
   *
   * Runners that can attribute a response set it directly; otherwise the
   * router stamps the session's acting agent. Undefined means the author is
   * genuinely unknown, and the gateway falls back to the channel's default SB
   * rather than inventing one.
   */
  agentId?: string;
}

export interface SessionResult {
  success: boolean;
  sessionId: string;
  backendSessionId: string | null;

  // Responses routed via send_response
  responses: ChannelResponse[];

  // Token usage from this interaction
  usage?: {
    /**
     * Tokens currently in the backend's context window.
     *
     * Omitted when the backend reports no such measure — Codex JSONL carries
     * none, and aliasing it to a cumulative input total stores a false
     * reading. Absent means unknown, not zero.
     */
    contextTokens?: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    /** This turn's per-model figures, keyed as the backend reported them. */
    modelUsage?: Record<string, ModelUsageTotals>;
    /**
     * True when the backend reports running thread totals instead of a
     * per-turn delta (Codex `turn.completed.usage` is `ThreadTokenUsage.total`).
     * The repository must diff against its checkpoint rather than add.
     */
    cumulative?: boolean;
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
  /** Workspace this identity belongs to — scopes which constitution it reads. */
  workspaceId?: string;
  backend?: string;
  provider?: string;
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

/** Contact identity for per-sender session context */
export interface ContactContext {
  id: string;
  name: string;
  displayName?: string;
  type: 'personal' | 'external' | 'group';
  platform?: string;
}

/**
 * The constitution documents, resolved from the database.
 *
 * Mirrors what `bootstrap` returns as `identityFiles`. Spawned sessions get
 * this from the server because not every backend runs a session-start hook —
 * Antigravity has none at all, so without this the agent starts with nothing
 * but its soul.
 */
export interface ConstitutionDocs {
  /** Shared across the workspace: how the team operates. */
  values?: string;
  process?: string;
  /** Who the human is. */
  user?: string;
  /** Per-agent: operational wake-up checklist. */
  heartbeat?: string;
}

export interface InjectedContext {
  agent: AgentIdentity;
  user: UserContext;
  temporal: TemporalContext;
  /** Constitution docs (values/process/user/heartbeat). Soul lives on `agent`. */
  constitution?: ConstitutionDocs;
  /** Contact identity when in a per-sender session */
  contact?: ContactContext;
  recentMemories: Array<{
    id: string;
    content: string;
    source: string;
    salience: string;
    createdAt: string;
  }>;
  /**
   * The same budgeted, topic-grouped digest `bootstrap` returns. Preferred over
   * rendering `recentMemories` directly — a raw dump of the critical and high
   * tiers ran past 170KB for an agent with a long history.
   */
  knowledgeSummary?: string;
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
      studioHint?: string;
      recipientSessionId?: string;
      contactId?: string;
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
    options?: {
      status?: SessionStatus;
      type?: SessionType;
      studioId?: string;
      contactId?: string;
      /** Canonical identity UUID — preferred over the ambiguous slug. */
      sbId?: string | null;
    }
  ): Promise<Session | null>;

  findByThreadKey?(
    userId: string,
    agentId: string,
    threadKey: string,
    studioId?: string,
    contactId?: string,
    /** Canonical identity UUID — preferred over the ambiguous slug. */
    sbId?: string | null
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

  update(
    id: string,
    updates: Omit<Partial<Session>, 'studioId'> & { studioId?: string | null }
  ): Promise<Session>;

  updateTokenUsage(
    id: string,
    usage: {
      /** Omitted when the backend reports no per-turn context measure. */
      contextTokens?: number;
      inputTokens: number;
      outputTokens: number;
      /** Cache breakdown of `inputTokens`, not additions to it. */
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      /** This turn's per-model figures, keyed as the backend reported them. */
      modelUsage?: Record<string, ModelUsageTotals>;
      /**
       * True when the counts are running totals for `backendSessionId`
       * rather than this turn's delta. The repository diffs them against
       * its stored checkpoint before accumulating.
       */
      cumulative?: boolean;
    },
    options?: { backendSessionId?: string | null }
  ): Promise<void>;

  markCompacted(id: string, newBackendSessionId: string | null): Promise<void>;

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
  getAgentBackend(
    userId: string,
    agentId: string
  ): Promise<{ backend: string | null; provider: string | null }>;
}

// ─── Runner Interface ───

export interface ClaudeRunnerConfig {
  workingDirectory: string;
  mcpConfigPath: string;
  model?: string;
  systemPrompt?: string;
  appendSystemPrompt?: string;
  pcpAccessToken?: string;
  /** PCP session ID for this run — written to runtime hint files so hooks link correctly */
  pcpSessionId?: string;
  /** Agent ID for this run — written to runtime hint files */
  agentId?: string;
  /** Originating channel (heartbeat, telegram, agent, …) — used by runners that label delivered messages */
  channel?: string;
  /** Studio/worktree scope — written to runtime hint so findRuntimeSessionByLinkId matches */
  studioId?: string;
  /** When true, bypass sandbox restrictions (e.g., Codex --dangerously-bypass-approvals-and-sandbox). Opt-in per studio. */
  sandboxBypass?: boolean;
  /**
   * Set by a runner when it has already prefixed this turn's message with the
   * constitution. Surfaces to the child as INK_CONSTITUTION_INJECTED=1 so the
   * session-start hook skips its own copy instead of duplicating ~9k tokens.
   * Only ever true on a fresh spawn — a resume carries the original in history.
   */
  constitutionInjected?: boolean;
  /**
   * Continuation-loop turn cap for InkRunner spawns. Counts OUTER
   * conversational turns — the delivered message plus continuation prompts
   * (runUserTurn cycles) — NOT provider subprocess calls, of which one turn's
   * tool loop may spawn several. Sourced from the SB's dashboard settings
   * (agent_identities.metadata.runtimeConfig.maxTurns); the runner clamps and
   * defaults (5) when absent. signal_status is the sanctioned in-loop halt —
   * this only caps runaway continuations.
   */
  maxTurns?: number;
  /**
   * Tool routing for InkRunner spawns, from the SB's dashboard settings
   * (runtimeConfig.toolRouting). Forwarded as `--tool-routing`; when absent
   * the ink chat loop resolves its own default ('local').
   */
  toolRouting?: 'backend' | 'local';
  /** Root repo path — propagated via context token for cross-project 'main' resolution */
  repoRoot?: string;
  /**
   * This server's own MCP endpoint, derived from the port it actually bound.
   *
   * Needed because a committed `.mcp.json` is not evidence of where the server
   * is listening: `PCP_PORT_BASE=4001 yarn dev` moves the listener without
   * rewriting that file. Runners that hand credentials to a subprocess must
   * target the real endpoint or they leak them to whoever owns the default port.
   */
  inkMcpUrl?: string;
  /**
   * Additional permission rules to merge into .claude/settings.local.json
   * before this session's spawn. Restored to the original after the process
   * exits. Used by strategy configs and 2FA permission grants.
   */
  permissionOverlay?: {
    allow?: string[];
    deny?: string[];
  };
  /** Run the backend CLI inside a Docker container instead of on the host */
  container?: {
    containerName: string;
    dockerBinary?: string;
    /** Host-side directory for runner temp files; bind-mounted as /run/ink inside the container */
    runtimeDir?: string;
  };
}

export interface RunnerResult {
  success: boolean;
  backendSessionId: string | null;
  responses: ChannelResponse[];
  usage?: SessionResult['usage'];
  /**
   * The model that served the main conversation, as the backend reported it
   * on its own top-level assistant messages. Distinct from per-model usage:
   * that says which models spent tokens, this says which one WAS the agent.
   */
  servedModel?: string;
  error?: string;
  /** The final text response from the backend (for auto-routing if no explicit send_response) */
  finalTextResponse?: string;
  /** Tool calls captured during this run (for activity stream logging) */
  toolCalls?: ToolCall[];
}

/** @deprecated Use RunnerResult */
export type ClaudeRunnerResult = RunnerResult;

export interface IRunner {
  /**
   * Run a message through a backend CLI.
   * Spawns process with --resume or equivalent as appropriate.
   */
  run(
    message: string,
    options: {
      backendSessionId?: string;
      injectedContext?: InjectedContext;
      config: ClaudeRunnerConfig;
      /**
       * FUTURE: inline base64 media for API-direct providers and a
       * persistent media store with ready access. No concrete CLI runner
       * consumes this today — CLI-spawned backends receive media as file
       * paths (mediaAttachments) and read the files natively. Kept on the
       * interface so an API-provider runner can adopt it without a
       * boundary change.
       */
      imageContents?: ImageContent[];
      /**
       * Media attachments as local file paths (downloaded by channel
       * listeners to ~/.ink/files/<channel>/). The live path for media:
       * runners forward paths to their backend (ClaudeRunner via
       * --add-dir + paths in the message; InkRunner via --attach-file)
       * and the backend reads the files natively.
       */
      mediaAttachments?: MediaAttachment[];
    }
  ): Promise<RunnerResult>;
}

/** @deprecated Use IRunner */
export type IClaudeRunner = IRunner;
