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
}

interface MissionRow {
  agent: string;
  activeSessions: number;
  unreadInbox: number;
  latestSessionId?: string;
  latestThreadKey?: string;
  latestPhase?: string;
  latestBackendSessionId?: string;
}

interface MissionSnapshot {
  rows: MissionRow[];
  sessions: Session[];
  feed: MissionFeedRow[];
  generatedAt: string;
}

interface MissionActivity {
  id: string;
  type?: string;
  subtype?: string;
  agentId?: string;
  content?: string;
  sessionId?: string;
  platform?: string;
  status?: string;
  createdAt?: string;
}

interface MissionFeedRow {
  id: string;
  timestamp?: string;
  type: string;
  route: string;
  studio: string;
  preview: string;
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
      };
    })
    .filter((activity): activity is MissionActivity => Boolean(activity));
}

function compactPreview(value?: string, max = 110): string {
  const normalized = (value || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '-';
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(1, max - 1))}…`;
}

function studioLabelForSession(session?: Session): string {
  if (!session) return '-';
  const studioId = session.studioId || session.studio?.id;
  const worktree = session.studio?.worktreeFolder;
  if (worktree && studioId) return `${worktree} (${studioId.slice(0, 8)})`;
  if (worktree) return worktree;
  if (studioId) return studioId.slice(0, 8);
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
      const type = activity.subtype ? `${activity.type}:${activity.subtype}` : activity.type || 'activity';

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

function newestSession(sessions: Session[]): Session | undefined {
  return sessions
    .slice()
    .sort((a, b) => Date.parse(b.startedAt || '') - Date.parse(a.startedAt || ''))[0];
}

export function summarizeMissionRows(
  sessions: Session[],
  unreadByAgent: Record<string, number>
): MissionRow[] {
  const grouped = new Map<string, Session[]>();

  for (const session of sessions) {
    const agent = session.agentId || 'unknown';
    const list = grouped.get(agent) || [];
    list.push(session);
    grouped.set(agent, list);
  }

  const allAgents = new Set<string>([
    ...Array.from(grouped.keys()),
    ...Object.keys(unreadByAgent),
  ]);

  return Array.from(allAgents)
    .map((agent) => {
      const list = grouped.get(agent) || [];
      const latest = newestSession(list);
      return {
        agent,
        activeSessions: list.length,
        unreadInbox: unreadByAgent[agent] || 0,
        latestSessionId: latest?.id,
        latestThreadKey: latest?.threadKey,
        latestPhase: latest?.currentPhase || latest?.status,
        latestBackendSessionId: latest?.backendSessionId || latest?.claudeSessionId,
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

  lines.push(chalk.dim('SB       active  unread  latest-id  phase/status          thread        backend-id '));
  for (const row of rows) {
    lines.push(
      chalk.dim(
        `${pad(row.agent, 8)} ${pad(String(row.activeSessions), 6)} ${pad(String(row.unreadInbox), 6)} ${pad(
          row.latestSessionId?.slice(0, 8) || '-',
          9
        )} ${pad(row.latestPhase || '-', 20)} ${pad(row.latestThreadKey || '-', 12)} ${pad(
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

  lines.push(chalk.dim('time      type            route                     studio             preview'));
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

  const unreadByAgent: Record<string, number> = {};
  for (const agentId of Array.from(allAgents)) {
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

  let feed: MissionFeedRow[] = [];
  if (options.feed || options.watch) {
    const activityResult = (await pcp
      .callTool('get_activity', {
        email: config.email,
        limit: Number.parseInt(options.feedLimit || '40', 10),
        types: ['message_in', 'message_out', 'state_change', 'tool_call', 'tool_result', 'agent_spawn', 'agent_complete', 'error'],
      })
      .catch(() => null)) as Record<string, unknown> | null;
    feed = summarizeMissionFeedRows(extractActivities(activityResult), sessions);
  }

  return {
    rows: summarizeMissionRows(sessions, unreadByAgent),
    sessions,
    feed,
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
    case 'message_in': return 'inbox';
    case 'message_out': return 'activity';
    case 'state_change': return 'session';
    case 'tool_call':
    case 'tool_result': return 'activity';
    case 'agent_spawn':
    case 'agent_complete': return 'session';
    default: return 'activity';
  }
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

function activityToFeedEvent(activity: MissionActivity, timezone?: string): FeedEvent {
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
    content = compactPreview(activity.content, maxPreview);
  } else if (activity.type === 'agent_spawn') {
    content = 'spawned sub-process';
  } else if (activity.type === 'agent_complete') {
    content = 'sub-process completed';
  } else {
    const subtype = activity.subtype ? `:${activity.subtype}` : '';
    content = `${activity.type || 'activity'}${subtype}: ${compactPreview(activity.content, maxPreview)}`;
  }

  // Only show type detail for non-obvious message types (skip 'message' which is default)
  const messageType = trigger?.messageType;
  const showTypeDetail = messageType && messageType !== 'message';

  return {
    id: activity.id,
    type,
    agent: actor,
    content,
    time: formatHumanTime(activity.createdAt, timezone),
    detail: showTypeDetail ? `type: ${messageType}` : undefined,
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

  const mission = renderInkMission({ timezone: undefined });

  mission.addEvent({
    id: 'init',
    type: 'system',
    content: `SB Mission Control — polling every ${intervalSeconds}s`,
    time: formatHumanTime(undefined, undefined),
  });

  // Initial load
  const loadSnapshot = async () => {
    try {
      const snapshot = await fetchMissionSnapshot({ ...options, feed: true, feedLimit: options.feedLimit || '40' });

      // Update agent summaries
      const agentSummaries: AgentSummary[] = snapshot.rows.map((row) => ({
        agent: row.agent,
        status: row.latestPhase || 'active',
        unread: row.unreadInbox,
        sessions: row.activeSessions,
        latestThread: row.latestThreadKey,
      }));
      mission.setAgents(agentSummaries);

      // Push new feed events
      const activities = extractActivities(
        (await pcp
          .callTool('get_activity', {
            email: config.email,
            limit: Number.parseInt(options.feedLimit || '40', 10),
            types: ['message_in', 'message_out', 'state_change', 'tool_call', 'tool_result', 'agent_spawn', 'agent_complete', 'error'],
          })
          .catch(() => null)) as Record<string, unknown> | null
      ).sort((a, b) => {
        const ams = a.createdAt ? Date.parse(a.createdAt) : 0;
        const bms = b.createdAt ? Date.parse(b.createdAt) : 0;
        return (Number.isNaN(ams) ? 0 : ams) - (Number.isNaN(bms) ? 0 : bms);
      });

      let newCount = 0;
      for (const activity of activities) {
        if (seenActivityIds.has(activity.id)) continue;
        seenActivityIds.add(activity.id);
        mission.addEvent(activityToFeedEvent(activity, undefined));
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
  registerOverviewLikeCommand(program, 'mission', 'Mission control for multi-SB sessions + unread inbox');
  registerOverviewLikeCommand(program, 'overview', 'Cross-SB overview with session matrix + activity feed');
}
