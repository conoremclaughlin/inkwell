import { execFileSync, execSync, spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { basename, dirname, join, resolve as resolvePath } from 'path';
import { Command } from 'commander';
import chalk from 'chalk';
import { readIdentityJson } from '../backends/identity.js';

export type StudioAccessMode = 'none' | 'ro' | 'rw';
export type StudioNetworkMode = 'default' | 'none';
export type BackendAuthName = 'claude' | 'codex' | 'gemini';

export interface StudioSandboxMount {
  source: string;
  target: string;
  readOnly: boolean;
  reason: string;
}

export interface StudioSandboxContext {
  studioPath: string;
  studioName: string;
  studioId?: string;
  agentId?: string;
  canonicalRepoRoot: string;
  canonicalGitDir?: string;
  worktreePaths: string[];
}

export interface StudioSandboxPlanOptions {
  image?: string;
  studioAccess?: StudioAccessMode;
  network?: StudioNetworkMode;
  includeSiblingStudios?: boolean;
  extraMountSpecs?: string[];
  backendAuth?: BackendAuthName[];
}

export interface StudioSandboxPlan {
  containerName: string;
  image: string;
  workdir: '/studio';
  uid?: number;
  gid?: number;
  network: StudioNetworkMode;
  studioAccess: StudioAccessMode;
  context: StudioSandboxContext;
  mounts: StudioSandboxMount[];
  env: Record<string, string>;
  patchedMcpConfigPath?: string;
}

export interface ParsedExtraMount {
  source: string;
  target: string;
  readOnly: boolean;
}

const DEFAULT_IMAGE = 'personal-context-protocol:studio-sandbox';
const CONTAINER_HOME = '/home/sb';
const BACKEND_AUTH_DIRS: Record<BackendAuthName, string> = {
  claude: join(homedir(), '.claude'),
  codex: join(homedir(), '.codex'),
  gemini: join(homedir(), '.gemini'),
};

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function findGitRoot(cwd: string): string {
  return git(['rev-parse', '--show-toplevel'], cwd);
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

    return resolvePath(gitDirPath.slice(0, idx));
  } catch {
    return gitRoot;
  }
}

function resolveCanonicalGitDir(gitRoot: string): string | undefined {
  const gitPath = join(gitRoot, '.git');
  if (!existsSync(gitPath)) return undefined;

  try {
    const raw = readFileSync(gitPath, 'utf-8');
    const match = raw.match(/^gitdir:\s*(.+)\s*$/m);
    if (match) {
      return resolvePath(gitRoot, match[1]);
    }
  } catch {
    // .git is likely a directory in the main worktree.
  }

  return gitPath;
}

function getWorktreePaths(canonicalRepoRoot: string): string[] {
  const worktreeOutput = git(['worktree', 'list', '--porcelain'], canonicalRepoRoot);
  const worktrees: string[] = [];

  for (const line of worktreeOutput.split('\n')) {
    if (line.startsWith('worktree ')) {
      worktrees.push(resolvePath(line.slice('worktree '.length)));
    }
  }

  return worktrees;
}

function sanitizeSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
}

function buildContainerName(context: StudioSandboxContext): string {
  const label = sanitizeSlug(context.studioName || basename(context.studioPath) || 'studio');
  const digest = createHash('sha256').update(context.studioPath).digest('hex').slice(0, 10);
  return `ink-studio-sandbox-${label}-${digest}`;
}

function rewriteLoopbackUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    if (
      parsed.hostname === 'localhost' ||
      parsed.hostname === '127.0.0.1' ||
      parsed.hostname === '::1' ||
      parsed.hostname === '[::1]'
    ) {
      parsed.hostname = 'host.docker.internal';
      return parsed.toString();
    }
  } catch {
    // Non-URL strings are left untouched.
  }
  return rawUrl;
}

function resolveSandboxServerUrl(): string {
  return rewriteLoopbackUrl(process.env.INK_SERVER_URL || 'http://localhost:3001').replace(
    /\/+$/,
    ''
  );
}

