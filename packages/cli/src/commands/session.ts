/**
 * Session Commands
 *
 * Manage PCP sessions.
 *
 * Commands:
 *   session list         List recent sessions
 *   session show <id>    Show session details
 *   session resume <id>  Resume a session
 *   session end [id]     End a session
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { callPcpTool } from '../lib/pcp-mcp.js';

interface PcpConfig {
  userId?: string;
  email?: string;
}

export interface Session {
  id: string;
  agentId?: string;
  status: string;
  currentPhase?: string;
  threadKey?: string;
  startedAt: string;
  endedAt?: string;
  summary?: string;
  backendSessionId?: string;
  claudeSessionId?: string;
  studioId?: string;
  studio?: {
    id?: string;
    worktreePath?: string;
    worktreeFolder?: string;
    branch?: string;
  } | null;
  logs?: Array<{ salience: string; content: string }>;
}

export interface SessionListResult {
  sessions: Session[];
}

// ============================================================================
// Helpers
// ============================================================================

function getPcpConfig(): PcpConfig | null {
  const configPath = join(homedir(), '.pcp', 'config.json');
  if (existsSync(configPath)) {
    try {
      return JSON.parse(readFileSync(configPath, 'utf-8'));
    } catch {
      return null;
    }
  }
  return null;
}

// ============================================================================
// Commands
// ============================================================================

function formatStatus(session: Session): string {
  return session.currentPhase || session.status || 'unknown';
}

function formatSessionLine(session: Session): string[] {
  const statusIcon =
    session.status === 'active'
      ? chalk.green('●')
      : session.status === 'completed'
        ? chalk.dim('○')
        : chalk.yellow('◐');

  const startedAt = new Date(session.startedAt);
  const duration = session.endedAt
    ? formatDuration(new Date(session.endedAt).getTime() - startedAt.getTime())
    : 'ongoing';
  const thread = session.threadKey || '-';
  const phase = formatStatus(session);

  const lines = [
    `  ${statusIcon} ${chalk.cyan(session.id.substring(0, 8))} ${chalk.dim(`(${phase})`)}`,
    chalk.dim(`      Started: ${formatDate(startedAt)}  Duration: ${duration}`),
    chalk.dim(`      Thread:  ${thread}`),
    chalk.dim(`      Attach:  sb chat -a ${session.agentId || 'wren'} --attach ${session.id}`),
  ];

  if (session.summary) {
    const summary =
      session.summary.length > 80 ? session.summary.substring(0, 80) + '...' : session.summary;
    lines.push(chalk.dim(`      Summary: ${summary}`));
  }

  if (session.studioId) {
    const studioLabel = session.studio?.worktreeFolder
      ? `${session.studioId} (${session.studio.worktreeFolder})`
      : session.studioId;
    lines.push(chalk.dim(`      Studio:  ${studioLabel}`));
    if (session.studio?.worktreePath) {
      lines.push(chalk.dim(`      Path:    ${session.studio.worktreePath}`));
    }
    if (session.studio?.branch) {
      lines.push(chalk.dim(`      Branch:  ${session.studio.branch}`));
    }
  }

  if (session.backendSessionId || session.claudeSessionId) {
    lines.push(chalk.dim(`      Backend: ${session.backendSessionId || session.claudeSessionId}`));
  }

  return lines;
}

export function renderSessionsByAgent(sessions: Session[], flat = false): string[] {
  if (sessions.length === 0) {
    return [chalk.dim('  No sessions found')];
  }

  if (flat) {
    const lines: string[] = [];
    for (const session of sessions) {
      lines.push(...formatSessionLine(session), '');
    }
    return lines;
  }

  const grouped = new Map<string, Session[]>();
  for (const session of sessions) {
    const key = session.agentId || 'unknown';
    const list = grouped.get(key) || [];
    list.push(session);
    grouped.set(key, list);
  }

  const lines: string[] = [];
  const agents = Array.from(grouped.keys()).sort((a, b) => a.localeCompare(b));
  for (const agent of agents) {
    const list = grouped.get(agent)!;
    const activeCount = list.filter((entry) => entry.status === 'active').length;
    lines.push(
      chalk.bold(`${agent}`) +
        chalk.dim(` (${list.length} session${list.length === 1 ? '' : 's'}, ${activeCount} active)`)
    );
    for (const session of list) {
      lines.push(...formatSessionLine(session), '');
    }
  }

  return lines;
}

async function listCommand(options: {
  agent?: string;
  limit?: string;
  flat?: boolean;
}): Promise<void> {
  const config = getPcpConfig();
  if (!config?.email) {
    console.error(chalk.red('PCP not configured. Run: sb init'));
    process.exit(1);
  }

  try {
    const result = await callPcpTool<SessionListResult>('list_sessions', {
      email: config.email,
      agentId: options.agent,
      limit: parseInt(options.limit || '10', 10),
    });

    console.log(chalk.bold('\nRecent Sessions:\n'));
    for (const line of renderSessionsByAgent(result.sessions || [], options.flat)) {
      console.log(line);
    }
  } catch (error) {
    console.error(chalk.red(`Failed to list sessions: ${error}`));
    process.exit(1);
  }
}

async function showCommand(sessionId: string): Promise<void> {
  const config = getPcpConfig();
  if (!config?.email) {
    console.error(chalk.red('PCP not configured. Run: sb init'));
    process.exit(1);
  }

  try {
    const session = await callPcpTool<Session>('get_session', {
      email: config.email,
      sessionId,
    });

    console.log(chalk.bold(`\nSession: ${session.id}\n`));
    console.log(chalk.dim('  Agent:    ') + (session.agentId || 'unknown'));
    console.log(chalk.dim('  Status:   ') + session.status);
    console.log(chalk.dim('  Started:  ') + formatDate(new Date(session.startedAt)));

    if (session.endedAt) {
      console.log(chalk.dim('  Ended:    ') + formatDate(new Date(session.endedAt)));
    }

    if (session.claudeSessionId) {
      console.log(chalk.dim('  Claude:   ') + session.claudeSessionId);
    }

    if (session.studioId) {
      const studioLabel = session.studio?.worktreeFolder
        ? `${session.studioId} (${session.studio.worktreeFolder})`
        : session.studioId;
      console.log(chalk.dim('  Studio:   ') + studioLabel);
      if (session.studio?.worktreePath) {
        console.log(chalk.dim('  Path:     ') + session.studio.worktreePath);
      }
      if (session.studio?.branch) {
        console.log(chalk.dim('  Branch:   ') + session.studio.branch);
      }
    }

    if (session.summary) {
      console.log('');
      console.log(chalk.dim('  Summary:'));
      for (const line of session.summary.split('\n')) {
        console.log(chalk.dim('    ' + line));
      }
    }

    if (session.logs && session.logs.length > 0) {
      console.log('');
      console.log(chalk.dim('  Logs:'));
      for (const log of session.logs.slice(-5)) {
        console.log(chalk.dim(`    [${log.salience}] ${log.content.substring(0, 60)}...`));
      }
    }

    console.log('');
  } catch (error) {
    console.error(chalk.red(`Failed to get session: ${error}`));
    process.exit(1);
  }
}

async function resumeCommand(sessionId: string): Promise<void> {
  const config = getPcpConfig();
  if (!config?.email) {
    console.error(chalk.red('PCP not configured. Run: sb init'));
    process.exit(1);
  }

  // Get session to find Claude session ID
  try {
    const session = await callPcpTool<Session>('get_session', {
      email: config.email,
      sessionId,
    });

    if (!session.claudeSessionId) {
      console.error(chalk.red('Session has no Claude session ID to resume'));
      process.exit(1);
    }

    console.log(chalk.cyan(`Resuming session ${sessionId.substring(0, 8)}...`));
    console.log(chalk.dim(`  Claude session: ${session.claudeSessionId}`));
    console.log('');
    console.log(chalk.dim('Run:'));
    console.log(chalk.dim(`  claude --resume ${session.claudeSessionId}`));
  } catch (error) {
    console.error(chalk.red(`Failed to resume session: ${error}`));
    process.exit(1);
  }
}

async function endCommand(sessionId?: string): Promise<void> {
  const config = getPcpConfig();
  if (!config?.email) {
    console.error(chalk.red('PCP not configured. Run: sb init'));
    process.exit(1);
  }

  if (!sessionId) {
    // Find active session
    console.log(chalk.yellow('No session ID provided. Use: sb session end <id>'));
    return;
  }

  try {
    await callPcpTool(
      'end_session',
      {
        email: config.email,
        sessionId,
      },
      { callerProfile: 'runtime' }
    );
    console.log(chalk.green(`Session ${sessionId.substring(0, 8)} ended`));
  } catch (error) {
    console.error(chalk.red(`Failed to end session: ${error}`));
    process.exit(1);
  }
}

// ============================================================================
// Utilities
// ============================================================================

function formatDate(date: Date): string {
  return date.toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${minutes}m`;
}

// ============================================================================
// Register Commands
// ============================================================================

export function registerSessionCommands(program: Command): void {
  const session = program.command('session').description('Manage PCP sessions');

  session
    .command('list')
    .alias('ls')
    .description('List recent sessions')
    .option('-a, --agent <id>', 'Filter by agent')
    .option('-l, --limit <n>', 'Number of sessions', '10')
    .option('--flat', 'Show flat list without SB grouping')
    .action(listCommand);

  session.command('show <id>').description('Show session details').action(showCommand);

  session.command('resume <id>').description('Resume a session').action(resumeCommand);

  session.command('end [id]').description('End a session').action(endCommand);
}
