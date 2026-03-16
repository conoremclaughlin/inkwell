/**
 * Session Service - Public Exports
 *
 * Stateless session management for multi-user agent orchestration.
 */

// Main service
export {
  SessionService,
  createSessionService,
  type SessionServiceConfig,
  type IActivityStream,
} from './session-service.js';

// Repository (for direct database access if needed)
export { SessionRepository } from './session-repository.js';

// Context builder
export { ContextBuilder, formatInjectedContext } from './context-builder.js';

// Backend runners
export { ClaudeRunner, buildIdentityPrompt } from './claude-runner.js';
export { CodexRunner } from './codex-runner.js';
export { GeminiRunner } from './gemini-runner.js';

// Types
export type {
  // Channel types
  ChannelType,
  ChatType,
  MediaAttachment,

  // Session types
  SessionType,
  SessionStatus,
  Session,

  // Request/Response types
  SessionRequest,
  ChannelResponse,
  SessionResult,

  // Context injection types
  AgentIdentity,
  UserContext,
  TemporalContext,
  InjectedContext,

  // Service interfaces
  ISessionService,
  ISessionRepository,
  IContextBuilder,

  // Runner types
  ClaudeRunnerConfig,
  RunnerResult,
  ClaudeRunnerResult, // deprecated alias
  IRunner,
  IClaudeRunner, // deprecated alias
} from './types.js';