function ensurePatchedMcpConfig(studioPath: string): string | undefined {
  const sourcePath = join(studioPath, '.mcp.json');
  if (!existsSync(sourcePath)) return undefined;

  try {
    const parsed = JSON.parse(readFileSync(sourcePath, 'utf-8')) as {
      mcpServers?: Record<string, { type?: string; url?: string }>;
    };
    const servers = parsed.mcpServers;
    if (!servers) return undefined;

    let modified = false;
    for (const server of Object.values(servers)) {
      if (server?.type === 'http' && typeof server.url === 'string') {
        const rewritten = rewriteLoopbackUrl(server.url);
        if (rewritten !== server.url) {
          server.url = rewritten;
          modified = true;
        }
      }
    }

    if (!modified) return undefined;

    const runtimeDir = join(studioPath, '.ink', 'runtime', 'studio-sandbox');
    mkdirSync(runtimeDir, { recursive: true });
    const targetPath = join(runtimeDir, 'mcp.docker.json');
    writeFileSync(targetPath, JSON.stringify(parsed, null, 2) + '\n', 'utf-8');
    return targetPath;
  } catch {
    return undefined;
  }
}

function isDangerousSourcePath(source: string): boolean {
  const normalized = resolvePath(source);
  const home = resolvePath(homedir());
  const blocked = new Set([
    '/',
    '/etc',
    '/proc',
    '/sys',
    '/dev',
    '/var/run/docker.sock',
    join(home, '.ssh'),
    join(home, '.aws'),
    join(home, '.gnupg'),
    join(home, '.kube'),
    join(home, '.config', 'gcloud'),
  ]);

  if (blocked.has(normalized)) return true;
  if (normalized === home) return true;
  return false;
}

export function parseExtraMount(spec: string): ParsedExtraMount {
  const parts = spec.split(':');
  if (parts.length < 2 || parts.length > 3) {
    throw new Error(
      `Invalid mount "${spec}". Expected hostPath:containerPath[:ro|rw] format.`
    );
  }

  const [source, target, mode = 'rw'] = parts;
  if (!source || !target) {
    throw new Error(`Invalid mount "${spec}". Source and target are required.`);
  }

  const normalizedSource = resolvePath(source);
  if (!existsSync(normalizedSource)) {
    throw new Error(`Mount source does not exist: ${normalizedSource}`);
  }

  if (!target.startsWith('/')) {
    throw new Error(`Mount target must be absolute: ${target}`);
  }

  if (isDangerousSourcePath(normalizedSource)) {
    throw new Error(`Refusing dangerous mount source: ${normalizedSource}`);
  }

  if (mode !== 'ro' && mode !== 'rw') {
    throw new Error(`Invalid mount mode "${mode}" for ${spec}. Use ro or rw.`);
  }

  return {
    source: normalizedSource,
    target,
    readOnly: mode === 'ro',
  };
}

export function resolveBackendAuthNames(raw?: string): BackendAuthName[] {
  if (!raw?.trim()) return [];
  const values = raw
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);

  if (values.includes('all')) {
    return ['claude', 'codex', 'gemini'];
  }

  const unique = new Set<BackendAuthName>();
  for (const value of values) {
    if (value !== 'claude' && value !== 'codex' && value !== 'gemini') {
      throw new Error(`Unsupported backend auth mount: ${value}`);
    }
    unique.add(value);
  }
  return [...unique];
}

export function getStudioSandboxContext(cwd: string): StudioSandboxContext {
  const studioPath = findGitRoot(cwd);
  const canonicalRepoRoot = resolveCanonicalRepoRoot(studioPath);
  const identity = readIdentityJson(studioPath);

  return {
    studioPath,
    studioName: identity?.studio || basename(studioPath),
    studioId: identity?.studioId,
    agentId: identity?.agentId,
    canonicalRepoRoot,
    canonicalGitDir: resolveCanonicalGitDir(canonicalRepoRoot),
    worktreePaths: getWorktreePaths(canonicalRepoRoot),
  };
}

function makeMount(
  source: string,
  target: string,
  readOnly: boolean,
  reason: string
): StudioSandboxMount {
  return {
    source: resolvePath(source),
    target,
    readOnly,
    reason,
  };
}

