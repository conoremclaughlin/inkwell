/**
 * Response shapes for the admin API endpoints this app consumes, mirroring
 * packages/api/src/routes/admin.ts. The threads endpoints' shapes come from
 * @inklabs/shared, shared with the web dashboard. For the rest, fields the
 * app does not render are omitted on purpose: a missing field here is a
 * smaller failure than a wrong one.
 */

// ─── GET /api/admin/threads, GET /api/admin/threads/messages ───
// Shared with every client: @inklabs/shared/stories/threads-api holds the one
// copy of these shapes, so the web dashboard and this app cannot drift.

export type {
  SpineGroup,
  SpineSession,
  SpineStudio,
  ThreadLastMessage,
  ThreadMessage,
  ThreadMessagesResponse,
  ThreadPerson,
  ThreadSpine,
  ThreadsResponse,
} from '@inklabs/shared/stories/threads-api';

// ─── POST /api/admin/threads/reopen ───

export interface ReopenResponse {
  success: boolean;
  threadKey: string;
  reopened: boolean;
  alreadyOpen: boolean;
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
  sbSlug: string | null;
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
  messageCount: number | null;
  startedAt: string | null;
  updatedAt: string;
  endedAt: string | null;
  studio: { id: string; branch: string | null; repoName: string | null } | null;
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

// ─── POST /api/admin/auth/mobile-signup ───

export type SignupResponse =
  | { confirmationRequired: true; email: string }
  | ({ confirmationRequired: false } & LoginResponse);

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

// ─── GET /api/admin/sessions/:id/conversation ───

export interface SessionInfo {
  id: string;
  sbSlug: string;
  agentName: string;
  backend: string | null;
  backendSessionId: string | null;
  lifecycle: string | null;
  currentPhase: string | null;
  activeThreadKey: string | null;
  startedAt: string;
  updatedAt: string;
  endedAt: string | null;
}

export interface SessionConversationResponse {
  session: SessionInfo;
  source: 'synced' | 'local' | 'cloud' | 'none';
  backend: string;
  transcript: { events: unknown[] } | null;
  totalEvents: number;
}

// ─── GET /api/admin/sessions/:id/logs ───

export interface SessionLogItem {
  id: string;
  source: 'activity_stream' | 'session_logs' | 'local_transcript' | 'synced_transcript';
  type: string;
  role: 'in' | 'out' | 'system';
  content: string;
  timestamp: string;
}

export interface SessionLogsResponse {
  session: {
    id: string;
    sbSlug: string | null;
    status: string | null;
    currentPhase: string | null;
    backend: string | null;
    startedAt: string;
    updatedAt: string;
    endedAt: string | null;
  };
  logs: SessionLogItem[];
  pagination: { total: number; limit: number; offset: number; hasMore: boolean };
  sources: { cloud: number; synced: number; local: number };
}

// ─── GET /api/admin/individuals ───

export interface Individual {
  id: string;
  sbSlug: string;
  name: string;
  role: string | null;
  backend: string | null;
  description: string | null;
}

export interface IndividualsResponse {
  individuals: Individual[];
}

// ─── POST /api/admin/threads ───

export interface StartThreadInput {
  key: string;
  recipients: string[];
  content: string;
  title?: string;
  priority?: 'low' | 'normal' | 'high' | 'urgent';
  /** Single recipient only: pin the wake to one of their studios ("main" = home). */
  studioSlug?: string;
}

export interface StartThreadResponse {
  success: boolean;
  created: boolean;
  messageId: string | null;
  threadId: string | null;
  threadKey: string;
  warning?: string | null;
}
