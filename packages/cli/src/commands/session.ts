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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { basename, dirname, join, resolve as resolvePath } from 'path';
import { homedir } from 'os';
import { createInterface } from 'readline/promises';
import { callPcpTool, getPcpServerUrl } from '../lib/pcp-mcp.js';
import { getValidAccessToken } from '../auth/tokens.js';

interface PcpConfig {
  userId?: string;
  email?: string;
}

export interface Session {
  id: string;
  agentId?: string;
  lifecycle?: string;
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
  workingDir?: string;
  logs?: Array<{ salience: string; content: string }>;
}

export interface SessionListResult {
  sessions: Session[];
}

interface SyncTranscriptResult {
  ok: boolean;
  sessionId: string;
  backend: string | null;
  backendSessionId: string | null;
  format: string;
  sourcePath: string;
  resolvedBy: string;
  lineCount: number;
  byteCount: number;
  syncedAt: string;
}

interface SyncedTranscriptArchiveSummary {
  archiveId: string;
  sessionId: string;
  backend: string | null;
  backendSessionId: string | null;
  format: 'json' | 'jsonl' | null;
  lineCount: number;
  byteCount: number;
  sourcePath: string | null;
  syncedAt: string;
  session: {
    id: string;
    agentId?: string | null;
    agentName?: string | null;
    agentRole?: string | null;
    backend?: string | null;
    backendSessionId?: string | null;
    threadKey?: string | null;
    startedAt: string;
    updatedAt: string;
    workingDir?: string | null;
    studioId?: string | null;
  };
}

interface SyncedTranscriptListResult {
  archives: SyncedTranscriptArchiveSummary[];
  count: number;
}

interface SyncedTranscriptPayload {
  version?: number;
  backend?: string | null;
  backendSessionId?: string | null;
  format?: 'json' | 'jsonl' | null;
  sourcePath?: string | null;
  syncedAt?: string | null;
  rawContent?: string | null;
  events?: unknown[];
}

interface StudioLookupResult {
  id?: string;
  worktreePath?: string | null;
}

