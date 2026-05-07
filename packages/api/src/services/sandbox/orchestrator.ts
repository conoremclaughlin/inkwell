/**
 * Sandbox Orchestrator
 *
 * Manages Docker container lifecycle for sandboxed agent work.
 * Called by the strategy service when an agent needs to be spun up
 * in an isolated environment for autonomous task execution.
 *
 * Design: builds docker run args from DB-sourced studio data (no filesystem
 * dependency for planning). Shells out to Docker via child_process.
 */

import { execFile, execFileSync } from 'child_process';
import { promisify } from 'util';
import { createHash } from 'crypto';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir, platform } from 'os';
import { logger } from '../../utils/logger.js';

const execFileAsync = promisify(execFile);

const DEFAULT_IMAGE = 'inkwell:studio-sandbox';
const CONTAINER_HOME = '/home/sb';
const CONTAINER_LABEL = 'ink.sandbox=true';

export type BackendAuthName = 'claude' | 'codex' | 'gemini';

export interface SandboxMount {
  source: string;
  target: string;
  readOnly: boolean;
}

export interface SandboxSpinUpRequest {
  userId: string;
  agentId: string;
  studioId: string;
  studioSlug?: string;
  worktreePath: string;
  repoRoot: string;
  branch?: string;
  taskGroupId?: string;
  taskGroupTitle?: string;
  taskGroupContext?: string;
  taskGroupThreadKey?: string;
  serverUrl?: string;
  image?: string;
  backendAuth?: BackendAuthName[];
  networkMode?: 'default' | 'none';
  extraEnv?: Record<string, string>;
}

export interface SandboxSpinUpResult {
  containerName: string;
  success: boolean;
  alreadyRunning?: boolean;
  error?: string;
}

export interface SandboxStatusResult {
  containerName: string;
  running: boolean;
  image?: string;
  startedAt?: string;
  labels?: Record<string, string>;
}

export function buildContainerName(request: SandboxSpinUpRequest): string {
  const label = sanitizeSlug(request.studioSlug || request.agentId || 'studio');
  const parts = [request.worktreePath];
  if (request.taskGroupId) parts.push(request.taskGroupId);
  const digest = createHash('sha256').update(parts.join(':')).digest('hex').slice(0, 8);

  if (request.taskGroupId && request.taskGroupTitle) {
    const taskSlug = sanitizeSlug(request.taskGroupTitle);
    return `ink-sandbox-${label}-${taskSlug}-${digest}`;
  }

  return `ink-sandbox-${label}-${digest}`;
}

function sanitizeSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
}

export function buildEnvVars(request: SandboxSpinUpRequest): Record<string, string> {
  const serverUrl = request.serverUrl || process.env.INK_SERVER_URL || 'http://localhost:3001';

  const env: Record<string, string> = {
    HOME: CONTAINER_HOME,
    AGENT_ID: request.agentId,
    INK_SERVER_URL: rewriteLoopbackUrl(serverUrl),
    INK_STUDIO_ID: request.studioId,
    INK_SANDBOX: 'docker',
    INK_STUDIO_PATH: '/studio',
    INK_STUDIOS_PATH: '/studios',
  };

  if (request.taskGroupId) {
    env.INK_TASK_GROUP_ID = request.taskGroupId;
  }
  if (request.taskGroupTitle) {
    env.INK_TASK_GROUP_TITLE = request.taskGroupTitle;
  }
  if (request.taskGroupContext) {
    env.INK_TASK_GROUP_CONTEXT = request.taskGroupContext;
  }
  if (request.taskGroupThreadKey) {
    env.INK_TASK_GROUP_THREAD_KEY = request.taskGroupThreadKey;
  }
  if (request.branch) {
    env.INK_BRANCH = request.branch;
  }

  if (request.extraEnv) {
    Object.assign(env, request.extraEnv);
  }

  return env;
}

function rewriteLoopbackUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    if (['localhost', '127.0.0.1', '::1', '[::1]'].includes(parsed.hostname)) {
      parsed.hostname = 'host.docker.internal';
      return parsed.toString().replace(/\/+$/, '');
    }
  } catch {
    // Not a URL — leave it
  }
  return rawUrl;
}

const CLAUDE_KEYCHAIN_SERVICE = 'Claude Code-credentials';
const CLAUDE_CREDENTIALS_RELATIVE = '.claude/.credentials.json';

/**
 * Stage a Claude config directory for Docker mounting.
 *
 * Claude Code stores OAuth tokens in the macOS keychain (primary) with a
 * file fallback at ~/.claude/.credentials.json. Docker containers can't
 * access the keychain, so we build a staging directory with extracted
 * credentials plus the config files Claude Code needs (settings, etc.).
 *
 * This replaces mounting ~/.claude directly — Docker can't overlay a file
 * inside a read-only directory mount, so we stage everything into one dir.
 *
 * Returns the path to the staged directory, or undefined if credentials
 * aren't available.
 */
