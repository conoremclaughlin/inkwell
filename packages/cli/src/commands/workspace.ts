/**
 * Workspace Commands
 *
 * Manage git worktrees for parallel development with PCP identity.
 *
 * Commands:
 *   studio init [name]     Initialize parent directory structure
 *   studio create <name>   Create a new workspace/studio
 *   studio list            List all workspaces/studios
 *   studio remove <name>   Remove a workspace/studio (keeps branch)
 *   studio clean <name>    Remove workspace/studio and delete branch
 *   studio status          Show status of all workspaces/studios
 *   studio path <name>     Output workspace/studio path (for cd)
 *   studio cd <name>       Print cd command (use with: eval $(sb studio cd foo))
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { execSync } from 'child_process';
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  renameSync,
  cpSync,
} from 'fs';
import { join, dirname, basename } from 'path';
import { homedir } from 'os';
import { installHooks } from './hooks.js';

interface WorkspaceIdentity {
  agentId: string;
  context: string;
  backend?: string;
  description: string;
  workspace: string;
  branch: string;
  createdAt: string;
  createdBy?: string;
}

interface WorkspaceInfo {
  name: string;
  path: string;
  branch: string;
  identity?: WorkspaceIdentity;
}

// ============================================================================
// Helpers
// ============================================================================

function findGitRoot(): string {
  try {
    const result = execSync('git rev-parse --show-toplevel', { encoding: 'utf-8' });
    return result.trim();
  } catch {
    console.error(chalk.red('Error: Not in a git repository'));
    process.exit(1);
  }
}

function getWorkspaceParent(gitRoot: string): string {
  return dirname(gitRoot);
}

function getWorkspacePrefix(gitRoot: string): string {
  // Use the repo folder name as prefix (e.g., "personal-context-protocol" -> "personal-context-protocol--")
  return `${basename(gitRoot)}--`;
}

function getWorkspacePath(gitRoot: string, name: string): string {
  return join(getWorkspaceParent(gitRoot), `${getWorkspacePrefix(gitRoot)}${name}`);
}

function git(args: string, cwd?: string): string {
  try {
    return execSync(`git ${args}`, {
      encoding: 'utf-8',
      cwd: cwd || process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch (error: unknown) {
    const err = error as { stderr?: string; message?: string };
    throw new Error(err.stderr || err.message || 'Git command failed');
  }
}

function branchExists(branch: string, cwd?: string): boolean {
  try {
    git(`show-ref --verify --quiet refs/heads/${branch}`, cwd);
    return true;
  } catch {
    return false;
  }
}

function getCurrentUser(): string | undefined {
  const pcpConfigPath = join(homedir(), '.pcp', 'config.json');
  if (existsSync(pcpConfigPath)) {
    try {
      const config = JSON.parse(readFileSync(pcpConfigPath, 'utf-8'));
      return config.email || config.userId;
    } catch {
      // Fall through
    }
  }
  try {
    return git('config user.email');
  } catch {
    return undefined;
  }
}

function listWorkspaces(gitRoot: string): WorkspaceInfo[] {
  const parentDir = getWorkspaceParent(gitRoot);
  const workspaces: WorkspaceInfo[] = [];

  const worktreeOutput = git('worktree list --porcelain', gitRoot);
  const worktrees = new Map<string, string>();

  let currentPath = '';
  for (const line of worktreeOutput.split('\n')) {
    if (line.startsWith('worktree ')) {
      currentPath = line.substring(9);
    } else if (line.startsWith('branch ')) {
      worktrees.set(currentPath, line.substring(7).replace('refs/heads/', ''));
    }
  }

  const prefix = getWorkspacePrefix(gitRoot);
  if (existsSync(parentDir)) {
    for (const entry of readdirSync(parentDir)) {
      if (entry.startsWith(prefix)) {
        const wsPath = join(parentDir, entry);
        const name = entry.slice(prefix.length);
        const branch = worktrees.get(wsPath) || 'unknown';

        let identity: WorkspaceIdentity | undefined;
        const identityPath = join(wsPath, '.pcp', 'identity.json');
        if (existsSync(identityPath)) {
          try {
            identity = JSON.parse(readFileSync(identityPath, 'utf-8'));
          } catch {
            // Ignore
          }
        }

        workspaces.push({ name, path: wsPath, branch, identity });
      }
    }
  }

  return workspaces;
}

/**
 * Get all worktree paths registered with git (excluding the main worktree).
 */
