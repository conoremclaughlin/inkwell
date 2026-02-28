/**
 * Backend Runner
 *
 * Spawns the selected AI CLI backend with identity injection,
 * passthrough flags, and session tracking.
 */

import { spawn, spawnSync } from 'child_process';
import chalk from 'chalk';
import { randomUUID } from 'crypto';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'fs';
import { join, resolve as resolvePath } from 'path';
import { homedir } from 'os';
import { getBackend, resolveAgentId } from '../backends/index.js';
import { getValidAccessToken } from '../auth/tokens.js';
import { callPcpTool, getPcpServerUrl } from '../lib/pcp-mcp.js';
import {
  getCurrentRuntimeSession,
  setCurrentRuntimeSession,
  upsertRuntimeSession,
} from '../session/runtime.js';

export interface SbOptions {
  agent: string | undefined;
  model: string | undefined; // undefined = use backend's default
  session: boolean;
  verbose: boolean;
  backend: string;
}

interface PcpConfig {
  email?: string;
}

interface PcpSessionSummary {
  id: string;
  studioId?: string | null;
  threadKey?: string | null;
  currentPhase?: string | null;
  startedAt: string;
  endedAt?: string | null;
  backend?: string | null;
  backendSessionId?: string | null;
  claudeSessionId?: string | null;
  workingDir?: string | null;
}

interface ListSessionsResult {
  sessions?: PcpSessionSummary[];
}

interface BackendLocalSessionSummary {
  backend: 'claude' | 'codex' | 'gemini';
  sessionId: string;
  projectPath: string;
  modified: string;
  firstPrompt?: string;
  messageCount?: number;
  gitBranch?: string;
}

interface ClaudeHistoryLine {
  display?: string;
  timestamp?: number;
  project?: string;
  sessionId?: string;
}

interface BackendExecutionLogContext {
  pcpConfig: PcpConfig | null;
  agentId: string;
  backend: string;
  binary: string;
  args: string[];
  promptParts?: string[];
  pcpSessionId?: string;
  backendSessionId?: string;
  studioId?: string;
  runtimeLinkId?: string;
  cwd: string;
  mode: 'prompt' | 'interactive';
  retryAttempt: number;
  maxAttempts: number;
}

type LogActivityResult = {
  activity?: { id?: string };
};

function getSessionBackendId(session: PcpSessionSummary): string | undefined {
  return session.backendSessionId || session.claudeSessionId || undefined;
}

export function filterUntrackedLocalClaudeSessions<T extends { sessionId: string }>(
  localSessions: T[],
  activePcpSessions: PcpSessionSummary[]
): T[] {
  const trackedSessionIds = new Set(
    activePcpSessions
      .map((session) => getSessionBackendId(session))
      .filter((sessionId): sessionId is string => Boolean(sessionId))
  );

  return localSessions.filter((session) => !trackedSessionIds.has(session.sessionId));
}