export function stageClaudeDir(stagingDir: string): string | undefined {
  const home = homedir();
  const claudeHome = join(home, '.claude');
  const stagedDir = join(stagingDir, 'claude-home');
  mkdirSync(stagedDir, { recursive: true });

  // Copy config files Claude Code needs
  const filesToCopy = ['settings.json', 'settings.local.json'];
  for (const file of filesToCopy) {
    const src = join(claudeHome, file);
    if (existsSync(src)) {
      writeFileSync(join(stagedDir, file), readFileSync(src, 'utf-8'), { mode: 0o600 });
    }
  }

  // Stage credentials: file fallback first, then keychain extraction
  const credFile = join(claudeHome, '.credentials.json');
  if (existsSync(credFile)) {
    writeFileSync(join(stagedDir, '.credentials.json'), readFileSync(credFile, 'utf-8'), {
      mode: 0o600,
    });
    return stagedDir;
  }

  if (platform() === 'darwin') {
    try {
      const raw = execFileSync(
        'security',
        ['find-generic-password', '-s', CLAUDE_KEYCHAIN_SERVICE, '-w'],
        { encoding: 'utf-8', timeout: 5_000, stdio: ['pipe', 'pipe', 'pipe'] }
      ).trim();

      const data = JSON.parse(raw);
      if (!data?.claudeAiOauth?.accessToken) return undefined;

      writeFileSync(join(stagedDir, '.credentials.json'), JSON.stringify(data, null, 2) + '\n', {
        mode: 0o600,
      });
      return stagedDir;
    } catch {
      logger.debug('Could not extract Claude credentials from keychain');
      return undefined;
    }
  }

  return undefined;
}

export function buildMounts(request: SandboxSpinUpRequest): SandboxMount[] {
  const mounts: SandboxMount[] = [];

  if (existsSync(request.worktreePath)) {
    mounts.push({ source: request.worktreePath, target: '/studio', readOnly: false });
  }

  // Mount patched MCP config if it exists
  const patchedMcpPath = patchMcpConfig(request.worktreePath);
  if (patchedMcpPath) {
    mounts.push({ source: patchedMcpPath, target: '/studio/.mcp.json', readOnly: true });
  }

  // Backend auth dirs (read-only)
  const home = homedir();
  const authDirs: Record<BackendAuthName, string> = {
    claude: join(home, '.claude'),
    codex: join(home, '.codex'),
    gemini: join(home, '.gemini'),
  };

  for (const backend of request.backendAuth || []) {
    if (backend === 'claude') {
      // Stage ~/.claude with credentials extracted from keychain.
      // We can't mount ~/.claude read-only and then overlay a file inside it,
      // so we stage everything into one directory.
      const runtimeDir = join(request.worktreePath, '.ink', 'runtime', 'sandbox');
      const stagedClaudeHome = stageClaudeDir(runtimeDir);
      if (stagedClaudeHome) {
        mounts.push({
          source: stagedClaudeHome,
          target: `${CONTAINER_HOME}/.claude`,
          readOnly: true,
        });
      } else {
        // Fallback: mount ~/.claude directly (no credentials, but settings work)
        const sourceDir = authDirs[backend];
        if (existsSync(sourceDir)) {
          mounts.push({
            source: sourceDir,
            target: `${CONTAINER_HOME}/.claude`,
            readOnly: true,
          });
        }
      }

      // Claude Code also needs ~/.claude.json (config separate from ~/.claude/ dir)
      const claudeJson = join(home, '.claude.json');
      if (existsSync(claudeJson)) {
        mounts.push({
          source: claudeJson,
          target: `${CONTAINER_HOME}/.claude.json`,
          readOnly: true,
        });
      }
    } else {
      const sourceDir = authDirs[backend];
      if (existsSync(sourceDir)) {
        mounts.push({
          source: sourceDir,
          target: `${CONTAINER_HOME}/.${backend}`,
          readOnly: true,
        });
      }
    }
  }

  return mounts;
}

/**
 * Patch .mcp.json for Docker: rewrite loopback URLs to host.docker.internal
 * and strip stdio/command-based servers (they can't spawn inside the container).
 */
export function patchMcpConfig(studioPath: string): string | undefined {
  const sourcePath = join(studioPath, '.mcp.json');
  if (!existsSync(sourcePath)) return undefined;

  try {
    const parsed = JSON.parse(readFileSync(sourcePath, 'utf-8')) as {
      mcpServers?: Record<string, Record<string, unknown>>;
    };
    const servers = parsed.mcpServers;
    if (!servers) return undefined;

    const patched: Record<string, Record<string, unknown>> = {};
    for (const [name, server] of Object.entries(servers)) {
      // Only keep HTTP transport servers — stdio/command servers can't run in the container
      if (server?.type === 'http' && typeof server.url === 'string') {
        patched[name] = { ...server, url: rewriteLoopbackUrl(server.url) };
      }
    }

    if (Object.keys(patched).length === 0) return undefined;

    const runtimeDir = join(studioPath, '.ink', 'runtime', 'sandbox');
    mkdirSync(runtimeDir, { recursive: true });
    const targetPath = join(runtimeDir, 'mcp.docker.json');
    writeFileSync(targetPath, JSON.stringify({ mcpServers: patched }, null, 2) + '\n', 'utf-8');
    return targetPath;
  } catch {
    return undefined;
  }
}

