/**
 * Payloads of the threads API, as every client reads them — the web
 * dashboard, the mobile app, and whatever comes next.
 * Mirrors GET /api/admin/threads and GET /api/admin/threads/messages.
 */

export interface SpineIdentity {
  project: string | null;
  type: string | null;
  id: string | null;
  pinned: boolean;
}

export interface SpineSession {
  id: string;
  sbSlug: string | null;
  lifecycle: string | null;
  status: string | null;
  phase: string | null;
  relation: 'anchor' | 'active' | 'both';
  /** Working right now — decided on the server (isSessionLive), not from lifecycle. */
  live?: boolean;
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

export interface ThreadLastMessage {
  id: string;
  /** The author's principal kind (spec inkmail-thread-scope §3). */
  senderKind: 'sb' | 'user' | 'system';
  /** The SB's slug; for a person or the system, the kind. */
  senderSlug: string;
  /** Named for this viewer on the server: SB slug, person's name, or 'system'. */
  senderName: string;
  /** The viewer wrote it. */
  isOwn: boolean;
  messageType: string;
  /** One line, capped on the server. */
  preview: string;
  createdAt: string;
}

/** A person on a thread, named for the viewer. */
export interface ThreadPerson {
  userId: string;
  name: string;
  isOwn: boolean;
}

export interface ThreadSpine {
  key: string;
  identity: SpineIdentity | null;
  thread: {
    title: string | null;
    summary?: string | null;
    status: string;
    createdBySlug: string;
    participants: string[];
    /** People on the thread, named for the viewer — never woken, never in `participants`. */
    people?: ThreadPerson[];
    closedAt: string | null;
    /** Newest deliverable message; absent from servers that predate it. */
    lastMessage?: ThreadLastMessage | null;
  } | null;
  sessions: SpineSession[];
  studios: SpineStudio[];
  taskGroups: SpineGroup[];
  participants: string[];
  sources: Array<'thread' | 'session' | 'studio' | 'group'>;
  lastActivityAt: string;
}

export interface FeedMeta {
  fetched: number;
  total: number;
  truncated: boolean;
}

export interface ThreadsResponse {
  spines: ThreadSpine[];
  meta: {
    threads: FeedMeta;
    sessions: FeedMeta;
    taskGroups: FeedMeta;
    parseUnavailable: boolean;
  };
}

export interface StudioHistoryItem {
  studioId: string;
  slug: string | null;
  branch: string | null;
  status: string;
  agents: string[];
  firstAt: string;
  lastAt: string;
  lastEvent: string;
}

export interface ThreadMessage {
  id: string;
  /** The author is a principal (spec inkmail-thread-scope §3). */
  senderKind: 'sb' | 'user' | 'system';
  /** The SB's slug; for a person or the system, the kind. */
  senderSlug: string;
  senderSbId?: string | null;
  senderUserId?: string | null;
  /** Named on the server for this viewer: SB slug, person's name, or 'system'. */
  senderName?: string;
  /** The viewer's own message — decided on the server against the Inkwell user. */
  isOwn?: boolean;
  content: string;
  messageType: string;
  priority: string;
  metadata?: Record<string, unknown> | null;
  createdAt: string;
}

export interface ThreadMessagesResponse {
  studioHistory?: StudioHistoryItem[];
  thread: {
    threadKey: string;
    title: string | null;
    status: string;
    createdBySlug: string;
    createdByKind?: 'sb' | 'user' | 'system';
    createdAt: string;
    closedAt: string | null;
  } | null;
  messages: ThreadMessage[];
  /** The Inkwell user this response was rendered for. */
  viewerUserId?: string;
  /** `truncated`: there are older messages than this page. */
  meta?: FeedMeta;
}