export function shouldAutoResumeRuntimeSession(
  existing: { pcpSessionId?: string; backendSessionId?: string } | undefined,
  isTty: boolean
): boolean {
  // CRITICAL UX NOTE:
  // - Interactive users (TTY=true) MUST see the session picker so they can explicitly choose
  //   between:
  //     1) starting a new session,
  //     2) resuming a tracked PCP session, or
  //     3) resuming a backend-local session.
  // - Non-interactive contexts (TTY=false), like scripts/piped invocations, cannot render the
  //   picker safely. Only in that case do we allow implicit runtime auto-resume.
  //
  // Regressions here are high-impact because they make session behavior feel "mysterious":
  // users see an unexpected resume with no chance to choose.
  //
  // If you modify this function, manually verify both:
  //   sb -a <agent> -b <backend>          # TTY: picker appears
  //   echo "prompt" | sb -a <agent> ...   # non-TTY: no picker, deterministic auto behavior
  return Boolean(existing?.pcpSessionId && !isTty);
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

async function resolvePcpAuthEnv(verbose: boolean): Promise<Record<string, string>> {
  try {
    const token = await getValidAccessToken(getPcpServerUrl());
    if (token) {
      if (verbose) console.log(chalk.dim('PCP auth: token injected'));
      return { PCP_ACCESS_TOKEN: token };
    }
  } catch {
    // Silently skip — auth is best-effort
  }
  if (verbose) console.log(chalk.dim('PCP auth: not authenticated'));
  return {};
}

function getPcpConfig(): PcpConfig | null {
  const configPath = join(homedir(), '.pcp', 'config.json');
  if (!existsSync(configPath)) return null;
  try {
    return JSON.parse(readFileSync(configPath, 'utf-8')) as PcpConfig;
  } catch {
    return null;
  }
}

function getIdentityContextFromIdentityJson(cwd = process.cwd()): {
  studioId?: string;
  identityId?: string;
} {
  const identityPath = join(cwd, '.pcp', 'identity.json');
  if (!existsSync(identityPath)) return {};
  try {
    const identity = JSON.parse(readFileSync(identityPath, 'utf-8')) as {
      studioId?: string;
      workspaceId?: string;
      identityId?: string;
    };
    return {
      studioId: identity.studioId || identity.workspaceId,
      identityId: identity.identityId,
    };
  } catch {
    return {};
  }
}

function normalizePath(path: string | null | undefined): string | null {
  if (!path) return null;
  try {
    return realpathSync(path);
  } catch {
    try {
      return resolvePath(path);
    } catch {
      return null;
    }
  }
}

function truncateText(text: string | null | undefined, max = 90): string {
  if (!text) return '';
  const compact = text.replace(/\s+/g, ' ').trim();
  if (compact.length <= max) return compact;
  return `${compact.slice(0, max - 1)}…`;
}

export function sanitizeBackendExecutionArgs(
  args: string[],
  backend: string,
  promptParts: string[] = []
): string[] {
  const sanitized = [...args];

  for (let i = 0; i < sanitized.length; i++) {
    const arg = sanitized[i];
    if (arg === '--append-system-prompt' && i + 1 < sanitized.length) {
      sanitized[i + 1] = '<redacted-system-prompt>';
      i += 1;
      continue;
    }

    if (arg === '-p' && i + 1 < sanitized.length && !sanitized[i + 1].startsWith('-')) {
      sanitized[i + 1] = '<redacted-prompt>';
      i += 1;
    }
  }

  if (sanitized.includes('-p') && sanitized.length > 0) {
    const lastIndex = sanitized.length - 1;
    if (!sanitized[lastIndex].startsWith('-')) {
      sanitized[lastIndex] = '<redacted-prompt>';
    }
  }

  // Codex one-shot prompts may be passed as positional args (no -p flag).
  if (backend === 'codex' && promptParts.length > 0 && sanitized.length >= promptParts.length) {
    const startIndex = sanitized.length - promptParts.length;
    const trailingMatches = promptParts.every(
      (part, index) => sanitized[startIndex + index] === part
    );
    if (trailingMatches) {
      for (let i = startIndex; i < sanitized.length; i++) {
        sanitized[i] = '<redacted-prompt-part>';
      }
    }
  }

  return sanitized;
}

export function filterPcpSessionsForContext(
  sessions: PcpSessionSummary[],
  backend: string,
  cwd = process.cwd(),
  localBackendSessionIds: Set<string> = new Set()
): PcpSessionSummary[] {
  const normalizedCwd = normalizePath(cwd);

  const backendMatched = sessions.filter((session) => {
    if (!session.backend) return true;
    return session.backend === backend;
  });

  if (!normalizedCwd) {
    return backendMatched;
  }

  const pathScoped = backendMatched.filter((session) => {
    const localMatchedId = session.backendSessionId || session.claudeSessionId;
    if (localMatchedId && localBackendSessionIds.has(localMatchedId)) return true;

    const normalizedWorkingDir = normalizePath(session.workingDir);
    return !!normalizedWorkingDir && normalizedWorkingDir === normalizedCwd;
  });

  return pathScoped.length > 0 ? pathScoped : backendMatched;
}

export function getClaudeLocalSessionsForProject(
  cwd = process.cwd(),
  limit = 20
): BackendLocalSessionSummary[] {
  const claudeProjectsDir = join(homedir(), '.claude', 'projects');
  if (!existsSync(claudeProjectsDir)) return [];

  const normalizedCwd = normalizePath(cwd);
  if (!normalizedCwd) return [];

  const results: BackendLocalSessionSummary[] = [];

  for (const entry of readdirSync(claudeProjectsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const indexPath = join(claudeProjectsDir, entry.name, 'sessions-index.json');
    if (!existsSync(indexPath)) continue;

    try {
      const parsed = JSON.parse(readFileSync(indexPath, 'utf-8')) as {
        entries?: Array<{
          sessionId?: string;
          projectPath?: string;
          modified?: string;
          firstPrompt?: string;
          messageCount?: number;
          gitBranch?: string;
        }>;
      };

      for (const item of parsed.entries || []) {
        if (!item.sessionId || !item.projectPath || !item.modified) continue;
        const normalizedProjectPath = normalizePath(item.projectPath);
        if (!normalizedProjectPath || normalizedProjectPath !== normalizedCwd) continue;

        results.push({
          backend: 'claude',
          sessionId: item.sessionId,
          projectPath: item.projectPath,
          modified: item.modified,
          firstPrompt: item.firstPrompt,
          messageCount: item.messageCount,
          gitBranch: item.gitBranch,
        });
      }
    } catch {
      // Ignore malformed local index files and continue.
    }
  }

  // Fallback path: some Claude installations persist session linkage in history.jsonl
  // even when per-project sessions-index files are missing/out-of-date.
  const historyPath = join(homedir(), '.claude', 'history.jsonl');
  if (existsSync(historyPath)) {
    try {
      const historySessions = extractClaudeHistorySessionsForProject(
        readFileSync(historyPath, 'utf-8'),
        normalizedCwd
      );
      results.push(...historySessions);
    } catch {
      // Ignore unreadable history file.
    }
  }

  const dedupedBySessionId = new Map<string, BackendLocalSessionSummary>();
  for (const session of results) {
    const existing = dedupedBySessionId.get(session.sessionId);
    if (!existing || new Date(session.modified).getTime() > new Date(existing.modified).getTime()) {
      dedupedBySessionId.set(session.sessionId, session);
    }
  }

  return Array.from(dedupedBySessionId.values())
    .sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime())
    .slice(0, limit);
}

export function extractClaudeHistorySessionsForProject(
  historyJsonl: string,
  normalizedCwd: string
): BackendLocalSessionSummary[] {
  const sessions: BackendLocalSessionSummary[] = [];
  for (const line of historyJsonl.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: ClaudeHistoryLine;
    try {
      parsed = JSON.parse(trimmed) as ClaudeHistoryLine;
    } catch {
      continue;
    }

    if (!parsed.sessionId || !parsed.project) continue;
    const normalizedProjectPath = normalizePath(parsed.project);
    if (!normalizedProjectPath || normalizedProjectPath !== normalizedCwd) continue;

    const modified =
      typeof parsed.timestamp === 'number' && Number.isFinite(parsed.timestamp)
        ? new Date(parsed.timestamp).toISOString()
        : new Date().toISOString();

    sessions.push({
      backend: 'claude',
      sessionId: parsed.sessionId,
      projectPath: parsed.project,
      modified,
      firstPrompt: parsed.display,
    });
  }

  return sessions;
}

export function getCodexLocalSessionsForProject(
  cwd = process.cwd(),
  limit = 20
): BackendLocalSessionSummary[] {
  const codexStateDbPath = join(homedir(), '.codex', 'state_5.sqlite');
  if (!existsSync(codexStateDbPath)) return [];

  const normalizedCwd = normalizePath(cwd);
  if (!normalizedCwd) return [];

  const query = `
SELECT id, cwd, updated_at,
       replace(replace(first_user_message, char(10), ' '), char(9), ' ') AS first_user_message,
       git_branch
FROM threads
WHERE archived = 0
ORDER BY updated_at DESC
LIMIT 200;
`;

  const result = spawnSync('sqlite3', ['-tabs', codexStateDbPath, query], { encoding: 'utf-8' });
  if (result.error || result.status !== 0 || !result.stdout) return [];

  const sessions: BackendLocalSessionSummary[] = [];
  const lines = result.stdout.split('\n').map((line) => line.trim());
  for (const line of lines) {
    if (!line) continue;
    const [sessionId, sessionCwd, updatedAtRaw, firstPrompt, gitBranch] = line.split('\t');
    if (!sessionId || !sessionCwd || !updatedAtRaw) continue;

    const normalizedSessionPath = normalizePath(sessionCwd);
    if (!normalizedSessionPath || normalizedSessionPath !== normalizedCwd) continue;

    const updatedAtSeconds = Number(updatedAtRaw);
    const modified = Number.isFinite(updatedAtSeconds)
      ? new Date(updatedAtSeconds * 1000).toISOString()
      : new Date().toISOString();

    sessions.push({
      backend: 'codex',
      sessionId,
      projectPath: sessionCwd,
      modified,
      firstPrompt: firstPrompt?.trim(),
      gitBranch: gitBranch?.trim(),
    });
  }

  return sessions.slice(0, limit);
}

function getGeminiProjectKeysForCwd(cwd = process.cwd()): string[] {
  const normalizedCwd = normalizePath(cwd);
  if (!normalizedCwd) return [];

  const keys = new Set<string>();

  const projectsJsonPath = join(homedir(), '.gemini', 'projects.json');
  if (existsSync(projectsJsonPath)) {
    try {
      const parsed = JSON.parse(readFileSync(projectsJsonPath, 'utf-8')) as {
        projects?: Record<string, string>;
      };
      for (const [projectPath, projectKey] of Object.entries(parsed.projects || {})) {
        const normalizedProjectPath = normalizePath(projectPath);
        if (normalizedProjectPath === normalizedCwd && projectKey) {
          keys.add(projectKey);
        }
      }
    } catch {
      // Ignore malformed projects.json
    }
  }

  const geminiHistoryDir = join(homedir(), '.gemini', 'history');
  if (existsSync(geminiHistoryDir)) {
    for (const entry of readdirSync(geminiHistoryDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const projectRootPath = join(geminiHistoryDir, entry.name, '.project_root');
      if (!existsSync(projectRootPath)) continue;
      try {
        const projectRoot = readFileSync(projectRootPath, 'utf-8').trim();
        if (normalizePath(projectRoot) === normalizedCwd) {
          keys.add(entry.name);
        }
      } catch {
        // Ignore unreadable .project_root files
      }
    }
  }

  return Array.from(keys);
}

function getGeminiSessionsForProjectKey(projectKey: string): BackendLocalSessionSummary[] {
  const chatsDir = join(homedir(), '.gemini', 'tmp', projectKey, 'chats');
  if (!existsSync(chatsDir)) return [];

  const sessions: BackendLocalSessionSummary[] = [];
  const projectRoot = join(homedir(), '.gemini', 'history', projectKey, '.project_root');
  const projectPath = existsSync(projectRoot)
    ? readFileSync(projectRoot, 'utf-8').trim()
    : projectKey;

  for (const entry of readdirSync(chatsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.startsWith('session-') || !entry.name.endsWith('.json')) {
      continue;
    }
    const sessionPath = join(chatsDir, entry.name);
    try {
      const parsed = JSON.parse(readFileSync(sessionPath, 'utf-8')) as {
        sessionId?: string;
        lastUpdated?: string;
        startTime?: string;
        summary?: string;
        messages?: Array<{ type?: string; content?: string }>;
      };

      if (!parsed.sessionId) continue;
      const modified = parsed.lastUpdated || parsed.startTime;
      if (!modified) continue;

      const firstUserMessage = (parsed.messages || []).find((message) => message.type === 'user');
      const firstPrompt =
        parsed.summary ||
        (typeof firstUserMessage?.content === 'string'
          ? firstUserMessage.content.trim()
          : undefined);

      sessions.push({
        backend: 'gemini',
        sessionId: parsed.sessionId,
        projectPath,
        modified,
        firstPrompt,
      });
    } catch {
      // Ignore malformed session files.
    }
  }

  return sessions;
}

export function getGeminiLocalSessionsForProject(
  cwd = process.cwd(),
  limit = 20
): BackendLocalSessionSummary[] {
  const projectKeys = getGeminiProjectKeysForCwd(cwd);
  if (projectKeys.length === 0) return [];

  const sessions = projectKeys.flatMap((projectKey) => getGeminiSessionsForProjectKey(projectKey));
  const deduped = new Map<string, BackendLocalSessionSummary>();
  for (const session of sessions) {
    const existing = deduped.get(session.sessionId);
    if (!existing || new Date(session.modified).getTime() > new Date(existing.modified).getTime()) {
      deduped.set(session.sessionId, session);
    }
  }

  return Array.from(deduped.values())
    .sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime())
    .slice(0, limit);
}

export function getBackendLocalSessionsForProject(
  backend: string,
  cwd = process.cwd(),
  limit = 20
): BackendLocalSessionSummary[] {
  if (backend === 'claude') return getClaudeLocalSessionsForProject(cwd, limit);
  if (backend === 'codex') return getCodexLocalSessionsForProject(cwd, limit);
  if (backend === 'gemini') return getGeminiLocalSessionsForProject(cwd, limit);
  return [];
}

function printPcpUnavailableWarning(reason: string, cwd = process.cwd()): void {
  console.log(chalk.yellow(`\n⚠ PCP session service unavailable (${reason}).`));
  const mcpPath = join(cwd, '.mcp.json');
  if (!existsSync(mcpPath)) {
    console.log(chalk.yellow('  .mcp.json not found in this repo.'));
  } else {
    try {
      const parsed = JSON.parse(readFileSync(mcpPath, 'utf-8')) as {
        mcpServers?: Record<string, unknown>;
      };
      if (!parsed.mcpServers?.pcp) {
        console.log(chalk.yellow('  .mcp.json is missing mcpServers.pcp.'));
      }
    } catch {
      console.log(chalk.yellow('  .mcp.json could not be parsed.'));
    }
  }
  console.log(chalk.dim('  To reconnect PCP features:'));
  console.log(chalk.dim('    sb auth login'));
  console.log(chalk.dim('    sb init'));
  console.log(chalk.dim('    sb status'));
}

export function hasBackendSessionOverride(
  backend: string,
  passthroughArgs: string[],
  promptParts: string[] = []
): boolean {
  const lowered = passthroughArgs.map((arg) => arg.toLowerCase());
  const has = (flag: string) => lowered.includes(flag.toLowerCase());
  const isCodexResumePrompt =
    backend === 'codex' &&
    promptParts[0]?.toLowerCase() === 'resume' &&
    Boolean(promptParts[1]) &&
    !promptParts[1]?.startsWith('-');
  const isCodexResumePassthrough =
    backend === 'codex' &&
    passthroughArgs[0]?.toLowerCase() === 'resume' &&
    Boolean(passthroughArgs[1]) &&
    !passthroughArgs[1]?.startsWith('-');

  if (isCodexResumePrompt || isCodexResumePassthrough) return true;

  if (backend === 'claude') {
    return (
      has('--resume') ||
      has('-r') ||
      has('--continue') ||
      has('-c') ||
      has('--session-id') ||
      has('--from-pr')
    );
  }

  return has('--resume') || has('-r') || has('--session-id');
}

function extractActivityIdFromLogResult(result: unknown): string | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const maybe = result as LogActivityResult;
  if (typeof maybe.activity?.id === 'string') return maybe.activity.id;
  return undefined;
}