export function buildStudioSandboxPlan(
  cwd: string,
  options: StudioSandboxPlanOptions = {}
): StudioSandboxPlan {
  const context = getStudioSandboxContext(cwd);
  const studioAccess = options.studioAccess || 'rw';
  const includeSiblingStudios = options.includeSiblingStudios ?? true;
  const readOnly = studioAccess === 'ro';
  const mounts: StudioSandboxMount[] = [];

  if (studioAccess !== 'none') {
    mounts.push(makeMount(context.studioPath, '/studio', readOnly, 'active studio'));

    if (includeSiblingStudios) {
      for (const path of context.worktreePaths) {
        if (!existsSync(path)) continue;
        const target = `/studios/${basename(path)}`;
        mounts.push(makeMount(path, target, readOnly, 'sibling studio'));
      }
    }

    if (context.canonicalGitDir && existsSync(context.canonicalGitDir)) {
      mounts.push(
        makeMount(
          context.canonicalGitDir,
          context.canonicalGitDir,
          readOnly,
          'canonical git dir for worktree .git indirection'
        )
      );
    }
  }

  const patchedMcpConfigPath =
    studioAccess !== 'none' ? ensurePatchedMcpConfig(context.studioPath) : undefined;
  if (patchedMcpConfigPath) {
    mounts.push(
      makeMount(
        patchedMcpConfigPath,
        '/studio/.mcp.json',
        true,
        'patched MCP config with host.docker.internal rewrites'
      )
    );
  }

  for (const backend of options.backendAuth || []) {
    const sourceDir = BACKEND_AUTH_DIRS[backend];
    if (existsSync(sourceDir)) {
      mounts.push(
        makeMount(sourceDir, `${CONTAINER_HOME}/.${backend}`, true, `${backend} auth/config`)
      );
    }
  }

  for (const spec of options.extraMountSpecs || []) {
    const parsed = parseExtraMount(spec);
    mounts.push(makeMount(parsed.source, parsed.target, parsed.readOnly, 'explicit extra mount'));
  }

  const containerName = buildContainerName(context);
  const image = options.image || DEFAULT_IMAGE;
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  const gid = typeof process.getgid === 'function' ? process.getgid() : undefined;

  return {
    containerName,
    image,
    workdir: '/studio',
    uid,
    gid,
    network: options.network || 'default',
    studioAccess,
    context,
    mounts,
    env: {
      HOME: CONTAINER_HOME,
      INK_SERVER_URL: resolveSandboxServerUrl(),
      ...(context.agentId ? { AGENT_ID: context.agentId } : {}),
      ...(context.studioId ? { INK_STUDIO_ID: context.studioId } : {}),
      INK_SANDBOX: 'docker',
      INK_STUDIO_PATH: '/studio',
      INK_STUDIOS_PATH: '/studios',
    },
    ...(patchedMcpConfigPath ? { patchedMcpConfigPath } : {}),
  };
}

function mountArg(mount: StudioSandboxMount): string {
  return `type=bind,src=${mount.source},dst=${mount.target}${mount.readOnly ? ',readonly' : ''}`;
}

export function buildDockerRunArgs(
  plan: StudioSandboxPlan,
  options: { detach?: boolean; command?: string[]; interactive?: boolean } = {}
): string[] {
  const args = ['run', '--rm', '--name', plan.containerName];

  if (options.detach) {
    args.push('-d');
  }
  if (options.interactive) {
    args.push('-it');
  }

  args.push('--workdir', plan.workdir);
  args.push('--add-host', 'host.docker.internal:host-gateway');
  args.push('--hostname', plan.containerName);
  args.push('--label', 'pcp.studio-sandbox=true');
  args.push('--label', `pcp.studio.path=${plan.context.studioPath}`);

  if (plan.uid !== undefined && plan.gid !== undefined) {
    args.push('--user', `${plan.uid}:${plan.gid}`);
  }

  if (plan.network === 'none') {
    args.push('--network', 'none');
  }

  for (const [key, value] of Object.entries(plan.env)) {
    args.push('-e', `${key}=${value}`);
  }

  for (const mount of plan.mounts) {
    args.push('--mount', mountArg(mount));
  }

  args.push(plan.image);
  if (options.command?.length) {
    args.push(...options.command);
  }

  return args;
}

function runDocker(args: string[], inherit = true): void {
  const result = spawnSync('docker', args, {
    stdio: inherit ? 'inherit' : 'pipe',
    encoding: 'utf-8',
  });

  if (result.status !== 0) {
    throw new Error(result.stderr || `docker ${args[0]} failed with exit code ${result.status}`);
  }
}

