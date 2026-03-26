/**
 * Backend Runner
 *
 * Spawns the selected AI CLI backend with identity injection,
 * passthrough flags, and session tracking.
 */

import { spawn, spawnSync } from 'child_process';
import chalk from 'chalk';
import { randomUUID } from 'crypto';
import {
  closeSync,
  openSync,
  readSync,
  type Dirent,
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'fs';
import { basename, dirname, join, resolve as resolvePath } from 'path';
import { homedir } from 'os';
import { getBackend, resolveAgentId } from '../backends/index.js';
import { classifyError } from '@personal-context/shared';
import { getValidAccessToken } from '../auth/tokens.js';
import { callPcpTool, getPcpServerUrl } from '../lib/pcp-mcp.js';
import { sbDebugLog } from '../lib/sb-debug.js';
import {
  getCurrentRuntimeSession,
  listRuntimeSessions,
  setCurrentRuntimeSession,
  upsertRuntimeSession,
} from '../session/runtime.js';

export interface SbOptions {
  agent: string | undefined;
  model: string | undefined; // undefined = use backend's default
  session: boolean;
  verbose: boolean;
  backend: string;
  sessionCandidates?: boolean;
  sessionCandidatesJson?: boolean;
  sessionCandidatesAll?: boolean;
  sessionChoice?: string;
  dangerous?: boolean;
}

interface PcpConfig {
  email?: string;
}

interface BootstrapContextResult {
  identityFiles?: Record<string, string>;
  recentMemories?: Array<Record<string, unknown>>;
  activeSessions?: Array<Record<string, unknown>>;
}

interface PcpSessionSummary {
  id: string;
  agentId?: string | null;
  studioId?: string | null;
  studio?: { branch?: string | null } | null;
  threadKey?: string | null;
  context?: string | null;
  currentPhase?: string | null;
  lifecycle?: string | null;
  status?: string | null;
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
  fileSizeBytes?: number;
  firstPrompt?: string;
  latestPrompt?: string;
  latestPromptAt?: string;
  messageCount?: number;
  gitBranch?: string;
  transcriptPath?: string;
}

interface SessionPreviewSummary {
  role: 'user' | 'assistant' | 'inbox';
  content: string;
  ts?: string;
}

interface SessionCandidateTableRow {
  type: string;
  choice: string;
  updated: string;
  phase: string;
  thread: string;
  link: string;
  preview: string;
}

function toEpochMs(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : undefined;
}

export function sortSessionEntriesByRecency<T extends { sortMs: number; key: string }>(
  entries: T[]
): T[] {
  return [...entries].sort((a, b) => b.sortMs - a.sortMs || a.key.localeCompare(b.key));
}

function formatCandidateTimestamp(value: string | null | undefined): string {
  if (!value) return '-';
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return '-';
  return new Date(ms).toLocaleString();
}

function formatFileSize(bytes: number | undefined): string | undefined {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return undefined;
  if (bytes < 1024) return `${bytes} B`;
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

function formatPickerTimestamp(value: string | null | undefined): string {
  if (!value) return '-';
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return '-';
  return new Date(ms).toLocaleString([], {
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function getCurrentGitBranch(cwd = process.cwd()): string | undefined {
  try {
    const result = spawnSync('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf-8',
    });
    if (result.status !== 0) return undefined;
    const value = result.stdout.trim();
    if (!value || value === 'HEAD') return undefined;
    return value;
  } catch {
    return undefined;
  }
}

function padSessionCandidateCell(value: string, width: number): string {
  return truncateText(value || '-', width).padEnd(width, ' ');
}

function truncatePickerLine(value: string, max = 120): string {
  if (!value) return '';
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

function getPickerLabelMaxWidth(): number {
  const columns = process.stdout.columns;
  if (!columns || columns <= 0) return 110;
  return Math.max(88, Math.min(200, columns - 8));
}

interface PickerMetaLineInput {
  source: string;
  id: string;
  when: string;
  state: string;
  branch: string;
}

function buildPickerMetaLine(input: PickerMetaLineInput): string {
  const maxWidth = getPickerLabelMaxWidth();
  const sourceWidth = 7;
  const idWidth = 8;
  const whenWidth = 14;
  const separator = '  ';
  const fixed = sourceWidth + idWidth + whenWidth + separator.length * 4;
  const flexible = Math.max(34, maxWidth - fixed);
  let stateWidth = Math.max(12, Math.floor(flexible * 0.3));
  let branchWidth = Math.max(20, flexible - stateWidth);
  if (stateWidth + branchWidth > flexible) stateWidth = Math.max(12, flexible - branchWidth);
  if (stateWidth + branchWidth > flexible) branchWidth = Math.max(20, flexible - stateWidth);

  return [
    padSessionCandidateCell(input.source, sourceWidth),
    padSessionCandidateCell(input.id, idWidth),
    padSessionCandidateCell(input.when, whenWidth),
    padSessionCandidateCell(input.state, stateWidth),
    padSessionCandidateCell(input.branch, branchWidth),
  ].join(separator);
}

export function buildSessionPickerLabel(options: {
  metaLine: string;
  preview?: string | null;
}): string {
  const maxWidth = getPickerLabelMaxWidth();
  const firstLine = truncatePickerLine(options.metaLine, maxWidth);
  if (!options.preview) return firstLine;

  const previewWidth = Math.max(36, maxWidth - 4);
  const previewLine = `  ↳ ${truncateText(options.preview, previewWidth)}`;
  return `${firstLine}\n${previewLine}`;
}

export function renderSessionCandidatesTable(rows: SessionCandidateTableRow[]): string[] {
  const terminalWidth = process.stdout.columns || 220;
  const separator = '  ';
  const fixedColumns: Array<{
    key: keyof SessionCandidateTableRow;
    header: string;
    width: number;
  }> = [
    { key: 'type', header: 'TYPE', width: 11 },
    { key: 'choice', header: 'CHOICE', width: 14 },
    { key: 'updated', header: 'UPDATED', width: 18 },
    { key: 'phase', header: 'PHASE', width: 16 },
    { key: 'thread', header: 'THREAD', width: 14 },
    { key: 'link', header: 'LINK', width: 16 },
  ];
  const fixedWidth =
    fixedColumns.reduce((sum, column) => sum + column.width, 0) +
    separator.length * fixedColumns.length;
  const previewWidth = Math.max(36, terminalWidth - fixedWidth);
  const columns: Array<{ key: keyof SessionCandidateTableRow; header: string; width: number }> = [
    ...fixedColumns,
    { key: 'preview', header: 'PREVIEW', width: previewWidth },
  ];

  const header = columns
    .map((column) => padSessionCandidateCell(column.header, column.width))
    .join(separator);
  const divider = columns.map((column) => '-'.repeat(column.width)).join(separator);

  const lines = rows.map((row) =>
    columns
      .map((column) => padSessionCandidateCell(row[column.key] || '-', column.width))
      .join(separator)
  );

  return [header, divider, ...lines];
}

export function resolveAdoptableLocalBackendSessionId(options: {
  backend: string;
  backendSessionId?: string;
  selectedLocalBackendSessionId?: string;
  createdNewPcpSession?: boolean;
  chosen?: PcpSessionSummary;
  localSessions: BackendLocalSessionSummary[];
}): string | undefined {
  const {
    backend,
    backendSessionId,
    selectedLocalBackendSessionId,
    createdNewPcpSession,
    chosen,
    localSessions,
  } = options;
  if (backend === 'claude') return undefined;
  if (backendSessionId || selectedLocalBackendSessionId) return undefined;
  // Never auto-adopt an existing backend-local session when the user explicitly
  // created a brand-new PCP session from the picker. "Start new session" must
  // launch a fresh backend conversation, not resume a prior local one.
  if (createdNewPcpSession) return undefined;
  if (!chosen?.id || localSessions.length === 0) return undefined;
  if (localSessions.length === 1) return localSessions[0].sessionId;

  const startedAtMs = toEpochMs(chosen.startedAt);
  if (!startedAtMs) return undefined;

  // For Codex/Gemini orphan repair: if exactly one untracked local session is
  // close to the PCP session start time, adopt it as the backend linkage.
  const REPAIR_WINDOW_MS = 15 * 60 * 1000;
  const nearby = localSessions.filter((session) => {
    const modifiedMs = toEpochMs(session.modified);
    if (modifiedMs === undefined) return false;
    return Math.abs(modifiedMs - startedAtMs) <= REPAIR_WINDOW_MS;
  });

  return nearby.length === 1 ? nearby[0].sessionId : undefined;
}

interface ClaudeHistoryLine {
  display?: string;
  timestamp?: number;
  project?: string;
  sessionId?: string;
}

interface CodexSessionMetaLine {
  timestamp?: string;
  type?: string;
  payload?: {
    id?: string;
    cwd?: string;
    timestamp?: string;
    originator?: string;
  };
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
  threadKey?: string;
  triggerSource?: string;
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

function normalizeSessionBackendName(backend: string | null | undefined): string {
  if (!backend) return '';
  const normalized = backend.trim().toLowerCase();
  if (normalized === 'claude-code') return 'claude';
  if (normalized === 'codex-cli') return 'codex';
  if (normalized === 'gemini-cli') return 'gemini';
  return normalized;
}

function isSessionResumable(session: PcpSessionSummary): boolean {
  if (session.endedAt) return false;

  const phase = (session.currentPhase || '').trim().toLowerCase();
  if (phase === 'complete' || phase.startsWith('complete:')) return false;

  const status = (session.status || '').trim().toLowerCase();
  if (status === 'completed' || status.startsWith('completed:')) return false;

  return true;
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

export function filterUntrackedLocalBackendSessions<T extends { sessionId: string }>(
  localSessions: T[],
  activePcpSessions: PcpSessionSummary[]
): T[] {
  return filterUntrackedLocalClaudeSessions(localSessions, activePcpSessions);
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

function truncateForStartupContext(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n\n...[truncated]`;
}

function buildInjectedStartupContext(
  bootstrap: BootstrapContextResult,
  sessionIds?: { pcpSessionId?: string; studioId?: string; studioName?: string }
): string {
  const sections: string[] = [
    '_Generated by `sb` at session start from PCP `bootstrap`._',
    '_Use this as startup context; if stale, call `mcp__pcp__bootstrap` manually._',
  ];

  // Session identity — always-available IDs for debugging and routing verification
  if (sessionIds?.pcpSessionId) {
    const idParts: string[] = [`- PCP Session: \`${sessionIds.pcpSessionId}\``];
    if (sessionIds.studioId) {
      const label = sessionIds.studioName
        ? `${sessionIds.studioId} (${sessionIds.studioName})`
        : sessionIds.studioId;
      idParts.push(`- Studio: \`${label}\``);
    }
    sections.push(`### SESSION IDENTITY\n${idParts.join('\n')}`);
  }

  const identityFiles = bootstrap.identityFiles || {};
  const orderedFiles: Array<{ key: string; title: string; maxChars: number }> = [
    { key: 'self', title: 'SELF', maxChars: 1200 },
    { key: 'soul', title: 'SOUL', maxChars: 6000 },
    { key: 'process', title: 'PROCESS', maxChars: 6000 },
    { key: 'values', title: 'VALUES', maxChars: 4000 },
    { key: 'user', title: 'USER', maxChars: 3000 },
    { key: 'heartbeat', title: 'HEARTBEAT', maxChars: 3000 },
  ];

  const identitySections: string[] = [];
  for (const { key, title, maxChars } of orderedFiles) {
    const content = identityFiles[key];
    if (!content || typeof content !== 'string') continue;
    identitySections.push(`### ${title}\n${truncateForStartupContext(content.trim(), maxChars)}`);
  }
  if (identitySections.length > 0) {
    sections.push(identitySections.join('\n\n'));
  }

  const memories = Array.isArray(bootstrap.recentMemories) ? bootstrap.recentMemories : [];
  if (memories.length > 0) {
    const memoryLines = memories.slice(0, 8).map((memory) => {
      const content =
        typeof memory.content === 'string'
          ? memory.content
          : JSON.stringify(memory).slice(0, 280) || '(empty)';
      return `- ${truncateForStartupContext(content.trim(), 280)}`;
    });
    sections.push(`### RECENT MEMORIES\n${memoryLines.join('\n')}`);
  }

  const activeSessions = Array.isArray(bootstrap.activeSessions) ? bootstrap.activeSessions : [];
  if (activeSessions.length > 0) {
    const sessionLines = activeSessions.slice(0, 8).map((session) => {
      const id = typeof session.id === 'string' ? session.id.slice(0, 8) : 'unknown';
      const phase =
        typeof session.currentPhase === 'string' && session.currentPhase.length > 0
          ? session.currentPhase
          : 'active';
      const thread =
        typeof session.threadKey === 'string' && session.threadKey.length > 0
          ? session.threadKey
          : '-';
      return `- ${id} phase=${phase} thread=${thread}`;
    });
    sections.push(`### ACTIVE SESSIONS\n${sessionLines.join('\n')}`);
  }

  return sections.join('\n\n').trim();
}

async function resolveCodexStartupContextBlock(options: {
  backend: string;
  agentId: string;
  pcpConfig: PcpConfig | null;
  hasAuthToken: boolean;
  verbose: boolean;
  pcpSessionId?: string;
}): Promise<string | undefined> {
  const { backend, agentId, pcpConfig, hasAuthToken, verbose, pcpSessionId } = options;
  if (backend !== 'codex') return undefined;
  if (!hasAuthToken) {
    sbDebugLog('sb', 'codex_startup_context_skipped', {
      reason: 'no_auth_token',
      agentId,
      backend,
      pcpSessionId: pcpSessionId || null,
    });
    return undefined;
  }

  try {
    const bootstrap = await callPcpTool<BootstrapContextResult>(
      'bootstrap',
      {
        email: pcpConfig?.email,
        agentId,
      },
      { timeoutMs: 5000, callerProfile: 'runtime' }
    );

    const { studioId: ctxStudioId, studioName: ctxStudioName } = await resolveStudioId(
      process.cwd()
    );
    const startupContextBlock = buildInjectedStartupContext(bootstrap, {
      pcpSessionId,
      studioId: ctxStudioId,
      studioName: ctxStudioName,
    });
    sbDebugLog('sb', 'codex_startup_context_injected', {
      agentId,
      backend,
      pcpSessionId: pcpSessionId || null,
      bytes: Buffer.byteLength(startupContextBlock, 'utf-8'),
    });
    if (verbose)
      console.log(chalk.dim('PCP startup context: injected into model_instructions_file'));
    return startupContextBlock;
  } catch (error) {
    sbDebugLog('sb', 'codex_startup_context_failed', {
      agentId,
      backend,
      pcpSessionId: pcpSessionId || null,
      error: error instanceof Error ? error.message : String(error),
    });
    if (verbose) console.log(chalk.dim('PCP startup context: unavailable (continuing)'));
    return undefined;
  }
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
  studioName?: string;
} {
  const identityPath = join(cwd, '.pcp', 'identity.json');
  if (!existsSync(identityPath)) return {};
  try {
    const identity = JSON.parse(readFileSync(identityPath, 'utf-8')) as {
      studioId?: string;
      identityId?: string;
      studio?: string;
    };
    return {
      studioId: identity.studioId,
      identityId: identity.identityId,
      studioName: identity.studio,
    };
  } catch {
    return {};
  }
}

/**
 * Resolve studioId from identity.json, falling back to a PCP API lookup
 * by worktree path if the UUID isn't stored locally.
 */
async function resolveStudioId(cwd: string): Promise<{
  studioId?: string;
  identityId?: string;
  studioName?: string;
}> {
  const local = getIdentityContextFromIdentityJson(cwd);
  if (local.studioId) return local;

  // No UUID in identity.json — try resolving via PCP API by worktree path
  try {
    const result = await callPcpTool<{ studio?: { id?: string } }>(
      'get_studio',
      { path: cwd },
      { timeoutMs: 3000 }
    );
    if (result?.studio?.id) {
      return { ...local, studioId: result.studio.id };
    }
  } catch {
    // API unavailable or studio not found — proceed without studioId
  }

  return local;
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

function parseJsonl(content: string): Array<Record<string, unknown>> {
  const parsed: Array<Record<string, unknown>> = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      parsed.push(obj);
    } catch {
      // ignore malformed lines
    }
  }
  return parsed;
}

function readFileTailUtf8(filePath: string, maxBytes = 256 * 1024): string {
  const fd = openSync(filePath, 'r');
  try {
    const size = statSync(filePath).size;
    const bytesToRead = Math.min(size, Math.max(1, maxBytes));
    const offset = Math.max(0, size - bytesToRead);
    const buffer = Buffer.allocUnsafe(bytesToRead);
    const readBytes = readSync(fd, buffer, 0, bytesToRead, offset);
    return buffer.subarray(0, readBytes).toString('utf-8');
  } finally {
    closeSync(fd);
  }
}

function readFilePrefixByLineCountUtf8(
  filePath: string,
  lineLimit: number,
  maxBytes = 2 * 1024 * 1024
): string {
  const fd = openSync(filePath, 'r');
  try {
    const chunkSize = 64 * 1024;
    const chunks: Buffer[] = [];
    const buffer = Buffer.allocUnsafe(chunkSize);
    let totalRead = 0;
    let position = 0;
    let newlineCount = 0;

    while (totalRead < maxBytes && newlineCount < lineLimit) {
      const remaining = maxBytes - totalRead;
      const bytesToRead = Math.min(chunkSize, remaining);
      const bytesRead = readSync(fd, buffer, 0, bytesToRead, position);
      if (bytesRead <= 0) break;

      const slice = Buffer.from(buffer.subarray(0, bytesRead));
      chunks.push(slice);
      totalRead += bytesRead;
      position += bytesRead;

      for (let i = 0; i < bytesRead; i += 1) {
        if (slice[i] === 10) newlineCount += 1; // '\n'
      }
    }

    return Buffer.concat(chunks).toString('utf-8');
  } finally {
    closeSync(fd);
  }
}

function extractMessageText(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const compact = value.replace(/\s+/g, ' ').trim();
    return compact || undefined;
  }
  if (Array.isArray(value)) {
    const chunks: string[] = [];
    for (const item of value) {
      const chunk = extractMessageText(item);
      if (chunk) chunks.push(chunk);
    }
    if (chunks.length === 0) return undefined;
    return chunks.join(' ');
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const textLikeKeys = ['text', 'message', 'content', 'output', 'input'];
    const chunks: string[] = [];
    for (const key of textLikeKeys) {
      const chunk = extractMessageText(record[key]);
      if (chunk) chunks.push(chunk);
    }
    if (chunks.length === 0) return undefined;
    return chunks.join(' ');
  }
  return undefined;
}

function normalizePreviewLeafText(value: string): string | undefined {
  const compact = value.replace(/\s+/g, ' ').trim();
  if (!compact) return undefined;
  if (/^<(local-command|tool[_-]?result|tool[_-]?use|bash-command)[^>]*>/i.test(compact)) {
    return undefined;
  }
  return compact;
}

function extractPreviewText(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return normalizePreviewLeafText(value);
  }
  if (Array.isArray(value)) {
    const chunks: string[] = [];
    for (const item of value) {
      const chunk = extractPreviewText(item);
      if (chunk) chunks.push(chunk);
    }
    if (chunks.length === 0) return undefined;
    return chunks.join(' ');
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const textLikeKeys = ['text', 'message', 'content', 'output', 'input'];
    const chunks: string[] = [];
    for (const key of textLikeKeys) {
      const chunk = extractPreviewText(record[key]);
      if (chunk) chunks.push(chunk);
    }
    if (chunks.length === 0) return undefined;
    return chunks.join(' ');
  }
  return undefined;
}

function extractClaudePreviewText(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return normalizePreviewLeafText(value);
  }

  if (Array.isArray(value)) {
    const chunks: string[] = [];
    for (const item of value) {
      const chunk = extractClaudePreviewText(item);
      if (chunk) chunks.push(chunk);
    }
    if (chunks.length === 0) return undefined;
    return chunks.join(' ');
  }

  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const blockType = typeof record.type === 'string' ? record.type.toLowerCase() : '';
    if (
      blockType === 'tool_result' ||
      blockType === 'tool_use' ||
      blockType === 'server_tool_use'
    ) {
      return undefined;
    }

    if (blockType === 'text' || blockType === 'input_text' || blockType === 'output_text') {
      return extractClaudePreviewText(record.text);
    }

    const textLikeKeys = ['text', 'message', 'content', 'output', 'input'];
    const chunks: string[] = [];
    for (const key of textLikeKeys) {
      const chunk = extractClaudePreviewText(record[key]);
      if (chunk) chunks.push(chunk);
    }
    if (chunks.length === 0) return undefined;
    return chunks.join(' ');
  }

  return undefined;
}

function roleFromUnknown(value: unknown): SessionPreviewSummary['role'] | undefined {
  if (value === 'user') return 'user';
  if (value === 'assistant' || value === 'model') return 'assistant';
  if (value === 'inbox') return 'inbox';
  return undefined;
}

function formatSessionPreviewText(
  summary: SessionPreviewSummary,
  options?: { assistantLabel?: string }
): string {
  const speaker =
    summary.role === 'assistant'
      ? options?.assistantLabel || 'assistant'
      : summary.role === 'inbox'
        ? 'inbox'
        : 'you';
  return `${speaker}: ${truncateText(summary.content, 110)}`;
}

function withAgentPreviewSpeaker(
  preview: string | undefined,
  assistantLabel?: string
): string | undefined {
  if (!preview) return undefined;
  const normalizedLabel = assistantLabel?.trim();
  if (normalizedLabel && /^assistant:\s*/i.test(preview)) {
    return `${normalizedLabel}: ${preview.replace(/^assistant:\s*/i, '')}`;
  }
  return preview;
}

export function withSessionFileSize(
  preview: string | undefined,
  fileSizeBytes: number | undefined
): string | undefined {
  const size = formatFileSize(fileSizeBytes);
  if (!size) return preview;

  const normalized = preview?.trim();
  if (!normalized) return `${size} · (session)`;
  if (normalized.includes(size)) return normalized;
  return `${size} · ${normalized}`;
}

function getSessionPhaseLabel(session: PcpSessionSummary): string | undefined {
  const currentPhase = (session.currentPhase || '').trim();
  if (currentPhase) return currentPhase;

  const lifecycle = (session.lifecycle || '').trim().toLowerCase();
  if (lifecycle && lifecycle !== 'active') return `runtime:${lifecycle}`;

  const status = (session.status || '').trim().toLowerCase();
  if (status && status !== 'active') return `runtime:${status}`;

  return undefined;
}

function extractLatestPreviewFromCodexRolloutJsonl(
  jsonl: string
): SessionPreviewSummary | undefined {
  const events = parseJsonl(jsonl);
  let latest: SessionPreviewSummary | undefined;
  for (const event of events) {
    const eventType = typeof event.type === 'string' ? event.type : '';
    const ts =
      typeof event.timestamp === 'string'
        ? event.timestamp
        : typeof event.ts === 'string'
          ? event.ts
          : undefined;

    if (eventType === 'response_item') {
      const payload =
        event.payload && typeof event.payload === 'object'
          ? (event.payload as Record<string, unknown>)
          : undefined;
      if (!payload) continue;
      if (payload.type !== 'message') continue;

      const role = roleFromUnknown(payload.role);
      if (!role || role === 'inbox') continue;
      const content = extractPreviewText(payload.content);
      if (!content) continue;
      latest = { role, content, ts };
      continue;
    }

    if (eventType === 'event_msg') {
      const payload =
        event.payload && typeof event.payload === 'object'
          ? (event.payload as Record<string, unknown>)
          : undefined;
      if (!payload) continue;
      if (payload.type === 'user_message') {
        const content = extractPreviewText(payload.message);
        if (content) latest = { role: 'user', content, ts };
      } else if (payload.type === 'agent_message') {
        const content = extractPreviewText(payload.message);
        if (content) latest = { role: 'assistant', content, ts };
      }
    }
  }
  return latest;
}

export function extractLatestPreviewFromPcpTranscriptJsonl(
  jsonl: string
): SessionPreviewSummary | undefined {
  const events = parseJsonl(jsonl);
  let latest: SessionPreviewSummary | undefined;
  for (const event of events) {
    const type = typeof event.type === 'string' ? event.type : '';
    if (type === 'user') {
      const content = extractPreviewText(event.content);
      if (!content) continue;
      latest = {
        role: 'user',
        content,
        ts: typeof event.ts === 'string' ? event.ts : undefined,
      };
      continue;
    }
    if (type === 'assistant') {
      const content = extractPreviewText(event.content);
      if (!content) continue;
      latest = {
        role: 'assistant',
        content,
        ts: typeof event.ts === 'string' ? event.ts : undefined,
      };
      continue;
    }
    if (type === 'inbox') {
      const content = extractPreviewText(event.rendered) || extractPreviewText(event.content);
      if (!content) continue;
      latest = {
        role: 'inbox',
        content,
        ts: typeof event.ts === 'string' ? event.ts : undefined,
      };
    }
  }
  return latest;
}

export function extractLatestPreviewFromClaudeSessionJsonl(
  jsonl: string
): SessionPreviewSummary | undefined {
  const events = parseJsonl(jsonl);
  let latest: SessionPreviewSummary | undefined;
  for (const event of events) {
    const ts = typeof event.timestamp === 'string' ? event.timestamp : undefined;
    const message =
      event.message && typeof event.message === 'object'
        ? (event.message as Record<string, unknown>)
        : undefined;

    const role = roleFromUnknown(message?.role || event.role || event.type);
    if (!role || role === 'inbox') continue;

    const content = extractClaudePreviewText(message?.content || event.content || message);
    if (!content) continue;
    latest = { role, content, ts };
  }
  return latest;
}

function findLatestPcpReplTranscriptForSession(
  sessionId: string,
  cwd = process.cwd()
): string | undefined {
  const searchRoots = new Set<string>([cwd]);
  const worktreesDir = join(cwd, '.worktrees');
  if (existsSync(worktreesDir)) {
    try {
      for (const entry of readdirSync(worktreesDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        searchRoots.add(join(worktreesDir, entry.name));
      }
    } catch {
      // Ignore unreadable .worktrees directory
    }
  }

  const cwdBase = basename(cwd);
  const repoPrefix = cwdBase.split('--')[0] || cwdBase;
  const parentDir = dirname(cwd);
  if (existsSync(parentDir)) {
    try {
      for (const entry of readdirSync(parentDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (entry.name !== repoPrefix && !entry.name.startsWith(`${repoPrefix}--`)) continue;
        searchRoots.add(join(parentDir, entry.name));
      }
    } catch {
      // Ignore unreadable sibling directories
    }
  }

  const prefix = `${sessionId}-`;
  const candidates: string[] = [];
  for (const root of searchRoots) {
    const dir = join(root, '.pcp', 'runtime', 'repl');
    if (!existsSync(dir)) continue;
    try {
      for (const entry of readdirSync(dir)) {
        if (!entry.startsWith(prefix) || !entry.endsWith('.jsonl')) continue;
        const fullPath = join(dir, entry);
        try {
          if (statSync(fullPath).isFile()) candidates.push(fullPath);
        } catch {
          // Ignore unreadable candidate files
        }
      }
    } catch {
      // Ignore unreadable repl directories
    }
  }

  candidates.sort((a, b) => {
    try {
      return statSync(b).mtimeMs - statSync(a).mtimeMs;
    } catch {
      return 0;
    }
  });
  return candidates[0];
}

function getPcpSessionPreviewLabel(
  session: PcpSessionSummary,
  assistantLabel: string,
  cwd = process.cwd()
): string | undefined {
  const transcriptPath = findLatestPcpReplTranscriptForSession(session.id, cwd);
  if (!transcriptPath) return undefined;
  try {
    const content = readFileSync(transcriptPath, 'utf-8');
    const summary = extractLatestPreviewFromPcpTranscriptJsonl(content);
    if (!summary) return undefined;
    return formatSessionPreviewText(summary, { assistantLabel });
  } catch {
    return undefined;
  }
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
  const normalizedBackend = normalizeSessionBackendName(backend);
  const nowMs = Date.now();
  // Keep only very recent path-ambiguous non-Claude sessions visible.
  // Six hours is long enough to survive normal work/restart gaps while still
  // suppressing stale cross-repo leakage from older unmapped sessions.
  const AMBIGUOUS_SESSION_WINDOW_MS = 6 * 60 * 60 * 1000;

  const backendMatched = sessions.filter((session) => {
    if (!session.backend) return true;
    return normalizeSessionBackendName(session.backend) === normalizedBackend;
  });

  if (!normalizedCwd) {
    return backendMatched;
  }

  const pathScoped: PcpSessionSummary[] = [];
  const ambiguous: PcpSessionSummary[] = [];

  for (const session of backendMatched) {
    const localMatchedId = session.backendSessionId || session.claudeSessionId;
    if (localMatchedId && localBackendSessionIds.has(localMatchedId)) {
      pathScoped.push(session);
      continue;
    }

    const normalizedWorkingDir = normalizePath(session.workingDir);
    if (normalizedWorkingDir && normalizedWorkingDir === normalizedCwd) {
      pathScoped.push(session);
      continue;
    }

    // Keep path-ambiguous non-Claude sessions visible in the picker so brand-new
    // PCP sessions (before hooks/close persist workingDir/backendSessionId) are
    // not accidentally hidden behind older mapped sessions.
    if (backend !== 'claude' && !normalizedWorkingDir && !localMatchedId) {
      const startedAtMs = toEpochMs(session.startedAt);
      const isFresh =
        startedAtMs !== undefined && Number.isFinite(startedAtMs)
          ? nowMs - startedAtMs <= AMBIGUOUS_SESSION_WINDOW_MS
          : false;
      if (isFresh) ambiguous.push(session);
    }
  }

  if (backend === 'claude') return pathScoped;
  if (pathScoped.length === 0 && ambiguous.length === 0) return [];

  const deduped = new Map<string, PcpSessionSummary>();
  for (const session of [...pathScoped, ...ambiguous]) {
    deduped.set(session.id, session);
  }
  return Array.from(deduped.values());
}

export function resolveBackendSessionIdForResume(options: {
  backend: string;
  chosen?: PcpSessionSummary;
  selectedLocalBackendSessionId?: string;
  localBackendSessionIds: Set<string>;
  knownBackendSessionIds?: Set<string>;
  /** Fallback from local runtime cache (sessions.json) when server-side backendSessionId is null */
  runtimeCachedSessionId?: string;
}): {
  backendSessionId?: string;
  staleTrackedBackendSessionId?: string;
  fallbackMode?: 'resume_pcp_session_id';
} {
  const {
    backend,
    chosen,
    selectedLocalBackendSessionId,
    localBackendSessionIds,
    knownBackendSessionIds,
    runtimeCachedSessionId,
  } = options;
  const normalizedBackend = normalizeSessionBackendName(backend);

  if (selectedLocalBackendSessionId) {
    return { backendSessionId: selectedLocalBackendSessionId };
  }

  if (
    !chosen ||
    (chosen.backend && normalizeSessionBackendName(chosen.backend) !== normalizedBackend)
  ) {
    return {};
  }

  const candidate =
    chosen.backendSessionId || chosen.claudeSessionId || runtimeCachedSessionId || undefined;
  if (!candidate) return {};

  if (localBackendSessionIds.size > 0 && !localBackendSessionIds.has(candidate)) {
    // Local project indexes can be incomplete (history truncation, worktree sharing,
    // path drift). If we can still find the session in the broader backend-local index,
    // prefer resume and avoid false stale classification.
    if (knownBackendSessionIds?.has(candidate)) {
      return { backendSessionId: candidate };
    }

    if (backend === 'claude' && chosen.id) {
      return {
        backendSessionId: chosen.id,
        staleTrackedBackendSessionId: candidate,
        fallbackMode: 'resume_pcp_session_id',
      };
    }
    return { staleTrackedBackendSessionId: candidate };
  }

  return { backendSessionId: candidate };
}

export function resolveBackendSessionSeedId(options: {
  backend: string;
  chosenSessionId?: string;
  backendSessionId?: string;
  createdNewPcpSession: boolean;
}): string | undefined {
  const { backend, chosenSessionId, backendSessionId, createdNewPcpSession } = options;

  if (backend !== 'claude') return undefined;
  if (!chosenSessionId) return undefined;
  if (backendSessionId) return undefined;

  // Seed Claude session ID only on first run when PCP session is created now.
  if (createdNewPcpSession) {
    return chosenSessionId;
  }

  return undefined;
}

export function resolveCapturedBackendSessionIdFromRuntime(options: {
  cwd?: string;
  backend: string;
  pcpSessionId?: string;
  runtimeLinkId?: string;
  agentId?: string;
  studioId?: string;
  knownLocalSessionSnapshot?: Map<string, string>;
  fallbackBackendSessionId?: string;
}): string | undefined {
  const {
    cwd = process.cwd(),
    backend,
    pcpSessionId,
    runtimeLinkId,
    agentId,
    studioId,
    knownLocalSessionSnapshot,
    fallbackBackendSessionId,
  } = options;

  const resolveFromRecord = (
    record?: { backendSessionId?: string; backendSessionIds?: string[] } | null
  ): string | undefined => {
    if (!record) return undefined;
    if (record.backendSessionId) return record.backendSessionId;
    const last = record.backendSessionIds?.at(-1);
    return typeof last === 'string' && last.trim() ? last : undefined;
  };

  if (!pcpSessionId) return fallbackBackendSessionId;

  const scopedRecords = listRuntimeSessions(cwd, backend).filter(
    (record) =>
      record.pcpSessionId === pcpSessionId &&
      (!agentId || record.agentId === agentId) &&
      (!studioId || record.studioId === studioId)
  );

  if (runtimeLinkId) {
    const byRuntimeLink = scopedRecords.find((record) => record.runtimeLinkId === runtimeLinkId);
    const linked = resolveFromRecord(byRuntimeLink);
    if (linked) return linked;
  }

  const current = getCurrentRuntimeSession(cwd, backend);
  if (
    current?.pcpSessionId === pcpSessionId &&
    (!agentId || current.agentId === agentId) &&
    (!studioId || current.studioId === studioId)
  ) {
    const currentSessionId = resolveFromRecord(current);
    if (currentSessionId) return currentSessionId;
  }

  if (knownLocalSessionSnapshot) {
    const postRunLocalSessions = getBackendLocalSessionsForProject(backend, cwd, 50);
    const newLocalSession = postRunLocalSessions.find(
      (session) => !knownLocalSessionSnapshot.has(session.sessionId)
    );
    if (newLocalSession?.sessionId) return newLocalSession.sessionId;

    const updatedExistingSession = postRunLocalSessions.find((session) => {
      const previousModified = knownLocalSessionSnapshot.get(session.sessionId);
      if (!previousModified) return false;
      return previousModified !== session.modified;
    });
    if (updatedExistingSession?.sessionId) return updatedExistingSession.sessionId;
  }

  return resolveFromRecord(scopedRecords[0]) || fallbackBackendSessionId;
}

export async function resolveCapturedBackendSessionIdWithRetry(options: {
  cwd?: string;
  backend: string;
  pcpSessionId?: string;
  runtimeLinkId?: string;
  agentId?: string;
  studioId?: string;
  knownLocalSessionSnapshot?: Map<string, string>;
  fallbackBackendSessionId?: string;
  attempts?: number;
  intervalMs?: number;
}): Promise<string | undefined> {
  const attempts = Math.max(1, options.attempts ?? 20);
  const intervalMs = Math.max(10, options.intervalMs ?? 100);

  let resolved = resolveCapturedBackendSessionIdFromRuntime(options);
  if (resolved) return resolved;

  for (let attempt = 1; attempt < attempts; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    resolved = resolveCapturedBackendSessionIdFromRuntime(options);
    if (resolved) return resolved;
  }

  return resolved;
}

export function extractSessionFromStartSessionResponse(
  payload: unknown
): PcpSessionSummary | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const record = payload as Record<string, unknown>;

  const nested = record.session;
  if (nested && typeof nested === 'object') {
    const nestedSession = nested as Record<string, unknown>;
    if (typeof nestedSession.id === 'string' && typeof nestedSession.startedAt === 'string') {
      return nestedSession as unknown as PcpSessionSummary;
    }
  }

  if (typeof record.id === 'string' && typeof record.startedAt === 'string') {
    return record as unknown as PcpSessionSummary;
  }

  if (typeof record.text === 'string') {
    try {
      const parsed = JSON.parse(record.text) as unknown;
      return extractSessionFromStartSessionResponse(parsed);
    } catch {
      return undefined;
    }
  }

  return undefined;
}

export function resolveStartedSessionFromList(options: {
  beforeSessionIds: Set<string>;
  requestedSessionId?: string;
  listedSessions: PcpSessionSummary[];
}): PcpSessionSummary | undefined {
  const { beforeSessionIds, requestedSessionId, listedSessions } = options;

  if (requestedSessionId) {
    const exact = listedSessions.find((session) => session.id === requestedSessionId);
    if (exact) return exact;
  }

  const created = listedSessions
    .filter((session) => !beforeSessionIds.has(session.id))
    .sort((a, b) => {
      const aMs = toEpochMs(a.startedAt) ?? 0;
      const bMs = toEpochMs(b.startedAt) ?? 0;
      return bMs - aMs;
    });
  return created[0];
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
  const historyPath = join(homedir(), '.claude', 'history.jsonl');
  let historySessions: BackendLocalSessionSummary[] = [];
  let historySessionIds = new Set<string>();
  if (existsSync(historyPath)) {
    try {
      historySessions = extractClaudeHistorySessionsForProject(
        readFileSync(historyPath, 'utf-8'),
        normalizedCwd
      );
      historySessionIds = new Set(historySessions.map((session) => session.sessionId));
    } catch {
      // Ignore unreadable history file.
    }
  }
  const normalizedDirName = normalizedCwd.replace(/[\\/]/g, '-');
  const projectDirCandidates = new Set<string>([
    join(claudeProjectsDir, normalizedDirName),
    join(claudeProjectsDir, cwd.replace(/[\\/]/g, '-')),
  ]);

  const sessionFileIdRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  for (const projectDir of projectDirCandidates) {
    if (!existsSync(projectDir)) continue;

    for (const entry of readdirSync(projectDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const sessionId = entry.name.slice(0, -'.jsonl'.length);
      if (!sessionFileIdRegex.test(sessionId)) continue;

      const filePath = join(projectDir, entry.name);
      try {
        // Claude may create per-session jsonl files that only contain
        // file-history snapshots and no resumable conversation stream.
        // Those "poison" files look like valid session IDs by filename but fail
        // with `No conversation found with session ID` when resumed.
        // Require explicit sessionId evidence in file contents before surfacing
        // as a local resumable candidate.
        if (
          !isLikelyClaudeResumableSessionFile(filePath, sessionId) &&
          !historySessionIds.has(sessionId)
        ) {
          continue;
        }

        const stats = statSync(filePath);
        let latestPrompt: string | undefined;
        let latestPromptAt: string | undefined;
        try {
          const transcript = readFileTailUtf8(filePath);
          const preview = extractLatestPreviewFromClaudeSessionJsonl(transcript);
          if (preview) {
            latestPrompt = formatSessionPreviewText(preview);
            latestPromptAt = preview.ts;
          }
        } catch {
          // Best-effort preview extraction only.
        }

        if (!latestPrompt) {
          latestPrompt = withSessionFileSize(undefined, stats.size);
        }

        results.push({
          backend: 'claude',
          sessionId,
          projectPath: normalizedCwd,
          modified: stats.mtime.toISOString(),
          fileSizeBytes: stats.size,
          latestPrompt,
          latestPromptAt,
          transcriptPath: filePath,
        });
      } catch {
        // Ignore unreadable file stats.
      }
    }
  }

  // Fallback path: some Claude installations persist session linkage in history.jsonl
  // even when per-project sessions-index files are missing/out-of-date.
  results.push(...historySessions);

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

function isLikelyClaudeResumableSessionFile(filePath: string, sessionId: string): boolean {
  let content: string;
  try {
    // Read just enough prefix to scan the first logical JSONL entries, without
    // loading entire large transcripts into memory.
    content = readFilePrefixByLineCountUtf8(filePath, 30);
  } catch {
    return false;
  }

  const lines = content.split('\n').slice(0, 30);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }

    const fromSessionId =
      typeof parsed.sessionId === 'string' ? parsed.sessionId.trim() : undefined;
    const fromLegacySessionId =
      typeof parsed.session_id === 'string' ? parsed.session_id.trim() : undefined;

    if (fromSessionId === sessionId || fromLegacySessionId === sessionId) {
      return true;
    }
  }

  return false;
}

export function getKnownClaudeSessionIds(limitPerProject = 500): Set<string> {
  const sessionIds = new Set<string>();
  const claudeProjectsDir = join(homedir(), '.claude', 'projects');

  const sessionFileIdRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  if (existsSync(claudeProjectsDir)) {
    for (const entry of readdirSync(claudeProjectsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      let seenForProject = 0;
      for (const file of readdirSync(join(claudeProjectsDir, entry.name), {
        withFileTypes: true,
      })) {
        if (!file.isFile() || !file.name.endsWith('.jsonl')) continue;
        const sessionId = file.name.slice(0, -'.jsonl'.length);
        if (!sessionFileIdRegex.test(sessionId)) continue;
        const filePath = join(claudeProjectsDir, entry.name, file.name);
        if (!isLikelyClaudeResumableSessionFile(filePath, sessionId)) continue;
        sessionIds.add(sessionId);
        seenForProject += 1;
        if (seenForProject >= limitPerProject) break;
      }
    }
  }

  const historyPath = join(homedir(), '.claude', 'history.jsonl');
  if (existsSync(historyPath)) {
    try {
      for (const line of readFileSync(historyPath, 'utf-8').split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed) as { sessionId?: string };
          if (parsed.sessionId?.trim()) sessionIds.add(parsed.sessionId.trim());
        } catch {
          // Ignore malformed history lines.
        }
      }
    } catch {
      // Ignore unreadable history file.
    }
  }

  return sessionIds;
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
  limit = 20,
  options: {
    includeExecSources?: boolean;
  } = {}
): BackendLocalSessionSummary[] {
  // Default to including exec/runner-owned Codex sessions. Those automated runs are
  // still attachable debugging artifacts, and hiding them regressed `sb -b codex`
  // session visibility compared to prior behavior.
  const includeExecSources = options.includeExecSources !== false;
  const fallbackToJsonl = (reason: string): BackendLocalSessionSummary[] => {
    const fallback = getCodexLocalSessionsFromJsonl(cwd, limit, { includeExecSources });
    sbDebugLog('backend', 'codex_local_sessions_fallback_jsonl', {
      cwd,
      reason,
      includeExecSources,
      returnedSessions: fallback.length,
      sessionIds: fallback.map((session) => session.sessionId),
    });
    return fallback;
  };

  const codexStateDbPath = join(homedir(), '.codex', 'state_5.sqlite');
  if (!existsSync(codexStateDbPath)) {
    sbDebugLog('backend', 'codex_local_sessions_missing_db', { cwd, codexStateDbPath });
    return fallbackToJsonl('missing_state_db');
  }

  const normalizedCwd = normalizePath(cwd);
  if (!normalizedCwd) {
    sbDebugLog('backend', 'codex_local_sessions_unresolved_cwd', { cwd });
    return [];
  }

  const query = `
SELECT id, cwd, updated_at,
       replace(replace(first_user_message, char(10), ' '), char(9), ' ') AS first_user_message,
       rollout_path,
       git_branch
FROM threads
WHERE archived = 0
  ${includeExecSources ? '' : "AND source = 'cli'"}
ORDER BY updated_at DESC
LIMIT 200;
`;

  const result = spawnSync('sqlite3', ['-tabs', codexStateDbPath, query], { encoding: 'utf-8' });
  if (result.error || result.status !== 0 || !result.stdout) {
    sbDebugLog('backend', 'codex_local_sessions_query_failed', {
      cwd: normalizedCwd,
      codexStateDbPath,
      status: result.status ?? null,
      error: result.error?.message || null,
      stderr: result.stderr?.toString()?.slice(-1000) || null,
    });
    return fallbackToJsonl('sqlite_query_failed');
  }

  const sessions: BackendLocalSessionSummary[] = [];
  const lines = result.stdout.split('\n').map((line) => line.trim());
  for (const line of lines) {
    if (!line) continue;
    const [sessionId, sessionCwd, updatedAtRaw, firstPrompt, rolloutPath, gitBranch] =
      line.split('\t');
    if (!sessionId || !sessionCwd || !updatedAtRaw) continue;

    const normalizedSessionPath = normalizePath(sessionCwd);
    if (!normalizedSessionPath || normalizedSessionPath !== normalizedCwd) continue;

    const updatedAtSeconds = Number(updatedAtRaw);
    const modified = Number.isFinite(updatedAtSeconds)
      ? new Date(updatedAtSeconds * 1000).toISOString()
      : new Date().toISOString();

    let latestPrompt: string | undefined;
    let latestPromptAt: string | undefined;
    const transcriptPath = rolloutPath?.trim() || undefined;
    let fileSizeBytes: number | undefined;
    if (transcriptPath && existsSync(transcriptPath)) {
      try {
        fileSizeBytes = statSync(transcriptPath).size;
        const transcript = readFileSync(transcriptPath, 'utf-8');
        const preview = extractLatestPreviewFromCodexRolloutJsonl(transcript);
        if (preview) {
          latestPrompt = formatSessionPreviewText(preview);
          latestPromptAt = preview.ts;
        }
      } catch {
        // Best-effort preview extraction only.
      }
    }

    if (!latestPrompt) {
      latestPrompt = withSessionFileSize(undefined, fileSizeBytes);
    }

    sessions.push({
      backend: 'codex',
      sessionId,
      projectPath: sessionCwd,
      modified,
      fileSizeBytes,
      firstPrompt: firstPrompt?.trim(),
      latestPrompt,
      latestPromptAt,
      gitBranch: gitBranch?.trim(),
      transcriptPath,
    });
  }

  const scoped = sessions.slice(0, limit);
  sbDebugLog('backend', 'codex_local_sessions_loaded', {
    cwd: normalizedCwd,
    includeExecSources,
    totalScopedSessions: sessions.length,
    returnedSessions: scoped.length,
    sessionIds: scoped.map((session) => session.sessionId),
  });
  return scoped.length > 0 ? scoped : fallbackToJsonl('sqlite_query_empty');
}

function getCodexLocalSessionsFromJsonl(
  cwd = process.cwd(),
  limit = 20,
  options: {
    includeExecSources?: boolean;
  } = {}
): BackendLocalSessionSummary[] {
  const includeExecSources = options.includeExecSources !== false;
  const codexSessionsDir = join(homedir(), '.codex', 'sessions');
  if (!existsSync(codexSessionsDir)) return [];

  const normalizedCwd = normalizePath(cwd);
  if (!normalizedCwd) return [];

  const sessionFiles: Array<{ path: string; modified: string }> = [];
  const stack: string[] = [codexSessionsDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) continue;

    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      try {
        const stats = statSync(fullPath);
        sessionFiles.push({ path: fullPath, modified: stats.mtime.toISOString() });
      } catch {
        // Ignore unreadable files.
      }
    }
  }

  const maxFilesToInspect = Math.max(limit * 25, 250);
  const sortedFiles = sessionFiles
    .sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime())
    .slice(0, maxFilesToInspect);

  const sessions: BackendLocalSessionSummary[] = [];
  for (const sessionFile of sortedFiles) {
    let content: string;
    try {
      content = readFileSync(sessionFile.path, 'utf-8');
    } catch {
      continue;
    }

    let matched: BackendLocalSessionSummary | undefined;
    const latestPreview = extractLatestPreviewFromCodexRolloutJsonl(content);
    const lines = content.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let parsed: CodexSessionMetaLine;
      try {
        parsed = JSON.parse(trimmed) as CodexSessionMetaLine;
      } catch {
        continue;
      }

      if (parsed.type !== 'session_meta') continue;
      const sessionId = parsed.payload?.id?.trim();
      const sessionCwd = parsed.payload?.cwd?.trim();
      if (!sessionId || !sessionCwd) break;
      const originator = parsed.payload?.originator?.trim();
      if (!includeExecSources && originator && !originator.startsWith('codex_cli')) break;

      const normalizedSessionCwd = normalizePath(sessionCwd);
      if (!normalizedSessionCwd || normalizedSessionCwd !== normalizedCwd) break;

      matched = {
        backend: 'codex',
        sessionId,
        projectPath: sessionCwd,
        modified: parsed.payload?.timestamp || parsed.timestamp || sessionFile.modified,
        latestPrompt: latestPreview ? formatSessionPreviewText(latestPreview) : undefined,
        latestPromptAt: latestPreview?.ts,
        fileSizeBytes: (() => {
          try {
            return statSync(sessionFile.path).size;
          } catch {
            return undefined;
          }
        })(),
        transcriptPath: sessionFile.path,
      };
      if (!matched.latestPrompt) {
        matched.latestPrompt = withSessionFileSize(undefined, matched.fileSizeBytes);
      }
      break;
    }

    if (matched) sessions.push(matched);
  }

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

