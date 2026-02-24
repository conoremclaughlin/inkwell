/**
 * Studio Commands
 *
 * Manage git worktrees for parallel development with PCP identity.
 *
 * Commands:
 *   studio init [name]     Initialize parent directory structure
 *   studio create <name>   Create a new studio
 *   studio list            List all studios
 *   studio remove <name>   Remove a studio (keeps branch)
 *   studio clean <name>    Remove studio and delete branch
 *   studio status          Show status of all studios
 *   studio path <name>     Output studio path (for cd)
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
  statSync,
} from 'fs';
import {
  join,
  dirname,
  basename,
  parse as parsePath,
  resolve as resolvePath,
  delimiter as pathDelimiter,
} from 'path';
import { homedir } from 'os';
import { installHooks } from './hooks.js';
import { loadAuth, decodeJwtPayload, isTokenExpired } from '../auth/tokens.js';
import { resolveAgentId } from '../backends/identity.js';

interface StudioIdentity {
  agentId: string;
  identityId?: string;
  context: string;
  backend?: string;
  studioId?: string;
  studio: string;
  description: string;
  branch: string;
  createdAt: string;
  createdBy?: string;
}

interface StudioInfo {
  name: string;
  path: string;
  branch: string;
  identity?: StudioIdentity;
}

interface RenameIdentity {
  studio?: string;
  workspace?: string;
  context?: string;
  description?: string;
  [key: string]: unknown;
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

function getStudioParent(gitRoot: string): string {
  return dirname(gitRoot);
}

function resolveCanonicalRepoRoot(gitRoot: string): string {
  const gitFile = join(gitRoot, '.git');
  if (!existsSync(gitFile)) return gitRoot;

  try {
    const stat = readFileSync(gitFile, 'utf-8');
    const match = stat.match(/^gitdir:\s*(.+)\s*$/m);
    if (!match) return gitRoot;

    const gitDirPath = resolvePath(gitRoot, match[1]);
    const marker = `${join('.git', 'worktrees')}`;
    const idx = gitDirPath.lastIndexOf(marker);
    if (idx === -1) return gitRoot;

    // /path/to/repo/.git/worktrees/name -> /path/to/repo
    return resolvePath(gitDirPath.slice(0, idx));
  } catch {
    return gitRoot;
  }
}

function getStudioPrefix(gitRoot: string): string {
  // Use canonical repo name (main worktree), not the current worktree folder.
  // This avoids nested prefixes like repo--lumen--alpha when run from repo--lumen.
  const canonicalRoot = resolveCanonicalRepoRoot(gitRoot);
  return `${basename(canonicalRoot)}--`;
}

function getStudioPath(gitRoot: string, name: string): string {
  return join(getStudioParent(gitRoot), `${getStudioPrefix(gitRoot)}${name}`);
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

function listStudios(gitRoot: string): StudioInfo[] {
  const parentDir = getStudioParent(gitRoot);
  const studios: StudioInfo[] = [];

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

  const prefix = getStudioPrefix(gitRoot);
  if (existsSync(parentDir)) {
    for (const entry of readdirSync(parentDir)) {
      if (entry.startsWith(prefix)) {
        const wsPath = join(parentDir, entry);
        const name = entry.slice(prefix.length);
        const branch = worktrees.get(wsPath) || 'unknown';

        let identity: StudioIdentity | undefined;
        const identityPath = join(wsPath, '.pcp', 'identity.json');
        if (existsSync(identityPath)) {
          try {
            identity = JSON.parse(readFileSync(identityPath, 'utf-8'));
          } catch {
            // Ignore
          }
        }

        studios.push({ name, path: wsPath, branch, identity });
      }
    }
  }

  return studios;
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

function isPromptCancelError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const maybe = err as { name?: string; message?: string };
  const name = maybe.name || '';
  const message = maybe.message || '';

  return (
    name === 'ExitPromptError' ||
    name === 'AbortPromptError' ||
    /force closed|ctrl\+c|sigint|cancell?ed|aborted/i.test(message)
  );
}

/**
 * Run the full interactive studio creation flow when name is omitted and stdin is a TTY.
 * Returns the resolved name, branch, and config dirs to copy.
 */
