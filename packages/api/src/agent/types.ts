/**
 * Agent Backend Types
 *
 * Defines the contract for agent backends (Claude Code, Direct API, etc.)
 * and the message/response types they work with.
 */

import { EventEmitter } from 'events';

export type ChannelType = 'telegram' | 'terminal' | 'discord' | 'whatsapp' | 'http' | 'api';
export type BackendType = 'claude-code' | 'direct-api';
export type ResponseFormat = 'text' | 'markdown' | 'code' | 'json';

/**
 * Bootstrap context injected into messages for context continuity
 */
export interface InjectedContext {
  user?: {
    id: string;
    summary?: string;
    metadata?: Record<string, unknown>;
  };
  assistant?: {
    summary?: string;
    metadata?: Record<string, unknown>;
  };
  relationship?: {
    summary?: string;
  };
  activeProjects?: Array<{
    id: string;
    name: string;
    description?: string;
    status: string;
  }>;
  currentFocus?: {
    projectId?: string;
    summary?: string;
  };
  recentMemories?: Array<{
    content: string;
    source: string;
    topics: string[];
  }>;
}

/**
 * Message coming INTO the agent from a channel
 */
export interface AgentMessage {
  id: string;
  channel: ChannelType;
  conversationId: string;
  sender: {
    id: string;
    name?: string;
    platform?: string;
  };
  content: string;
  timestamp: Date;
  metadata?: Record<string, unknown>;

  // Context that should be included
  context?: {
    userId?: string;
    projectId?: string;
    sessionId?: string;
    replyToMessageId?: string;
  };

  // Auto-injected context from bootstrap (set by SessionHost)
  injectedContext?: InjectedContext;
}

/**
 * Response going OUT from the agent to a channel
 * This is what the send_response MCP tool receives
 */
export interface AgentResponse {
  channel: ChannelType;
  conversationId: string;
  content: string;
  format?: ResponseFormat;
  replyToMessageId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Backend health status
 */
export interface BackendHealth {
  healthy: boolean;
  lastCheck: Date;
  sessionId?: string;
  uptime?: number;
  messageCount?: number;
  error?: string;
}

/**
 * Configuration for agent backends
 */
export interface BackendConfig {
  type: BackendType;

  // Claude Code specific
  mcpConfigPath?: string;
  workingDirectory?: string;
  model?: string;
  systemPrompt?: string;

  // Direct API specific
  apiKey?: string;
  baseUrl?: string;
  maxTokens?: number;

  // Common
  timeout?: number;
  retryAttempts?: number;
}

/**
 * The core interface all agent backends must implement
 * Extends EventEmitter for event-based communication
 */
export interface AgentBackend extends EventEmitter {
  readonly type: BackendType;

  /**
   * Initialize the backend (start process, connect to API, etc.)
   */
  initialize(): Promise<void>;

  /**
   * Gracefully shutdown the backend
   */
  shutdown(): Promise<void>;

  /**
   * Send a message to the agent for processing
   * Response comes back via MCP send_response tool, not return value
   */
  sendMessage(message: AgentMessage): Promise<void>;

  /**
   * Check if the backend is ready to receive messages
   */
  isReady(): boolean;

  /**
   * Get health status
   */
  getHealth(): BackendHealth;

  /**
   * Get the current session ID (if applicable)
   */
  getSessionId(): string | null;

  /**
   * Resume a previous session (if supported)
   */
  resumeSession?(sessionId: string): Promise<boolean>;
}

/**
 * Callback for when a response is ready to be sent
 * Registered by the session host to handle MCP send_response calls
 */
export type ResponseHandler = (response: AgentResponse) => Promise<void>;

/**
 * Events emitted by backends
 */
export interface BackendEvents {
  ready: () => void;
  error: (error: Error) => void;
  message: (content: string) => void;
  exit: (code: number | null) => void;
}
