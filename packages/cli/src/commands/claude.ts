/**
 * Backend Runner
 *
 * Spawns the selected AI CLI backend with identity injection,
 * passthrough flags, and session tracking.
 */

import { spawn, spawnSync } from 'child_process';
import chalk from 'chalk';
import { randomUUID } from 'crypto';
import { type Dirent, existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'fs';
import { join, resolve as resolvePath } from 'path';
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
  sessionChoice?: string;
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
  studioId?: string | null;
  threadKey?: string | null;
  currentPhase?: string | null;
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

function toEpochMs(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : undefined;
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
  if (status === 'completed') return false;

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

function buildInjectedStartupContext(bootstrap: BootstrapContextResult): string {
  const sections: string[] = [
    '_Generated by `sb` at session start from PCP `bootstrap`._',
    '_Use this as startup context; if stale, call `mcp__pcp__bootstrap` manually._',
  ];

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

    const startupContextBlock = buildInjectedStartupContext(bootstrap);
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

function withAgentPreviewSpeaker(preview: string | undefined, agentId: string): string | undefined {
  if (!preview) return undefined;
  if (/^assistant:\s*/i.test(preview)) {
    return `${agentId}: ${preview.replace(/^assistant:\s*/i, '')}`;
  }
  return preview;
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
      const content = extractMessageText(payload.content);
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
        const content = extractMessageText(payload.message);
        if (content) latest = { role: 'user', content, ts };
      } else if (payload.type === 'agent_message') {
        const content = extractMessageText(payload.message);
        if (content) latest = { role: 'assistant', content, ts };
      }
    }
  }
  return latest;
}