function getWorktreePaths(gitRoot: string): string[] {
  const output = git('worktree list --porcelain', gitRoot);
  const paths: string[] = [];

  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) {
      const path = line.substring(9);
      if (path !== gitRoot) {
        paths.push(path);
      }
    }
  }

  return paths;
}

// ============================================================================
// Interactive helpers
// ============================================================================

interface InteractiveResult {
  name: string;
  branch: string;
  configDirs: string[];
}

/**
 * Run the full interactive workspace creation flow when name is omitted and stdin is a TTY.
 * Returns the resolved name, branch, and config dirs to copy.
 */
async function runInteractiveFlow(agentId: string, gitRoot: string): Promise<InteractiveResult> {
  const { input, checkbox } = await import('@inquirer/prompts');

  // Step 1: Workspace name
  const name = await input({
    message: 'Workspace name',
    default: 'new',
  });

  // Step 2: Branch name (derived, editable)
  const defaultBranch = `${agentId}/workspace/${name}`;
  const branch = await input({
    message: 'Branch name',
    default: defaultBranch,
  });

  // Step 3: Config directories to copy
  const candidateDirs = ['.claude', '.codex', '.gemini'].filter((dir) =>
    existsSync(join(gitRoot, dir))
  );

  let configDirs: string[] = [];
  if (candidateDirs.length > 0) {
    configDirs = await checkbox({
      message: 'Copy config folders?',
      choices: candidateDirs.map((dir) => ({
        name: dir,
        value: dir,
        checked: dir === '.claude',
      })),
    });
  }

  return { name, branch, configDirs };
}

/**
 * Copy config directories from git root into the new workspace.
 *
 * - .claude/ is always copied as-is (hand-authored permissions)
 * - .codex/, .gemini/ — if .mcp.json exists in the target, regenerate via syncMcpConfig instead
 * - .pcp/identity.json is always freshly written (never copied)
 */
function copyConfigDirs(gitRoot: string, wsPath: string, dirs: string[]): void {
  for (const dir of dirs) {
    const source = join(gitRoot, dir);
    const target = join(wsPath, dir);

    if (!existsSync(source)) continue;

    if (dir === '.claude') {
      // Always copy as-is
      cpSync(source, target, { recursive: true });
    } else if ((dir === '.codex' || dir === '.gemini') && existsSync(join(wsPath, '.mcp.json'))) {
      // Will be regenerated via syncMcpConfig — skip copying stale generated files
      continue;
    } else {
      cpSync(source, target, { recursive: true });
    }
  }
}

// ============================================================================
// Commands
// ============================================================================

interface InitResult {
  parentDir: string;
  moves: Array<{ from: string; to: string }>;
}

/**
 * Plan the init migration: figure out what needs to move where.
 */
function planInit(gitRoot: string, parentName: string): InitResult {
  const grandparent = getWorkspaceParent(gitRoot);
  const repoName = basename(gitRoot);
  const parentDir = join(grandparent, parentName);

  const moves: Array<{ from: string; to: string }> = [];

  // Main repo move
  moves.push({ from: gitRoot, to: join(parentDir, repoName) });

  // Find existing worktrees that are siblings of the main repo
  const prefix = getWorkspacePrefix(gitRoot);
  const worktreePaths = getWorktreePaths(gitRoot);

  for (const wtPath of worktreePaths) {
    const wtName = basename(wtPath);
    // Only move worktrees that follow our naming convention (siblings with prefix)
    if (wtName.startsWith(prefix) && dirname(wtPath) === grandparent) {
      moves.push({ from: wtPath, to: join(parentDir, wtName) });
    }
  }

  return { parentDir, moves };
}

