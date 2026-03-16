import { Command } from 'commander';
import chalk from 'chalk';
import { PcpClient } from '../lib/pcp-client.js';
import { renderSessionsByAgent, type Session } from './session.js';
import { renderInkMission, type InkMission } from '../repl/ink/index.js';
import type { FeedEvent, FeedEventType, AgentSummary } from '../repl/ink/index.js';
import { formatHumanTime } from '../repl/tui-components.js';

interface MissionOptions {
  agent?: string;
  limit?: string;
  watch?: boolean;
  interval?: string;
  attach?: string;
  feed?: boolean;
  feedLimit?: string;
  json?: boolean;
  fullscreen?: boolean;
}

interface MissionRow {
  agent: string;
  activeSessions: number;
  unreadInbox: number;
  latestSessionId?: string;
  latestThreadKey?: string;
  latestLifecycle?: string;
  latestPhase?: string;
  latestBackendSessionId?: string;
  sessionsByLifecycle?: Record<string, number>;
}

interface MissionSnapshot {
  rows: MissionRow[];
  sessions: Session[];
  feed: MissionFeedRow[];
  inboxMessages: InboxMessage[];
  generatedAt: string;
}

export interface MissionActivity {
  id: string;
  type?: string;
  subtype?: string;
  agentId?: string;
  content?: string;
  sessionId?: string;
  platform?: string;
  status?: string;
  createdAt?: string;
  payload?: Record<string, unknown>;
}

export interface InboxMessage {
  id: string;
  subject?: string;
  content?: string;
  messageType?: string;
  priority?: string;
  status?: string;
  senderAgentId?: string;
  threadKey?: string;
  metadata?: Record<string, unknown>;
  createdAt?: string;
  recipientAgentId?: string;
}

interface MissionFeedRow {
  id: string;
  timestamp?: string;
  type: string;
  route: string;
  studio: string;
  preview: string;
}

// ── Inbox extraction ──

export function extractInboxMessages(
  result: Record<string, unknown> | null | undefined
): InboxMessage[] {
  if (!result) return [];
  const candidate =
    (Array.isArray(result.messages) ? result.messages : undefined) ||
    (Array.isArray(result.inbox) ? result.inbox : undefined) ||
    (Array.isArray(result.data) ? result.data : undefined) ||
    [];

  const legacyMessages = candidate
    .map((entry): InboxMessage | undefined => {
      const row = entry as Record<string, unknown>;
      const id = row.id;
      if (typeof id !== 'string') return undefined;
      return {
        id,
        subject: typeof row.subject === 'string' ? row.subject : undefined,
        content: typeof row.content === 'string' ? row.content : undefined,
        messageType: typeof row.messageType === 'string' ? row.messageType : undefined,
        priority: typeof row.priority === 'string' ? row.priority : undefined,
        status: typeof row.status === 'string' ? row.status : undefined,
        senderAgentId: typeof row.senderAgentId === 'string' ? row.senderAgentId : undefined,
        threadKey: typeof row.threadKey === 'string' ? row.threadKey : undefined,
        metadata:
          row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
            ? (row.metadata as Record<string, unknown>)
            : undefined,
        createdAt: typeof row.createdAt === 'string' ? row.createdAt : undefined,
        recipientAgentId:
          typeof row.recipientAgentId === 'string' ? row.recipientAgentId : undefined,
      };
    })
    .filter((msg): msg is InboxMessage => Boolean(msg));

  // Also extract thread preview messages from threadsWithUnread
  const threadMessages: InboxMessage[] = [];
  const threads = Array.isArray(result.threadsWithUnread) ? result.threadsWithUnread : [];
  for (const thread of threads) {
    const t = thread as Record<string, unknown>;
    const threadKey = typeof t.threadKey === 'string' ? t.threadKey : undefined;
    const participants = Array.isArray(t.participants) ? (t.participants as string[]) : [];
    const previews = Array.isArray(t.previewMessages) ? t.previewMessages : [];
    for (const preview of previews) {
      const p = preview as Record<string, unknown>;
      const sender = typeof p.senderAgentId === 'string' ? p.senderAgentId : undefined;
      const content = typeof p.content === 'string' ? p.content : undefined;
      const createdAt = typeof p.createdAt === 'string' ? p.createdAt : undefined;
      const msgType = typeof p.messageType === 'string' ? p.messageType : undefined;
      if (!createdAt) continue;
      // Derive recipient: the other participant(s) in the thread
      const recipients = participants.filter((id) => id !== sender);
      threadMessages.push({
        id: `thread-${threadKey}-${createdAt}`,
        content,
        messageType: msgType,
        senderAgentId: sender,
        recipientAgentId: recipients[0],
        threadKey,
        createdAt,
      });
    }
  }

  return [...legacyMessages, ...threadMessages];
}