async function logBackendExecutionStart(
  context: BackendExecutionLogContext
): Promise<string | undefined> {
  if (!context.pcpConfig?.email) return undefined;

  try {
    const argsSanitized = sanitizeBackendExecutionArgs(
      context.args,
      context.backend,
      context.promptParts || []
    );

    const result = await callPcpTool<LogActivityResult>('log_activity', {
      email: context.pcpConfig.email,
      agentId: context.agentId,
      type: 'tool_call',
      subtype: `backend_cli:${context.backend}`,
      status: 'running',
      ...(context.pcpSessionId ? { sessionId: context.pcpSessionId } : {}),
      ...(context.runtimeLinkId ? { correlationId: context.runtimeLinkId } : {}),
      content: `Spawned backend CLI (${context.binary})`,
      payload: {
        kind: 'backend_cli_execution',
        phase: 'start',
        backend: context.backend,
        binary: context.binary,
        argsSanitized,
        cwd: context.cwd,
        studioId: context.studioId || null,
        pcpSessionId: context.pcpSessionId || null,
        backendSessionId: context.backendSessionId || null,
        retryAttempt: context.retryAttempt,
        maxAttempts: context.maxAttempts,
      },
    });

    return extractActivityIdFromLogResult(result);
  } catch {
    return undefined;
  }
}