function inspectContainerName(containerName: string): boolean {
  const result = spawnSync('docker', ['container', 'inspect', containerName], {
    stdio: 'ignore',
  });
  return result.status === 0;
}

function printPlan(plan: StudioSandboxPlan, json = false): void {
  if (json) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }

  console.log(chalk.bold('Studio sandbox plan'));
  console.log(chalk.dim(`  Container: ${plan.containerName}`));
  console.log(chalk.dim(`  Image:     ${plan.image}`));
  console.log(chalk.dim(`  Studio:    ${plan.context.studioPath}`));
  console.log(chalk.dim(`  Access:    ${plan.studioAccess}`));
  console.log(chalk.dim(`  Network:   ${plan.network}`));
  if (plan.patchedMcpConfigPath) {
    console.log(chalk.dim(`  MCP file:  ${plan.patchedMcpConfigPath}`));
  }
  console.log(chalk.bold('\nMounts'));
  for (const mount of plan.mounts) {
    console.log(
      chalk.dim(
        `  ${mount.source} -> ${mount.target}${mount.readOnly ? ' (ro)' : ' (rw)'} [${mount.reason}]`
      )
    );
  }
}

function addCommonSandboxOptions(command: Command): Command {
  return command
    .option('--image <image>', 'Sandbox image', DEFAULT_IMAGE)
    .option('--studio-access <mode>', 'Studio access: none|ro|rw', 'rw')
    .option('--network <mode>', 'Network mode: default|none', 'default')
    .option('--backend-auth <list>', 'Mount backend auth dirs: claude,codex,gemini,all')
    .option('--mount <spec...>', 'Extra mount(s): hostPath:containerPath[:ro|rw]')
    .option('--no-sibling-studios', 'Do not mount sibling studios under /studios');
}

function buildPlanFromCommand(cwd: string, options: Record<string, unknown>): StudioSandboxPlan {
  const studioAccess = String(options.studioAccess || 'rw') as StudioAccessMode;
  if (!['none', 'ro', 'rw'].includes(studioAccess)) {
    throw new Error(`Invalid --studio-access value: ${studioAccess}`);
  }

  const network = String(options.network || 'default') as StudioNetworkMode;
  if (!['default', 'none'].includes(network)) {
    throw new Error(`Invalid --network value: ${network}`);
  }

  return buildStudioSandboxPlan(cwd, {
    image: typeof options.image === 'string' ? options.image : DEFAULT_IMAGE,
    studioAccess,
    network,
    includeSiblingStudios: options.siblingStudios !== false,
    backendAuth: resolveBackendAuthNames(
      typeof options.backendAuth === 'string' ? options.backendAuth : undefined
    ),
    extraMountSpecs: Array.isArray(options.mount)
      ? (options.mount as string[])
      : typeof options.mount === 'string'
        ? [options.mount]
        : [],
  });
}

function buildSandboxImage(options: { image?: string; noCache?: boolean }, cwd: string): void {
  const gitRoot = findGitRoot(cwd);
  const args = ['build', '-f', join(gitRoot, 'Dockerfile.studio-sandbox'), '-t'];
  args.push(options.image || DEFAULT_IMAGE);
  if (options.noCache) args.push('--no-cache');
  args.push(gitRoot);
  runDocker(args);
}

function planCommand(options: Record<string, unknown>): void {
  const plan = buildPlanFromCommand(process.cwd(), options);
  printPlan(plan, Boolean(options.json));
}

function buildCommand(options: Record<string, unknown>): void {
  buildSandboxImage(
    {
      image: typeof options.image === 'string' ? options.image : DEFAULT_IMAGE,
      noCache: Boolean(options.noCache),
    },
    process.cwd()
  );
  console.log(chalk.green('✓ Studio sandbox image built'));
}

function upCommand(options: Record<string, unknown>): void {
  const plan = buildPlanFromCommand(process.cwd(), options);
  if (inspectContainerName(plan.containerName)) {
    console.log(chalk.yellow(`Sandbox already running: ${plan.containerName}`));
    return;
  }
  const args = buildDockerRunArgs(plan, { detach: true });
  runDocker(args);
  console.log(chalk.green(`✓ Started sandbox ${plan.containerName}`));
}

