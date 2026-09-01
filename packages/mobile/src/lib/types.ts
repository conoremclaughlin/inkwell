/**
 * Response shapes for the admin API endpoints this app consumes, mirroring
 * packages/api/src/routes/admin.ts (and kept in step with the web dashboard's
 * copies in packages/web). Fields the app does not render are omitted on
 * purpose — a missing field here is a smaller failure than a wrong one.
 */

// ─── GET /api/admin/threads ───

export interface SpineSession {
  id: string;
  agentId: string | null;
  lifecycle: string | null;
  status: string | null;
  phase: string | null;
  relation: 'anchor' | 'active' | 'both';
  updatedAt: string;
  studioId: string | null;
}

export interface SpineStudio {
  id: string;
  slug: string | null;
  branch: string;
  agentId: string;
  relation: 'affinity' | 'lease' | 'both';
  leaseAgentId: string | null;
  updatedAt: string;
}

export interface SpineGroup {
  id: string;
  title: string;
  status: string | null;
  executionModel: string | null;
  executionPhase: string | null;
  updatedAt: string;
}

export interface ThreadSpine {
  key: string;
  thread: {
    title: string | null;
    status: string;
    createdByAgentId: string;
    participants: string[];
    closedAt: string | null;
  } | null;
  sessions: SpineSession[];
  studios: SpineStudio[];
  taskGroups: SpineGroup[];
  participants: string[];
  sources: Array<'thread' | 'session' | 'studio' | 'group'>;
  lastActivityAt: string;
}

export interface ThreadsResponse {
  spines: ThreadSpine[];
}

// ─── GET /api/admin/threads/messages?key= ───

export interface ThreadMessage {
  id: string;
  senderAgentId: string;
  content: string;
  messageType: string;
  priority: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface ThreadMessagesResponse {
  thread: {
    threadKey: string;
    title: string | null;
    status: string;
    createdByAgentId: string;
    createdAt: string;
    closedAt: string | null;
  } | null;
  messages: ThreadMessage[];
  meta?: { fetched: number; total: number; truncated: boolean };
}

// ─── POST /api/admin/threads/reply ───

export interface ReplyResponse {
  success: boolean;
  messageId: string | null;
  threadId: string;
  warning?: string | null;
}

// ─── GET /api/admin/sessions ───

export interface FleetSession {
  id: string;
  agentId: string | null;
  agentName: string;
  lifecycle: string;
  status: string | null;
  currentPhase: string | null;
  threadKey: string | null;
  activeThreadKey: string | null;
  summary: string | null;
  context: string | null;
  backend: string | null;
  model: string | null;
  startedAt: string | null;
  updatedAt: string;
}

export interface SessionsResponse {
  stats: {
    running: number;
    generating: number;
    idle: number;
    blocked: number;
    paused: number;
    total: number;
  };
  sessions: FleetSession[];
}

// ─── POST /api/admin/auth/mobile-login / mobile-refresh ───

export interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  userId: string;
  email: string;
}

export interface RefreshResponse {
  accessToken: string;
  expiresIn: number;
  userId: string;
  email: string;
}

// ─── GET /api/admin/workspaces ───

export interface Workspace {
  id: string;
  name: string;
  slug: string | null;
  type: string | null;
  role: string | null;
  description: string | null;
  archivedAt: string | null;
}

export interface WorkspacesResponse {
  currentWorkspaceId: string | null;
  currentWorkspaceRole: string | null;
  workspaces: Workspace[];
}