function getGeminiProjectKeysForCwd(cwd = process.cwd()): string[] {
  const normalizedCwd = normalizePath(cwd);
  if (!normalizedCwd) {
    sbDebugLog('backend', 'gemini_project_keys_unresolved_cwd', { cwd });
    return [];
  }

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

  const resolved = Array.from(keys);
  sbDebugLog('backend', 'gemini_project_keys_loaded', {
    cwd: normalizedCwd,
    keyCount: resolved.length,
    keys: resolved,
  });
  return resolved;
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
      const fileSizeBytes = (() => {
        try {
          return statSync(sessionPath).size;
        } catch {
          return undefined;
        }
      })();

      const firstUserMessage = (parsed.messages || []).find((message) => message.type === 'user');
      const latestMessage = [...(parsed.messages || [])].reverse().find((message) => {
        if (typeof message?.content !== 'string') return false;
        return Boolean(extractPreviewText(message.content));
      });
      const firstPrompt =
        parsed.summary ||
        (typeof firstUserMessage?.content === 'string'
          ? firstUserMessage.content.trim()
          : undefined);
      const latestPrompt =
        latestMessage && typeof latestMessage.content === 'string'
          ? (() => {
              const content = extractPreviewText(latestMessage.content);
              if (!content) return undefined;
              return formatSessionPreviewText({
                role: latestMessage.type === 'user' ? 'user' : 'assistant',
                content,
              });
            })()
          : undefined;
      const latestPromptWithFallback =
        latestPrompt || withSessionFileSize(undefined, fileSizeBytes);

      sessions.push({
        backend: 'gemini',
        sessionId: parsed.sessionId,
        projectPath,
        modified,
        fileSizeBytes,
        firstPrompt,
        latestPrompt: latestPromptWithFallback,
        transcriptPath: sessionPath,
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
  if (projectKeys.length === 0) {
    sbDebugLog('backend', 'gemini_local_sessions_no_project_keys', { cwd });
    return [];
  }

  const sessions = projectKeys.flatMap((projectKey) => getGeminiSessionsForProjectKey(projectKey));
  const deduped = new Map<string, BackendLocalSessionSummary>();
  for (const session of sessions) {
    const existing = deduped.get(session.sessionId);
    if (!existing || new Date(session.modified).getTime() > new Date(existing.modified).getTime()) {
      deduped.set(session.sessionId, session);
    }
  }

  const sorted = Array.from(deduped.values())
    .sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime())
    .slice(0, limit);
  sbDebugLog('backend', 'gemini_local_sessions_loaded', {
    cwd,
    projectKeyCount: projectKeys.length,
    dedupedCount: deduped.size,
    returnedSessions: sorted.length,
    sessionIds: sorted.map((session) => session.sessionId),
  });
  return sorted;
}

export function getBackendLocalSessionsForProject(
  backend: string,
  cwd = process.cwd(),
  limit = 20,
  options: {
    includeAllSources?: boolean;
  } = {}
): BackendLocalSessionSummary[] {
  if (backend === 'claude') return getClaudeLocalSessionsForProject(cwd, limit);
  if (backend === 'codex') {
    return getCodexLocalSessionsForProject(
      cwd,
      limit,
      options.includeAllSources ? { includeExecSources: true } : {}
    );
  }
  if (backend === 'gemini') return getGeminiLocalSessionsForProject(cwd, limit);
  return [];
}

function printPcpUnavailableWarning(reason: string, cwd = process.cwd()): void {
  const serverUrl = getPcpServerUrl();
  console.log(chalk.yellow(`\n⚠ PCP session service unavailable (${reason}).`));
  console.log(chalk.yellow(`  PCP_SERVER_URL: ${serverUrl}`));
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
  console.log(chalk.dim(`    curl -sS ${serverUrl.replace(/\/+$/, '')}/health`));
  console.log(chalk.dim('    sb auth login'));
  console.log(chalk.dim('    sb init'));
  console.log(chalk.dim('    sb status'));
}

function hasPcpHookCommand(value: unknown): boolean {
  const signatures = [
    'hooks on-session-start',
    'hooks on-stop',
    'hooks on-prompt',
    'hooks pre-compact',
    'hooks post-compact',
  ];
  if (typeof value === 'string') {
    return (
      value.includes('sb hooks ') ||
      signatures.some((signature) => value.includes(signature)) ||
      value.includes('commands/hooks.js')
    );
  }
  if (Array.isArray(value)) {
    return value.some((entry) => hasPcpHookCommand(entry));
  }
  if (value && typeof value === 'object') {
    return Object.values(value).some((entry) => hasPcpHookCommand(entry));
  }
  return false;
}

function getHookHealthForBackend(
  backend: string,
  cwd = process.cwd()
): { installed: boolean; configPath: string } {
  if (backend === 'codex') {
    const configPath = join(cwd, '.codex', 'config.toml');
    if (!existsSync(configPath)) return { installed: false, configPath: '.codex/config.toml' };
    const content = readFileSync(configPath, 'utf-8');
    const installed =
      /session_start\s*=\s*".*hooks on-session-start[^"]*"/.test(content) &&
      /session_end\s*=\s*".*hooks on-stop[^"]*"/.test(content) &&
      /user_prompt\s*=\s*".*hooks on-prompt[^"]*"/.test(content);
    return { installed, configPath: '.codex/config.toml' };
  }

  if (backend === 'gemini') {
    const configPath = join(cwd, '.gemini', 'settings.json');
    if (!existsSync(configPath)) return { installed: false, configPath: '.gemini/settings.json' };
    try {
      const parsed = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
      return { installed: hasPcpHookCommand(parsed.hooks), configPath: '.gemini/settings.json' };
    } catch {
      return { installed: false, configPath: '.gemini/settings.json' };
    }
  }

  const configPath = join(cwd, '.claude', 'settings.local.json');
  if (!existsSync(configPath))
    return { installed: false, configPath: '.claude/settings.local.json' };
  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    return {
      installed: hasPcpHookCommand(parsed.hooks),
      configPath: '.claude/settings.local.json',
    };
  } catch {
    return { installed: false, configPath: '.claude/settings.local.json' };
  }
}

