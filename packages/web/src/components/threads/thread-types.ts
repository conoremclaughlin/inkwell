/**
 * Payloads of the threads API, as this app reads them.
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
  senderSlug: string;
  sentByUser: boolean;
  messageType: string;
  /** One line, capped on the server. */
  preview: string;
  createdAt: string;
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
  senderSlug: string;
  content: string;
  messageType: string;
  priority: string;
  /**
   * A person's reply carries { sentBy: 'user' } here while its sender slot
   * says 'unknown' (see POST /threads/reply). Until the principal columns
   * of spec inkmail-thread-scope §3 land, this marker is how the page tells
   * a person from a genuinely unattributed sender.
   */
  metadata?: Record<string, unknown> | null;
  createdAt: string;
  /** Principal fields from spec inkmail-thread-scope §3, once the server sends them. */
  senderKind?: 'sb' | 'user' | 'system';
  senderName?: string;
  isOwn?: boolean;
}

export interface ThreadMessagesResponse {
  studioHistory?: StudioHistoryItem[];
  thread: {
    threadKey: string;
    title: string | null;
    status: string;
    createdBySlug: string;
    createdAt: string;
    closedAt: string | null;
  } | null;
  messages: ThreadMessage[];
  /** `truncated`: there are older messages than this page. */
  meta?: FeedMeta;
}
