/**
 * Workspace Commands
 *
 * Manage product-level workspaces (personal/team scope) — the top-level
 * container for artifacts, team SBs, reminders, and more.
 * Distinct from local git worktree studios (`sb studio ...`).
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { callPcpTool } from '../lib/pcp-mcp.js';

interface PcpConfig {
  userId?: string;
  email?: string;
  agentMapping?: Record<string, string>;
  workspaceId?: string;
}

interface Workspace {
  id: string;
  name: string;
  slug: string;
  type: 'personal' | 'team';
  role?: 'owner' | 'admin' | 'member' | 'viewer';
  description?: string | null;
  archivedAt?: string | null;
}

interface WorkspaceMember {
  role?: string;
  user?: {
    email?: string | null;
    firstName?: string | null;
    username?: string | null;
    lastLoginAt?: string | null;
  };
  userId?: string;
  userWasCreated?: boolean;
}

interface AddWorkspaceMemberResult {
  success?: boolean;
  error?: string;
  member?: WorkspaceMember;
}

interface GetWorkspaceResult {
  workspace?: {
    members?: WorkspaceMember[];
  };
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

async function listWorkspaces(options: {
  all?: boolean;
  type?: 'personal' | 'team';
  json?: boolean;
}): Promise<void> {
  const config = getPcpConfig();
  if (!config?.email) {
    console.error(chalk.red('PCP not configured. Run: sb init'));
    process.exit(1);
  }

  const parsed = await callPcpTool<{ workspaces?: Workspace[] }>('list_workspaces', {
    email: config.email,
    includeArchived: options.all === true,
    type: options.type,
    ensurePersonal: true,
  });
  const workspaces = Array.isArray(parsed.workspaces) ? (parsed.workspaces as Workspace[]) : [];

  if (options.json) {
    console.log(JSON.stringify({ selectedWorkspaceId: config.workspaceId, workspaces }, null, 2));
    return;
  }

  if (workspaces.length === 0) {
    console.log(chalk.yellow('No workspaces found.'));
    return;
  }

  console.log(chalk.bold('\nWorkspaces:\n'));

  for (const workspace of workspaces) {
    const selected = config.workspaceId === workspace.id;
    const marker = selected ? chalk.green('●') : chalk.dim('○');
    const type = workspace.type === 'team' ? chalk.blue('team') : chalk.gray('personal');
    const role = workspace.role ? chalk.magenta(workspace.role) : chalk.dim('member');

    console.log(
      `  ${marker} ${chalk.cyan(workspace.name)} ${chalk.dim(`(${workspace.slug})`)} ${type} ${role}`
    );
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

async function useWorkspace(workspaceRef: string): Promise<void> {
  const config = getPcpConfig();
  if (!config?.email) {
    console.error(chalk.red('PCP not configured. Run: sb init'));
    process.exit(1);
  }

  const parsed = await callPcpTool<{ workspaces?: Workspace[] }>('list_workspaces', {
    email: config.email,
    includeArchived: false,
    ensurePersonal: true,
  });
  const workspaces = Array.isArray(parsed.workspaces) ? (parsed.workspaces as Workspace[]) : [];
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

async function resolveWorkspaceByRef(workspaceRef: string, config: PcpConfig): Promise<Workspace> {
  const parsed = await callPcpTool<{ workspaces?: Workspace[] }>('list_workspaces', {
    email: config.email,
    includeArchived: false,
    ensurePersonal: true,
  });
  const workspaces = Array.isArray(parsed.workspaces) ? (parsed.workspaces as Workspace[]) : [];
  const match = workspaces.find(
    (workspace) => workspace.id === workspaceRef || workspace.slug === workspaceRef
  );

  if (!match) {
    throw new Error(`Workspace not found: ${workspaceRef}`);
  }

  return match;
}

async function createWorkspace(
  name: string,
  options: { type?: 'personal' | 'team'; description?: string; slug?: string; use?: boolean }
): Promise<void> {
  const config = getPcpConfig();
  if (!config?.email) {
    console.error(chalk.red('PCP not configured. Run: sb init'));
    process.exit(1);
  }

  const parsed = await callPcpTool<{ workspace?: Workspace }>('create_workspace', {
    email: config.email,
    name,
    type: options.type || 'team',
    description: options.description,
    slug: options.slug,
  });
  const workspace = parsed.workspace as Workspace | undefined;

  if (!workspace?.id) {
    console.error(chalk.red('Workspace creation failed'));
    process.exit(1);
  }

  if (options.use) {
    savePcpConfig({
      ...config,
      workspaceId: workspace.id,
    });
  }

  console.log(chalk.green(`Created workspace: ${workspace.name} (${workspace.slug})`));
  console.log(chalk.dim(`  id: ${workspace.id}`));
  if (options.use) {
    console.log(chalk.cyan('Selected as active workspace.'));
  }
}

async function inviteWorkspaceMember(
  workspaceRef: string,
  inviteeEmail: string,
  options: { role?: 'owner' | 'admin' | 'member' | 'viewer' }
): Promise<void> {
  const config = getPcpConfig();
  if (!config?.email) {
    console.error(chalk.red('PCP not configured. Run: sb init'));
    process.exit(1);
  }

  let targetWorkspace: Workspace;
  try {
    targetWorkspace = await resolveWorkspaceByRef(workspaceRef, config);
  } catch (error) {
    console.error(chalk.red(error instanceof Error ? error.message : 'Workspace lookup failed'));
    process.exit(1);
  }

  const parsed = await callPcpTool<AddWorkspaceMemberResult>('add_workspace_member', {
    email: config.email,
    workspaceId: targetWorkspace.id,
    inviteeEmail,
    role: options.role || 'member',
  });

  if (parsed.success === false) {
    console.error(chalk.red(`Failed to invite member: ${String(parsed.error || 'unknown error')}`));
    process.exit(1);
  }

  const member = parsed.member;
  console.log(
    chalk.green(
      `Added ${member?.user?.email || inviteeEmail} to ${targetWorkspace.name} as ${member?.role || options.role || 'member'}`
    )
  );
  if (member?.userWasCreated) {
    console.log(
      chalk.dim('Created placeholder PCP user for this email (will activate on first login).')
    );
  }
}

async function listWorkspaceMembers(workspaceRef?: string): Promise<void> {
  const config = getPcpConfig();
  if (!config?.email) {
    console.error(chalk.red('PCP not configured. Run: sb init'));
    process.exit(1);
  }

  const targetRef = workspaceRef || config.workspaceId;
  if (!targetRef) {
    console.error(
      chalk.red('No workspace selected. Pass <id-or-slug> or run `sb workspace use` first.')
    );
    process.exit(1);
  }

  let targetWorkspace: Workspace;
  try {
    targetWorkspace = await resolveWorkspaceByRef(targetRef, config);
  } catch (error) {
    console.error(chalk.red(error instanceof Error ? error.message : 'Workspace lookup failed'));
    process.exit(1);
  }

  const parsed = await callPcpTool<GetWorkspaceResult>('get_workspace', {
    email: config.email,
    workspaceId: targetWorkspace.id,
    includeMembers: true,
  });
  const members = Array.isArray(parsed.workspace?.members) ? parsed.workspace.members : [];

  console.log(chalk.bold(`\nMembers — ${targetWorkspace.name}\n`));
  if (members.length === 0) {
    console.log(chalk.yellow('No members found.'));
    return;
  }

  for (const member of members) {
    const label =
      member.user?.firstName ||
      member.user?.username ||
      member.user?.email ||
      member.userId ||
      'unknown';
    const joinedLabel = member.user?.lastLoginAt ? 'joined' : 'invited';
    console.log(
      `  ${chalk.cyan(label)} ${chalk.dim(`(${member.role || 'member'})`)} ${chalk.gray(`[${joinedLabel}]`)}`
    );
  }
  console.log('');
}

function currentWorkspace(): void {
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

export function registerWorkspaceCommands(program: Command): void {
  const workspace = program
    .command('workspace')
    .description('Workspace management (personal/team scope)');

  workspace
    .command('list')
    .alias('ls')
    .option('--all', 'Include archived workspaces')
    .option('--type <type>', 'Filter by workspace type (personal|team)')
    .option('--json', 'Output JSON')
    .action(listWorkspaces);

  workspace
    .command('use <workspace-id-or-slug>')
    .description('Select the active workspace for this machine')
    .action(useWorkspace);

  workspace
    .command('create <name>')
    .description('Create a new workspace')
    .option('--type <type>', 'Workspace type (personal|team)', 'team')
    .option('--description <description>', 'Workspace description')
    .option('--slug <slug>', 'Workspace slug')
    .option('--use', 'Select the created workspace after creation')
    .action(
      (
        name,
        options: { type?: 'personal' | 'team'; description?: string; slug?: string; use?: boolean }
      ) => createWorkspace(name, options)
    );

  workspace
    .command('invite <workspace-id-or-slug> <email>')
    .description('Invite/add a collaborator to a workspace')
    .option('--role <role>', 'Role (owner|admin|member|viewer)', 'member')
    .action(
      (workspaceRef, inviteeEmail, options: { role?: 'owner' | 'admin' | 'member' | 'viewer' }) =>
        inviteWorkspaceMember(workspaceRef, inviteeEmail, options)
    );

  workspace
    .command('members [workspace-id-or-slug]')
    .description('List collaborators in a workspace')
    .action(listWorkspaceMembers);

  workspace.command('current').description('Print selected workspace ID').action(currentWorkspace);
}