async function logBackendExecutionResult(options: {
  context: BackendExecutionLogContext;
  parentActivityId?: string;
  exitCode: number | null;
  durationMs: number;
  error?: string;
  backendSessionId?: string;
}): Promise<void> {
  if (!options.context.pcpConfig?.email) return;

  const status = options.exitCode === 0 && !options.error ? 'completed' : 'failed';

  try {
    await callPcpTool('log_activity', {
      email: options.context.pcpConfig.email,
      agentId: options.context.agentId,
      type: 'tool_result',
      subtype: `backend_cli:${options.context.backend}`,
      status,
      ...(options.context.pcpSessionId ? { sessionId: options.context.pcpSessionId } : {}),
      ...(options.parentActivityId ? { parentId: options.parentActivityId } : {}),
      ...(options.context.runtimeLinkId ? { correlationId: options.context.runtimeLinkId } : {}),
      content:
        status === 'completed'
          ? `Backend CLI finished (${options.context.binary})`
          : `Backend CLI failed (${options.context.binary})`,
      payload: {
        kind: 'backend_cli_execution',
        phase: 'result',
        backend: options.context.backend,
        binary: options.context.binary,
        cwd: options.context.cwd,
        studioId: options.context.studioId || null,
        pcpSessionId: options.context.pcpSessionId || null,
        backendSessionId: options.backendSessionId || null,
        retryAttempt: options.context.retryAttempt,
        maxAttempts: options.context.maxAttempts,
        retries: Math.max(options.context.retryAttempt - 1, 0),
        exitCode: options.exitCode,
        durationMs: options.durationMs,
        error: options.error || null,
      },
    });
  } catch {
    // Best-effort telemetry only.
  }
}

