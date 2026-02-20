import { Command } from 'commander';
import chalk from 'chalk';
import { PcpClient } from '../lib/pcp-client.js';
import { renderSessionsByAgent, type Session } from './session.js';

interface MissionOptions {
  agent?: string;
  limit?: string;
  watch?: boolean;
  interval?: string;
  attach?: string;
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
  generatedAt: string;
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

  lines.push(chalk.dim('agent    active  unread  latest-id  phase/status          thread        backend-id '));
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

  return {
    rows: summarizeMissionRows(sessions, unreadByAgent),
    sessions,
    generatedAt: new Date().toISOString(),
  };
}

function printSnapshot(snapshot: MissionSnapshot): void {
  console.log(chalk.bold('\nSB Mission Control\n'));
  console.log(chalk.dim(`Generated: ${formatTime(snapshot.generatedAt)}\n`));

  if (snapshot.rows.length === 0) {
    console.log(chalk.dim('No active sessions or unread inbox activity.'));
    return;
  }

  for (const line of renderMissionTable(snapshot.rows)) {
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

  if (!options.watch) {
    await renderOnce();
    return;
  }

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

export function registerMissionCommand(program: Command): void {
  program
    .command('mission')
    .description('Mission control for multi-SB sessions + unread inbox')
    .option('-a, --agent <id>', 'Filter to a specific SB/agent')
    .option('-l, --limit <n>', 'Session query limit', '40')
    .option('-w, --watch', 'Continuously refresh mission control')
    .option('-i, --interval <seconds>', 'Refresh interval when --watch is enabled', '6')
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
