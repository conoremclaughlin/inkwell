/**
 * Agent Commands
 *
 * Interact with PCP agents.
 *
 * Commands:
 *   agent trigger <id>   Trigger an agent to wake up
 *   agent status [id]    Check agent status
 *   agent inbox [id]     Check agent inbox
 *   agent list           List known agents
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { resolveAgentId } from '../backends/identity.js';
import { getCurrentRuntimeSession } from '../session/runtime.js';
import { callPcpTool } from '../lib/pcp-mcp.js';

interface PcpConfig {
  userId?: string;
  email?: string;
  agentMapping?: Record<string, string>;
}

interface TriggerResult {
  messageId: string;
  trigger?: { triggered: boolean };
}

interface AgentStatusResult {
  status: string;
  inbox?: { unreadCount: number };
  lastSession?: { endedAt?: string; startedAt: string };
}

interface InboxResult {
  unreadCount: number;
  messages: Array<{
    status: string;
    priority: string;
    subject?: string;
    senderAgentId?: string;
    createdAt: string;
  }>;
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

async function triggerAgent(
  agentId: string,
  options: {
    message?: string;
    priority?: string;
    threadKey?: string;
    recipientSessionId?: string;
    studioId?: string;
    studioHint?: string;
  }
): Promise<void> {
  const spinner = ora(`Triggering agent: ${agentId}`).start();

  try {
    const config = getPcpConfig();
    if (!config?.email) {
      spinner.fail('PCP not configured. Run: sb init');
      process.exit(1);
    }

    // First, send to inbox
    const currentRuntime = getCurrentRuntimeSession(process.cwd());
    const threadKey = options.threadKey || currentRuntime?.threadKey;

    const result = await callPcpTool<TriggerResult>('send_to_inbox', {
      email: config.email,
      recipientAgentId: agentId,
      senderAgentId: 'cli',
      content: options.message || `CLI trigger at ${new Date().toISOString()}`,
      messageType: 'message',
      priority: options.priority || 'normal',
      ...(threadKey ? { threadKey } : {}),
      ...(options.recipientSessionId ? { recipientSessionId: options.recipientSessionId } : {}),
      ...(options.studioId ? { recipientStudioId: options.studioId } : {}),
      ...(options.studioHint ? { recipientStudioHint: options.studioHint } : {}),
      trigger: true,
      triggerType: 'message',
      triggerSummary: options.message || 'CLI trigger',
    });
    spinner.succeed(`Triggered ${agentId}`);

    if (result.trigger?.triggered) {
      console.log(chalk.dim(`  Trigger dispatched (async)`));
    }
    console.log(chalk.dim(`  Message ID: ${result.messageId}`));
  } catch (error) {
    spinner.fail(`Failed to trigger: ${error}`);
    process.exit(1);
  }
}

async function statusCommand(agentId?: string): Promise<void> {
  const config = getPcpConfig();
  if (!config?.email) {
    console.error(chalk.red('PCP not configured. Run: sb init'));
    process.exit(1);
  }

  const agents = agentId ? [agentId] : ['myra', 'wren', 'benson'];

  console.log(chalk.bold('\nAgent Status:\n'));

  for (const agent of agents) {
    try {
      const result = await callPcpTool<AgentStatusResult>('get_agent_status', {
        email: config.email,
        agentId: agent,
      });

      const statusIcon =
        result.status === 'active'
          ? chalk.green('●')
          : result.status === 'recently_active'
            ? chalk.yellow('●')
            : chalk.dim('○');

      console.log(`  ${statusIcon} ${chalk.cyan(agent)}`);
      console.log(chalk.dim(`      Status: ${result.status}`));
      console.log(chalk.dim(`      Inbox:  ${result.inbox?.unreadCount || 0} unread`));

      if (result.lastSession) {
        const lastActive = new Date(result.lastSession.endedAt || result.lastSession.startedAt);
        const ago = formatTimeAgo(lastActive);
        console.log(chalk.dim(`      Last:   ${ago}`));
      }
      console.log('');
    } catch {
      console.log(`  ${chalk.dim('○')} ${chalk.cyan(agent)}`);
      console.log(chalk.dim('      Status: unreachable'));
      console.log('');
    }
  }
}

async function inboxCommand(agentId?: string): Promise<void> {
  const config = getPcpConfig();
  if (!config?.email) {
    console.error(chalk.red('PCP not configured. Run: sb init'));
    process.exit(1);
  }

  const agent = agentId || resolveAgentId();
  if (!agent) {
    console.error(chalk.red('No agent identity configured. Pass an agent ID or run `sb init`.'));
    process.exit(1);
  }

  try {
    const result = await callPcpTool<InboxResult>('get_inbox', {
      email: config.email,
      agentId: agent,
      status: 'all',
      limit: 10,
    });

    console.log(chalk.bold(`\nInbox for ${agent}:`));
    console.log(chalk.dim(`  ${result.unreadCount} unread\n`));

    if (!result.messages || result.messages.length === 0) {
      console.log(chalk.dim('  No messages'));
      return;
    }

    for (const msg of result.messages) {
      const statusIcon = msg.status === 'unread' ? chalk.yellow('●') : chalk.dim('○');
      const priorityBadge =
        msg.priority === 'urgent'
          ? chalk.red('[URGENT]')
          : msg.priority === 'high'
            ? chalk.yellow('[HIGH]')
            : '';

      console.log(`  ${statusIcon} ${priorityBadge} ${msg.subject || '(no subject)'}`);
      console.log(chalk.dim(`      From: ${msg.senderAgentId || 'user'}`));
      console.log(chalk.dim(`      ${formatTimeAgo(new Date(msg.createdAt))}`));
      console.log('');
    }
  } catch (error) {
    console.error(chalk.red(`Failed to fetch inbox: ${error}`));
    process.exit(1);
  }
}

function listCommand(): void {
  console.log(chalk.bold('\nKnown Agents:\n'));

  const agents = [
    { id: 'wren', description: 'Session-based development collaborator (Claude Code)' },
    { id: 'myra', description: 'Persistent messaging bridge (Telegram/WhatsApp)' },
    { id: 'benson', description: 'Conversational partner (Discord/Slack)' },
  ];

  for (const agent of agents) {
    console.log(chalk.cyan(`  ${agent.id}`));
    console.log(chalk.dim(`      ${agent.description}`));
    console.log('');
  }
}

// ============================================================================
// Utilities
// ============================================================================

function formatTimeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);

  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
  return date.toLocaleDateString();
}

// ============================================================================
// Register Commands
// ============================================================================

export function registerAgentCommands(program: Command): void {
  const agent = program.command('agent').description('Interact with PCP agents');

  agent
    .command('trigger <id>')
    .description('Trigger an agent to wake up')
    .option('-m, --message <msg>', 'Message to include')
    .option('-p, --priority <level>', 'Priority (low, normal, high, urgent)', 'normal')
    .option('--thread-key <key>', 'Thread key for continuity (e.g., pr:75)')
    .option('--recipient-session-id <id>', 'Recipient session UUID')
    .option('--studio-id <id>', 'Recipient studio UUID')
    .option('--studio-hint <hint>', 'Recipient studio routing hint (e.g., main)')
    .action(triggerAgent);

  agent
    .command('status [id]')
    .description('Check agent status (all agents if no ID)')
    .action(statusCommand);

  agent.command('inbox [id]').description('Check agent inbox').action(inboxCommand);

  agent.command('list').alias('ls').description('List known agents').action(listCommand);
}