function extractBackendSessionIdFromEvent(event: Record<string, unknown>): string | undefined {
  const queue: unknown[] = [event];
  const sessionKeys = new Set([
    'session_id',
    'sessionId',
    'conversation_id',
    'conversationId',
    'thread_id',
    'threadId',
  ]);

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || typeof current !== 'object') continue;
    const obj = current as Record<string, unknown>;

    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === 'string' && sessionKeys.has(key) && value.trim()) {
        return value.trim();
      }
      if (value && typeof value === 'object') queue.push(value);
    }
  }

  return undefined;
}

function parseSessionIdFromJsonLine(line: string): string | undefined {
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    return extractBackendSessionIdFromEvent(parsed);
  } catch {
    return undefined;
  }
}

async function persistBackendSessionLink(options: {
  pcpSessionId?: string;
  backendSessionId?: string;
  backend: string;
  agentId: string;
  runtimeLinkId?: string;
  studioId?: string;
  identityId?: string;
  email?: string;
}): Promise<void> {
  if (!options.pcpSessionId || !options.backendSessionId) return;

  upsertRuntimeSession(process.cwd(), {
    pcpSessionId: options.pcpSessionId,
    backend: options.backend,
    agentId: options.agentId,
    ...(options.identityId ? { identityId: options.identityId } : {}),
    ...(options.studioId ? { studioId: options.studioId } : {}),
    ...(options.runtimeLinkId ? { runtimeLinkId: options.runtimeLinkId } : {}),
    backendSessionId: options.backendSessionId,
    updatedAt: new Date().toISOString(),
  });

  try {
    await callPcpTool('update_session_phase', {
      email: options.email,
      agentId: options.agentId,
      sessionId: options.pcpSessionId,
      backendSessionId: options.backendSessionId,
      status: 'active',
      workingDir: process.cwd(),
    });
  } catch {
    // Best-effort linkage update only.
  }
}

