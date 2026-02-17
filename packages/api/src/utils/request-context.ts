/**
 * Request Context
 *
 * Provides two levels of context for MCP tools:
 *
 * 1. Request-scoped context (AsyncLocalStorage):
 *    - Used for web dashboard API calls with JWT auth
 *    - Set in middleware, available during request lifecycle
 *
 * 2. Session-scoped context (global):
 *    - Used for Claude Code sessions
 *    - Set by bootstrap() at session start
 *    - Persists until cleared or replaced
 *
 * Usage:
 * - Web Dashboard: runWithRequestContext() in middleware
 * - Claude Code: setSessionContext() from bootstrap tool
 * - Tools: mergeWithContext() to get best available user identification
 */

import { AsyncLocalStorage } from 'async_hooks';

export interface RequestContextData {
  /** Authenticated user ID */
  userId?: string;
  /** User's email */
  email?: string;
  /** Platform (telegram, whatsapp, etc.) */
  platform?: 'telegram' | 'whatsapp' | 'discord';
  /** Platform-specific user ID */
  platformId?: string;
  /** Agent ID if known (text label) */
  agentId?: string;
  /** Canonical agent_identities UUID (strongest identity binding) */
  identityId?: string;
  /** Session ID if in a session */
  sessionId?: string;
  /** Active product workspace container ID */
  workspaceId?: string;
  /** Conversation ID for channel routing */
  conversationId?: string;
  /** Request timestamp */
  timestamp: Date;
}

const asyncLocalStorage = new AsyncLocalStorage<RequestContextData>();

// Session-scoped context (persists across requests in a session)
// Used primarily for Claude Code where context is set at bootstrap
let sessionContext: Omit<RequestContextData, 'timestamp'> | null = null;

// Session-scoped identity pin (immutable once set by bootstrap or token)
// Prevents mid-session identity changes (e.g. via prompt injection)
let pinnedSessionAgentId: string | null = null;

/**
 * Run a function with request context set.
 * All code within the callback can access the context via getRequestContext().
 */
export function runWithRequestContext<T>(
  context: Omit<RequestContextData, 'timestamp'>,
  fn: () => T | Promise<T>
): T | Promise<T> {
  return asyncLocalStorage.run({ ...context, timestamp: new Date() }, fn);
}

/**
 * Set session-scoped context.
 * Used by bootstrap() to establish user context for the session.
 * Persists until cleared or replaced.
 */
export function setSessionContext(context: Omit<RequestContextData, 'timestamp'> | null): void {
  sessionContext = context;
}

/**
 * Get session-scoped context.
 */
export function getSessionContext(): RequestContextData | undefined {
  if (!sessionContext) return undefined;
  return { ...sessionContext, timestamp: new Date() };
}

/**
 * Clear session context.
 */
export function clearSessionContext(): void {
  sessionContext = null;
}

/**
 * Get the current request context.
 * Returns undefined if no context is set (not within a request).
 */
export function getRequestContext(): RequestContextData | undefined {
  return asyncLocalStorage.getStore();
}

/**
 * Get user identification from context.
 * Checks request context first, then falls back to session context.
 * Returns the best available identifier, preferring userId > email > platform+platformId.
 */
export function getUserFromContext():
  | {
      userId?: string;
      email?: string;
      platform?: string;
      platformId?: string;
    }
  | undefined {
  // Try request context first (higher priority)
  const reqCtx = getRequestContext();
  if (reqCtx?.userId || reqCtx?.email || (reqCtx?.platform && reqCtx?.platformId)) {
    return {
      userId: reqCtx.userId,
      email: reqCtx.email,
      platform: reqCtx.platform,
      platformId: reqCtx.platformId,
    };
  }

  // Fall back to session context
  const sessCtx = getSessionContext();
  if (sessCtx) {
    return {
      userId: sessCtx.userId,
      email: sessCtx.email,
      platform: sessCtx.platform,
      platformId: sessCtx.platformId,
    };
  }

  return undefined;
}

/**
 * Check if current context has user identification.
 * Checks both request context and session context.
 */
export function hasUserContext(): boolean {
  const user = getUserFromContext();
  if (!user) return false;
  return !!(user.userId || user.email || (user.platform && user.platformId));
}

// ============================================================================
// Identity Pinning
// ============================================================================

/**
 * Pin the session to a specific agent identity.
 * Once pinned, the identity is immutable for the session lifetime.
 * Called by bootstrap() and when an agent-bound token is first used.
 * Throws if already pinned to a different identity.
 */
export function pinSessionAgent(agentId: string): void {
  const reqCtx = getRequestContext();
  if (reqCtx) {
    // HTTP request scope: identity is token-bound per request.
    // Never mutate the process-global pin in this mode.
    return;
  }

  if (process.env.MCP_TRANSPORT === 'http') {
    // Streamable HTTP server is long-lived and multi-client.
    // Process-global pinning leaks identity across clients/sessions.
    return;
  }

  if (pinnedSessionAgentId !== null && pinnedSessionAgentId !== agentId) {
    throw new Error(
      `Identity already pinned to "${pinnedSessionAgentId}". Cannot change to "${agentId}".`
    );
  }
  pinnedSessionAgentId = agentId;
}

/**
 * Get the pinned agent identity.
 *
 * In HTTP mode (request context exists): returns agentId from the token only.
 *   The global session pin is NEVER consulted — it's process-global and would
 *   leak identity across concurrent requests from different users/agents.
 *
 * In stdio mode (no request context): returns the session pin set by bootstrap().
 *   Safe because stdio is single-session-per-process.
 *
 * Returns null if no identity is pinned (human user or pre-bootstrap).
 */
export function getPinnedAgentId(): string | null {
  const reqCtx = getRequestContext();
  if (reqCtx) {
    // HTTP mode: only trust the token-bound agentId, never the global pin
    return reqCtx.agentId ?? null;
  }
  if (process.env.MCP_TRANSPORT === 'http') {
    return null;
  }
  // stdio mode: use the session pin from bootstrap()
  return pinnedSessionAgentId;
}

/**
 * Clear the pinned agent identity.
 * Used when cleaning up session state.
 */
export function clearPinnedAgent(): void {
  pinnedSessionAgentId = null;
}

/**
 * Merge explicit args with context.
 * Explicit values take precedence over context.
 */
export function mergeWithContext<T extends Record<string, unknown>>(
  args: T
): T & {
  userId?: string;
  email?: string;
  platform?: string;
  platformId?: string;
  workspaceId?: string;
} {
  const ctx = getUserFromContext();
  const reqCtx = getRequestContext();
  const sessCtx = getSessionContext();
  if (!ctx && !reqCtx?.workspaceId && !sessCtx?.workspaceId) {
    return args as T & {
      userId?: string;
      email?: string;
      platform?: string;
      platformId?: string;
      workspaceId?: string;
    };
  }

  // Only fill in missing values from context
  const merged = {
    ...args,
    userId: (args.userId as string | undefined) ?? ctx?.userId,
    email: (args.email as string | undefined) ?? ctx?.email,
    platform: (args.platform as string | undefined) ?? ctx?.platform,
    platformId: (args.platformId as string | undefined) ?? ctx?.platformId,
    workspaceId:
      (args.workspaceId as string | undefined) ?? reqCtx?.workspaceId ?? sessCtx?.workspaceId,
  };

  return merged as T & {
    userId?: string;
    email?: string;
    platform?: string;
    platformId?: string;
    workspaceId?: string;
  };
}