async function runInteractiveFlow(agentId: string, gitRoot: string): Promise<InteractiveResult> {
  const { input, checkbox } = await import('@inquirer/prompts');

  // Step 1: Studio name
  const name = await input({
    message: 'Studio name',
    default: 'new',
  });

  // Step 2: Branch name (derived, editable)
  const defaultBranch = `${agentId}/studio/main`;
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
      message: 'Copy config folders? (space to toggle, enter to confirm)',
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
 * Copy config directories from git root into the new studio.
 *
 * - .claude/ is always copied as-is (hand-authored permissions)
 * - .codex/, .gemini/ — if .mcp.json exists in the target, regenerate via syncMcpConfig instead
 * - .pcp/identity.json is always freshly written (never copied)
 */
function copyConfigDirs(sourceRoot: string, wsPath: string, dirs: string[]): void {
  for (const dir of dirs) {
    const source = join(sourceRoot, dir);
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

function resolveCopySourceRoot(gitRoot: string, copyFrom?: string): string {
  const canonicalRoot = resolveCanonicalRepoRoot(gitRoot);
  if (!copyFrom || copyFrom === 'main') {
    return canonicalRoot;
  }

  const explicitPath = resolvePath(copyFrom);
  if (existsSync(explicitPath)) {
    if (!statSync(explicitPath).isDirectory()) {
      throw new Error(`--copy-from must point to a directory: ${copyFrom}`);
    }
    return explicitPath;
  }

  const studioPath = getStudioPath(gitRoot, copyFrom);
  if (existsSync(studioPath)) {
    return studioPath;
  }

  throw new Error(`Copy source not found: ${copyFrom}`);
}

/**
 * Copy .mcp.json and .env.local when missing in the new studio.
 * These are local bootstrap files and should be present by default.
 */
function copyBootstrapFiles(sourceRoot: string, wsPath: string): string[] {
  if (sourceRoot === wsPath) return [];

  const copied: string[] = [];
  for (const file of ['.mcp.json', '.env.local']) {
    const source = join(sourceRoot, file);
    const target = join(wsPath, file);
    if (existsSync(source) && !existsSync(target)) {
      cpSync(source, target);
      copied.push(file);
    }
  }
  return copied;
}

function updateIdentityForStudioRename(wsPath: string, from: string, to: string): boolean {
  const identityPath = join(wsPath, '.pcp', 'identity.json');
  if (!existsSync(identityPath)) return false;

  try {
    const identity = JSON.parse(readFileSync(identityPath, 'utf-8')) as RenameIdentity;
    let changed = false;

    if (identity.studio !== to) {
      identity.studio = to;
      changed = true;
    }

    if (identity.workspace && identity.workspace === from) {
      identity.workspace = to;
      changed = true;
    }

    if (identity.context === `studio-${from}` || identity.context === `workspace-${from}`) {
      identity.context = `studio-${to}`;
      changed = true;
    }

    if (
      identity.description === `Studio: ${from}` ||
      identity.description === `Workspace: ${from}`
    ) {
      identity.description = `Studio: ${to}`;
      changed = true;
    }

    if (changed) {
      writeFileSync(identityPath, JSON.stringify(identity, null, 2));
    }
    return changed;
  } catch {
    return false;
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
  const grandparent = getStudioParent(gitRoot);
  const repoName = basename(gitRoot);
  const parentDir = join(grandparent, parentName);

  const moves: Array<{ from: string; to: string }> = [];

  // Main repo move
  moves.push({ from: gitRoot, to: join(parentDir, repoName) });

  // Find existing worktrees that are siblings of the main repo
  const prefix = getStudioPrefix(gitRoot);
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

async function initStudio(
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

async function createStudio(
  name: string,
  options: {
    agent?: string;
    purpose?: string;
    branch?: string;
    backend?: string;
    copyConfig?: boolean;
    configDirs?: string;
    copyFrom?: string;
  },
  overrides?: { branch?: string; configDirsList?: string[] }
): Promise<void> {
  const agentId = options.agent || resolveAgentId() || 'sb';
  const spinner = ora(`Creating studio: ${name}`).start();

  try {
    const gitRoot = findGitRoot();
    const copySourceRoot = resolveCopySourceRoot(gitRoot, options.copyFrom);
    const wsPath = getStudioPath(gitRoot, name);
    // Priority: overrides (from interactive) > options (from flags) > default
    const branch = overrides?.branch || options.branch || `${agentId}/studio/main`;

    if (existsSync(wsPath)) {
      spinner.fail(`Studio already exists at ${wsPath}`);
      process.exit(1);
    }

    spinner.text = 'Creating git worktree...';
    if (branchExists(branch, gitRoot)) {
      git(`worktree add "${wsPath}" "${branch}"`, gitRoot);
    } else {
      git(`worktree add -b "${branch}" "${wsPath}"`, gitRoot);
    }

    spinner.text = 'Copying bootstrap files...';
    const copiedBootstrapFiles = copyBootstrapFiles(copySourceRoot, wsPath);

    // Determine which config dirs to copy
    const configDirsList =
      overrides?.configDirsList ??
      (options.copyConfig ? (options.configDirs || '.claude').split(',').map((s) => s.trim()) : []);

    if (configDirsList.length > 0) {
      spinner.text = 'Copying config directories...';
      copyConfigDirs(copySourceRoot, wsPath, configDirsList);
    }

    // Regenerate .codex/.gemini via syncMcpConfig if .mcp.json exists in the new studio
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

    // Resolve identityId from auth token if available
    let identityId: string | undefined;
    const auth = loadAuth();
    if (auth && !isTokenExpired(auth)) {
      const payload = decodeJwtPayload(auth.access_token);
      if (payload?.identityId) {
        identityId = payload.identityId;
      }
    }

    // Always write fresh identity.json (never copy from source)
    const identity: StudioIdentity = {
      agentId,
      ...(identityId ? { identityId } : {}),
      context: `studio-${name}`,
      ...(options.backend ? { backend: options.backend } : {}),
      studio: name,
      description: options.purpose || `Studio: ${name}`,
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
    if (copiedBootstrapFiles.length > 0) {
      console.log(chalk.dim('  Files:  ') + copiedBootstrapFiles.join(', '));
    }
    if (options.copyFrom) {
      console.log(chalk.dim('  Source: ') + copySourceRoot);
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
    spinner.fail(`Failed to create studio: ${error}`);
    process.exit(1);
  }
}

async function renameStudio(from: string, to: string): Promise<void> {
  const spinner = ora(`Renaming studio: ${from} → ${to}`).start();

  try {
    const gitRoot = findGitRoot();
    const fromPath = getStudioPath(gitRoot, from);
    const toPath = getStudioPath(gitRoot, to);

    if (!existsSync(fromPath)) {
      spinner.fail(`Studio not found: ${from}`);
      process.exit(1);
    }

    if (existsSync(toPath)) {
      spinner.fail(`Target studio already exists: ${to}`);
      process.exit(1);
    }

    git(`worktree move "${fromPath}" "${toPath}"`, gitRoot);

    spinner.text = 'Updating studio identity metadata...';
    const updatedIdentity = updateIdentityForStudioRename(toPath, from, to);

    // Intentionally keep existing branch name unchanged.
    // Studio names are path/identity labels; branch naming is an independent concern.
    const branch = git('branch --show-current', toPath);

    spinner.succeed(`Studio renamed: ${from} → ${to}`);
    console.log('');
    console.log(chalk.dim('  Path:   ') + toPath);
    console.log(chalk.dim('  Branch: ') + branch + chalk.dim(' (unchanged)'));
    if (updatedIdentity) {
      console.log(chalk.dim('  Identity updated: ') + chalk.green('.pcp/identity.json'));
    }
  } catch (error) {
    spinner.fail(
      `Failed to rename studio: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exit(1);
  }
}

function listCommand(): void {
  const gitRoot = findGitRoot();
  const studios = listStudios(gitRoot);

  if (studios.length === 0) {
    console.log(chalk.yellow('No studios found.'));
    console.log(chalk.dim('Create one with: sb studio create <name>'));
    return;
  }

  console.log(chalk.bold('\nPCP Studios:\n'));

  for (const ws of studios) {
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

async function removeStudio(name: string): Promise<void> {
  const spinner = ora(`Removing studio: ${name}`).start();

  try {
    const gitRoot = findGitRoot();
    const wsPath = getStudioPath(gitRoot, name);

    if (!existsSync(wsPath)) {
      spinner.fail(`Studio not found: ${name}`);
      process.exit(1);
    }

    git(`worktree remove "${wsPath}"`, gitRoot);
    spinner.succeed(`Studio removed: ${name}`);
    console.log(chalk.dim('  Branch kept for PR. Use "sb studio clean" to also delete branch.'));
  } catch (error) {
    spinner.fail(`Failed to remove studio: ${error}`);
    process.exit(1);
  }
}

async function cleanStudio(name: string): Promise<void> {
  const spinner = ora(`Cleaning studio: ${name}`).start();

  try {
    const gitRoot = findGitRoot();
    const wsPath = getStudioPath(gitRoot, name);

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
    spinner.fail(`Failed to clean studio: ${error}`);
    process.exit(1);
  }
}

function statusCommand(): void {
  const gitRoot = findGitRoot();
  const studios = listStudios(gitRoot);

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

  for (const studio of studios) {
    console.log(chalk.cyan(`  ${studio.name} (${studio.branch})`));
    try {
      const status = git('status --short', studio.path);
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
  const wsPath = getStudioPath(gitRoot, name);

  if (!existsSync(wsPath)) {
    console.error(`Studio not found: ${name}`);
    process.exit(1);
  }

  console.log(wsPath);
}

function cdCommand(name: string): void {
  const gitRoot = findGitRoot();
  const wsPath = getStudioPath(gitRoot, name);

  if (!existsSync(wsPath)) {
    console.error(`Studio not found: ${name}`);
    process.exit(1);
  }

  // Output shell command that can be eval'd
  console.log(`cd "${wsPath}"`);
}

// ============================================================================
// CLI Link
// ============================================================================

function resolveCliRoot(): string {
  // Walk up from cwd checking each directory and its packages/cli subdir
  let dir = process.cwd();
  const { root } = parsePath(dir);
  while (true) {
    for (const candidate of [join(dir, 'packages', 'cli'), dir]) {
      const pkgPath = join(candidate, 'package.json');
      if (existsSync(pkgPath)) {
        try {
          const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
          if (pkg.name === '@personal-context/cli') return candidate;
        } catch {
          // continue
        }
      }
    }
    if (dir === root) break;
    dir = dirname(dir);
  }
  throw new Error('Could not find @personal-context/cli package. Run from within the repo.');
}

function resolveDefaultCliName(): string {
  const cwd = process.cwd();
  const identityPath = join(cwd, '.pcp', 'identity.json');
  if (existsSync(identityPath)) {
    try {
      const identity = JSON.parse(readFileSync(identityPath, 'utf-8'));
      if (identity.agentId) return `sb-${identity.agentId}`;
    } catch {
      // fall through
    }
  }
  // Fall back to directory-based name
  const dirName = basename(cwd);
  const match = dirName.match(/--(.+)$/);
  if (match) return `sb-${match[1]}`;
  return 'sb-dev';
}

type CliLinkTargets = {
  primaryBinDir: string;
  compatBinDir: string;
  primaryLinkPath: string;
  compatLinkPath: string;
};

function getCliLinkTargets(homeDir: string, name: string): CliLinkTargets {
  const primaryBinDir = join(homeDir, '.pcp', 'bin');
  const compatBinDir = join(homeDir, '.local', 'bin');
  return {
    primaryBinDir,
    compatBinDir,
    primaryLinkPath: join(primaryBinDir, name),
    compatLinkPath: join(compatBinDir, name),
  };
}

function shouldWarnMissingCliBinPath(pathValue: string | undefined, targets: CliLinkTargets): boolean {
  const pathEntries = (pathValue || '').split(pathDelimiter);
  return !pathEntries.includes(targets.primaryBinDir) && !pathEntries.includes(targets.compatBinDir);
}

async function cliLinkCommand(options: { name?: string; unlink?: boolean }): Promise<void> {
  const name = options.name || resolveDefaultCliName();
  const targets = getCliLinkTargets(homedir(), name);
  const { primaryBinDir, compatBinDir, primaryLinkPath, compatLinkPath } = targets;

  if (options.unlink) {
    let removed = false;
    if (existsSync(primaryLinkPath)) {
      const { unlinkSync } = await import('fs');
      unlinkSync(primaryLinkPath);
      console.log(chalk.green(`Unlinked: ${primaryLinkPath}`));
      removed = true;
    }
    if (existsSync(compatLinkPath)) {
      const { unlinkSync } = await import('fs');
      unlinkSync(compatLinkPath);
      console.log(chalk.green(`Unlinked compatibility link: ${compatLinkPath}`));
      removed = true;
    }
    if (!removed) {
      console.log(chalk.dim(`Not found: ${primaryLinkPath}`));
      console.log(chalk.dim(`Not found: ${compatLinkPath}`));
    }
    return;
  }

  let cliRoot: string;
  try {
    cliRoot = resolveCliRoot();
  } catch (err) {
    console.error(chalk.red(err instanceof Error ? err.message : String(err)));
    process.exit(1);
    return;
  }

  const spinner = ora(`Building CLI from ${cliRoot}`).start();

  try {
    // Build
    execSync('npx tsc', { cwd: cliRoot, stdio: 'pipe' });

    // Copy templates (matches the build script)
    const templatesSource = join(cliRoot, 'src', 'templates');
    const templatesDest = join(cliRoot, 'dist', 'templates');
    if (existsSync(templatesSource)) {
      cpSync(templatesSource, templatesDest, { recursive: true });
    }

    // Ensure executable
    const cliJs = join(cliRoot, 'dist', 'cli.js');
    if (!existsSync(cliJs)) {
      spinner.fail('Build succeeded but dist/cli.js not found');
      process.exit(1);
    }
    execSync(`chmod +x "${cliJs}"`, { stdio: 'pipe' });

    // Create symlink
    mkdirSync(primaryBinDir, { recursive: true });
    mkdirSync(compatBinDir, { recursive: true });
    const { symlinkSync, unlinkSync } = await import('fs');

    // Remove existing symlink if present
    if (existsSync(primaryLinkPath)) {
      unlinkSync(primaryLinkPath);
    }
    if (existsSync(compatLinkPath)) {
      unlinkSync(compatLinkPath);
    }
    symlinkSync(cliJs, primaryLinkPath);
    symlinkSync(primaryLinkPath, compatLinkPath);

    spinner.succeed(`Linked: ${primaryLinkPath} → ${cliJs}`);
    console.log(chalk.dim(`  Compatibility link: ${compatLinkPath} → ${primaryLinkPath}`));

    if (shouldWarnMissingCliBinPath(process.env.PATH, targets)) {
      console.log(
        chalk.yellow(
          `  PATH warning: neither ${primaryBinDir} nor ${compatBinDir} is currently in PATH`
        )
      );
      console.log(
        chalk.dim(`  Add one of them to your shell profile so '${name}' resolves in new shells.`)
      );
    }

    console.log('');
    console.log(chalk.dim(`  Test it: ${name} --help`));
    console.log(chalk.dim(`  Remove:  sb studio cli --unlink${options.name ? ` --name ${name}` : ''}`));
  } catch (error) {
    spinner.fail(`Failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

// ============================================================================
// Register Commands
// ============================================================================

// Exported for testing
export {
  findGitRoot,
  getStudioParent,
  getStudioPrefix,
  getStudioPath,
  getWorktreePaths,
  updateIdentityForStudioRename,
  resolveCopySourceRoot,
  getCliLinkTargets,
  shouldWarnMissingCliBinPath,
  planInit,
  git,
};
export type { InitResult };

export function registerStudioCommands(program: Command): void {
  const ws = program
    .command('studio')
    .alias('ws')
    .description('Studio management for parallel development (worktree-backed)');

  ws.command('init [parent-name]')
    .description('Initialize parent directory structure (groups repo + worktrees)')
    .option('-n, --dry-run', 'Show planned moves without making changes')
    .action(initStudio);

  ws.command('create [name]')
    .description('Create a new studio with git worktree')
    .option('-a, --agent <agent>', 'Agent ID for this studio')
    .option('-p, --purpose <desc>', 'Description/purpose of the studio')
    .option('-br, --branch <branch>', 'Custom branch name (default: <agentId>/studio/main)')
    .option('-b, --backend <name>', 'Primary backend (claude-code, codex, gemini)')
    .option('--copy-config', 'Copy config directories into the new studio')
    .option(
      '--config-dirs <dirs>',
      'Comma-separated config dirs to copy (default: .claude)',
      '.claude'
    )
    .option(
      '--copy-from <source>',
      'Copy bootstrap files (.mcp.json, .env.local) and config dirs from source studio/path (default: main worktree)'
    )
    .action(async (name: string | undefined, options) => {
      if (!name && process.stdin.isTTY) {
        // Interactive mode: prompt for all values
        try {
          const gitRoot = findGitRoot();
          const copySourceRoot = resolveCopySourceRoot(gitRoot, options.copyFrom);
          const agentId = options.agent || resolveAgentId() || 'sb';
          const result = await runInteractiveFlow(agentId, copySourceRoot);
          return createStudio(result.name, options, {
            branch: result.branch,
            configDirsList: result.configDirs,
          });
        } catch (err) {
          if (isPromptCancelError(err)) {
            console.log(chalk.yellow('\nStudio creation canceled.'));
            process.exit(130);
          }
          const message = err instanceof Error ? err.message : String(err);
          console.error(chalk.red(`Interactive studio creation failed: ${message}`));
          process.exit(1);
        }
      }
      const resolvedName = name || 'new';
      return createStudio(resolvedName, options);
    });

  ws.command('list').alias('ls').description('List all studios').action(listCommand);

  ws.command('remove <name>')
    .alias('rm')
    .description('Remove a studio (keeps branch for PR)')
    .action(removeStudio);

  ws.command('clean <name>')
    .description('Remove studio and delete branch')
    .action(cleanStudio);

  ws.command('status')
    .alias('st')
    .description('Show git status of all studios')
    .action(statusCommand);

  ws.command('rename <from> <to>')
    .alias('mv')
    .description('Rename a studio (moves worktree path and updates identity metadata)')
    .action(renameStudio);

  ws.command('path <name>').description('Output studio path').action(pathCommand);

  ws.command('cd <name>')
    .description('Output cd command (use with: eval $(sb studio cd <name>))')
    .action(cdCommand);

  ws.command('cli')
    .description('Build CLI and link as a named binary in ~/.pcp/bin (default: sb-<agent>)')
    .option('-n, --name <name>', 'Binary name (default: sb-<agent> from .pcp/identity.json)')
    .option('--unlink', 'Remove the linked binary instead of creating it')
    .action(cliLinkCommand);
}