async function ensurePcpSessionContext(
  agentId: string,
  backend: string,
  passthroughArgs: string[],
  verbose: boolean,
  promptParts: string[] = []
): Promise<{ pcpSessionId?: string; backendSessionId?: string }> {
  if (hasBackendSessionOverride(backend, passthroughArgs, promptParts)) return {};

  const config = getPcpConfig();
  const email = config?.email;
  const cwd = process.cwd();
  const { studioId, identityId } = getIdentityContextFromIdentityJson(cwd);
  const localBackendSessions = getBackendLocalSessionsForProject(backend, cwd, 20);
  const localBackendSessionIds = new Set(localBackendSessions.map((session) => session.sessionId));
  const sessionChoiceByValue = new Map<string, string>();

  // Fast path: runtime already knows current session for this backend.
  const existing = getCurrentRuntimeSession(cwd, backend);
  if (existing?.pcpSessionId && shouldAutoResumeRuntimeSession(existing, process.stdin.isTTY)) {
    return {
      pcpSessionId: existing.pcpSessionId,
      backendSessionId: existing.backendSessionId,
    };
  }

  // Pull active session list so caller can resume or start new.
  let activeSessions: PcpSessionSummary[] = [];
  let pcpAvailable = Boolean(email);
  let pcpUnavailableReason: string | undefined;

  if (!email) {
    pcpAvailable = false;
    pcpUnavailableReason = 'not authenticated';
  } else {
    try {
      const listed = await callPcpTool<ListSessionsResult>('list_sessions', {
        email,
        agentId,
        ...(studioId ? { studioId } : {}),
        limit: 20,
      });
      activeSessions = filterPcpSessionsForContext(
        (listed.sessions || []).filter((s) => !s.endedAt),
        backend,
        cwd,
        localBackendSessionIds
      );
    } catch (err) {
      pcpAvailable = false;
      pcpUnavailableReason = err instanceof Error ? err.message : 'request failed';
    }
  }

  if (!pcpAvailable) {
    printPcpUnavailableWarning(pcpUnavailableReason || 'unknown error', cwd);
  }

  const untrackedLocalBackendSessions =
    backend === 'claude'
      ? filterUntrackedLocalClaudeSessions(localBackendSessions, activeSessions)
      : localBackendSessions;

  let chosen: PcpSessionSummary | undefined;
  let selectedLocalBackendSessionId: string | undefined;

  const startNewPcpSession = async (): Promise<PcpSessionSummary | undefined> => {
    if (!pcpAvailable || !email) return undefined;

    const newSessionId = randomUUID();
    try {
      const started = await callPcpTool<{ session?: PcpSessionSummary }>('start_session', {
        email,
        agentId,
        ...(studioId ? { studioId } : {}),
        backend,
        forceNew: true,
        sessionId: newSessionId,
      });
      return started.session || { id: newSessionId, startedAt: new Date().toISOString() };
    } catch {
      return { id: newSessionId, startedAt: new Date().toISOString() };
    }
  };

  if (process.stdin.isTTY) {
    const choices: Array<{ name: string; value: string }> = [
      {
        name: pcpAvailable ? 'Start new session' : 'Start new backend session',
        value: '__new__',
      },
    ];

    for (const session of activeSessions) {
      const value = `__pcp__:${session.id}`;
      const linkedBackendSessionId =
        backend === 'claude' ? getSessionBackendId(session) : undefined;
      choices.push({
        name: `Resume PCP ${session.id.slice(0, 8)}${session.threadKey ? ` (${session.threadKey})` : ''}${session.currentPhase ? ` — ${session.currentPhase}` : ''}${linkedBackendSessionId ? ` · tracks Claude ${linkedBackendSessionId.slice(0, 8)}` : ''}`,
        value,
      });
      sessionChoiceByValue.set(value, session.id);
    }

    for (const localSession of untrackedLocalBackendSessions) {
      const value = `__local__:${localSession.sessionId}`;
      const preview = localSession.firstPrompt
        ? ` — ${truncateText(localSession.firstPrompt)}`
        : '';
      const backendLabel = localSession.backend[0].toUpperCase() + localSession.backend.slice(1);
      choices.push({
        name:
          localSession.backend === 'claude'
            ? `Resume Claude local ${localSession.sessionId.slice(0, 8)} (${new Date(localSession.modified).toLocaleString()})${preview}`
            : `Resume ${backendLabel} local ${localSession.sessionId.slice(0, 8)} (${new Date(localSession.modified).toLocaleString()})${preview}`,
        value,
      });
      sessionChoiceByValue.set(value, localSession.sessionId);
    }

    try {
      const { select } = await import('@inquirer/prompts');
      const selection = await select({
        message: `Session for ${agentId}/${backend}`,
        choices,
      });
      if (selection === '__new__') {
        chosen = await startNewPcpSession();
      } else if (selection.startsWith('__pcp__:')) {
        const sessionId = sessionChoiceByValue.get(selection);
        chosen = activeSessions.find((session) => session.id === sessionId);
      } else if (selection.startsWith('__local__:')) {
        selectedLocalBackendSessionId = sessionChoiceByValue.get(selection);
        if (selectedLocalBackendSessionId && pcpAvailable) {
          chosen = await startNewPcpSession();
        }
      }
    } catch (err) {
      if (isPromptCancelError(err)) {
        console.log(chalk.yellow('\nSession selection canceled.'));
        process.exit(130);
      }
      // Prompt canceled or unavailable; fallback to start new.
    }
  }

  if (!chosen && !selectedLocalBackendSessionId && pcpAvailable) {
    chosen = await startNewPcpSession();
  }

  if (!chosen?.id && !selectedLocalBackendSessionId) return {};

  if (!chosen?.id && selectedLocalBackendSessionId) {
    return { backendSessionId: selectedLocalBackendSessionId };
  }

  if (!chosen?.id) return {};

  const backendSessionId =
    selectedLocalBackendSessionId ||
    (!chosen.backend || chosen.backend === backend
      ? chosen.backendSessionId || chosen.claudeSessionId || undefined
      : undefined);

  upsertRuntimeSession(cwd, {
    pcpSessionId: chosen.id,
    backend,
    agentId,
    ...(identityId ? { identityId } : {}),
    ...(studioId ? { studioId } : {}),
    ...(chosen.threadKey ? { threadKey: chosen.threadKey } : {}),
    ...(backendSessionId ? { backendSessionId } : {}),
    startedAt: chosen.startedAt,
  });
  setCurrentRuntimeSession(cwd, chosen.id, backend, {
    agentId,
    ...(identityId ? { identityId } : {}),
    ...(studioId ? { studioId } : {}),
  });

  if (verbose) {
    console.log(chalk.dim(`PCP session: ${chosen.id}`));
    if (backendSessionId) {
      console.log(chalk.dim(`Backend session: ${backendSessionId}`));
    }
  }

  if (email) {
    try {
      await callPcpTool('update_session_phase', {
        email,
        agentId,
        sessionId: chosen.id,
        status: 'active',
        workingDir: cwd,
      });
    } catch {
      // Best-effort only.
    }
  }

  return {
    pcpSessionId: chosen.id,
    backendSessionId,
  };
}