export function inboxMessageToFeedEvent(msg: InboxMessage, timezone?: string): FeedEvent {
  const maxPreview = Math.min(120, (process.stdout.columns || 80) - 25);
  const sender = msg.senderAgentId || 'user';
  const recipient = msg.recipientAgentId || 'unknown';

  // Build content line
  const preview = msg.subject || compactPreview(msg.content, maxPreview);
  const typeTag = msg.messageType && msg.messageType !== 'message' ? `[${msg.messageType}] ` : '';
  const content = `from ${sender}: ${typeTag}${preview}`;

  // Map messageType to feed event type
  let type: FeedEventType = 'inbox';
  if (msg.messageType === 'task_request') type = 'task';
  if (msg.messageType === 'session_resume') type = 'session';

  // Extract routing metadata from inbox `metadata.pcp.recipient`
  const pcp = msg.metadata?.pcp as Record<string, unknown> | undefined;
  const recipientMeta = pcp?.recipient as Record<string, unknown> | undefined;
  const studioHint =
    typeof recipientMeta?.studioHint === 'string' ? recipientMeta.studioHint : undefined;
  const studioId = typeof recipientMeta?.studioId === 'string' ? recipientMeta.studioId : undefined;

  const detailParts: string[] = [];
  if (msg.messageType && msg.messageType !== 'message') {
    detailParts.push(`type: ${msg.messageType}`);
  }
  if (msg.threadKey) detailParts.push(`thread: ${msg.threadKey}`);
  const studioLabel = studioHint || (studioId ? studioId.slice(0, 8) : undefined);
  if (studioLabel) detailParts.push(`studio: ${studioLabel}`);
  if (msg.priority && msg.priority !== 'normal') detailParts.push(`priority: ${msg.priority}`);

  return {
    id: `inbox-${msg.id}`,
    type,
    agent: recipient,
    content,
    time: formatHumanTime(msg.createdAt, timezone),
    detail: detailParts.length > 0 ? detailParts.join('  ·  ') : undefined,
  };
}

export function resolveAttachCommand(
  sessions: Session[],
  target: string
): { command: string; sessionId: string; agentId: string } | null {
  const trimmed = target.trim();
  if (!trimmed) return null;

  const directMatch = sessions.find((session) => session.id.startsWith(trimmed));
  if (directMatch) {
    const agentId = directMatch.agentId || 'wren';
    return {
      command: `sb chat -a ${agentId} --session-id ${directMatch.id}`,
      sessionId: directMatch.id,
      agentId,
    };
  }

  const byAgent = sessions
    .filter((session) => (session.agentId || '').toLowerCase() === trimmed.toLowerCase())
    .sort((a, b) => Date.parse(b.startedAt || '') - Date.parse(a.startedAt || ''))[0];
  if (!byAgent) return null;

  const agentId = byAgent.agentId || trimmed;
  return {
    command: `sb chat -a ${agentId} --session-id ${byAgent.id}`,
    sessionId: byAgent.id,
    agentId,
  };
}

function parseSessions(result: Record<string, unknown>): Session[] {
  if (Array.isArray(result.sessions)) {
    return result.sessions as Session[];
  }

  if (Array.isArray(result.data)) {
    return result.data as Session[];
  }

  const nested = result.data as Record<string, unknown> | undefined;
  if (nested && Array.isArray(nested.sessions)) {
    return nested.sessions as Session[];
  }

  return [];
}

export function extractUnreadCount(result: Record<string, unknown>): number {
  // Prefer totalUnreadCount (includes thread unreads) over legacy unreadCount
  const total = result.totalUnreadCount;
  if (typeof total === 'number' && Number.isFinite(total)) {
    return total;
  }

  const explicit = result.unreadCount;
  if (typeof explicit === 'number' && Number.isFinite(explicit)) {
    return explicit;
  }

  const count = result.count;
  if (typeof count === 'number' && Number.isFinite(count)) {
    return count;
  }

  if (Array.isArray(result.messages)) {
    return result.messages.length;
  }

  if (Array.isArray(result.inbox)) {
    return result.inbox.length;
  }

  const data = result.data as Record<string, unknown> | undefined;
  if (data) {
    if (typeof data.unreadCount === 'number' && Number.isFinite(data.unreadCount)) {
      return data.unreadCount;
    }
    if (Array.isArray(data.messages)) {
      return data.messages.length;
    }
  }

  return 0;
}

function extractActivities(result: Record<string, unknown> | null | undefined): MissionActivity[] {
  if (!result) return [];
  const candidate =
    (Array.isArray(result.activities) ? result.activities : undefined) ||
    (Array.isArray(result.data) ? result.data : undefined) ||
    [];

  return candidate
    .map((entry): MissionActivity | undefined => {
      const row = entry as Record<string, unknown>;
      const id = row.id;
      if (typeof id !== 'string') return undefined;
      return {
        id,
        type: typeof row.type === 'string' ? row.type : undefined,
        subtype: typeof row.subtype === 'string' ? row.subtype : undefined,
        agentId:
          typeof row.agentId === 'string'
            ? row.agentId
            : typeof row.agent_id === 'string'
              ? row.agent_id
              : undefined,
        content: typeof row.content === 'string' ? row.content : undefined,
        sessionId:
          typeof row.sessionId === 'string'
            ? row.sessionId
            : typeof row.session_id === 'string'
              ? row.session_id
              : undefined,
        platform: typeof row.platform === 'string' ? row.platform : undefined,
        status: typeof row.status === 'string' ? row.status : undefined,
        createdAt:
          typeof row.createdAt === 'string'
            ? row.createdAt
            : typeof row.created_at === 'string'
              ? row.created_at
              : undefined,
        payload:
          row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload)
            ? (row.payload as Record<string, unknown>)
            : undefined,
      };
    })
    .filter((activity): activity is MissionActivity => Boolean(activity));
}