export function buildDockerRunArgs(request: SandboxSpinUpRequest): string[] {
  const containerName = buildContainerName(request);
  const image = request.image || DEFAULT_IMAGE;
  const env = buildEnvVars(request);
  const mounts = buildMounts(request);

  const args = ['run', '--rm', '-d', '--name', containerName];
  args.push('--workdir', '/studio');
  args.push('--add-host', 'host.docker.internal:host-gateway');
  args.push('--hostname', containerName);

  // Labels for discovery and lifecycle management
  args.push('--label', CONTAINER_LABEL);
  args.push('--label', `ink.agent-id=${request.agentId}`);
  args.push('--label', `ink.studio-id=${request.studioId}`);
  if (request.taskGroupId) {
    args.push('--label', `ink.task-group-id=${request.taskGroupId}`);
  }

  // Preserve host user for file ownership
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  const gid = typeof process.getgid === 'function' ? process.getgid() : undefined;
  if (uid !== undefined && gid !== undefined) {
    args.push('--user', `${uid}:${gid}`);
  }

  if (request.networkMode === 'none') {
    args.push('--network', 'none');
  }

  for (const [key, value] of Object.entries(env)) {
    args.push('-e', `${key}=${value}`);
  }

  for (const mount of mounts) {
    const ro = mount.readOnly ? ',readonly' : '';
    args.push('--mount', `type=bind,src=${mount.source},dst=${mount.target}${ro}`);
  }

  args.push(image);
  return args;
}

// ============================================================================
// Orchestrator Class
// ============================================================================

export class SandboxOrchestrator {
  private dockerCommand: string;

  constructor(options: { dockerCommand?: string } = {}) {
    this.dockerCommand = options.dockerCommand || 'docker';
  }

  async spinUp(request: SandboxSpinUpRequest): Promise<SandboxSpinUpResult> {
    const containerName = buildContainerName(request);

    // Check if already running
    const alreadyRunning = await this.isRunning(containerName);
    if (alreadyRunning) {
      logger.info(`Sandbox already running: ${containerName}`);
      return { containerName, success: true, alreadyRunning: true };
    }

    const args = buildDockerRunArgs(request);

    try {
      await execFileAsync(this.dockerCommand, args, { timeout: 30_000 });
      logger.info('Sandbox container started', {
        containerName,
        agentId: request.agentId,
        studioId: request.studioId,
        taskGroupId: request.taskGroupId,
      });
      return { containerName, success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('Sandbox spin-up failed', { containerName, error: message });
      return { containerName, success: false, error: message };
    }
  }

  async stop(containerName: string): Promise<boolean> {
    try {
      await execFileAsync(this.dockerCommand, ['rm', '-f', containerName], { timeout: 15_000 });
      logger.info(`Sandbox stopped: ${containerName}`);
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`Sandbox stop failed: ${containerName}`, { error: message });
      return false;
    }
  }

  async isRunning(containerName: string): Promise<boolean> {
    try {
      await execFileAsync(this.dockerCommand, ['container', 'inspect', containerName], {
        timeout: 5_000,
      });
      return true;
    } catch {
      return false;
    }
  }

  async getStatus(containerName: string): Promise<SandboxStatusResult> {
    try {
      const { stdout } = await execFileAsync(
        this.dockerCommand,
        ['container', 'inspect', '--format', '{{json .}}', containerName],
        { timeout: 5_000 }
      );
      const info = JSON.parse(stdout.trim());
      return {
        containerName,
        running: info.State?.Running === true,
        image: info.Config?.Image,
        startedAt: info.State?.StartedAt,
        labels: info.Config?.Labels,
      };
    } catch {
      return { containerName, running: false };
    }
  }

  async listSandboxes(): Promise<SandboxStatusResult[]> {
    try {
      const { stdout } = await execFileAsync(
        this.dockerCommand,
        ['ps', '--filter', 'label=ink.sandbox=true', '--format', '{{json .}}'],
        { timeout: 10_000 }
      );

      if (!stdout.trim()) return [];

      return stdout
        .trim()
        .split('\n')
        .map((line) => {
          const info = JSON.parse(line);
          return {
            containerName: info.Names,
            running: info.State === 'running',
            image: info.Image,
            labels: info.Labels ? parseLabelString(info.Labels) : undefined,
          };
        });
    } catch {
      return [];
    }
  }

  async exec(
    containerName: string,
    command: string[]
  ): Promise<{ stdout: string; stderr: string }> {
    return execFileAsync(this.dockerCommand, ['exec', containerName, ...command], {
      timeout: 60_000,
    });
  }
}

function parseLabelString(labels: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const pair of labels.split(',')) {
    const eqIdx = pair.indexOf('=');
    if (eqIdx > 0) {
      result[pair.slice(0, eqIdx)] = pair.slice(eqIdx + 1);
    }
  }
  return result;
}
