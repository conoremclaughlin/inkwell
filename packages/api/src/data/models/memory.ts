/**
 * Memory and Session types for long-term memory storage
 */

export type MemorySource = 'conversation' | 'observation' | 'user_stated' | 'inferred' | 'session';
export type Salience = 'low' | 'medium' | 'high' | 'critical';

export interface Memory {
  id: string;
  userId: string;
  content: string;
  source: MemorySource;
  salience: Salience;
  topics: string[];
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
  source?: MemorySource;
  salience?: Salience;
  topics?: string[];
  metadata?: Record<string, unknown>;
  expiresAt?: Date;
}

export interface MemorySearchOptions {
  source?: MemorySource;
  salience?: Salience;
  topics?: string[];
  limit?: number;
  offset?: number;
  includeExpired?: boolean;
}

export interface Session {
  id: string;
  userId: string;
  agentId?: string;
  startedAt: Date;
  endedAt?: Date;
  summary?: string;
  metadata: Record<string, unknown>;
}

export interface SessionCreateInput {
  userId: string;
  agentId?: string;
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
  source: MemorySource;
  salience: Salience;
  topics: string[];
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
  started_at: string;
  ended_at: string | null;
  summary: string | null;
  metadata: Record<string, unknown>;
}

export interface SessionLogRow {
  id: string;
  session_id: string;
  content: string;
  salience: Salience;
  created_at: string;
}
