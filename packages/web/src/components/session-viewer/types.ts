export interface ConversationTurn {
  id: string;
  role: 'user' | 'assistant' | 'system';
  timestamp: string;
  blocks: ContentBlock[];
}

export type ContentBlock =
  | TextBlock
  | ToolCallBlock
  | ToolResultBlock
  | ThinkingBlock
  | SystemBlock;

export interface TextBlock {
  kind: 'text';
  text: string;
}

export interface ToolCallBlock {
  kind: 'tool-call';
  toolUseId: string;
  name: string;
  input: unknown;
}

export interface ToolResultBlock {
  kind: 'tool-result';
  toolUseId: string;
  content: string;
  isError: boolean;
}

export interface ThinkingBlock {
  kind: 'thinking';
  text: string;
}

export interface SystemBlock {
  kind: 'system';
  text: string;
  subtype?: string;
}

export interface SessionInfo {
  id: string;
  agentId: string;
  agentName: string;
  backend: string | null;
  backendSessionId: string | null;
  lifecycle: string | null;
  currentPhase: string | null;
  activeThreadKey: string | null;
  startedAt: string;
  updatedAt: string;
  endedAt: string | null;
  studio: {
    id: string;
    branch: string | null;
    repoName: string | null;
    slug: string | null;
  } | null;
}

export interface ConversationResponse {
  session: SessionInfo;
  backend: string;
  turns: ConversationTurn[];
  source: 'synced' | 'local' | 'cloud' | 'none';
  totalEvents: number;
}

export interface SessionListItem {
  id: string;
  agentId: string;
  agentName: string;
  agentRole: string | null;
  backend: string | null;
  lifecycle: string | null;
  currentPhase: string | null;
  activeThreadKey: string | null;
  startedAt: string;
  updatedAt: string;
  endedAt: string | null;
  messageCount: number | null;
  studio: {
    id: string;
    branch: string | null;
    repoName: string | null;
    slug: string | null;
  } | null;
}
