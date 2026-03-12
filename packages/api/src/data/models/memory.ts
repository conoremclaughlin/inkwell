/**
 * Memory and Session types for long-term memory storage
 */

// Common source values — not exhaustive, DB accepts any string
export type MemorySource =
  | 'conversation'
  | 'observation'
  | 'user_stated'
  | 'inferred'
  | 'session'
  | 'reflection'
  | (string & {});
export type Salience = 'low' | 'medium' | 'high' | 'critical';

export interface Memory {
  id: string;
  userId: string;
  content: string;
  summary?: string; // One-liner for bootstrap injection. Falls back to truncated content.
  topicKey?: string; // Primary structured topic key (e.g., "project:pcp/memory"). Follows type:identifier convention.
  source: MemorySource;
  salience: Salience;
  topics: string[];
  agentId?: string; // Which AI being created this memory (wren, benson, etc). Null = shared memory.
  embedding?: number[]; // 1024 dimensions for Voyage AI, nullable for now
  metadata: Record<string, unknown>;
  version: number;
  createdAt: Date;
  expiresAt?: Date;
}

export type ChangeType = 'update' | 'delete';

export interface MemoryHistory {
  id: string;
  memoryId: string;
  userId: string;
  content: string;
  summary?: string;
  topicKey?: string;
  source: MemorySource;
  salience: Salience;
  topics: string[];
  metadata: Record<string, unknown>;
  version: number;
  createdAt: Date;
  archivedAt: Date;
  changeType: ChangeType;
}

export interface MemoryCreateInput {
  userId: string;
  content: string;
  summary?: string; // One-liner for bootstrap injection
  topicKey?: string; // Primary structured topic key (e.g., "decision:jwt-auth")
  source?: MemorySource;
  salience?: Salience;
  topics?: string[];
  metadata?: Record<string, unknown>;
  expiresAt?: Date;
  agentId?: string; // Which AI being created this memory
}

export interface MemorySearchOptions {
  source?: MemorySource;
  salience?: Salience;
  topics?: string[];
  limit?: number;
  offset?: number;
  includeExpired?: boolean;
  agentId?: string; // Filter by agent
  includeShared?: boolean; // Include shared memories (agentId=null) when filtering. Default true.
}

export type SessionPhase =
  | 'investigating'
  | 'implementing'
  | 'reviewing'
  | 'paused'
  | 'complete'
  | string;

export type SessionLifecycle = 'running' | 'idle' | 'completed' | 'failed';

export interface Session {
  id: string;
  userId: string;
  agentId?: string;
  studioId?: string;
  threadKey?: string;
  /** Runtime lifecycle state: running, idle, completed, failed */
  lifecycle?: SessionLifecycle;
  /** @deprecated Use lifecycle. Kept for backward compat. */
  status?: string;
  currentPhase?: string;
  backend?: string;
  model?: string;
  backendSessionId?: string;
  claudeSessionId?: string;
  workingDir?: string;
  context?: string;
  startedAt: Date;
  endedAt?: Date;
  summary?: string;
  updatedAt?: Date;
  metadata: Record<string, unknown>;
}

export interface SessionCreateInput {
  id?: string;
  userId: string;
  agentId?: string;
  studioId?: string;
  threadKey?: string;
  backend?: string;
  model?: string;
  metadata?: Record<string, unknown>;
}

export interface SessionLog {
  id: string;
  sessionId: string;
  content: string;
  salience: Salience;
  createdAt: Date;
}

export interface SessionLogCreateInput {
  sessionId: string;
  content: string;
  salience?: Salience;
}

// Database row types (snake_case)
export interface MemoryRow {
  id: string;
  user_id: string;
  content: string;
  summary: string | null;
  topic_key: string | null;
  source: MemorySource;
  salience: Salience;
  topics: string[];
  agent_id: string | null;
  embedding: number[] | null;
  metadata: Record<string, unknown>;
  version: number;
  created_at: string;
  expires_at: string | null;
}

export interface MemoryHistoryRow {
  id: string;
  memory_id: string;
  user_id: string;
  content: string;
  summary: string | null;
  topic_key: string | null;
  source: MemorySource;
  salience: Salience;
  topics: string[];
  metadata: Record<string, unknown>;
  version: number;
  created_at: string;
  archived_at: string;
  change_type: ChangeType;
}

export interface SessionRow {
  id: string;
  user_id: string;
  agent_id: string | null;
  studio_id: string | null;
  thread_key: string | null;
  lifecycle?: string | null;
  status?: string | null;
  current_phase: string | null;
  backend?: string | null;
  model?: string | null;
  backend_session_id?: string | null;
  claude_session_id?: string | null;
  working_dir?: string | null;
  context?: string | null;
  started_at: string;
  ended_at: string | null;
  summary: string | null;
  updated_at?: string | null;
  metadata: Record<string, unknown>;
}

export interface SessionLogRow {
  id: string;
  session_id: string;
  content: string;
  salience: Salience;
  created_at: string;
}