export function hasBackendSessionOverride(
  backend: string,
  passthroughArgs: string[],
  promptParts: string[] = []
): boolean {
  const lowered = passthroughArgs.map((arg) => arg.toLowerCase());
  const has = (flag: string) => lowered.includes(flag.toLowerCase());
  const isCodexResumePrompt = backend === 'codex' && promptParts[0]?.toLowerCase() === 'resume';
  const codexResumeIndex = passthroughArgs.findIndex((arg) => arg.toLowerCase() === 'resume');
  const isCodexResumePassthrough =
    backend === 'codex' &&
    codexResumeIndex >= 0 &&
    passthroughArgs.slice(0, codexResumeIndex).every((arg) => arg.startsWith('-'));

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

export function extractBackendSessionOverrideId(
  backend: string,
  passthroughArgs: string[],
  promptParts: string[] = []
): string | undefined {
  const readFlagValue = (flags: string[]): string | undefined => {
    for (let i = 0; i < passthroughArgs.length; i += 1) {
      const token = passthroughArgs[i]?.toLowerCase();
      if (!token || !flags.includes(token)) continue;
      const value = passthroughArgs[i + 1];
      if (value && !value.startsWith('-')) return value;
    }
    return undefined;
  };

  if (backend === 'codex') {
    if (promptParts[0]?.toLowerCase() === 'resume') {
      const positional = promptParts[1];
      if (positional && !positional.startsWith('-')) return positional;
    }

    const resumeIndex = passthroughArgs.findIndex((arg) => arg.toLowerCase() === 'resume');
    if (resumeIndex >= 0) {
      const value = passthroughArgs[resumeIndex + 1];
      if (value && !value.startsWith('-')) return value;
    }

    return readFlagValue(['--resume', '-r', '--session-id']);
  }

  if (backend === 'claude') {
    return readFlagValue(['--resume', '-r', '--session-id']);
  }

  return readFlagValue(['--resume', '-r', '--session-id']);
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
        ...(context.threadKey ? { threadKey: context.threadKey } : {}),
        ...(context.triggerSource ? { triggerSource: context.triggerSource } : {}),
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
      payload: (() => {
        const base = {
          kind: 'backend_cli_execution' as const,
          phase: 'result' as const,
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
          ...(options.context.threadKey ? { threadKey: options.context.threadKey } : {}),
          ...(options.context.triggerSource
            ? { triggerSource: options.context.triggerSource }
            : {}),
        };
        if (options.error) {
          const ec = classifyError({
            errorText: options.error,
            backend: options.context.backend,
            exitCode: options.exitCode,
          });
          return {
            ...base,
            errorCategory: ec.category,
            errorSummary: ec.summary,
            retryable: ec.retryable,
          };
        }
        return base;
      })(),
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

export function shouldRetryWithFreshBackendSession(options: {
  backend: string;
  attemptedBackendSessionId?: string;
  stderrText?: string;
}): boolean {
  const { backend, attemptedBackendSessionId, stderrText = '' } = options;
  if (backend !== 'claude') return false;
  if (!attemptedBackendSessionId) return false;

  const lowered = stderrText.toLowerCase();
  return (
    lowered.includes('no conversation found with session id') ||
    (lowered.includes('session id') && lowered.includes('already in use'))
  );
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
  const gitBranch = getCurrentGitBranch(process.cwd());

  upsertRuntimeSession(process.cwd(), {
    pcpSessionId: options.pcpSessionId,
    backend: options.backend,
    agentId: options.agentId,
    ...(options.identityId ? { identityId: options.identityId } : {}),
    ...(options.studioId ? { studioId: options.studioId } : {}),
    ...(options.runtimeLinkId ? { runtimeLinkId: options.runtimeLinkId } : {}),
    backendSessionId: options.backendSessionId,
    ...(gitBranch ? { gitBranch } : {}),
    updatedAt: new Date().toISOString(),
  });

  try {
    const updateResult = await callPcpTool<{
      sessionConflict?: {
        backendSessionId?: string;
        conflictingSessionId?: string;
        conflictingAgentId?: string;
      };
      sessionTrace?: { changedFields?: string[] };
    }>('update_session_phase', {
      email: options.email,
      agentId: options.agentId,
      sessionId: options.pcpSessionId,
      backendSessionId: options.backendSessionId,
      status: 'active',
      workingDir: process.cwd(),
    });

    if (updateResult?.sessionConflict) {
      sbDebugLog('claude', 'persist_backend_link_conflict_warning', {
        backend: options.backend,
        agentId: options.agentId,
        pcpSessionId: options.pcpSessionId,
        backendSessionId: options.backendSessionId,
        conflict: updateResult.sessionConflict,
      });
    }
    if (updateResult?.sessionTrace?.changedFields?.length) {
      sbDebugLog('claude', 'persist_backend_link_session_trace', {
        pcpSessionId: options.pcpSessionId,
        changedFields: updateResult.sessionTrace.changedFields,
      });
    }
  } catch {
    // Best-effort linkage update only.
  }
}

async function ensurePcpSessionContext(
  agentId: string,
  backend: string,
  passthroughArgs: string[],
  verbose: boolean,
  promptParts: string[] = [],
  options: {
    listCandidates?: boolean;
    listCandidatesJson?: boolean;
    listCandidatesAll?: boolean;
    selectionOverride?: string;
  } = {}
): Promise<{
  pcpSessionId?: string;
  backendSessionId?: string;
  backendSessionSeedId?: string;
  threadKey?: string;
}> {
  const hasSessionOverride = hasBackendSessionOverride(backend, passthroughArgs, promptParts);
  const overrideBackendSessionId = extractBackendSessionOverrideId(
    backend,
    passthroughArgs,
    promptParts
  );

  const config = getPcpConfig();
  const email = config?.email;
  const cwd = process.cwd();
  const { studioId, identityId } = await resolveStudioId(cwd);
  const currentGitBranch = getCurrentGitBranch(cwd);
  const localSessionLimit = options.listCandidates || options.listCandidatesJson ? 120 : 40;
  const pcpSessionLimit = options.listCandidates || options.listCandidatesJson ? 80 : 40;
  const localBackendSessions = getBackendLocalSessionsForProject(backend, cwd, localSessionLimit, {
    includeAllSources: options.listCandidatesAll,
  });
  const localBackendSessionIds = new Set(localBackendSessions.map((session) => session.sessionId));
  const knownBackendSessionIds =
    backend === 'claude' ? getKnownClaudeSessionIds() : localBackendSessionIds;
  const sessionChoiceByValue = new Map<string, string>();
  const explicitSelection = Boolean(options.selectionOverride || options.listCandidates);
  const existing = getCurrentRuntimeSession(cwd, backend);
  sbDebugLog('claude', 'ensure_context_start', {
    backend,
    agentId,
    isTty: process.stdin.isTTY,
    explicitSelection,
    hasSessionOverride,
    overrideBackendSessionId: overrideBackendSessionId || null,
    listCandidatesAll: options.listCandidatesAll || false,
    selectionOverride: options.selectionOverride || null,
    localCount: localBackendSessions.length,
    knownCount: knownBackendSessionIds.size,
    existingPcpSessionId: existing?.pcpSessionId || null,
    existingBackendSessionId: existing?.backendSessionId || null,
  });

  // Fast path: runtime already knows current session for this backend.
  if (
    !explicitSelection &&
    existing?.pcpSessionId &&
    shouldAutoResumeRuntimeSession(existing, process.stdin.isTTY)
  ) {
    sbDebugLog('claude', 'ensure_context_fast_path_resume', {
      backend,
      agentId,
      pcpSessionId: existing.pcpSessionId,
      backendSessionId: existing.backendSessionId || null,
      isTty: process.stdin.isTTY,
    });
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
        limit: pcpSessionLimit,
      });
      activeSessions = filterPcpSessionsForContext(
        (listed.sessions || []).filter((s) => isSessionResumable(s)),
        backend,
        cwd,
        localBackendSessionIds
      );
      if (backend === 'claude') {
        activeSessions = activeSessions.filter((session) => {
          const linkedBackendSessionId = getSessionBackendId(session);
          if (!linkedBackendSessionId) return true;
          return knownBackendSessionIds.has(linkedBackendSessionId);
        });
      }
      sbDebugLog('claude', 'active_sessions_loaded', {
        backend,
        agentId,
        listedCount: (listed.sessions || []).length,
        filteredCount: activeSessions.length,
        filtered: activeSessions.map((session) => ({
          id: session.id,
          backend: session.backend || null,
          backendSessionId: session.backendSessionId || session.claudeSessionId || null,
          workingDir: session.workingDir || null,
          phase: getSessionPhaseLabel(session) || null,
        })),
      });
    } catch (err) {
      pcpAvailable = false;
      pcpUnavailableReason = err instanceof Error ? err.message : 'request failed';
    }
  }

  if (!pcpAvailable) {
    sbDebugLog('sb', 'pcp_unavailable', {
      backend,
      agentId,
      reason: pcpUnavailableReason || 'unknown error',
      studioId: studioId || null,
    });
    printPcpUnavailableWarning(pcpUnavailableReason || 'unknown error', cwd);
  }

  if (process.stdin.isTTY || options.listCandidates) {
    const hooks = getHookHealthForBackend(backend, cwd);
    if (!hooks.installed) {
      console.log(
        chalk.yellow(
          `\n⚠ PCP hooks not installed for ${backend} (${hooks.configPath}). Session mapping may be unreliable.`
        )
      );
      console.log(chalk.dim(`  Run: sb hooks install -b ${backend}`));
    }
  }

  const untrackedLocalBackendSessions = filterUntrackedLocalBackendSessions(
    localBackendSessions,
    activeSessions
  );
  const runtimeSessionsForBackend = listRuntimeSessions(cwd, backend);
  const runtimeBackendSessionIdByPcpSessionId = new Map<string, string>();
  const runtimeBranchByPcpSessionId = new Map<string, string>();
  for (const session of runtimeSessionsForBackend) {
    if (
      session.backendSessionId &&
      !runtimeBackendSessionIdByPcpSessionId.has(session.pcpSessionId)
    ) {
      runtimeBackendSessionIdByPcpSessionId.set(session.pcpSessionId, session.backendSessionId);
    }
    if (session.gitBranch && !runtimeBranchByPcpSessionId.has(session.pcpSessionId)) {
      runtimeBranchByPcpSessionId.set(session.pcpSessionId, session.gitBranch);
    }
  }
  const pcpSessionByBackendSessionId = new Map<string, PcpSessionSummary>();
  for (const session of activeSessions) {
    const backendSessionId =
      getSessionBackendId(session) || runtimeBackendSessionIdByPcpSessionId.get(session.id);
    if (!backendSessionId || pcpSessionByBackendSessionId.has(backendSessionId)) continue;
    pcpSessionByBackendSessionId.set(backendSessionId, session);
  }
  // Keep the picker de-duplicated: linked locals are rendered through the PCP row
  // (with linked preview/timestamp), while untracked locals remain independently selectable.
  const displayLocalBackendSessions = untrackedLocalBackendSessions;
  const existingSessionIds = new Set(activeSessions.map((session) => session.id));
  const pcpPreviewBySessionId = new Map<string, string>();
  for (const session of activeSessions) {
    const preview = getPcpSessionPreviewLabel(session, session.agentId || agentId, cwd);
    if (preview) pcpPreviewBySessionId.set(session.id, preview);
  }

  let chosen: PcpSessionSummary | undefined;
  let selectedLocalBackendSessionId: string | undefined;
  let createdNewPcpSession = false;

  const normalizedSelectionOverride = options.selectionOverride?.trim();
  const pcpSelection = (selection: string): string | undefined => {
    const value = selection.replace(/^__pcp__:/, '').replace(/^pcp:/, '');
    const found = activeSessions.find(
      (session) => session.id === value || session.id.startsWith(value)
    );
    return found?.id;
  };
  const localSelection = (selection: string): string | undefined => {
    const value = selection.replace(/^__local__:/, '').replace(/^local:/, '');
    const found = localBackendSessions.find(
      (session) => session.sessionId === value || session.sessionId.startsWith(value)
    );
    return found?.sessionId;
  };

  const startNewPcpSession = async (): Promise<PcpSessionSummary | undefined> => {
    if (!pcpAvailable || !email) return undefined;

    const resolveCreatedSessionFromList = async (
      requestedSessionId: string | undefined,
      mode: 'with_session_id' | 'legacy_without_session_id'
    ): Promise<PcpSessionSummary | undefined> => {
      try {
        const listed = await callPcpTool<ListSessionsResult>(
          'list_sessions',
          {
            email,
            agentId,
            ...(studioId ? { studioId } : {}),
            limit: pcpSessionLimit,
          },
          { callerProfile: 'runtime' }
        );
        const listedActive = filterPcpSessionsForContext(
          (listed.sessions || []).filter((session) => isSessionResumable(session)),
          backend,
          cwd,
          localBackendSessionIds
        );
        const scopedActive =
          backend === 'claude'
            ? listedActive.filter((session) => {
                const linkedBackendSessionId =
                  getSessionBackendId(session) ||
                  runtimeBackendSessionIdByPcpSessionId.get(session.id);
                if (!linkedBackendSessionId) return true;
                return knownBackendSessionIds.has(linkedBackendSessionId);
              })
            : listedActive;
        const resolved = resolveStartedSessionFromList({
          beforeSessionIds: existingSessionIds,
          requestedSessionId,
          listedSessions: scopedActive,
        });
        sbDebugLog('sb', 'pcp_start_session_resolve_from_list', {
          backend,
          agentId,
          studioId: studioId || null,
          mode,
          requestedSessionId: requestedSessionId || null,
          resolvedSessionId: resolved?.id || null,
          listedCount: scopedActive.length,
        });
        if (resolved) activeSessions = scopedActive;
        return resolved;
      } catch (error) {
        sbDebugLog('sb', 'pcp_start_session_resolve_from_list_failed', {
          backend,
          agentId,
          studioId: studioId || null,
          mode,
          requestedSessionId: requestedSessionId || null,
          error: error instanceof Error ? error.message : String(error),
        });
        return undefined;
      }
    };

    const newSessionId = randomUUID();
    try {
      const started = await callPcpTool<{ session?: PcpSessionSummary }>(
        'start_session',
        {
          email,
          agentId,
          ...(studioId ? { studioId } : {}),
          backend,
          forceNew: true,
          sessionId: newSessionId,
        },
        { callerProfile: 'runtime' }
      );
      const directSession = extractSessionFromStartSessionResponse(started);
      const resolvedSession =
        directSession || (await resolveCreatedSessionFromList(newSessionId, 'with_session_id'));
      sbDebugLog('sb', 'pcp_start_session_success', {
        backend,
        agentId,
        studioId: studioId || null,
        requestedSessionId: newSessionId,
        returnedSessionId: resolvedSession?.id || null,
        mode: 'with_session_id',
      });
      if (resolvedSession) return resolvedSession;
      throw new Error('start_session returned no session payload');
    } catch (errorWithSessionId) {
      // Backward compatibility: older PCP servers may reject the newer `sessionId`
      // parameter. Retry once without it so "start new session" still creates a
      // real server-side PCP session instead of a synthetic local-only UUID.
      sbDebugLog('sb', 'pcp_start_session_retry_legacy', {
        backend,
        agentId,
        studioId: studioId || null,
        attemptedSessionId: newSessionId,
        error:
          errorWithSessionId instanceof Error
            ? errorWithSessionId.message
            : String(errorWithSessionId),
      });

      try {
        const startedLegacy = await callPcpTool<{ session?: PcpSessionSummary }>(
          'start_session',
          {
            email,
            agentId,
            ...(studioId ? { studioId } : {}),
            backend,
            forceNew: true,
          },
          { callerProfile: 'runtime' }
        );
        const directSession = extractSessionFromStartSessionResponse(startedLegacy);
        const resolvedSession =
          directSession ||
          (await resolveCreatedSessionFromList(undefined, 'legacy_without_session_id'));
        sbDebugLog('sb', 'pcp_start_session_success', {
          backend,
          agentId,
          studioId: studioId || null,
          requestedSessionId: newSessionId,
          returnedSessionId: resolvedSession?.id || null,
          mode: 'legacy_without_session_id',
        });
        return resolvedSession;
      } catch (legacyError) {
        sbDebugLog('sb', 'pcp_start_session_failed', {
          backend,
          agentId,
          studioId: studioId || null,
          attemptedSessionId: newSessionId,
          errorWithSessionId:
            errorWithSessionId instanceof Error
              ? errorWithSessionId.message
              : String(errorWithSessionId),
          legacyError: legacyError instanceof Error ? legacyError.message : String(legacyError),
        });
        return undefined;
      }
    }
  };

  if (hasSessionOverride) {
    if (!overrideBackendSessionId) {
      sbDebugLog('claude', 'ensure_context_override_without_explicit_id', {
        backend,
        agentId,
      });
      return {};
    }

    const matchedByBackendId =
      pcpSessionByBackendSessionId.get(overrideBackendSessionId) ||
      activeSessions.find(
        (session) =>
          session.id === overrideBackendSessionId ||
          session.id.startsWith(overrideBackendSessionId) ||
          getSessionBackendId(session) === overrideBackendSessionId
      );

    chosen = matchedByBackendId;
    if (!chosen) {
      chosen = await startNewPcpSession();
      createdNewPcpSession = Boolean(chosen?.id);
    }

    if (chosen?.id) {
      await persistBackendSessionLink({
        pcpSessionId: chosen.id,
        backendSessionId: overrideBackendSessionId,
        backend,
        agentId,
        studioId,
        identityId,
        email,
      });
      sbDebugLog('claude', 'ensure_context_override_linked', {
        backend,
        agentId,
        pcpSessionId: chosen.id,
        backendSessionId: overrideBackendSessionId,
        createdNewPcpSession,
      });
      return {
        pcpSessionId: chosen.id,
        ...(chosen.threadKey ? { threadKey: chosen.threadKey } : {}),
      };
    }

    sbDebugLog('claude', 'ensure_context_override_link_failed', {
      backend,
      agentId,
      backendSessionId: overrideBackendSessionId,
    });
    return {};
  }

  const localBySessionId = new Map(
    localBackendSessions.map((session) => [session.sessionId, session])
  );
  if (options.listCandidates || options.listCandidatesJson) {
    const pcpCandidates = activeSessions.map((session) => {
      const linkedBackendSessionId =
        getSessionBackendId(session) || runtimeBackendSessionIdByPcpSessionId.get(session.id);
      const linkedLocalSession = linkedBackendSessionId
        ? localBySessionId.get(linkedBackendSessionId)
        : undefined;
      const linkedPreviewText = withSessionFileSize(
        withAgentPreviewSpeaker(
          linkedLocalSession?.latestPrompt || linkedLocalSession?.firstPrompt,
          session.agentId || agentId
        ),
        linkedLocalSession?.fileSizeBytes
      );
      const ownerAgentId = session.agentId || null;
      const sortTimestamp = linkedLocalSession?.latestPromptAt || linkedLocalSession?.modified;
      const sortMs = toEpochMs(sortTimestamp || session.startedAt) ?? 0;
      return {
        type: 'pcp' as const,
        id: session.id,
        ownerAgentId,
        threadKey: session.threadKey || null,
        phase: getSessionPhaseLabel(session) || null,
        contextPreview: session.context || null,
        startedAt: session.startedAt || null,
        backendSessionId: linkedBackendSessionId || null,
        linkedLocalModified:
          linkedLocalSession?.latestPromptAt || linkedLocalSession?.modified || null,
        linkedLocalPreview: linkedPreviewText || null,
        linkedLocalFileSizeBytes: linkedLocalSession?.fileSizeBytes || null,
        linkedLocalFileSize: formatFileSize(linkedLocalSession?.fileSizeBytes) || null,
        pcpPreview: pcpPreviewBySessionId.get(session.id) || null,
        sortMs,
      };
    });
    const localCandidates = displayLocalBackendSessions.map((session) => {
      const linkedPcpSession = pcpSessionByBackendSessionId.get(session.sessionId);
      const preview = withSessionFileSize(
        withAgentPreviewSpeaker(
          session.latestPrompt || session.firstPrompt,
          linkedPcpSession?.agentId || agentId
        ),
        session.fileSizeBytes
      );
      const sortMs = toEpochMs(session.latestPromptAt || session.modified) ?? 0;
      return {
        type: 'local' as const,
        id: session.sessionId,
        modified: session.latestPromptAt || session.modified,
        preview: preview || null,
        fileSizeBytes: session.fileSizeBytes || null,
        fileSize: formatFileSize(session.fileSizeBytes) || null,
        gitBranch: session.gitBranch || null,
        linkedPcpSessionId: linkedPcpSession?.id || null,
        linkedPcpAgentId: linkedPcpSession?.agentId || null,
        linkedPcpPhase: linkedPcpSession ? getSessionPhaseLabel(linkedPcpSession) || null : null,
        selectable: !linkedPcpSession,
        sortMs,
      };
    });
    const interleavedCandidates = sortSessionEntriesByRecency([
      ...pcpCandidates.map((candidate) => ({
        key: `pcp:${candidate.id}`,
        kind: 'pcp' as const,
        sortMs: candidate.sortMs,
        candidate,
      })),
      ...localCandidates.map((candidate) => ({
        key: `local:${candidate.id}`,
        kind: 'local' as const,
        sortMs: candidate.sortMs,
        candidate,
      })),
    ]);

    if (options.listCandidatesJson) {
      console.log(
        JSON.stringify(
          {
            backend,
            agentId,
            cwd,
            pcpAvailable,
            pcpUnavailableReason: pcpUnavailableReason || null,
            limits: {
              local: localSessionLimit,
              pcp: pcpSessionLimit,
            },
            counts: {
              pcp: pcpCandidates.length,
              local: localCandidates.length,
              localSelectable: localCandidates.filter((candidate) => candidate.selectable).length,
            },
            candidates: [
              { type: 'new' as const },
              ...interleavedCandidates.map((entry) => entry.candidate),
            ],
          },
          null,
          2
        )
      );
    } else {
      console.log(chalk.bold(`\nSession candidates for ${agentId}/${backend}:`));
      const backendLabel = backend[0].toUpperCase() + backend.slice(1);
      const rows: SessionCandidateTableRow[] = [
        {
          type: 'new',
          choice: 'new',
          updated: '-',
          phase: '-',
          thread: '-',
          link: '-',
          preview: pcpAvailable ? 'Start new session' : 'Start new backend session',
        },
        ...interleavedCandidates.map((entry) => {
          if (entry.kind === 'pcp') {
            const session = entry.candidate;
            const showOwner = Boolean(session.ownerAgentId && session.ownerAgentId !== agentId);
            const ownerPhase = showOwner
              ? `${session.ownerAgentId} · ${session.phase || '-'}`
              : session.phase || '-';
            return {
              type: showOwner ? `pcp:${session.ownerAgentId}` : 'pcp',
              choice: `pcp:${session.id.slice(0, 8)}`,
              updated: formatCandidateTimestamp(session.linkedLocalModified || session.startedAt),
              phase: ownerPhase,
              thread: session.threadKey || '-',
              link: session.backendSessionId
                ? `${backendLabel} ${session.backendSessionId.slice(0, 8)}`
                : '-',
              preview:
                session.linkedLocalPreview || session.pcpPreview || session.contextPreview || '-',
            };
          }
          const localSession = entry.candidate;
          const showOwner = Boolean(
            localSession.linkedPcpAgentId && localSession.linkedPcpAgentId !== agentId
          );
          const ownerPhase = showOwner
            ? `${localSession.linkedPcpAgentId} · ${localSession.linkedPcpPhase || '-'}`
            : localSession.linkedPcpPhase || '-';
          return {
            type: localSession.linkedPcpSessionId
              ? showOwner
                ? `local:${localSession.linkedPcpAgentId}`
                : 'local+pcp'
              : 'local',
            choice: `local:${localSession.id.slice(0, 8)}`,
            updated: formatCandidateTimestamp(localSession.modified),
            phase: ownerPhase,
            thread: '-',
            link: localSession.linkedPcpSessionId
              ? `pcp:${localSession.linkedPcpSessionId.slice(0, 8)}`
              : localSession.gitBranch || '-',
            preview: localSession.preview || '-',
          };
        }),
      ];
      const [header, divider, ...body] = renderSessionCandidatesTable(rows);
      if (header) console.log(chalk.bold(`  ${header}`));
      if (divider) console.log(chalk.dim(`  ${divider}`));
      for (const line of body) {
        console.log(chalk.dim(`  ${line}`));
      }
      const selectableLocals = localCandidates.filter((candidate) => candidate.selectable).length;
      console.log(
        chalk.dim(
          `\n  Local sessions: ${localCandidates.length} (${selectableLocals} selectable, ${localCandidates.length - selectableLocals} already linked to PCP)`
        )
      );
      console.log('');
    }
    if (!normalizedSelectionOverride) {
      process.exit(0);
    }
  }

  if (normalizedSelectionOverride) {
    const selection = normalizedSelectionOverride.toLowerCase();
    if (selection === 'new' || selection === '__new__') {
      chosen = await startNewPcpSession();
      createdNewPcpSession = Boolean(chosen?.id);
    } else if (selection.startsWith('pcp:') || selection.startsWith('__pcp__:')) {
      const matchedSessionId = pcpSelection(selection);
      chosen = activeSessions.find((session) => session.id === matchedSessionId);
    } else if (selection.startsWith('local:') || selection.startsWith('__local__:')) {
      selectedLocalBackendSessionId = localSelection(selection);
      if (selectedLocalBackendSessionId && pcpAvailable) {
        // Find-or-link: prefer an existing PCP session linked to this backend
        // session, then try an unlinked PCP session in the same studio, and
        // only create new as a last resort.
        const linkedPcpSession = pcpSessionByBackendSessionId.get(selectedLocalBackendSessionId);
        if (linkedPcpSession) {
          chosen = linkedPcpSession;
        } else {
          // Try to find an unlinked PCP session for this agent+studio that
          // can be adopted instead of creating an orphan.
          const unlinkable = activeSessions.find(
            (s) =>
              !getSessionBackendId(s) &&
              s.backend === backend &&
              (!studioId || s.studioId === studioId)
          );
          if (unlinkable) {
            chosen = unlinkable;
            sbDebugLog('claude', 'adopting_unlinked_pcp_session', {
              backend,
              agentId,
              pcpSessionId: unlinkable.id,
              selectedLocalBackendSessionId,
            });
          } else {
            chosen = await startNewPcpSession();
            createdNewPcpSession = Boolean(chosen?.id);
          }
        }
      }
    } else {
      console.error(
        chalk.red(
          `Unknown session choice "${options.selectionOverride}". Use "new", "pcp:<id>", or "local:<id>".`
        )
      );
      process.exit(1);
    }
  } else if (process.stdin.isTTY) {
    const choices: Array<{ name: string; value: string }> = [
      {
        name: pcpAvailable ? 'Start new session' : 'Start new backend session',
        value: '__new__',
      },
    ];

    const choiceEntries: Array<{
      key: string;
      sortMs: number;
      value: string;
      label: string;
      sessionId: string;
    }> = [];

    for (const session of activeSessions) {
      const value = `__pcp__:${session.id}`;
      const linkedBackendSessionId =
        getSessionBackendId(session) || runtimeBackendSessionIdByPcpSessionId.get(session.id);
      const linkedLocalSession = linkedBackendSessionId
        ? localBySessionId.get(linkedBackendSessionId)
        : undefined;
      const linkedPreviewText = withAgentPreviewSpeaker(
        linkedLocalSession?.latestPrompt || linkedLocalSession?.firstPrompt,
        session.agentId || agentId
      );
      const linkedPreviewWithSize = withSessionFileSize(
        linkedPreviewText,
        linkedLocalSession?.fileSizeBytes
      );
      const linkedAt = linkedLocalSession?.latestPromptAt || linkedLocalSession?.modified;
      const backendLabel = backend[0].toUpperCase() + backend.slice(1);
      const ownerLabel = session.agentId || null;
      const showOwner = Boolean(ownerLabel && ownerLabel !== agentId);
      const sourceLabel = showOwner ? `PCP/${ownerLabel}` : 'PCP';
      const preview = pcpPreviewBySessionId.get(session.id);
      const phaseLabel = getSessionPhaseLabel(session);
      const pickerPreview = linkedPreviewWithSize || preview || session.context || undefined;
      const branchLabel =
        linkedLocalSession?.gitBranch ||
        runtimeBranchByPcpSessionId.get(session.id) ||
        session.studio?.branch ||
        '-';
      const stateTokens = [
        showOwner ? ownerLabel : null,
        phaseLabel || 'runtime:active',
        session.threadKey ? `thread ${truncateText(session.threadKey, 20)}` : null,
        linkedBackendSessionId ? `${backendLabel} ${linkedBackendSessionId.slice(0, 8)}` : null,
      ].filter(Boolean) as string[];
      choiceEntries.push({
        key: value,
        sortMs: toEpochMs(linkedAt || session.startedAt) ?? 0,
        value,
        sessionId: session.id,
        label: buildSessionPickerLabel({
          metaLine: buildPickerMetaLine({
            source: sourceLabel,
            id: session.id.slice(0, 8),
            when: formatPickerTimestamp(linkedAt || session.startedAt),
            state: stateTokens.join(' · '),
            branch: pickerPreview || branchLabel,
          }),
        }),
      });
    }

    for (const localSession of displayLocalBackendSessions) {
      const value = `__local__:${localSession.sessionId}`;
      const previewAt = localSession.latestPromptAt || localSession.modified;
      const backendLabel = localSession.backend[0].toUpperCase() + localSession.backend.slice(1);
      const linkedPcpSession = pcpSessionByBackendSessionId.get(localSession.sessionId);
      const ownerLabel = linkedPcpSession?.agentId || null;
      const showOwner = Boolean(ownerLabel && ownerLabel !== agentId);
      const previewText = withSessionFileSize(
        withAgentPreviewSpeaker(
          localSession.latestPrompt || localSession.firstPrompt,
          ownerLabel || agentId
        ),
        localSession.fileSizeBytes
      );
      const sourceLabel = showOwner ? `${backendLabel}/${ownerLabel}` : backendLabel;
      const stateLabel = linkedPcpSession
        ? showOwner
          ? `${ownerLabel} · linked pcp:${linkedPcpSession.id.slice(0, 8)}`
          : `linked pcp:${linkedPcpSession.id.slice(0, 8)}`
        : 'local';
      choiceEntries.push({
        key: value,
        sortMs: toEpochMs(previewAt) ?? 0,
        value,
        sessionId: localSession.sessionId,
        label: buildSessionPickerLabel({
          metaLine: buildPickerMetaLine({
            source: sourceLabel,
            id: localSession.sessionId.slice(0, 8),
            when: formatPickerTimestamp(previewAt),
            state: stateLabel,
            branch: previewText || localSession.gitBranch || '-',
          }),
        }),
      });
    }

    sortSessionEntriesByRecency(choiceEntries).forEach((entry) => {
      choices.push({ name: entry.label, value: entry.value });
      sessionChoiceByValue.set(entry.value, entry.sessionId);
    });

    try {
      const { select } = await import('@inquirer/prompts');
      const pageSize = Math.max(12, Math.min(30, (process.stdout.rows || 28) - 6));
      const selection = await select({
        message: `Session for ${agentId}/${backend}`,
        choices,
        pageSize,
      });
      if (selection === '__new__') {
        chosen = await startNewPcpSession();
        createdNewPcpSession = Boolean(chosen?.id);
      } else if (selection.startsWith('__pcp__:')) {
        const sessionId = sessionChoiceByValue.get(selection);
        chosen = activeSessions.find((session) => session.id === sessionId);
      } else if (selection.startsWith('__local__:')) {
        selectedLocalBackendSessionId = sessionChoiceByValue.get(selection);
        if (selectedLocalBackendSessionId && pcpAvailable) {
          // Find-or-link: prefer linked PCP session, then adopt unlinked, then create new
          const linkedPcpSession = pcpSessionByBackendSessionId.get(selectedLocalBackendSessionId);
          if (linkedPcpSession) {
            chosen = linkedPcpSession;
          } else {
            const unlinkable = activeSessions.find(
              (s) =>
                !getSessionBackendId(s) &&
                s.backend === backend &&
                (!studioId || s.studioId === studioId)
            );
            if (unlinkable) {
              chosen = unlinkable;
              sbDebugLog('claude', 'adopting_unlinked_pcp_session', {
                backend,
                agentId,
                pcpSessionId: unlinkable.id,
                selectedLocalBackendSessionId,
              });
            } else {
              chosen = await startNewPcpSession();
              createdNewPcpSession = Boolean(chosen?.id);
            }
          }
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
    createdNewPcpSession = Boolean(chosen?.id);
  }

  if (!chosen?.id && !selectedLocalBackendSessionId) return {};

  if (!chosen?.id && selectedLocalBackendSessionId) {
    return { backendSessionId: selectedLocalBackendSessionId };
  }

  if (!chosen?.id) return {};

  const { backendSessionId, staleTrackedBackendSessionId, fallbackMode } =
    resolveBackendSessionIdForResume({
      backend,
      chosen,
      selectedLocalBackendSessionId,
      localBackendSessionIds,
      knownBackendSessionIds,
      runtimeCachedSessionId: chosen?.id
        ? runtimeBackendSessionIdByPcpSessionId.get(chosen.id)
        : undefined,
    });
  // ═══════════════════════════════════════════════════════════════════════
  // BACKEND SESSION LINKING — CRITICAL: Each backend has unique semantics.
  //
  // DO NOT modify this section without understanding how each backend
  // handles session resume, creation, and linking. Careless changes here
  // cause silent data loss (content not loading, orphaned sessions, wrong
  // session resumed). Test each backend independently.
  //
  // - Claude: Always preserves backend session links. Claude Code manages
  //   its own session continuity via --resume/--session-id.
  // - Codex: Sessions are independent local files. PCP links are advisory.
  //   Drops pre-linked sessions on new PCP session to avoid stale links,
  //   UNLESS the user explicitly selected a local session from the picker.
  // - Gemini: Session semantics are different and largely untested for
  //   this path. Do NOT assume Codex patterns apply to Gemini.
  // ═══════════════════════════════════════════════════════════════════════
  const preserveTrackedBackendSessionId = !createdNewPcpSession || backend === 'claude';
  let resolvedTrackedBackendSessionId = preserveTrackedBackendSessionId
    ? backendSessionId
    : undefined;
  if (
    createdNewPcpSession &&
    backend === 'codex' &&
    backendSessionId &&
    !selectedLocalBackendSessionId
  ) {
    // Only ignore pre-linked backend sessions when the user didn't explicitly
    // select a local session. If they picked a specific Codex session
    // from the list, they want to resume it.
    sbDebugLog('claude', 'new_session_ignoring_prelinked_backend_session', {
      backend,
      agentId,
      pcpSessionId: chosen.id,
      ignoredBackendSessionId: backendSessionId,
    });
  }
  // When the user explicitly picked a local backend session from the picker,
  // use it as the resume target even if we created a new PCP session.
  if (!resolvedTrackedBackendSessionId && selectedLocalBackendSessionId) {
    resolvedTrackedBackendSessionId = selectedLocalBackendSessionId;
    sbDebugLog('claude', 'using_selected_local_backend_session', {
      backend,
      agentId,
      selectedLocalBackendSessionId,
      createdNewPcpSession,
    });
  }
  const adoptedLocalBackendSessionId = resolveAdoptableLocalBackendSessionId({
    backend,
    backendSessionId: resolvedTrackedBackendSessionId,
    selectedLocalBackendSessionId,
    createdNewPcpSession,
    chosen,
    localSessions: untrackedLocalBackendSessions,
  });
  const effectiveBackendSessionId = resolvedTrackedBackendSessionId || adoptedLocalBackendSessionId;
  const backendSessionSeedId = resolveBackendSessionSeedId({
    backend,
    chosenSessionId: chosen.id,
    backendSessionId: effectiveBackendSessionId,
    createdNewPcpSession,
  });

  if (staleTrackedBackendSessionId && process.stdin.isTTY) {
    if (fallbackMode === 'resume_pcp_session_id' && chosen.id) {
      console.log(
        chalk.yellow(
          `\nLinked Claude session ${staleTrackedBackendSessionId.slice(0, 8)} is unavailable for this project; retrying with PCP-linked Claude session ${chosen.id.slice(0, 8)}.`
        )
      );
    } else {
      const backendLabel = backend[0].toUpperCase() + backend.slice(1);
      console.log(
        chalk.yellow(
          `\nLinked ${backendLabel} session ${staleTrackedBackendSessionId.slice(0, 8)} is unavailable for this project; starting backend fresh.`
        )
      );
    }
  }

  upsertRuntimeSession(cwd, {
    pcpSessionId: chosen.id,
    backend,
    agentId,
    ...(identityId ? { identityId } : {}),
    ...(studioId ? { studioId } : {}),
    ...(chosen.threadKey ? { threadKey: chosen.threadKey } : {}),
    ...(effectiveBackendSessionId ? { backendSessionId: effectiveBackendSessionId } : {}),
    ...(currentGitBranch ? { gitBranch: currentGitBranch } : {}),
    startedAt: chosen.startedAt,
  });
  setCurrentRuntimeSession(cwd, chosen.id, backend, {
    agentId,
    ...(identityId ? { identityId } : {}),
    ...(studioId ? { studioId } : {}),
  });

  if (verbose) {
    console.log(chalk.dim(`PCP session: ${chosen.id}`));
    if (effectiveBackendSessionId) {
      console.log(chalk.dim(`Backend session: ${effectiveBackendSessionId}`));
    }
  }

  if (email) {
    try {
      await callPcpTool('update_session_phase', {
        email,
        agentId,
        sessionId: chosen.id,
        ...(effectiveBackendSessionId ? { backendSessionId: effectiveBackendSessionId } : {}),
        status: 'active',
        workingDir: cwd,
      });
    } catch {
      // Best-effort only.
    }
  }

  sbDebugLog('claude', 'ensure_context_result', {
    backend,
    agentId,
    pcpSessionId: chosen.id,
    backendSessionId: effectiveBackendSessionId || null,
    backendSessionSeedId: backendSessionSeedId || null,
    createdNewPcpSession,
    selectedLocalBackendSessionId: selectedLocalBackendSessionId || null,
    threadKey: chosen.threadKey || null,
  });

  return {
    pcpSessionId: chosen.id,
    backendSessionId: effectiveBackendSessionId,
    ...(backendSessionSeedId ? { backendSessionSeedId } : {}),
    ...(chosen.threadKey ? { threadKey: chosen.threadKey } : {}),
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
        promptParts,
        {
          listCandidates: options.sessionCandidates || options.sessionCandidatesJson,
          listCandidatesJson: options.sessionCandidatesJson,
          listCandidatesAll: options.sessionCandidatesAll,
          selectionOverride: options.sessionChoice,
        }
      )
    : {};
  const runtimeLinkId = options.session ? randomUUID() : undefined;
  const currentGitBranch = getCurrentGitBranch(process.cwd());
  const { studioId, identityId } = await resolveStudioId(process.cwd());

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
      ...(currentGitBranch ? { gitBranch: currentGitBranch } : {}),
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

  const authEnv = await resolvePcpAuthEnv(options.verbose);
  const pcpConfig = getPcpConfig();
  const startupContextBlock = await resolveCodexStartupContextBlock({
    backend: options.backend,
    agentId,
    pcpConfig,
    hasAuthToken: Boolean(authEnv.PCP_ACCESS_TOKEN || process.env.PCP_ACCESS_TOKEN),
    verbose: options.verbose,
    pcpSessionId: sessionContext.pcpSessionId,
  });

  const prepared = adapter.prepare({
    agentId,
    model: options.model,
    prompt,
    promptParts,
    passthroughArgs,
    ...(startupContextBlock ? { startupContextBlock } : {}),
    ...sessionContext,
    ...(studioId ? { studioId } : {}),
    ...(options.dangerous ? { dangerous: true } : {}),
  });

  if (options.verbose) {
    console.log(chalk.dim(`Running: ${prepared.binary} ${prepared.args.join(' ')}`));
  }

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
    threadKey: sessionContext.threadKey,
    cwd: process.cwd(),
    mode: 'prompt',
    retryAttempt: 1,
    maxAttempts: 1,
  };
  const executionStartedAt = Date.now();
  const backendStartActivityId = await logBackendExecutionStart(executionContext);
  const knownLocalSessionSnapshot = options.session
    ? new Map(
        getBackendLocalSessionsForProject(options.backend, process.cwd(), 50).map((session) => [
          session.sessionId,
          session.modified,
        ])
      )
    : undefined;
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
      // PCP_AUTH_BEARER: full "Bearer <token>" for Codex env_http_headers
      ...(authEnv.PCP_ACCESS_TOKEN
        ? { PCP_AUTH_BEARER: `Bearer ${authEnv.PCP_ACCESS_TOKEN}` }
        : {}),
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
    if (!capturedBackendSessionId) {
      capturedBackendSessionId = await resolveCapturedBackendSessionIdWithRetry({
        backend: options.backend,
        pcpSessionId: sessionContext.pcpSessionId,
        runtimeLinkId,
        agentId,
        studioId,
        knownLocalSessionSnapshot,
        fallbackBackendSessionId: capturedBackendSessionId,
      });
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
    ? await ensurePcpSessionContext(
        agentId,
        options.backend,
        passthroughArgs,
        options.verbose,
        [],
        {
          listCandidates: options.sessionCandidates || options.sessionCandidatesJson,
          listCandidatesJson: options.sessionCandidatesJson,
          listCandidatesAll: options.sessionCandidatesAll,
          selectionOverride: options.sessionChoice,
        }
      )
    : {};
  const runtimeLinkId = options.session ? randomUUID() : undefined;
  const currentGitBranch = getCurrentGitBranch(process.cwd());
  const { studioId, identityId } = await resolveStudioId(process.cwd());

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
      ...(currentGitBranch ? { gitBranch: currentGitBranch } : {}),
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

  const authEnv = await resolvePcpAuthEnv(options.verbose);
  const pcpConfig = getPcpConfig();
  const startupContextBlock = await resolveCodexStartupContextBlock({
    backend: options.backend,
    agentId,
    pcpConfig,
    hasAuthToken: Boolean(authEnv.PCP_ACCESS_TOKEN || process.env.PCP_ACCESS_TOKEN),
    verbose: options.verbose,
    pcpSessionId: sessionContext.pcpSessionId,
  });
  const knownLocalSessionSnapshot = options.session
    ? new Map(
        getBackendLocalSessionsForProject(options.backend, process.cwd(), 50).map((session) => [
          session.sessionId,
          session.modified,
        ])
      )
    : undefined;
  const maxAttempts = sessionContext.backendSessionId ? 2 : 1;
  let attempt = 1;
  let attemptBackendSessionId = sessionContext.backendSessionId;
  let attemptBackendSessionSeedId = sessionContext.backendSessionSeedId;
  let finalCapturedBackendSessionId = sessionContext.backendSessionId;

  const runAttempt = async (): Promise<{ code: number | null; stderrText: string }> => {
    const prepared = adapter.prepare({
      agentId,
      model: options.model,
      promptParts: [],
      passthroughArgs,
      ...(startupContextBlock ? { startupContextBlock } : {}),
      ...sessionContext,
      ...(attemptBackendSessionId ? { backendSessionId: attemptBackendSessionId } : {}),
      ...(attemptBackendSessionSeedId ? { backendSessionSeedId: attemptBackendSessionSeedId } : {}),
      ...(studioId ? { studioId } : {}),
      ...(options.dangerous ? { dangerous: true } : {}),
    });

    if (options.verbose) {
      console.log(chalk.dim(`Running: ${prepared.binary} ${prepared.args.join(' ')}`));
    }

    const executionContext: BackendExecutionLogContext = {
      pcpConfig,
      agentId,
      backend: options.backend,
      binary: prepared.binary,
      args: prepared.args,
      pcpSessionId: sessionContext.pcpSessionId,
      backendSessionId: attemptBackendSessionId,
      studioId,
      runtimeLinkId,
      threadKey: sessionContext.threadKey,
      cwd: process.cwd(),
      mode: 'interactive',
      retryAttempt: attempt,
      maxAttempts,
    };
    const executionStartedAt = Date.now();
    const backendStartActivityId = await logBackendExecutionStart(executionContext);

    return await new Promise<{ code: number | null; stderrText: string }>((resolve) => {
      let stderrText = '';

      const child = spawn(prepared.binary, prepared.args, {
        stdio: ['inherit', 'inherit', 'pipe'],
        env: {
          ...process.env,
          ...authEnv,
          ...prepared.env,
          ...(runtimeLinkId ? { PCP_RUNTIME_LINK_ID: runtimeLinkId } : {}),
        },
      });

      child.stderr?.on('data', (chunk) => {
        const text = chunk.toString();
        stderrText += text;
        process.stderr.write(chunk);
      });

      child.on('close', async (code) => {
        prepared.cleanup();
        finalCapturedBackendSessionId = await resolveCapturedBackendSessionIdWithRetry({
          backend: options.backend,
          pcpSessionId: sessionContext.pcpSessionId,
          runtimeLinkId,
          agentId,
          studioId,
          knownLocalSessionSnapshot,
          fallbackBackendSessionId: finalCapturedBackendSessionId,
        });

        await logBackendExecutionResult({
          context: executionContext,
          parentActivityId: backendStartActivityId,
          exitCode: code ?? null,
          durationMs: Date.now() - executionStartedAt,
          backendSessionId: finalCapturedBackendSessionId,
        });
        resolve({ code: code ?? null, stderrText });
      });

      child.on('error', async (err) => {
        prepared.cleanup();
        const errorText = err.message || 'spawn failed';
        await logBackendExecutionResult({
          context: executionContext,
          parentActivityId: backendStartActivityId,
          exitCode: null,
          durationMs: Date.now() - executionStartedAt,
          error: errorText,
          backendSessionId: finalCapturedBackendSessionId,
        });
        resolve({ code: 1, stderrText: `${stderrText}\n${errorText}`.trim() });
      });
    });
  };

  while (true) {
    const { code, stderrText } = await runAttempt();
    const shouldRetry =
      attempt < maxAttempts &&
      shouldRetryWithFreshBackendSession({
        backend: options.backend,
        attemptedBackendSessionId: attemptBackendSessionId,
        stderrText,
      });

    if (shouldRetry) {
      if (attemptBackendSessionId) {
        console.log(
          chalk.yellow(
            `\nLinked Claude session ${attemptBackendSessionId.slice(0, 8)} failed to resume; retrying once with a fresh backend session.`
          )
        );
      }
      attempt += 1;
      attemptBackendSessionId = undefined;
      attemptBackendSessionSeedId = undefined;
      continue;
    }

    await persistBackendSessionLink({
      pcpSessionId: sessionContext.pcpSessionId,
      backendSessionId: finalCapturedBackendSessionId,
      backend: options.backend,
      agentId,
      runtimeLinkId,
      studioId,
      identityId,
      email: pcpConfig?.email,
    });

    process.exit(code || 0);
  }
}