async function initWorkspace(
  parentName: string | undefined,
  options: { dryRun?: boolean }
): Promise<void> {
  if (!parentName) {
    console.error(chalk.red('Error: Parent directory name is required.'));
    console.error(chalk.dim('Usage: sb studio init <parent-name>'));
    console.error(chalk.dim('Example: sb studio init pcp'));
    process.exit(1);
  }

  const gitRoot = findGitRoot();
  const { parentDir, moves } = planInit(gitRoot, parentName);

  // Validate: parent directory must not already exist
  if (existsSync(parentDir)) {
    console.error(chalk.red(`Error: Directory already exists: ${parentDir}`));
    console.error(chalk.dim('Choose a different name or remove the existing directory.'));
    process.exit(1);
  }

  // Validate: no target paths should exist
  for (const move of moves) {
    if (existsSync(move.to)) {
      console.error(chalk.red(`Error: Target path already exists: ${move.to}`));
      process.exit(1);
    }
  }

  if (options.dryRun) {
    console.log(chalk.bold('\nDry run — planned moves:\n'));
    console.log(chalk.dim(`  Create: ${parentDir}/`));
    console.log('');
    for (const move of moves) {
      console.log(chalk.dim(`  ${move.from}`));
      console.log(chalk.cyan(`    → ${move.to}`));
      console.log('');
    }
    console.log(chalk.yellow('No changes made (--dry-run).'));
    return;
  }

  const spinner = ora('Initializing parent directory structure').start();

  try {
    // Create parent directory
    spinner.text = `Creating ${parentDir}`;
    mkdirSync(parentDir, { recursive: true });

    // Move worktrees first (before moving the main repo, since git refs point to main)
    const worktreeMoves = moves.filter((m) => m.from !== gitRoot);
    for (const move of worktreeMoves) {
      spinner.text = `Moving ${basename(move.from)}`;
      renameSync(move.from, move.to);
    }

    // Move main repo last
    const mainMove = moves.find((m) => m.from === gitRoot)!;
    spinner.text = `Moving ${basename(mainMove.from)}`;
    renameSync(mainMove.from, mainMove.to);

    // Repair git worktree cross-references
    spinner.text = 'Repairing git worktree references';
    const newWorktreePaths = worktreeMoves.map((m) => `"${m.to}"`).join(' ');
    if (newWorktreePaths) {
      git(`worktree repair ${newWorktreePaths}`, mainMove.to);
    }

    spinner.succeed('Parent directory initialized');
    console.log('');
    console.log(chalk.bold('Moves:'));
    for (const move of moves) {
      console.log(chalk.dim(`  ${move.from}`));
      console.log(chalk.cyan(`    → ${move.to}`));
    }
    console.log('');
    console.log(chalk.cyan('Next steps:'));
    console.log(chalk.dim(`  cd ${mainMove.to}`));
    console.log('');
    console.log(chalk.dim('Note: Claude Code sessions from the old path will not carry over.'));
    console.log(chalk.dim('PCP memories persist automatically via bootstrap.'));
  } catch (error) {
    spinner.fail(`Failed to initialize: ${error}`);
    console.error('');
    console.error(chalk.yellow('Some moves may have partially completed.'));
    console.error(chalk.yellow('Check the state of these directories:'));
    console.error(chalk.dim(`  ${parentDir}`));
    for (const move of moves) {
      console.error(chalk.dim(`  ${move.from}`));
      console.error(chalk.dim(`  ${move.to}`));
    }
    console.error('');
    console.error(chalk.yellow('If worktree references are broken, run from the main repo:'));
    console.error(chalk.dim('  git worktree repair <worktree-paths...>'));
    process.exit(1);
  }
}