/** Parse "project--slug" worktree folder into "project / slug" display format. */
export function formatWorktreeLabel(folder: string): string {
  const dashIdx = folder.indexOf('--');
  if (dashIdx > 0) {
    return `${folder.slice(0, dashIdx)} / ${folder.slice(dashIdx + 2)}`;
  }
  return folder;
}

/**
 * Format a state_change activity into a human-readable summary showing actual values.
 * Payload shape: { changedFields, before, after, ... }
 */
function formatStateChange(activity: MissionActivity): string {
  const p = activity.payload;
  const after = p?.after as Record<string, unknown> | undefined;
  const changedFields = p?.changedFields as string[] | undefined;

  if (!after || !changedFields?.length) {
    // Fallback to raw content if payload is missing
    return (activity.content || 'session updated').replace(/\s+/g, ' ').trim();
  }

  const sessionId =
    typeof p?.sessionId === 'string' ? p.sessionId.slice(0, 8) : activity.sessionId?.slice(0, 8);

  // Show the values that changed, not just the field names
  const parts: string[] = [];
  for (const field of changedFields) {
    const val = after[field];
    if (val == null || val === '') continue;
    const strVal = String(val);
    // Skip very long values (like context blobs) in the summary line
    if (strVal.length > 80) continue;
    parts.push(`${field}: ${strVal}`);
  }

  if (parts.length === 0) {
    return `Session ${sessionId || '?'} updated (${changedFields.join(', ')})`;
  }

  return `Session ${sessionId || '?'} → ${parts.join(', ')}`;
}