/**
 * Run a backend with a prompt (one-shot mode).
 */
export async function runClaude(
  prompt: string,
  promptParts: string[],
  options: SbOptions,
  passthroughArgs: string[] = []
): Promise<void> {
  const agentId = resolveAgentId(options.agent, options.backend);
  if (!agentId) {
    console.error(chalk.red('No agent identity configured.'));
    console.error(
      chalk.dim('Run `sb init` to set up PCP in this repo, or `sb awaken` to create a new SB.')
    );
    console.error(chalk.dim('Or pass `-a <agent>` to specify one directly.'));
    process.exit(1);
  }
  const adapter = getBackend(options.backend);
  const sessionContext = options.session
    ? await ensurePcpSessionContext(
        agentId,
        options.backend,
        passthroughArgs,
        options.verbose,
        promptParts
      )
    : {};
  const runtimeLinkId = options.session ? randomUUID() : undefined;
  const { studioId, identityId } = getIdentityContextFromIdentityJson(process.cwd());

  if (sessionContext.pcpSessionId && runtimeLinkId) {
    upsertRuntimeSession(process.cwd(), {
      pcpSessionId: sessionContext.pcpSessionId,
      backend: options.backend,
      agentId,
      ...(identityId ? { identityId } : {}),
      ...(studioId ? { studioId } : {}),
      runtimeLinkId,
      ...(sessionContext.backendSessionId
        ? { backendSessionId: sessionContext.backendSessionId }
        : {}),
      updatedAt: new Date().toISOString(),
    });
  }

  if (options.verbose) {
    console.log(chalk.dim(`Backend: ${adapter.name}`));
    console.log(chalk.dim(`Agent: ${agentId}`));
    console.log(chalk.dim(`Model: ${options.model}`));
    console.log(chalk.dim(`Session tracking: ${options.session}`));
    if (passthroughArgs.length) {
      console.log(chalk.dim(`Passthrough: ${passthroughArgs.join(' ')}`));
    }
  }

  const prepared = adapter.prepare({
    agentId,
    model: options.model,
    prompt,
    promptParts,
    passthroughArgs,
    ...sessionContext,
  });

  const authEnv = await resolvePcpAuthEnv(options.verbose);

  if (options.verbose) {
    console.log(chalk.dim(`Running: ${prepared.binary} ${prepared.args.join(' ')}`));
  }

  const pcpConfig = getPcpConfig();
  const executionContext: BackendExecutionLogContext = {
    pcpConfig,
    agentId,
    backend: options.backend,
    binary: prepared.binary,
    args: prepared.args,
    promptParts,
    pcpSessionId: sessionContext.pcpSessionId,
    backendSessionId: sessionContext.backendSessionId,
    studioId,
    runtimeLinkId,
    cwd: process.cwd(),
    mode: 'prompt',
    retryAttempt: 1,
    maxAttempts: 1,
  };
  const executionStartedAt = Date.now();
  const backendStartActivityId = await logBackendExecutionStart(executionContext);
  let capturedBackendSessionId = sessionContext.backendSessionId;
  let stdoutLineBuffer = '';
  let cleanedUp = false;
  let finalizedExecution = false;
  const ensureCleanup = (): void => {
    if (cleanedUp) return;
    cleanedUp = true;
    prepared.cleanup();
  };
  const finalizeExecution = async (exitCode: number | null, error?: string): Promise<void> => {
    if (finalizedExecution) return;
    finalizedExecution = true;
    await logBackendExecutionResult({
      context: executionContext,
      parentActivityId: backendStartActivityId,
      exitCode,
      durationMs: Date.now() - executionStartedAt,
      error,
      backendSessionId: capturedBackendSessionId,
    });
  };
  const consumeOutputChunk = (chunkText: string): void => {
    stdoutLineBuffer += chunkText;
    const lines = stdoutLineBuffer.split('\n');
    stdoutLineBuffer = lines.pop() || '';

    for (const line of lines) {
      const parsedSessionId = parseSessionIdFromJsonLine(line.trim());
      if (parsedSessionId) capturedBackendSessionId = parsedSessionId;
    }
  };

  const child = spawn(prepared.binary, prepared.args, {
    stdio: ['inherit', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ...authEnv,
      ...prepared.env,
      ...(runtimeLinkId ? { PCP_RUNTIME_LINK_ID: runtimeLinkId } : {}),
    },
  });

  child.stdout?.on('data', (chunk) => {
    process.stdout.write(chunk);
    consumeOutputChunk(chunk.toString());
  });

  child.stderr?.on('data', (chunk) => {
    process.stderr.write(chunk);
  });

  child.on('close', async (code) => {
    ensureCleanup();
    if (stdoutLineBuffer.trim()) {
      const parsedSessionId = parseSessionIdFromJsonLine(stdoutLineBuffer.trim());
      if (parsedSessionId) capturedBackendSessionId = parsedSessionId;
    }

    await persistBackendSessionLink({
      pcpSessionId: sessionContext.pcpSessionId,
      backendSessionId: capturedBackendSessionId,
      backend: options.backend,
      agentId,
      runtimeLinkId,
      studioId,
      identityId,
      email: pcpConfig?.email,
    });
    await finalizeExecution(code ?? null);

    if (code !== 0) process.exit(code || 1);
  });

  child.on('error', async (err) => {
    ensureCleanup();
    await finalizeExecution(null, err.message || 'spawn failed');
    process.exit(1);
  });

  process.on('SIGINT', () => child.kill('SIGINT'));
  process.on('SIGTERM', () => child.kill('SIGTERM'));
}