async function createWorkspace(
  name: string,
  options: {
    agent?: string;
    purpose?: string;
    branch?: string;
    backend?: string;
    copyConfig?: boolean;
    configDirs?: string;
  },
  overrides?: { branch?: string; configDirsList?: string[] }
): Promise<void> {
  const agentId = options.agent || 'wren';
  const spinner = ora(`Creating workspace: ${name}`).start();

  try {
    const gitRoot = findGitRoot();
    const wsPath = getWorkspacePath(gitRoot, name);
    // Priority: overrides (from interactive) > options (from flags) > default
    const branch = overrides?.branch || options.branch || `${agentId}/workspace/${name}`;

    if (existsSync(wsPath)) {
      spinner.fail(`Workspace already exists at ${wsPath}`);
      process.exit(1);
    }

    spinner.text = 'Creating git worktree...';
    if (branchExists(branch, gitRoot)) {
      git(`worktree add "${wsPath}" "${branch}"`, gitRoot);
    } else {
      git(`worktree add -b "${branch}" "${wsPath}"`, gitRoot);
    }

    // Determine which config dirs to copy
    const configDirsList =
      overrides?.configDirsList ??
      (options.copyConfig ? (options.configDirs || '.claude').split(',').map((s) => s.trim()) : []);

    if (configDirsList.length > 0) {
      spinner.text = 'Copying config directories...';
      copyConfigDirs(gitRoot, wsPath, configDirsList);
    }

    // Regenerate .codex/.gemini via syncMcpConfig if .mcp.json exists in the new workspace
    if (existsSync(join(wsPath, '.mcp.json'))) {
      spinner.text = 'Syncing MCP config for backends...';
      try {
        const { syncMcpConfig } = await import('./mcp.js');
        syncMcpConfig(wsPath);
      } catch {
        // syncMcpConfig not available or failed — not critical
      }
    }

    spinner.text = 'Setting up PCP identity...';
    const pcpDir = join(wsPath, '.pcp');
    mkdirSync(pcpDir, { recursive: true });

    // Always write fresh identity.json (never copy from source)
    const identity: WorkspaceIdentity = {
      agentId,
      context: `workspace-${name}`,
      ...(options.backend ? { backend: options.backend } : {}),
      description: options.purpose || `Workspace: ${name}`,
      workspace: name,
      branch,
      createdAt: new Date().toISOString(),
      createdBy: getCurrentUser(),
    };

    writeFileSync(join(pcpDir, 'identity.json'), JSON.stringify(identity, null, 2));

    // Auto-install PCP hooks
    spinner.text = 'Installing PCP hooks...';
    const { result: hooksResult, backend: hooksBackend } = installHooks(wsPath);

    spinner.succeed(`Studio created: ${name}`);
    console.log('');
    console.log(chalk.dim('  Path:   ') + wsPath);
    console.log(chalk.dim('  Branch: ') + branch);
    console.log(chalk.dim('  Agent:  ') + identity.agentId);
    if (configDirsList.length > 0) {
      console.log(chalk.dim('  Config: ') + configDirsList.join(', '));
    }
    if (hooksResult === 'installed') {
      console.log(chalk.dim('  Hooks:  ') + `${hooksBackend.name} (installed)`);
    } else if (hooksResult === 'already-installed') {
      console.log(chalk.dim('  Hooks:  ') + `${hooksBackend.name} (already installed)`);
    } else if (hooksResult === 'conflict') {
      console.log(
        chalk.yellow('  Hooks:  ') +
          `skipped — existing non-PCP hooks in ${hooksBackend.configPath}. Run: sb hooks install --force`
      );
    }
    console.log('');
    console.log(chalk.cyan('To start working:'));
    console.log(chalk.dim(`  cd ${wsPath} && sb`));
    console.log('');
    console.log(chalk.cyan('Or use:'));
    console.log(chalk.dim(`  eval $(sb studio cd ${name})`));
  } catch (error) {
    spinner.fail(`Failed to create workspace: ${error}`);
    process.exit(1);
  }
}