function runCommand(command: string[], options: Record<string, unknown>): void {
  const plan = buildPlanFromCommand(process.cwd(), options);
  const dockerCommand =
    command.length > 0 ? command : ['bash', '-lc', 'printf "Sandbox ready at %s\\n" "$PWD"'];
  const args = buildDockerRunArgs(plan, { command: dockerCommand, interactive: false });
  runDocker(args);
}

function shellCommand(options: Record<string, unknown>): void {
  const plan = buildPlanFromCommand(process.cwd(), options);
  if (inspectContainerName(plan.containerName)) {
    runDocker(['exec', '-it', plan.containerName, 'bash']);
    return;
  }
  const args = buildDockerRunArgs(plan, {
    interactive: true,
    command: ['bash'],
  });
  runDocker(args);
}

function execCommand(command: string[], options: Record<string, unknown>): void {
  const plan = buildPlanFromCommand(process.cwd(), options);
  if (!inspectContainerName(plan.containerName)) {
    throw new Error(`Sandbox is not running: ${plan.containerName}. Start it with ink studio sandbox up`);
  }
  if (command.length === 0) {
    throw new Error('No command provided for sandbox exec');
  }
  runDocker(['exec', plan.containerName, ...command]);
}

function statusCommand(options: Record<string, unknown>): void {
  const plan = buildPlanFromCommand(process.cwd(), options);
  const running = inspectContainerName(plan.containerName);
  if (options.json) {
    console.log(
      JSON.stringify(
        {
          containerName: plan.containerName,
          running,
          image: plan.image,
          studioPath: plan.context.studioPath,
        },
        null,
        2
      )
    );
    return;
  }

  console.log(chalk.bold('Studio sandbox status'));
  console.log(chalk.dim(`  Container: ${plan.containerName}`));
  console.log(chalk.dim(`  Running:   ${running ? 'yes' : 'no'}`));
  console.log(chalk.dim(`  Image:     ${plan.image}`));
  console.log(chalk.dim(`  Studio:    ${plan.context.studioPath}`));
}

function downCommand(options: Record<string, unknown>): void {
  const plan = buildPlanFromCommand(process.cwd(), options);
  if (!inspectContainerName(plan.containerName)) {
    console.log(chalk.yellow(`Sandbox not running: ${plan.containerName}`));
    return;
  }
  runDocker(['rm', '-f', plan.containerName]);
  console.log(chalk.green(`✓ Stopped sandbox ${plan.containerName}`));
}

export function registerStudioSandboxCommands(studio: Command): void {
  const sandbox = studio.command('sandbox').description('Manage studio-first Docker sandboxes');

  sandbox
    .command('build')
    .description('Build the default studio sandbox image')
    .option('--image <image>', 'Sandbox image', DEFAULT_IMAGE)
    .option('--no-cache', 'Build without Docker layer cache')
    .action(buildCommand);

  addCommonSandboxOptions(
    sandbox
      .command('plan')
      .description('Show the current studio sandbox mount/network plan')
      .option('--json', 'Output JSON')
  ).action(planCommand);

  addCommonSandboxOptions(
    sandbox.command('up').description('Start a persistent sandbox container for this studio')
  ).action(upCommand);

  addCommonSandboxOptions(
    sandbox
      .command('run [command...]')
      .allowExcessArguments(true)
      .description('Run a one-shot command in a new studio sandbox container')
  ).action((command: string[], options: Record<string, unknown>) => runCommand(command || [], options));

  addCommonSandboxOptions(
    sandbox.command('shell').description('Open a shell in the running sandbox, or start an ephemeral one')
  ).action(shellCommand);

  addCommonSandboxOptions(
    sandbox
      .command('exec <command...>')
      .allowExcessArguments(true)
      .description('Run a command inside the running studio sandbox')
  ).action((command: string[], options: Record<string, unknown>) => execCommand(command || [], options));

  addCommonSandboxOptions(
    sandbox.command('status').description('Show status for the current studio sandbox')
  )
    .option('--json', 'Output JSON')
    .action(statusCommand);

  addCommonSandboxOptions(
    sandbox.command('down').description('Stop the running studio sandbox for this studio')
  ).action(downCommand);
}