/**
 * Run a backend interactively (no prompt).
 */
export async function runClaudeInteractive(
  options: SbOptions,
  passthroughArgs: string[] = []
): Promise<void> {
  const agentId = resolveAgentId(options.agent, options.backend);
  if (!agentId) {
    console.error(chalk.red('No agent identity configured.'));
    console.error(
      chalk.dim('Run `sb init` to set up PCP in this repo, or `sb awaken` to create a new SB.')
    );
    console.error(chalk.dim('Or pass `-a <agent>` to specify one directly.'));
    process.exit(1);
  }
  const adapter = getBackend(options.backend);
  const sessionContext = options.session
    ? await ensurePcpSessionContext(agentId, options.backend, passthroughArgs, options.verbose, [])
    : {};
  const runtimeLinkId = options.session ? randomUUID() : undefined;
  const { studioId, identityId } = getIdentityContextFromIdentityJson(process.cwd());

  if (sessionContext.pcpSessionId && runtimeLinkId) {
    upsertRuntimeSession(process.cwd(), {
      pcpSessionId: sessionContext.pcpSessionId,
      backend: options.backend,
      agentId,
      ...(identityId ? { identityId } : {}),
      ...(studioId ? { studioId } : {}),
      runtimeLinkId,
      ...(sessionContext.backendSessionId
        ? { backendSessionId: sessionContext.backendSessionId }
        : {}),
      updatedAt: new Date().toISOString(),
    });
  }

  if (options.verbose) {
    console.log(chalk.dim(`Backend: ${adapter.name}`));
    console.log(chalk.dim(`Agent: ${agentId}`));
    console.log(chalk.dim(`Model: ${options.model}`));
    if (passthroughArgs.length) {
      console.log(chalk.dim(`Passthrough: ${passthroughArgs.join(' ')}`));
    }
  }

  const prepared = adapter.prepare({
    agentId,
    model: options.model,
    promptParts: [],
    passthroughArgs,
    ...sessionContext,
  });

  const authEnv = await resolvePcpAuthEnv(options.verbose);

  if (options.verbose) {
    console.log(chalk.dim(`Running: ${prepared.binary} ${prepared.args.join(' ')}`));
  }

  const pcpConfig = getPcpConfig();
  const executionContext: BackendExecutionLogContext = {
    pcpConfig,
    agentId,
    backend: options.backend,
    binary: prepared.binary,
    args: prepared.args,
    pcpSessionId: sessionContext.pcpSessionId,
    backendSessionId: sessionContext.backendSessionId,
    studioId,
    runtimeLinkId,
    cwd: process.cwd(),
    mode: 'interactive',
    retryAttempt: 1,
    maxAttempts: 1,
  };
  const executionStartedAt = Date.now();
  const backendStartActivityId = await logBackendExecutionStart(executionContext);
  let cleanedUp = false;
  let finalizedExecution = false;
  const ensureCleanup = (): void => {
    if (cleanedUp) return;
    cleanedUp = true;
    prepared.cleanup();
  };
  const finalizeExecution = async (exitCode: number | null, error?: string): Promise<void> => {
    if (finalizedExecution) return;
    finalizedExecution = true;
    await logBackendExecutionResult({
      context: executionContext,
      parentActivityId: backendStartActivityId,
      exitCode,
      durationMs: Date.now() - executionStartedAt,
      error,
      backendSessionId: sessionContext.backendSessionId,
    });
  };

  const child = spawn(prepared.binary, prepared.args, {
    stdio: 'inherit',
    env: {
      ...process.env,
      ...authEnv,
      ...prepared.env,
      ...(runtimeLinkId ? { PCP_RUNTIME_LINK_ID: runtimeLinkId } : {}),
    },
  });

  child.on('close', async (code) => {
    ensureCleanup();
    await finalizeExecution(code ?? null);
    process.exit(code || 0);
  });

  child.on('error', async (err) => {
    ensureCleanup();
    await finalizeExecution(null, err.message || 'spawn failed');
    process.exit(1);
  });
}