function listCommand(): void {
  const gitRoot = findGitRoot();
  const workspaces = listWorkspaces(gitRoot);

  if (workspaces.length === 0) {
    console.log(chalk.yellow('No workspaces found.'));
    console.log(chalk.dim('Create one with: sb studio create <name>'));
    return;
  }

  console.log(chalk.bold('\nPCP Studios:\n'));

  for (const ws of workspaces) {
    console.log(chalk.cyan(`  ${ws.name}`));
    console.log(chalk.dim(`    Folder: ${basename(ws.path)}`));
    console.log(chalk.dim(`    Path:   ${ws.path}`));
    console.log(chalk.dim(`    Branch: ${ws.branch}`));
    if (ws.identity) {
      console.log(chalk.dim(`    Agent:  ${ws.identity.agentId}`));
      if (ws.identity.createdBy) {
        console.log(chalk.dim(`    Owner:  ${ws.identity.createdBy}`));
      }
    }
    console.log('');
  }
}

async function removeWorkspace(name: string): Promise<void> {
  const spinner = ora(`Removing studio: ${name}`).start();

  try {
    const gitRoot = findGitRoot();
    const wsPath = getWorkspacePath(gitRoot, name);

    if (!existsSync(wsPath)) {
      spinner.fail(`Studio not found: ${name}`);
      process.exit(1);
    }

    git(`worktree remove "${wsPath}"`, gitRoot);
    spinner.succeed(`Studio removed: ${name}`);
    console.log(chalk.dim('  Branch kept for PR. Use "sb studio clean" to also delete branch.'));
  } catch (error) {
    spinner.fail(`Failed to remove workspace: ${error}`);
    process.exit(1);
  }
}

async function cleanWorkspace(name: string): Promise<void> {
  const spinner = ora(`Cleaning studio: ${name}`).start();

  try {
    const gitRoot = findGitRoot();
    const wsPath = getWorkspacePath(gitRoot, name);

    // Read branch from identity.json if available, fall back to git worktree list
    let branch: string | undefined;
    const identityPath = join(wsPath, '.pcp', 'identity.json');
    if (existsSync(identityPath)) {
      try {
        const identity = JSON.parse(readFileSync(identityPath, 'utf-8'));
        branch = identity.branch;
      } catch {
        // Fall through to worktree lookup
      }
    }

    if (!branch) {
      // Look up branch from git worktree list
      const worktreeOutput = git('worktree list --porcelain', gitRoot);
      let currentPath = '';
      for (const line of worktreeOutput.split('\n')) {
        if (line.startsWith('worktree ')) {
          currentPath = line.substring(9);
        } else if (line.startsWith('branch ') && currentPath === wsPath) {
          branch = line.substring(7).replace('refs/heads/', '');
        }
      }
    }

    if (existsSync(wsPath)) {
      spinner.text = 'Removing worktree...';
      git(`worktree remove "${wsPath}" --force`, gitRoot);
    }

    if (branch && branchExists(branch, gitRoot)) {
      spinner.text = 'Deleting branch...';
      git(`branch -D "${branch}"`, gitRoot);
    }

    spinner.succeed(`Cleaned studio: ${name}`);
  } catch (error) {
    spinner.fail(`Failed to clean workspace: ${error}`);
    process.exit(1);
  }
}

