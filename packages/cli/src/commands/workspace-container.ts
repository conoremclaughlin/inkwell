/**
 * Workspace Container Commands
 *
 * Manage product-level workspaces (personal/team scope).
 * These are distinct from local git worktree studios (`sb studio ...`).
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

interface PcpConfig {
  userId?: string;
  email?: string;
  agentMapping?: Record<string, string>;
  workspaceId?: string;
}

interface WorkspaceContainer {
  id: string;
  name: string;
  slug: string;
  type: 'personal' | 'team';
  description?: string | null;
  archivedAt?: string | null;
}

function getConfigPath(): string {
  return join(homedir(), '.pcp', 'config.json');
}

function getPcpConfig(): PcpConfig | null {
  const configPath = getConfigPath();
  if (!existsSync(configPath)) return null;

  try {
    return JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch {
    return null;
  }
}

function savePcpConfig(config: PcpConfig): void {
  const configPath = getConfigPath();
  const configDir = join(homedir(), '.pcp');
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
}

function getPcpServerUrl(): string {
  return process.env.PCP_SERVER_URL || 'http://localhost:3001';
}

async function fetchPcp(path: string, options?: RequestInit): Promise<Response> {
  const url = `${getPcpServerUrl()}${path}`;
  // Intentionally no Authorization header here:
  // CLI workspace selection currently goes through MCP tool calls (`/api/mcp/call`)
  // that resolve user context from explicit args (email/userId), matching other sb CLI commands.
  return fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });
}

function unwrapToolResult(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Invalid response payload');
  }

  const direct = payload as Record<string, unknown>;
  if (Array.isArray(direct.workspaces)) {
    return direct;
  }

  const mcpText = (direct.result as { content?: Array<{ text?: string }> } | undefined)
    ?.content?.[0]?.text
    || (direct.content as Array<{ text?: string }> | undefined)?.[0]?.text;

  if (typeof mcpText === 'string') {
    try {
      const parsed = JSON.parse(mcpText) as Record<string, unknown>;
      return parsed;
    } catch {
      // fall through
    }
  }

  return direct;
}

async function listWorkspaceContainers(options: { all?: boolean; type?: 'personal' | 'team'; json?: boolean }): Promise<void> {
  const config = getPcpConfig();
  if (!config?.email) {
    console.error(chalk.red('PCP not configured. Run: sb init'));
    process.exit(1);
  }

  const response = await fetchPcp('/api/mcp/call', {
    method: 'POST',
    body: JSON.stringify({
      tool: 'list_workspace_containers',
      args: {
        email: config.email,
        includeArchived: options.all === true,
        type: options.type,
        ensurePersonal: true,
      },
    }),
  });

  if (!response.ok) {
    console.error(chalk.red(`Failed to list workspaces: ${await response.text()}`));
    process.exit(1);
  }

  const raw = await response.json() as unknown;
  const parsed = unwrapToolResult(raw);
  const workspaces = Array.isArray(parsed.workspaces)
    ? (parsed.workspaces as WorkspaceContainer[])
    : [];

  if (options.json) {
    console.log(JSON.stringify({ selectedWorkspaceId: config.workspaceId, workspaces }, null, 2));
    return;
  }

  if (workspaces.length === 0) {
    console.log(chalk.yellow('No workspace containers found.'));
    return;
  }

  console.log(chalk.bold('\nWorkspace Containers:\n'));

  for (const workspace of workspaces) {
    const selected = config.workspaceId === workspace.id;
    const marker = selected ? chalk.green('●') : chalk.dim('○');
    const type = workspace.type === 'team' ? chalk.blue('team') : chalk.gray('personal');

    console.log(`  ${marker} ${chalk.cyan(workspace.name)} ${chalk.dim(`(${workspace.slug})`)} ${type}`);
    console.log(chalk.dim(`      id: ${workspace.id}`));
    if (workspace.description) {
      console.log(chalk.dim(`      ${workspace.description}`));
    }
    if (workspace.archivedAt) {
      console.log(chalk.yellow(`      archived: ${workspace.archivedAt}`));
    }
    console.log('');
  }
}

async function useWorkspaceContainer(workspaceRef: string): Promise<void> {
  const config = getPcpConfig();
  if (!config?.email) {
    console.error(chalk.red('PCP not configured. Run: sb init'));
    process.exit(1);
  }

  const response = await fetchPcp('/api/mcp/call', {
    method: 'POST',
    body: JSON.stringify({
      tool: 'list_workspace_containers',
      args: {
        email: config.email,
        includeArchived: false,
        ensurePersonal: true,
      },
    }),
  });

  if (!response.ok) {
    console.error(chalk.red(`Failed to list workspaces: ${await response.text()}`));
    process.exit(1);
  }

  const raw = await response.json() as unknown;
  const parsed = unwrapToolResult(raw);
  const workspaces = Array.isArray(parsed.workspaces)
    ? (parsed.workspaces as WorkspaceContainer[])
    : [];
  const match = workspaces.find((w) => w.id === workspaceRef || w.slug === workspaceRef);

  if (!match) {
    console.error(chalk.red(`Workspace not found: ${workspaceRef}`));
    process.exit(1);
  }

  savePcpConfig({
    ...config,
    workspaceId: match.id,
  });

  console.log(chalk.green(`Selected workspace: ${match.name} (${match.slug})`));
  console.log(chalk.dim(`  id: ${match.id}`));
}

function currentWorkspaceContainer(): void {
  const config = getPcpConfig();
  if (!config) {
    console.error(chalk.red('PCP not configured. Run: sb init'));
    process.exit(1);
  }

  if (!config.workspaceId) {
    console.log(chalk.yellow('No workspace selected.'));
    console.log(chalk.dim('Use `sb workspace use <id-or-slug>` to select one.'));
    return;
  }

  console.log(config.workspaceId);
}

export function registerWorkspaceContainerCommands(program: Command): void {
  const workspace = program
    .command('workspace')
    .description('Product workspace container management (personal/team scope)');

  workspace.command('list')
    .alias('ls')
    .option('--all', 'Include archived workspaces')
    .option('--type <type>', 'Filter by workspace type (personal|team)')
    .option('--json', 'Output JSON')
    .action(listWorkspaceContainers);

  workspace.command('use <workspace-id-or-slug>')
    .description('Select the active workspace container for this machine')
    .action(useWorkspaceContainer);

  workspace.command('current')
    .description('Print selected workspace container ID')
    .action(currentWorkspaceContainer);
}
