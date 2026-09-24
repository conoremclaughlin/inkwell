/**
 * Response shapes for the admin API endpoints this app consumes, mirroring
 * packages/api/src/routes/admin.ts (and kept in step with the web dashboard's
 * copies in packages/web). Fields the app does not render are omitted on
 * purpose — a missing field here is a smaller failure than a wrong one.
 */

// ─── GET /api/admin/threads ───

export interface SpineSession {
  id: string;
  sbSlug: string | null;
  lifecycle: string | null;
  status: string | null;
  phase: string | null;
  relation: 'anchor' | 'active' | 'both';
  /**
   * Whether this session is working right now. Computed by the server
   * (isSessionLive in thread-spines.ts) because `lifecycle` alone is not
   * evidence: nothing reaps abandoned sessions, so rows sit at `running` for
   * months. Do not re-derive presence here — there is one owner for the rule.
   */
  live: boolean;
  updatedAt: string;
  studioId: string | null;
}

export interface SpineStudio {
  id: string;
  slug: string | null;
  branch: string;
  sbSlug: string;
  relation: 'affinity' | 'lease' | 'both';
  leaseSlug: string | null;
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
    /** One-line "what is this about" (DB-capped at 280 chars); often absent. */
    summary: string | null;
    status: string;
    createdBySlug: string;
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
  /** Who wrote it (spec inkmail-thread-scope §3): an SB, a person, or the system. */
  senderKind: 'sb' | 'user' | 'system';
  /** The SB's display slug; the kind for a person or the system. */
  senderSlug: string | null;
  senderSbId: string | null;
  senderUserId: string | null;
  /** Named on the server: the SB's slug, the person's profile name, or 'system'. */
  senderName: string;
  /** The viewer's own message — decided on the server against the PCP user, never here. */
  isOwn: boolean;
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
    createdBySlug: string;
    createdAt: string;
    closedAt: string | null;
  } | null;
  messages: ThreadMessage[];
  /** The PCP user this response was rendered for. */
  viewerUserId?: string;
  meta?: { fetched: number; total: number; truncated: boolean };
}

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