interface TranscriptInstallPlan {
  destinationPath: string;
  sidecarFiles: Array<{ path: string; content: string }>;
  resolvedBy: 'path' | 'cwd' | 'studio' | 'implicit-cwd';
  targetCwd?: string;
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


function normalizePath(input: string): string {
  return resolvePath(input);
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = bytes / 1024;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  const decimals = size >= 10 ? 1 : 2;
  return `${size.toFixed(decimals)} ${units[unitIndex]}`;
}

export function materializeSyncedTranscriptContent(payload: SyncedTranscriptPayload): {
  content: string;
  format: 'json' | 'jsonl';
  restoredFrom: 'raw' | 'events';
} {
  const format = payload.format === 'json' ? 'json' : 'jsonl';
  if (typeof payload.rawContent === 'string' && payload.rawContent.length > 0) {
    return {
      content: payload.rawContent,
      format,
      restoredFrom: 'raw',
    };
  }

  if (format === 'json') {
    return {
      content: JSON.stringify(Array.isArray(payload.events) ? payload.events : [], null, 2),
      format,
      restoredFrom: 'events',
    };
  }

  const jsonl = (Array.isArray(payload.events) ? payload.events : [])
    .map((event) => JSON.stringify(event))
    .join('\n');
  return {
    content: jsonl.length > 0 ? `${jsonl}\n` : '',
    format,
    restoredFrom: 'events',
  };
}

function buildProjectScopedKey(cwd: string): string {
  const normalized = normalizePath(cwd).replace(/[\\/]/g, '-').replace(/^-+/, '');
  return normalized || basename(cwd) || 'project';
}

export function buildTranscriptInstallPlan(options: {
  sessionId: string;
  backend?: string | null;
  backendSessionId?: string | null;
  format?: 'json' | 'jsonl' | null;
  targetPath?: string;
  targetCwd?: string;
  resolvedBy: 'path' | 'cwd' | 'studio' | 'implicit-cwd';
}): TranscriptInstallPlan {
  const format = options.format === 'json' ? 'json' : 'jsonl';

  if (options.targetPath) {
    const normalizedPath = normalizePath(options.targetPath);
    return {
      destinationPath: normalizedPath,
      sidecarFiles: [],
      resolvedBy: 'path',
    };
  }

  if (!options.targetCwd) {
    throw new Error('A target cwd is required for backend-native transcript installs.');
  }

  const backend = (options.backend || '').toLowerCase();
  const targetCwd = normalizePath(options.targetCwd);
  const backendSessionId = options.backendSessionId || options.sessionId;

  if (backend.includes('claude')) {
    return {
      destinationPath: join(
        homedir(),
        '.claude',
        'projects',
        buildProjectScopedKey(targetCwd),
        `${backendSessionId}.jsonl`
      ),
      sidecarFiles: [],
      resolvedBy: options.resolvedBy,
      targetCwd,
    };
  }

  if (backend.includes('codex')) {
    return {
      destinationPath: join(
        homedir(),
        '.codex',
        'sessions',
        buildProjectScopedKey(targetCwd),
        `${backendSessionId}.jsonl`
      ),
      sidecarFiles: [],
      resolvedBy: options.resolvedBy,
      targetCwd,
    };
  }

  if (backend.includes('gemini')) {
    const projectKey = buildProjectScopedKey(targetCwd);
    return {
      destinationPath: join(
        homedir(),
        '.gemini',
        'tmp',
        projectKey,
        'chats',
        `session-import-${backendSessionId}.json`
      ),
      sidecarFiles: [
        {
          path: join(homedir(), '.gemini', 'history', projectKey, '.project_root'),
          content: `${targetCwd}\n`,
        },
      ],
      resolvedBy: options.resolvedBy,
      targetCwd,
    };
  }

  if (backend.includes('pcp')) {
    return {
      destinationPath: join(
        targetCwd,
        '.pcp',
        'runtime',
        'repl',
        `${options.sessionId}-synced-${backendSessionId}.${format === 'json' ? 'json' : 'jsonl'}`
      ),
      sidecarFiles: [],
      resolvedBy: options.resolvedBy,
      targetCwd,
    };
  }

  throw new Error(
    `Cannot infer a backend-native install target for backend "${options.backend || 'unknown'}". Use --path instead.`
  );
}

export function renderSyncedTranscriptArchives(
  archives: SyncedTranscriptArchiveSummary[]
): string[] {
  if (archives.length === 0) return [chalk.dim('  No synced transcripts found')];

  return archives.flatMap((archive) => {
    const header = `  ${chalk.cyan(archive.sessionId.substring(0, 8))} ${chalk.dim(`(${archive.backend || 'unknown'})`)}`;
    const thread = archive.session.threadKey || '-';
    const agent = archive.session.agentName || archive.session.agentId || 'Unknown';
    const lines = [
      header,
      chalk.dim(`      Agent:   ${agent}`),
      chalk.dim(
        `      Synced:  ${formatDate(new Date(archive.syncedAt))}  Size: ${formatBytes(archive.byteCount)}  Lines: ${archive.lineCount.toLocaleString()}`
      ),
      chalk.dim(`      Thread:  ${thread}`),
      chalk.dim(`      Source:  ${archive.sourcePath || 'n/a'}`),
    ];

    if (archive.session.workingDir) {
      lines.push(chalk.dim(`      Path:    ${archive.session.workingDir}`));
    }

    return [...lines, ''];
  });
}

async function fetchAdminJson<T>(options: {
  path: string;
  method?: 'GET' | 'POST';
  body?: Record<string, unknown>;
  workspaceId?: string;
}): Promise<T> {
  const serverUrl = getPcpServerUrl().replace(/\/+$/, '');
  const token = await getValidAccessToken(serverUrl);
  if (!token) {
    throw new Error('Not authenticated. Run: sb auth login');
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };
  if (options.workspaceId?.trim()) {
    headers['x-pcp-workspace-id'] = options.workspaceId.trim();
  }
  if (options.body) {
    headers['Content-Type'] = 'application/json';
  }

  const response = await fetch(`${serverUrl}${options.path}`, {
    method: options.method || 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const text = await response.text();
  const parsed = text.trim() ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (!response.ok) {
    const message =
      (typeof parsed.error === 'string' && parsed.error) ||
      `HTTP ${response.status} ${response.statusText}`;
    throw new Error(message);
  }

  return parsed as T;
}

async function maybeConfirmImplicitCwd(cwd: string, skipConfirmation?: boolean): Promise<void> {
  if (skipConfirmation || !process.stdin.isTTY || !process.stdout.isTTY) return;

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (
      await rl.question(
        `Use current directory as the install target context?\n  ${cwd}\nProceed? [Y/n] `
      )
    )
      .trim()
      .toLowerCase();

    if (answer && answer !== 'y' && answer !== 'yes') {
      console.log(chalk.yellow('Cancelled transcript pull.'));
      process.exit(0);
    }
  } finally {
    rl.close();
  }
}

async function resolvePullTarget(options: {
  config: PcpConfig | null;
  studio?: string;
  cwd?: string;
  path?: string;
  yes?: boolean;
}): Promise<{
  resolvedBy: 'path' | 'cwd' | 'studio' | 'implicit-cwd';
  targetPath?: string;
  targetCwd?: string;
}> {
  if (options.path) {
    return { resolvedBy: 'path', targetPath: options.path };
  }

  if (options.cwd) {
    return { resolvedBy: 'cwd', targetCwd: options.cwd };
  }

  if (options.studio) {
    if (!options.config?.email) {
      throw new Error('PCP not configured. Run: sb init');
    }
    const studio = await callPcpTool<StudioLookupResult>('get_studio', {
      email: options.config.email,
      studioId: options.studio,
    });
    if (!studio?.worktreePath) {
      throw new Error(`Studio ${options.studio} does not have a worktree path.`);
    }
    return { resolvedBy: 'studio', targetCwd: studio.worktreePath };
  }

  const cwd = process.cwd();
  await maybeConfirmImplicitCwd(cwd, options.yes);
  return { resolvedBy: 'implicit-cwd', targetCwd: cwd };
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

async function syncTranscriptCommand(
  sessionId: string,
  options: {
    backend?: string;
    backendSessionId?: string;
    workspaceId?: string;
    json?: boolean;
  }
): Promise<void> {
  const payload: Record<string, unknown> = {};
  if (options.backend) payload.backend = options.backend;
  if (options.backendSessionId) payload.backendSessionId = options.backendSessionId;

  let result: SyncTranscriptResult;
  try {
    result = await fetchAdminJson<SyncTranscriptResult>({
      path: `/api/admin/sessions/${encodeURIComponent(sessionId)}/sync-transcript`,
      method: 'POST',
      body: payload,
      workspaceId: options.workspaceId,
    });
  } catch (error) {
    console.error(chalk.red(`Failed to sync transcript: ${error}`));
    process.exit(1);
  }

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(chalk.green(`Synced transcript for session ${sessionId.substring(0, 8)}.`));
  console.log(chalk.dim(`  Backend:     ${result.backend || 'unknown'}`));
  console.log(chalk.dim(`  Session:     ${result.backendSessionId || 'n/a'}`));
  console.log(chalk.dim(`  Format:      ${result.format}`));
  console.log(chalk.dim(`  Lines:       ${result.lineCount.toLocaleString()}`));
  console.log(chalk.dim(`  Bytes:       ${result.byteCount.toLocaleString()}`));
  console.log(chalk.dim(`  Source path: ${result.sourcePath}`));
  console.log(chalk.dim(`  Synced at:   ${formatDate(new Date(result.syncedAt))}`));
}

async function listSyncedTranscriptsCommand(options: {
  limit?: string;
  workspaceId?: string;
  json?: boolean;
}): Promise<void> {
  try {
    const params = new URLSearchParams();
    if (options.limit) params.set('limit', options.limit);
    const suffix = params.toString() ? `?${params.toString()}` : '';
    const result = await fetchAdminJson<SyncedTranscriptListResult>({
      path: `/api/admin/sessions/synced${suffix}`,
      workspaceId: options.workspaceId,
    });

    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log(chalk.bold('\nSynced Transcripts:\n'));
    for (const line of renderSyncedTranscriptArchives(result.archives || [])) {
      console.log(line);
    }
  } catch (error) {
    console.error(chalk.red(`Failed to list synced transcripts: ${error}`));
    process.exit(1);
  }
}

async function pullSyncedTranscriptCommand(
  sessionId: string,
  options: {
    path?: string;
    studio?: string;
    cwd?: string;
    workspaceId?: string;
    overwrite?: boolean;
    yes?: boolean;
    json?: boolean;
  }
): Promise<void> {
  const config = getPcpConfig();
  try {
    const payload = await fetchAdminJson<SyncedTranscriptPayload>({
      path: `/api/admin/sessions/${encodeURIComponent(sessionId)}/transcript?format=json`,
      workspaceId: options.workspaceId,
    });

    const target = await resolvePullTarget({
      config,
      studio: options.studio,
      cwd: options.cwd,
      path: options.path,
      yes: options.yes,
    });

    const plan = buildTranscriptInstallPlan({
      sessionId,
      backend: payload.backend,
      backendSessionId: payload.backendSessionId,
      format: payload.format,
      targetPath: target.targetPath,
      targetCwd: target.targetCwd,
      resolvedBy: target.resolvedBy,
    });

    const materialized = materializeSyncedTranscriptContent(payload);
    const destinationDir = dirname(plan.destinationPath);
    mkdirSync(destinationDir, { recursive: true });

    if (existsSync(plan.destinationPath)) {
      const existingContent = readFileSync(plan.destinationPath, 'utf-8');
      if (existingContent === materialized.content) {
        if (options.json) {
          console.log(
            JSON.stringify(
              {
                ok: true,
                sessionId,
                destinationPath: plan.destinationPath,
                status: 'already_present',
                resolvedBy: plan.resolvedBy,
                targetCwd: plan.targetCwd || null,
              },
              null,
              2
            )
          );
          return;
        }

        console.log(
          chalk.green(`Transcript already present for session ${sessionId.substring(0, 8)}.`)
        );
        console.log(chalk.dim(`  Destination: ${plan.destinationPath}`));
        return;
      }

      if (!options.overwrite) {
        throw new Error(
          `Destination already exists with different content: ${plan.destinationPath}. Re-run with --overwrite or use --path.`
        );
      }
    }

    writeFileSync(plan.destinationPath, materialized.content);
    for (const sidecar of plan.sidecarFiles) {
      mkdirSync(dirname(sidecar.path), { recursive: true });
      writeFileSync(sidecar.path, sidecar.content);
    }

    if (options.json) {
      console.log(
        JSON.stringify(
          {
            ok: true,
            sessionId,
            backend: payload.backend || null,
            backendSessionId: payload.backendSessionId || null,
            format: materialized.format,
            restoredFrom: materialized.restoredFrom,
            destinationPath: plan.destinationPath,
            resolvedBy: plan.resolvedBy,
            targetCwd: plan.targetCwd || null,
            sidecarFiles: plan.sidecarFiles.map((file) => file.path),
          },
          null,
          2
        )
      );
      return;
    }

    console.log(chalk.green(`Pulled transcript for session ${sessionId.substring(0, 8)}.`));
    console.log(chalk.dim(`  Backend:      ${payload.backend || 'unknown'}`));
    console.log(chalk.dim(`  Destination:  ${plan.destinationPath}`));
    if (plan.targetCwd) {
      console.log(chalk.dim(`  Target cwd:   ${plan.targetCwd}`));
    }
    console.log(chalk.dim(`  Resolved by:  ${plan.resolvedBy}`));
    console.log(chalk.dim(`  Restored via: ${materialized.restoredFrom}`));
    if (plan.sidecarFiles.length > 0) {
      console.log(
        chalk.dim(`  Sidecars:     ${plan.sidecarFiles.map((file) => file.path).join(', ')}`)
      );
    }
  } catch (error) {
    console.error(chalk.red(`Failed to pull synced transcript: ${error}`));
    process.exit(1);
  }
}

async function syncCommandDispatcher(
  target: string | undefined,
  value: string | undefined,
  options: {
    backend?: string;
    backendSessionId?: string;
    workspaceId?: string;
    limit?: string;
    path?: string;
    studio?: string;
    cwd?: string;
    overwrite?: boolean;
    yes?: boolean;
    json?: boolean;
  }
): Promise<void> {
  if (target === 'list') {
    await listSyncedTranscriptsCommand(options);
    return;
  }

  if (target === 'pull') {
    if (!value) {
      console.error(chalk.red('Missing session ID. Use: sb session sync pull <id>'));
      process.exit(1);
    }
    await pullSyncedTranscriptCommand(value, options);
    return;
  }

  if (target === 'push') {
    if (!value) {
      console.error(chalk.red('Missing session ID. Use: sb session sync push <id>'));
      process.exit(1);
    }
    await syncTranscriptCommand(value, options);
    return;
  }

  if (!target) {
    console.error(
      chalk.red(
        'Missing sync action. Use: sb session sync <id>, sb session sync list, or sb session sync pull <id>'
      )
    );
    process.exit(1);
  }

  await syncTranscriptCommand(target, options);
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

  session
    .command('sync [target] [value]')
    .description('Push, list, and pull synced session transcripts')
    .option('--backend <backend>', 'Override backend resolver (claude|codex|gemini|pcp)')
    .option('--backend-session-id <id>', 'Override backend session id used for transcript lookup')
    .option('--limit <n>', 'Number of synced archives to list', '20')
    .option('--path <path>', 'Write pulled transcript to an explicit file path')
    .option('--studio <id>', 'Resolve pull install target from a studio worktree')
    .option('--cwd <path>', 'Resolve pull install target from a working directory')
    .option('--workspace-id <id>', 'Workspace scope override for the admin API call')
    .option('--overwrite', 'Overwrite pulled transcript destination if content differs')
    .option('--yes', 'Skip confirmation when defaulting pull installs to the current directory')
    .option('--json', 'Print raw JSON response')
    .addHelpText(
      'after',
      `
Examples:
  sb session sync <id>               Push a local transcript to the server archive
  sb session sync push <id>          Explicit push form
  sb session sync list               Show synced transcripts available on the server
  sb session sync pull <id>          Pull into the current directory context
  sb session sync pull <id> --path /tmp/transcript.jsonl
  sb session sync pull <id> --studio <studio-id>
  sb session sync pull <id> --cwd /path/to/project
`
    )
    .action(syncCommandDispatcher);
}