function statusCommand(): void {
  const gitRoot = findGitRoot();
  const workspaces = listWorkspaces(gitRoot);

  console.log(chalk.bold('\nStudio Status:\n'));

  console.log(chalk.cyan(`  main (${gitRoot})`));
  try {
    const status = git('status --short', gitRoot);
    if (status) {
      for (const line of status.split('\n')) {
        console.log(chalk.dim(`    ${line}`));
      }
    } else {
      console.log(chalk.green('    Clean'));
    }
  } catch {
    console.log(chalk.red('    Error getting status'));
  }
  console.log('');

  for (const ws of workspaces) {
    console.log(chalk.cyan(`  ${ws.name} (${ws.branch})`));
    try {
      const status = git('status --short', ws.path);
      if (status) {
        for (const line of status.split('\n')) {
          console.log(chalk.dim(`    ${line}`));
        }
      } else {
        console.log(chalk.green('    Clean'));
      }
    } catch {
      console.log(chalk.red('    Error getting status'));
    }
    console.log('');
  }
}

function pathCommand(name: string): void {
  const gitRoot = findGitRoot();
  const wsPath = getWorkspacePath(gitRoot, name);

  if (!existsSync(wsPath)) {
    console.error(`Studio not found: ${name}`);
    process.exit(1);
  }

  console.log(wsPath);
}

function cdCommand(name: string): void {
  const gitRoot = findGitRoot();
  const wsPath = getWorkspacePath(gitRoot, name);

  if (!existsSync(wsPath)) {
    console.error(`Studio not found: ${name}`);
    process.exit(1);
  }

  // Output shell command that can be eval'd
  console.log(`cd "${wsPath}"`);
}

// ============================================================================
// Register Commands
// ============================================================================

// Exported for testing
export {
  findGitRoot,
  getWorkspaceParent,
  getWorkspacePrefix,
  getWorkspacePath,
  getWorktreePaths,
  planInit,
  git,
};
export type { InitResult };

export function registerWorkspaceCommands(program: Command): void {
  const ws = program
    .command('studio')
    .alias('ws')
    .description('Studio management for parallel development (worktree-backed)');

  ws.command('init [parent-name]')
    .description('Initialize parent directory structure (groups repo + worktrees)')
    .option('-n, --dry-run', 'Show planned moves without making changes')
    .action(initWorkspace);

  ws.command('create [name]')
    .description('Create a new workspace with git worktree')
    .option('-a, --agent <agent>', 'Agent ID for this workspace', 'wren')
    .option('-p, --purpose <desc>', 'Description/purpose of the workspace')
    .option('-b, --branch <branch>', 'Custom branch name (default: <agentId>/workspace/<name>)')
    .option('--backend <name>', 'Primary backend (claude-code, codex, gemini)')
    .option('--copy-config', 'Copy config directories into the new workspace')
    .option(
      '--config-dirs <dirs>',
      'Comma-separated config dirs to copy (default: .claude)',
      '.claude'
    )
    .action(async (name: string | undefined, options) => {
      if (!name && process.stdin.isTTY) {
        // Interactive mode: prompt for all values
        try {
          const gitRoot = findGitRoot();
          const agentId = options.agent || 'wren';
          const result = await runInteractiveFlow(agentId, gitRoot);
          return createWorkspace(result.name, options, {
            branch: result.branch,
            configDirsList: result.configDirs,
          });
        } catch {
          // User cancelled or inquirer failed — fall through to default
        }
      }
      const resolvedName = name || 'new';
      return createWorkspace(resolvedName, options);
    });

  ws.command('list').alias('ls').description('List all workspaces').action(listCommand);

  ws.command('remove <name>')
    .alias('rm')
    .description('Remove a workspace (keeps branch for PR)')
    .action(removeWorkspace);

  ws.command('clean <name>')
    .description('Remove workspace and delete branch')
    .action(cleanWorkspace);

  ws.command('status')
    .alias('st')
    .description('Show git status of all workspaces')
    .action(statusCommand);

  ws.command('path <name>').description('Output workspace path').action(pathCommand);

  ws.command('cd <name>')
    .description('Output cd command (use with: eval $(sb studio cd <name>))')
    .action(cdCommand);
}