function extractLatestPreviewFromPcpTranscriptJsonl(
  jsonl: string
): SessionPreviewSummary | undefined {
  const events = parseJsonl(jsonl);
  let latest: SessionPreviewSummary | undefined;
  for (const event of events) {
    const type = typeof event.type === 'string' ? event.type : '';
    if (type === 'user') {
      const content = extractMessageText(event.content);
      if (!content) continue;
      latest = {
        role: 'user',
        content,
        ts: typeof event.ts === 'string' ? event.ts : undefined,
      };
      continue;
    }
    if (type === 'assistant') {
      const content = extractMessageText(event.content);
      if (!content) continue;
      latest = {
        role: 'assistant',
        content,
        ts: typeof event.ts === 'string' ? event.ts : undefined,
      };
      continue;
    }
    if (type === 'inbox') {
      const content = extractMessageText(event.rendered) || extractMessageText(event.content);
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

function findLatestPcpReplTranscriptForSession(
  sessionId: string,
  cwd = process.cwd()
): string | undefined {
  const dir = join(cwd, '.pcp', 'runtime', 'repl');
  if (!existsSync(dir)) return undefined;
  const prefix = `${sessionId}-`;
  const candidates = readdirSync(dir)
    .filter((entry) => entry.startsWith(prefix) && entry.endsWith('.jsonl'))
    .map((entry) => join(dir, entry))
    .filter((fullPath) => {
      try {
        return statSync(fullPath).isFile();
      } catch {
        return false;
      }
    })
    .sort((a, b) => {
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
  agentId: string,
  cwd = process.cwd()
): string | undefined {
  const transcriptPath = findLatestPcpReplTranscriptForSession(session.id, cwd);
  if (!transcriptPath) return undefined;
  try {
    const content = readFileSync(transcriptPath, 'utf-8');
    const summary = extractLatestPreviewFromPcpTranscriptJsonl(content);
    if (!summary) return undefined;
    return formatSessionPreviewText(summary, { assistantLabel: agentId });
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

  const candidate = chosen.backendSessionId || chosen.claudeSessionId || undefined;
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
  knownLocalSessionIds?: Set<string>;
  fallbackBackendSessionId?: string;
}): string | undefined {
  const {
    cwd = process.cwd(),
    backend,
    pcpSessionId,
    runtimeLinkId,
    agentId,
    studioId,
    knownLocalSessionIds,
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

  if (knownLocalSessionIds && knownLocalSessionIds.size > 0) {
    const postRunLocalSessions = getBackendLocalSessionsForProject(backend, cwd, 50);
    const newLocalSession = postRunLocalSessions.find(
      (session) => !knownLocalSessionIds.has(session.sessionId)
    );
    if (newLocalSession?.sessionId) return newLocalSession.sessionId;
  }

  return resolveFromRecord(scopedRecords[0]) || fallbackBackendSessionId;
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
        if (!isLikelyClaudeResumableSessionFile(filePath, sessionId)) {
          continue;
        }

        const stats = statSync(filePath);
        results.push({
          backend: 'claude',
          sessionId,
          projectPath: normalizedCwd,
          modified: stats.mtime.toISOString(),
          transcriptPath: filePath,
        });
      } catch {
        // Ignore unreadable file stats.
      }
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

function isLikelyClaudeResumableSessionFile(filePath: string, sessionId: string): boolean {
  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
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
  limit = 20
): BackendLocalSessionSummary[] {
  const fallbackToJsonl = (reason: string): BackendLocalSessionSummary[] => {
    const fallback = getCodexLocalSessionsFromJsonl(cwd, limit);
    sbDebugLog('backend', 'codex_local_sessions_fallback_jsonl', {
      cwd,
      reason,
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
    if (transcriptPath && existsSync(transcriptPath)) {
      try {
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

    sessions.push({
      backend: 'codex',
      sessionId,
      projectPath: sessionCwd,
      modified,
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
    totalScopedSessions: sessions.length,
    returnedSessions: scoped.length,
    sessionIds: scoped.map((session) => session.sessionId),
  });
  return scoped.length > 0 ? scoped : fallbackToJsonl('sqlite_query_empty');
}

function getCodexLocalSessionsFromJsonl(
  cwd = process.cwd(),
  limit = 20
): BackendLocalSessionSummary[] {
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

      const normalizedSessionCwd = normalizePath(sessionCwd);
      if (!normalizedSessionCwd || normalizedSessionCwd !== normalizedCwd) break;

      matched = {
        backend: 'codex',
        sessionId,
        projectPath: sessionCwd,
        modified: parsed.payload?.timestamp || parsed.timestamp || sessionFile.modified,
        latestPrompt: latestPreview ? formatSessionPreviewText(latestPreview) : undefined,
        latestPromptAt: latestPreview?.ts,
        transcriptPath: sessionFile.path,
      };
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

      const firstUserMessage = (parsed.messages || []).find((message) => message.type === 'user');
      const latestMessage = [...(parsed.messages || [])]
        .reverse()
        .find((message) => Boolean(message?.content?.trim()));
      const firstPrompt =
        parsed.summary ||
        (typeof firstUserMessage?.content === 'string'
          ? firstUserMessage.content.trim()
          : undefined);
      const latestPrompt =
        latestMessage && typeof latestMessage.content === 'string'
          ? formatSessionPreviewText({
              role: latestMessage.type === 'user' ? 'user' : 'assistant',
              content: latestMessage.content,
            })
          : undefined;

      sessions.push({
        backend: 'gemini',
        sessionId: parsed.sessionId,
        projectPath,
        modified,
        firstPrompt,
        latestPrompt,
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
  const isCodexResumePrompt =
    backend === 'codex' &&
    promptParts[0]?.toLowerCase() === 'resume' &&
    Boolean(promptParts[1]) &&
    !promptParts[1]?.startsWith('-');
  const isCodexResumePassthrough =
    backend === 'codex' && passthroughArgs[0]?.toLowerCase() === 'resume';

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
  promptParts: string[] = [],
  options: {
    listCandidates?: boolean;
    listCandidatesJson?: boolean;
    selectionOverride?: string;
  } = {}
): Promise<{
  pcpSessionId?: string;
  backendSessionId?: string;
  backendSessionSeedId?: string;
  threadKey?: string;
}> {
  if (hasBackendSessionOverride(backend, passthroughArgs, promptParts)) return {};

  const config = getPcpConfig();
  const email = config?.email;
  const cwd = process.cwd();
  const { studioId, identityId } = getIdentityContextFromIdentityJson(cwd);
  const localBackendSessions = getBackendLocalSessionsForProject(backend, cwd, 20);
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
        limit: 20,
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
          phase: session.currentPhase || null,
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
  const existingSessionIds = new Set(activeSessions.map((session) => session.id));
  const pcpPreviewBySessionId = new Map<string, string>();
  for (const session of activeSessions) {
    const preview = getPcpSessionPreviewLabel(session, agentId, cwd);
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
    const found = untrackedLocalBackendSessions.find(
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
            limit: 20,
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
                const linkedBackendSessionId = getSessionBackendId(session);
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

  const localBySessionId = new Map(
    localBackendSessions.map((session) => [session.sessionId, session])
  );
  if (options.listCandidates || options.listCandidatesJson) {
    const pcpCandidates = activeSessions.map((session) => {
      const linkedBackendSessionId = getSessionBackendId(session);
      const linkedLocalSession = linkedBackendSessionId
        ? localBySessionId.get(linkedBackendSessionId)
        : undefined;
      return {
        type: 'pcp' as const,
        id: session.id,
        threadKey: session.threadKey || null,
        phase: session.currentPhase || null,
        backendSessionId: linkedBackendSessionId || null,
        linkedLocalModified:
          linkedLocalSession?.latestPromptAt || linkedLocalSession?.modified || null,
        linkedLocalPreview:
          linkedLocalSession?.latestPrompt || linkedLocalSession?.firstPrompt || null,
        pcpPreview: pcpPreviewBySessionId.get(session.id) || null,
      };
    });
    const localCandidates = untrackedLocalBackendSessions.map((session) => ({
      type: 'local' as const,
      id: session.sessionId,
      modified: session.latestPromptAt || session.modified,
      preview:
        withAgentPreviewSpeaker(session.latestPrompt || session.firstPrompt, agentId) || null,
      gitBranch: session.gitBranch || null,
    }));

    if (options.listCandidatesJson) {
      console.log(
        JSON.stringify(
          {
            backend,
            agentId,
            cwd,
            pcpAvailable,
            pcpUnavailableReason: pcpUnavailableReason || null,
            candidates: [{ type: 'new' as const }, ...pcpCandidates, ...localCandidates],
          },
          null,
          2
        )
      );
    } else {
      console.log(chalk.bold(`\nSession candidates for ${agentId}/${backend}:`));
      console.log(chalk.dim('  new'));
      for (const session of pcpCandidates) {
        const backendLabel = backend[0].toUpperCase() + backend.slice(1);
        const linkedPreview = session.linkedLocalPreview
          ? ` — ${truncateText(session.linkedLocalPreview)}`
          : '';
        const linkedWhen = session.linkedLocalModified
          ? ` (${new Date(session.linkedLocalModified).toLocaleString()})`
          : '';
        const pcpPreview = session.pcpPreview ? ` — ${truncateText(session.pcpPreview, 120)}` : '';
        console.log(
          chalk.dim(
            `  pcp:${session.id}${session.threadKey ? ` (${session.threadKey})` : ''}${session.phase ? ` — ${session.phase}` : ''}${session.backendSessionId ? ` · tracks ${backendLabel} ${session.backendSessionId.slice(0, 8)}` : ''}${linkedWhen}${linkedPreview}${pcpPreview}`
          )
        );
      }
      for (const localSession of localCandidates) {
        console.log(
          chalk.dim(
            `  local:${localSession.id}${localSession.preview ? ` — ${truncateText(localSession.preview)}` : ''}`
          )
        );
      }
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
        chosen = await startNewPcpSession();
        createdNewPcpSession = Boolean(chosen?.id);
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

    for (const session of activeSessions) {
      const value = `__pcp__:${session.id}`;
      const linkedBackendSessionId = getSessionBackendId(session);
      const linkedLocalSession = linkedBackendSessionId
        ? localBySessionId.get(linkedBackendSessionId)
        : undefined;
      const linkedPreview = linkedLocalSession?.firstPrompt
        ? ` — ${truncateText(linkedLocalSession.firstPrompt)}`
        : '';
      const linkedWhen = linkedLocalSession?.modified
        ? ` (${new Date(linkedLocalSession.modified).toLocaleString()})`
        : '';
      const backendLabel = backend[0].toUpperCase() + backend.slice(1);
      const preview = pcpPreviewBySessionId.get(session.id);
      choices.push({
        name: `Resume PCP ${session.id.slice(0, 8)}${session.threadKey ? ` (${session.threadKey})` : ''}${session.currentPhase ? ` — ${session.currentPhase}` : ''}${linkedBackendSessionId ? ` · tracks ${backendLabel} ${linkedBackendSessionId.slice(0, 8)}` : ''}${linkedWhen}${linkedPreview}${preview ? ` — ${truncateText(preview, 120)}` : ''}`,
        value,
      });
      sessionChoiceByValue.set(value, session.id);
    }

    for (const localSession of untrackedLocalBackendSessions) {
      const value = `__local__:${localSession.sessionId}`;
      const previewText = withAgentPreviewSpeaker(
        localSession.latestPrompt || localSession.firstPrompt,
        agentId
      );
      const preview = previewText ? ` — ${truncateText(previewText)}` : '';
      const previewAt = localSession.latestPromptAt || localSession.modified;
      const backendLabel = localSession.backend[0].toUpperCase() + localSession.backend.slice(1);
      choices.push({
        name:
          localSession.backend === 'claude'
            ? `Resume Claude local ${localSession.sessionId.slice(0, 8)} (${new Date(previewAt).toLocaleString()})${preview}`
            : `Resume ${backendLabel} local ${localSession.sessionId.slice(0, 8)} (${new Date(previewAt).toLocaleString()})${preview}`,
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
        createdNewPcpSession = Boolean(chosen?.id);
      } else if (selection.startsWith('__pcp__:')) {
        const sessionId = sessionChoiceByValue.get(selection);
        chosen = activeSessions.find((session) => session.id === sessionId);
      } else if (selection.startsWith('__local__:')) {
        selectedLocalBackendSessionId = sessionChoiceByValue.get(selection);
        if (selectedLocalBackendSessionId && pcpAvailable) {
          chosen = await startNewPcpSession();
          createdNewPcpSession = Boolean(chosen?.id);
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
    });
  const preserveTrackedBackendSessionId = !createdNewPcpSession || backend === 'claude';
  const resolvedTrackedBackendSessionId = preserveTrackedBackendSessionId
    ? backendSessionId
    : undefined;
  if (createdNewPcpSession && backend !== 'claude' && backendSessionId) {
    sbDebugLog('claude', 'new_session_ignoring_prelinked_backend_session', {
      backend,
      agentId,
      pcpSessionId: chosen.id,
      ignoredBackendSessionId: backendSessionId,
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
          selectionOverride: options.sessionChoice,
        }
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
  const knownLocalSessionIds = options.session
    ? new Set(
        getBackendLocalSessionsForProject(options.backend, process.cwd(), 50).map(
          (session) => session.sessionId
        )
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
      capturedBackendSessionId = resolveCapturedBackendSessionIdFromRuntime({
        backend: options.backend,
        pcpSessionId: sessionContext.pcpSessionId,
        runtimeLinkId,
        agentId,
        studioId,
        knownLocalSessionIds,
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
          selectionOverride: options.sessionChoice,
        }
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
  const knownLocalSessionIds = options.session
    ? new Set(
        getBackendLocalSessionsForProject(options.backend, process.cwd(), 50).map(
          (session) => session.sessionId
        )
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
        finalCapturedBackendSessionId = resolveCapturedBackendSessionIdFromRuntime({
          backend: options.backend,
          pcpSessionId: sessionContext.pcpSessionId,
          runtimeLinkId,
          agentId,
          studioId,
          knownLocalSessionIds,
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