function compactPreview(value?: string, max = 110): string {
  const normalized = (value || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '-';
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(1, max - 1))}…`;
}

export function repoNameFromPath(dir?: string): string | null {
  if (!dir) return null;
  // Extract the last path component as the repo name
  const name = dir.replace(/\/+$/, '').split('/').pop();
  return name || null;
}

export function studioLabelForSession(session?: Session): string {
  if (!session) return '-';
  const studioId = session.studioId || session.studio?.id;
  const worktree = session.studio?.worktreeFolder;
  if (worktree) return formatWorktreeLabel(worktree);
  if (studioId) return studioId.slice(0, 8);
  // Fallback: extract repo name from workingDir
  const repo = repoNameFromPath(session.workingDir);
  if (repo) return repo;
  return '-';
}

function parseTriggerEnvelope(
  content?: string
): { from?: string; messageType?: string; summary?: string } | undefined {
  if (!content) return undefined;
  const fromMatch = content.match(/^\[TRIGGER from ([^\]]+)\]/im);
  const typeMatch = content.match(/^Type:\s*(.+)$/im);
  const summaryMatch = content.match(/^Summary:\s*(.+)$/im);
  if (!fromMatch && !typeMatch && !summaryMatch) return undefined;
  return {
    from: fromMatch?.[1]?.trim(),
    messageType: typeMatch?.[1]?.trim(),
    summary: summaryMatch?.[1]?.trim(),
  };
}

export function summarizeMissionFeedRows(
  activities: MissionActivity[],
  sessions: Session[]
): MissionFeedRow[] {
  const sessionsById = new Map(sessions.map((session) => [session.id, session]));
  return activities
    .slice()
    .sort((a, b) => {
      const ams = a.createdAt ? Date.parse(a.createdAt) : 0;
      const bms = b.createdAt ? Date.parse(b.createdAt) : 0;
      return (Number.isNaN(ams) ? 0 : ams) - (Number.isNaN(bms) ? 0 : bms);
    })
    .map((activity) => {
      const trigger = parseTriggerEnvelope(activity.content);
      const actor = activity.agentId || 'system';
      const platform = activity.platform || '-';
      const sessionStudio = studioLabelForSession(
        activity.sessionId ? sessionsById.get(activity.sessionId) : undefined
      );
      const type = activity.subtype
        ? `${activity.type}:${activity.subtype}`
        : activity.type || 'activity';

      if (activity.type === 'message_in') {
        const from = trigger?.from || (platform === 'agent' ? 'agent' : platform);
        const kind = trigger?.messageType ? `inbox:${trigger.messageType}` : 'inbox';
        return {
          id: activity.id,
          timestamp: activity.createdAt,
          type: kind,
          route: `${from} → ${actor}`,
          studio: sessionStudio,
          preview: compactPreview(trigger?.summary || activity.content),
        };
      }

      if (activity.type === 'message_out') {
        return {
          id: activity.id,
          timestamp: activity.createdAt,
          type: 'outbound',
          route: `${actor} → ${platform}`,
          studio: sessionStudio,
          preview: compactPreview(activity.content),
        };
      }

      return {
        id: activity.id,
        timestamp: activity.createdAt,
        type,
        route: actor,
        studio: sessionStudio,
        preview: compactPreview(activity.content),
      };
    });
}

function inboxMessageToFeedRow(msg: InboxMessage): MissionFeedRow {
  const sender = msg.senderAgentId || 'user';
  const recipient = msg.recipientAgentId || 'unknown';

  const typeTag = msg.messageType
    ? msg.messageType === 'message'
      ? 'inbox'
      : `inbox:${msg.messageType}`
    : 'inbox';

  const pcp = msg.metadata?.pcp as Record<string, unknown> | undefined;
  const recipientMeta = pcp?.recipient as Record<string, unknown> | undefined;
  const studioHint =
    typeof recipientMeta?.studioHint === 'string' ? recipientMeta.studioHint : undefined;
  const studioId = typeof recipientMeta?.studioId === 'string' ? recipientMeta.studioId : undefined;

  return {
    id: `inbox-${msg.id}`,
    timestamp: msg.createdAt,
    type: typeTag,
    route: `${sender} → ${recipient}`,
    studio: studioHint || (studioId ? studioId.slice(0, 8) : '-'),
    preview: compactPreview(msg.subject || msg.content),
  };
}

function newestSession(sessions: Session[]): Session | undefined {
  return sessions
    .slice()
    .sort((a, b) => Date.parse(b.startedAt || '') - Date.parse(a.startedAt || ''))[0];
}

export function summarizeMissionRows(
  sessions: Session[],
  unreadByAgent: Record<string, number>,
  lifecycleByAgent?: Record<string, Record<string, number>>
): MissionRow[] {
  const grouped = new Map<string, Session[]>();

  for (const session of sessions) {
    const agent = session.agentId || 'unknown';
    const list = grouped.get(agent) || [];
    list.push(session);
    grouped.set(agent, list);
  }

  const allAgents = new Set<string>([...Array.from(grouped.keys()), ...Object.keys(unreadByAgent)]);

  return Array.from(allAgents)
    .map((agent) => {
      const list = grouped.get(agent) || [];
      const latest = newestSession(list);

      // Count sessions by lifecycle
      const byLifecycle: Record<string, number> = {};
      for (const s of list) {
        const lc = s.lifecycle || 'unknown';
        byLifecycle[lc] = (byLifecycle[lc] || 0) + 1;
      }

      return {
        agent,
        activeSessions: list.length,
        unreadInbox: unreadByAgent[agent] || 0,
        latestSessionId: latest?.id,
        latestThreadKey: latest?.threadKey,
        latestLifecycle: latest?.lifecycle || 'idle',
        latestPhase: latest?.currentPhase || undefined,
        latestBackendSessionId: latest?.backendSessionId || latest?.claudeSessionId,
        sessionsByLifecycle:
          lifecycleByAgent?.[agent] ||
          (Object.keys(byLifecycle).length > 0 ? byLifecycle : undefined),
      } satisfies MissionRow;
    })
    .sort((a, b) => {
      if (b.activeSessions !== a.activeSessions) return b.activeSessions - a.activeSessions;
      if (b.unreadInbox !== a.unreadInbox) return b.unreadInbox - a.unreadInbox;
      return a.agent.localeCompare(b.agent);
    });
}

function pad(value: string, width: number): string {
  return value.length >= width ? value.slice(0, width) : value.padEnd(width);
}

function formatTime(iso?: string): string {
  if (!iso) return '-';
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '-';
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function renderMissionTable(rows: MissionRow[]): string[] {
  const lines: string[] = [];

  lines.push(
    chalk.dim(
      'SB       active  unread  latest-id  lifecycle   phase                 thread        backend-id '
    )
  );
  for (const row of rows) {
    lines.push(
      chalk.dim(
        `${pad(row.agent, 8)} ${pad(String(row.activeSessions), 6)} ${pad(String(row.unreadInbox), 6)} ${pad(
          row.latestSessionId?.slice(0, 8) || '-',
          9
        )} ${pad(row.latestLifecycle || 'idle', 10)} ${pad(row.latestPhase || '-', 20)} ${pad(row.latestThreadKey || '-', 12)} ${pad(
          row.latestBackendSessionId || '-',
          10
        )}`
      )
    );
  }

  return lines;
}

function renderMissionFeed(rows: MissionFeedRow[]): string[] {
  const lines: string[] = [];
  lines.push(chalk.bold('\nOverview feed\n'));
  if (rows.length === 0) {
    lines.push(chalk.dim('  No recent activity.'));
    return lines;
  }

  lines.push(
    chalk.dim('time      type            route                     studio             preview')
  );
  for (const row of rows.slice(-20)) {
    lines.push(
      chalk.dim(
        `${pad(formatTime(row.timestamp), 8)}  ${pad(row.type, 14)}  ${pad(row.route, 24)}  ${pad(
          row.studio,
          16
        )}  ${row.preview}`
      )
    );
  }
  return lines;
}

async function fetchMissionSnapshot(options: MissionOptions): Promise<MissionSnapshot> {
  const pcp = new PcpClient();
  const config = pcp.getConfig();

  if (!config.email) {
    throw new Error('PCP not configured. Run: sb init');
  }

  const listResult = (await pcp.callTool('list_sessions', {
    email: config.email,
    status: 'active',
    limit: Number.parseInt(options.limit || '40', 10),
    ...(options.agent ? { agentId: options.agent } : {}),
  })) as Record<string, unknown>;

  const sessions = parseSessions(listResult);
  const allAgents = new Set<string>(
    sessions.map((session) => session.agentId || 'unknown').filter(Boolean)
  );

  if (options.agent) {
    allAgents.add(options.agent);
  }

  const allInboxMessages: InboxMessage[] = [];
  const fetchAllInbox = options.feed || options.watch;

  // Use get_agent_summaries for accurate per-agent unread counts and session breakdowns.
  // This computes thread unreads with proper per-agent last_read_at (no inflation).
  const unreadByAgent: Record<string, number> = {};
  const lifecycleByAgent: Record<string, Record<string, number>> = {};
  try {
    const summariesResult = (await pcp.callTool('get_agent_summaries', {
      email: config.email,
      ...(options.agent ? { agentIds: [options.agent] } : {}),
    })) as Record<string, unknown>;

    const agents = Array.isArray(summariesResult.agents) ? summariesResult.agents : [];
    for (const a of agents) {
      const agent = a as Record<string, unknown>;
      const agentId = typeof agent.agentId === 'string' ? agent.agentId : 'unknown';
      const totalUnread = typeof agent.totalUnread === 'number' ? agent.totalUnread : 0;
      unreadByAgent[agentId] = totalUnread;
      allAgents.add(agentId);

      // Extract session lifecycle breakdown
      const byLc = agent.sessionsByLifecycle;
      if (byLc && typeof byLc === 'object' && !Array.isArray(byLc)) {
        const breakdown: Record<string, number> = {};
        for (const [lc, count] of Object.entries(byLc as Record<string, unknown>)) {
          if (typeof count === 'number') breakdown[lc] = count;
        }
        if (Object.keys(breakdown).length > 0) lifecycleByAgent[agentId] = breakdown;
      }
    }
  } catch {
    // Fallback: server doesn't support get_agent_summaries yet — derive from get_inbox
    const agentsToQuery = options.agent ? [options.agent] : Array.from(allAgents);
    for (const agentId of agentsToQuery) {
      try {
        const inboxResult = (await pcp.callTool('get_inbox', {
          email: config.email,
          agentId,
          status: 'unread',
          limit: 200,
        })) as Record<string, unknown>;
        unreadByAgent[agentId] = extractUnreadCount(inboxResult);
      } catch {
        unreadByAgent[agentId] = 0;
      }
    }
  }

  // Fetch inbox messages for the feed (all agents, all statuses)
  if (fetchAllInbox) {
    try {
      const inboxResult = (await pcp.callTool('get_inbox', {
        email: config.email,
        ...(options.agent ? { agentId: options.agent } : {}),
        status: 'all',
        limit: Number.parseInt(options.feedLimit || '40', 10),
      })) as Record<string, unknown>;
      allInboxMessages.push(...extractInboxMessages(inboxResult));
    } catch {
      // Feed messages are best-effort
    }
  }

  let feed: MissionFeedRow[] = [];
  if (fetchAllInbox) {
    // Activity-sourced rows (non-inbox types)
    const activityResult = (await pcp
      .callTool('get_activity', {
        email: config.email,
        limit: Number.parseInt(options.feedLimit || '40', 10),
        types: [
          'message_out',
          'state_change',
          'tool_call',
          'tool_result',
          'agent_spawn',
          'agent_complete',
          'error',
        ],
      })
      .catch(() => null)) as Record<string, unknown> | null;
    const activityFeed = summarizeMissionFeedRows(extractActivities(activityResult), sessions);

    // Inbox-sourced rows
    const inboxFeed = allInboxMessages.map(inboxMessageToFeedRow);

    // Merge and sort by timestamp
    feed = [...activityFeed, ...inboxFeed].sort((a, b) => {
      const ams = a.timestamp ? Date.parse(a.timestamp) : 0;
      const bms = b.timestamp ? Date.parse(b.timestamp) : 0;
      return (Number.isNaN(ams) ? 0 : ams) - (Number.isNaN(bms) ? 0 : bms);
    });
  }

  return {
    rows: summarizeMissionRows(sessions, unreadByAgent, lifecycleByAgent),
    sessions,
    feed,
    inboxMessages: allInboxMessages,
    generatedAt: new Date().toISOString(),
  };
}

function printSnapshot(snapshot: MissionSnapshot): void {
  console.log(chalk.bold('\nSB Overview\n'));
  console.log(chalk.dim(`Generated: ${formatTime(snapshot.generatedAt)}\n`));

  if (snapshot.rows.length === 0) {
    console.log(chalk.dim('No active sessions or unread inbox activity.'));
  } else {
    for (const line of renderMissionTable(snapshot.rows)) {
      console.log(line);
    }
  }

  for (const line of renderMissionFeed(snapshot.feed)) {
    console.log(line);
  }

  console.log(chalk.bold('\nQuick attach commands'));
  for (const row of snapshot.rows) {
    console.log(chalk.dim(`  sb chat -a ${row.agent} --attach`));
    console.log(chalk.dim(`  sb chat -a ${row.agent} --attach-latest`));
  }

  console.log(chalk.bold('\nActive sessions\n'));
  for (const line of renderSessionsByAgent(snapshot.sessions, false)) {
    console.log(line);
  }
}

function mapActivityToFeedType(activity: MissionActivity): FeedEventType {
  switch (activity.type) {
    case 'message_in':
      return 'inbox';
    case 'message_out':
      return 'activity';
    case 'state_change':
      return 'session';
    case 'tool_call':
    case 'tool_result':
      return 'activity';
    case 'agent_spawn':
    case 'agent_complete':
      return 'session';
    default:
      return 'activity';
  }
}

/** Extract backend name from subtype like "backend_cli:claude-code" → "claude-code" */
export function backendFromSubtype(subtype?: string): string | null {
  if (!subtype) return null;
  const prefix = 'backend_cli:';
  if (subtype.startsWith(prefix)) return subtype.slice(prefix.length);
  return null;
}

/**
 * Detect system-originated messages and return a clean label + summary.
 * Heartbeat reminders, scheduled tasks, and other automated triggers
 * have no sender agent — without this they show as "from unknown".
 */
function parseSystemOrigin(
  activity: MissionActivity
): { label: string; summary: string } | undefined {
  const raw = activity.content || '';

  // Heartbeat reminders: [HEARTBEAT REMINDER]\nTitle: <title>\n...
  if (raw.startsWith('[HEARTBEAT REMINDER]')) {
    const titleMatch = raw.match(/^Title:\s*(.+)$/m);
    const title = titleMatch?.[1]?.trim() || 'scheduled reminder';
    return { label: '⏰ reminder', summary: title };
  }

  // Agent-channel messages with no trigger envelope are system-initiated
  if (activity.platform === 'agent' && activity.type === 'message_in') {
    // Generic system trigger — show a compact preview
    return { label: 'system', summary: compactPreview(raw, 80) };
  }

  return undefined;
}

export function activityToFeedEvent(
  activity: MissionActivity,
  timezone?: string,
  sessionsById?: Map<string, Session>
): FeedEvent {
  const trigger = parseTriggerEnvelope(activity.content);
  const actor = activity.agentId || 'system';
  const type = mapActivityToFeedType(activity);

  // Keep feed content compact — terminal width minus icon/agent/time overhead
  const maxPreview = Math.min(120, (process.stdout.columns || 80) - 25);

  let content: string;
  if (activity.type === 'message_in') {
    // Check for system-originated messages (heartbeat, scheduler, etc.)
    const systemOrigin = !trigger ? parseSystemOrigin(activity) : undefined;
    if (systemOrigin) {
      content = `${systemOrigin.label}: ${systemOrigin.summary}`;
    } else {
      const from = trigger?.from || 'unknown';
      const summary = trigger?.summary || compactPreview(activity.content, maxPreview);
      content = `from ${from}: ${summary}`;
    }
  } else if (activity.type === 'message_out') {
    content = `→ ${activity.platform || 'unknown'}: ${compactPreview(activity.content, maxPreview)}`;
  } else if (activity.type === 'state_change') {
    content = formatStateChange(activity);
  } else if (activity.type === 'tool_call' || activity.type === 'tool_result') {
    const ap = activity.payload;
    const isBackendCli = activity.subtype?.startsWith('backend_cli:');
    if (isBackendCli) {
      // Backend CLI spawn/result — render like agent_spawn/complete with trigger metadata
      const backend =
        (typeof ap?.backend === 'string' ? ap.backend : null) ||
        backendFromSubtype(activity.subtype);
      const source = typeof ap?.triggerSource === 'string' ? ap.triggerSource : null;
      const callThread = typeof ap?.threadKey === 'string' ? ap.threadKey : null;
      const durationMs = typeof ap?.durationMs === 'number' ? ap.durationMs : null;
      const error = typeof ap?.error === 'string' ? ap.error : null;
      const parts: string[] = [];
      if (backend) parts.push(backend);
      if (durationMs != null) parts.push(`${Math.round(durationMs / 1000)}s`);
      if (source) parts.push(`via ${source}`);
      if (callThread) parts.push(callThread);
      if (activity.type === 'tool_result' && activity.status === 'failed' && error) {
        content = parts.length > 0 ? `failed (${parts.join(', ')}): ${error}` : `failed: ${error}`;
      } else {
        const verb = activity.type === 'tool_call' ? 'spawned' : 'completed';
        content = parts.length > 0 ? `${verb} (${parts.join(', ')})` : `${verb} backend`;
      }
    } else {
      // Individual PCP tool call — content is already "toolName(params)"
      content = compactPreview(activity.content, maxPreview);
    }
  } else if (activity.type === 'agent_spawn') {
    const ap = activity.payload;
    const backend =
      (typeof ap?.backend === 'string' ? ap.backend : null) || backendFromSubtype(activity.subtype);
    const triggeredBy = typeof ap?.triggeredBy === 'string' ? ap.triggeredBy : null;
    const source = typeof ap?.triggerSource === 'string' ? ap.triggerSource : null;
    const spawnThread = typeof ap?.threadKey === 'string' ? ap.threadKey : null;
    const parts: string[] = [];
    if (backend) parts.push(backend);
    if (source === 'agent' && triggeredBy) parts.push(`via ${triggeredBy}`);
    else if (source) parts.push(`via ${source}`);
    if (spawnThread) parts.push(spawnThread);
    content = parts.length > 0 ? `spawned (${parts.join(', ')})` : 'spawned sub-process';
  } else if (activity.type === 'agent_complete') {
    const ap = activity.payload;
    const backend =
      (typeof ap?.backend === 'string' ? ap.backend : null) || backendFromSubtype(activity.subtype);
    const durationMs = typeof ap?.durationMs === 'number' ? ap.durationMs : null;
    const durationLabel = durationMs != null ? `${Math.round(durationMs / 1000)}s` : null;
    const triggeredBy = typeof ap?.triggeredBy === 'string' ? ap.triggeredBy : null;
    const source = typeof ap?.triggerSource === 'string' ? ap.triggerSource : null;
    const completeThread = typeof ap?.threadKey === 'string' ? ap.threadKey : null;
    const parts: string[] = [];
    if (backend) parts.push(backend);
    if (durationLabel) parts.push(durationLabel);
    if (source === 'agent' && triggeredBy) parts.push(`via ${triggeredBy}`);
    else if (source) parts.push(`via ${source}`);
    if (completeThread) parts.push(completeThread);
    content = parts.length > 0 ? `completed (${parts.join(', ')})` : 'sub-process completed';
  } else if (activity.type === 'error') {
    // Show full error reason — mission control exists for this visibility
    const ap = activity.payload;
    const backend =
      (typeof ap?.backend === 'string' ? ap.backend : null) || backendFromSubtype(activity.subtype);
    const errorCategory = typeof ap?.errorCategory === 'string' ? ap.errorCategory : null;
    const errorDetail =
      typeof ap?.error === 'string' ? ap.error : activity.content || 'unknown error';
    const label = backend
      ? errorCategory
        ? `failed (${backend}, ${errorCategory})`
        : `failed (${backend})`
      : errorCategory
        ? `failed (${errorCategory})`
        : 'error';
    content = `${label}: ${errorDetail}`;
  } else {
    const subtype = activity.subtype ? `:${activity.subtype}` : '';
    content = `${activity.type || 'activity'}${subtype}: ${compactPreview(activity.content, maxPreview)}`;
  }

  // Build detail line: message type, threadKey, studio
  // Sources (in priority order): activity payload (direct from message), then session join
  const messageType = trigger?.messageType;
  const p = activity.payload;
  const session =
    activity.sessionId && sessionsById ? sessionsById.get(activity.sessionId) : undefined;
  const threadKey =
    (typeof p?.threadKey === 'string' ? p.threadKey : undefined) || session?.threadKey;
  const studioHint = typeof p?.studioHint === 'string' ? p.studioHint : undefined;
  const studioId = typeof p?.studioId === 'string' ? p.studioId : undefined;
  const studioLabel =
    (studioHint ? formatWorktreeLabel(studioHint) : null) ||
    studioLabelForSession(session) ||
    studioId?.slice(0, 8) ||
    '-';

  const detailParts: string[] = [];
  if (messageType && messageType !== 'message') detailParts.push(`type: ${messageType}`);
  if (threadKey) detailParts.push(`thread: ${threadKey}`);
  if (studioLabel && studioLabel !== '-') detailParts.push(`studio: ${studioLabel}`);

  return {
    id: activity.id,
    type,
    agent: actor,
    content,
    time: formatHumanTime(activity.createdAt, timezone),
    detail: detailParts.length > 0 ? detailParts.join('  ·  ') : undefined,
  };
}

async function runInkMission(options: MissionOptions): Promise<void> {
  const pcp = new PcpClient();
  const config = pcp.getConfig();
  if (!config.email) {
    throw new Error('PCP not configured. Run: sb init');
  }

  const intervalSeconds = Math.max(3, Number.parseInt(options.interval || '6', 10));
  const seenActivityIds = new Set<string>();

  const mission = renderInkMission({ timezone: undefined, fullscreen: !!options.fullscreen });

  mission.addEvent({
    id: 'init',
    type: 'system',
    content: `SB Mission Control — polling every ${intervalSeconds}s`,
    time: formatHumanTime(undefined, undefined),
  });

  // Initial load
  const loadSnapshot = async () => {
    try {
      const snapshot = await fetchMissionSnapshot({
        ...options,
        feed: true,
        feedLimit: options.feedLimit || '40',
      });

      // Update agent summaries
      const agentSummaries: AgentSummary[] = snapshot.rows.map((row) => ({
        agent: row.agent,
        status: row.latestLifecycle || 'idle',
        phase: row.latestPhase,
        unread: row.unreadInbox,
        sessions: row.activeSessions,
        sessionsByLifecycle: row.sessionsByLifecycle,
        latestThread: row.latestThreadKey,
      }));
      mission.setAgents(agentSummaries);

      // ── Build feed events from snapshot data ──
      // Inbox messages are the authoritative source for inbound messages
      // (they carry threadKey, messageType, and routing metadata natively).
      // Activities cover non-inbox types (outbound, state changes, etc.).

      // Convert inbox messages to feed events (already fetched by fetchMissionSnapshot)
      const inboxEvents: Array<{ event: FeedEvent; timestamp: number }> =
        snapshot.inboxMessages.map((msg) => ({
          event: inboxMessageToFeedEvent(msg, undefined),
          timestamp: msg.createdAt ? Date.parse(msg.createdAt) : 0,
        }));

      // Fetch activities for non-inbox types
      const feedLimit = Number.parseInt(options.feedLimit || '40', 10);
      const activities = extractActivities(
        (await pcp
          .callTool('get_activity', {
            email: config.email,
            limit: feedLimit,
            types: [
              'message_out',
              'state_change',
              'tool_call',
              'tool_result',
              'agent_spawn',
              'agent_complete',
              'error',
            ],
          })
          .catch(() => null)) as Record<string, unknown> | null
      );

      // Build sessions map for activity enrichment
      const recentSessionsResult = (await pcp
        .callTool('list_sessions', {
          email: config.email,
          limit: 50,
        })
        .catch(() => null)) as Record<string, unknown> | null;
      const recentSessions = recentSessionsResult ? parseSessions(recentSessionsResult) : [];
      const sessionsById = new Map<string, Session>();
      for (const s of recentSessions) sessionsById.set(s.id, s);
      for (const s of snapshot.sessions) sessionsById.set(s.id, s);

      // Convert activities to feed events
      const activityEvents: Array<{ event: FeedEvent; timestamp: number }> = activities.map(
        (a) => ({
          event: activityToFeedEvent(a, undefined, sessionsById),
          timestamp: a.createdAt ? Date.parse(a.createdAt) : 0,
        })
      );

      // Merge and sort by timestamp
      const allEvents = [...inboxEvents, ...activityEvents].sort(
        (a, b) =>
          (Number.isNaN(a.timestamp) ? 0 : a.timestamp) -
          (Number.isNaN(b.timestamp) ? 0 : b.timestamp)
      );

      let newCount = 0;
      for (const { event } of allEvents) {
        if (seenActivityIds.has(event.id)) continue;
        seenActivityIds.add(event.id);
        mission.addEvent(event);
        newCount++;
      }

      const totalAgents = agentSummaries.length;
      const totalUnread = agentSummaries.reduce((sum, a) => sum + a.unread, 0);
      mission.setStatus(
        `${totalAgents} SB${totalAgents !== 1 ? 's' : ''} · ${totalUnread} unread · refreshing every ${intervalSeconds}s`
      );

      return newCount;
    } catch (err) {
      mission.addEvent({
        id: `error-${Date.now()}`,
        type: 'system',
        content: `Poll error: ${String(err)}`,
        time: formatHumanTime(undefined, undefined),
      });
      return 0;
    }
  };

  // Initial load
  await loadSnapshot();

  // Poll loop
  const pollTimer = setInterval(() => {
    void loadSnapshot();
  }, intervalSeconds * 1000);

  // Wait for user to exit
  await mission.waitForExit();

  clearInterval(pollTimer);
  mission.cleanup();
}

async function runMission(options: MissionOptions): Promise<void> {
  const intervalSeconds = Math.max(1, Number.parseInt(options.interval || '6', 10));

  const renderOnce = async (): Promise<void> => {
    const snapshot = await fetchMissionSnapshot(options);
    if (options.attach) {
      const attach = resolveAttachCommand(snapshot.sessions, options.attach);
      if (!attach) {
        throw new Error(`No active session matched attach target: ${options.attach}`);
      }
      if (options.json) {
        console.log(
          JSON.stringify(
            {
              ...snapshot,
              attach,
            },
            null,
            2
          )
        );
        return;
      }
      console.log(chalk.bold('\nResolved attach target\n'));
      console.log(chalk.dim(`agent:   ${attach.agentId}`));
      console.log(chalk.dim(`session: ${attach.sessionId}`));
      console.log(chalk.green(`\n${attach.command}\n`));
      return;
    }
    if (options.json) {
      console.log(JSON.stringify(snapshot, null, 2));
      return;
    }
    printSnapshot(snapshot);
  };

  // Use Ink live feed for --watch on TTY
  if (options.watch && process.stdout.isTTY && !options.json) {
    await runInkMission(options);
    return;
  }

  if (!options.watch) {
    await renderOnce();
    return;
  }

  // Legacy clear-screen loop for non-TTY or JSON watch
  const clearScreen = () => {
    process.stdout.write('\x1Bc');
  };

  let stopped = false;
  const stop = () => {
    stopped = true;
  };

  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  try {
    while (!stopped) {
      clearScreen();
      console.log(chalk.dim(`Watching mission control (refresh every ${intervalSeconds}s)`));
      await renderOnce();
      await new Promise((resolve) => setTimeout(resolve, intervalSeconds * 1000));
    }
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}

function registerOverviewLikeCommand(program: Command, name: string, description: string): void {
  program
    .command(name)
    .description(description)
    .option('-a, --agent <id>', 'Filter to a specific SB/agent')
    .option('-l, --limit <n>', 'Session query limit', '40')
    .option('-w, --watch', 'Continuously refresh overview')
    .option('-i, --interval <seconds>', 'Refresh interval when --watch is enabled', '6')
    .option('--feed', 'Include recent cross-agent activity feed')
    .option('--feed-limit <n>', 'Activity rows to fetch for feed rendering', '40')
    .option('--attach <target>', 'Resolve quick attach command for agent or session-id prefix')
    .option('--json', 'Output JSON')
    .option('--fullscreen', 'Fullscreen alternate buffer mode (app-controlled scrolling)')
    .action(async (options: MissionOptions) => {
      try {
        await runMission(options);
      } catch (error) {
        console.error(chalk.red(`Mission command failed: ${String(error)}`));
        process.exit(1);
      }
    });
}

export function registerMissionCommand(program: Command): void {
  registerOverviewLikeCommand(
    program,
    'mission',
    'Mission control for multi-SB sessions + unread inbox'
  );
  registerOverviewLikeCommand(
    program,
    'overview',
    'Cross-SB overview with session matrix + activity feed'
  );
}
