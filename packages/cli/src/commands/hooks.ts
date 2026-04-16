/**
 * Hooks Commands
 *
 * Bridge CLI coding agents (Claude Code, Codex, Gemini) with Inkwell's
 * session/memory/inbox system via lifecycle hooks.
 *
 * Commands:
 *   hooks install     Install Inkwell hooks into the detected backend
 *   hooks uninstall   Remove Inkwell-managed hooks
 *   hooks status      Show installed hook status
 *   hooks pre-compact         Hook: pre-compaction reminder
 *   hooks post-compact        Hook: post-compaction bootstrap
 *   hooks on-session-start    Hook: session start bootstrap
 *   hooks on-tool-approval    Hook: 2FA approval check (PreToolUse)
 *   hooks on-prompt           Hook: periodic inbox check
 *   hooks on-stop             Hook: session nudge + inbox check
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { homedir } from 'os';
import { createHash } from 'crypto';
import { resolveAgentId, readIdentityJson, readRoleMd } from '../backends/identity.js';
import { getValidAccessToken, getValidDelegatedAccessToken } from '../auth/tokens.js';
import {
  findRuntimeSessionByLinkId,
  getCurrentRuntimeSession,
  listRuntimeSessions,
  setCurrentRuntimeSession,
  upsertRuntimeSession,
} from '../session/runtime.js';
import { sbDebugLog } from '../lib/sb-debug.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ─── Hook Logger ─────────────────────────────────────────────────────
// Always-on structured logging for hook lifecycle events.
// Writes to ~/.ink/logs/hooks.log — not gated by SB_DEBUG.
// Hooks run as short-lived subprocesses, so we append synchronously.
const HOOK_LOG_DIR = join(homedir(), '.ink', 'logs');
const HOOK_LOG_FILE = join(HOOK_LOG_DIR, 'hooks.log');
let hookLogDirCreated = false;

function hookLog(event: string, data?: Record<string, unknown>): void {
  try {
    if (!hookLogDirCreated) {
      mkdirSync(HOOK_LOG_DIR, { recursive: true });
      hookLogDirCreated = true;
    }
    const record = {
      ts: new Date().toISOString(),
      pid: process.pid,
      event,
      cwd: process.cwd(),
      ...data,
    };
    appendFileSync(HOOK_LOG_FILE, JSON.stringify(record) + '\n');
  } catch {
    // Never fail the hook because logging failed
  }
}

// ============================================================================
// Types
// ============================================================================

interface HookCapabilities {
  name: string;
  configPath: string;
  configFormat: 'json' | 'toml';
  events: {
    sessionStart: string | null;
    preCompact: string | null;
    postCompact: string | null;
    onPrompt: string | null;
    onStop: string | null;
  };
  supportsCompaction: boolean;
  supportsPromptHook: boolean;
}

const CLAUDE_CODE: HookCapabilities = {
  name: 'claude-code',
  configPath: '.claude/settings.local.json',
  configFormat: 'json',
  events: {
    sessionStart: 'SessionStart',
    preCompact: 'PreCompact',
    postCompact: 'SessionStart', // uses "compact" matcher on SessionStart
    onPrompt: 'UserPromptSubmit',
    onStop: 'Stop',
  },
  supportsCompaction: true,
  supportsPromptHook: true,
};

const CODEX: HookCapabilities = {
  name: 'codex',
  configPath: '.codex/config.toml',
  configFormat: 'toml',
  events: {
    sessionStart: 'session_start',
    preCompact: null,
    postCompact: null,
    onPrompt: 'user_prompt',
    onStop: 'session_end',
  },
  supportsCompaction: false,
  supportsPromptHook: true,
};

const GEMINI: HookCapabilities = {
  name: 'gemini',
  configPath: '.gemini/settings.json',
  configFormat: 'json',
  events: {
    sessionStart: 'SessionStart',
    // PreCompress/postCompact disabled: Gemini fires PreCompress but has no
    // post-compression SessionStart event (SessionStartSource only has
    // 'startup'/'resume'/'clear' — no 'compress'). The "compress" matcher
    // on SessionStart is dead code and lifecycle gets stuck at 'compacting'.
    preCompact: null,
    postCompact: null,
    onPrompt: 'BeforeAgent',
    onStop: 'AfterAgent',
  },
  supportsCompaction: false,
  supportsPromptHook: true,
};

interface PcpConfig {
  userId?: string;
  email?: string;
}

// ============================================================================
// Backend Detection
// ============================================================================

function detectBackend(cwd: string): HookCapabilities {
  // 1. Check .ink/identity.json for explicit backend
  const identity = readIdentityJson(cwd);
  if (identity?.backend) {
    const fromIdentity = getBackendByName(identity.backend);
    if (fromIdentity) return fromIdentity;
  }

  // 2. Fallback to filesystem detection
  if (existsSync(join(cwd, '.claude'))) return CLAUDE_CODE;
  if (existsSync(join(cwd, '.gemini'))) return GEMINI;
  if (existsSync(join(cwd, 'codex.toml')) || existsSync(join(cwd, '.codex'))) return CODEX;
  return CLAUDE_CODE; // default
}

function getBackendByName(name: string): HookCapabilities {
  switch (name.toLowerCase()) {
    case 'claude':
    case 'claude-code':
      return CLAUDE_CODE;
    case 'codex':
      return CODEX;
    case 'gemini':
      return GEMINI;
    default:
      return CLAUDE_CODE;
  }
}

function getDefaultBackends(): HookCapabilities[] {
  // Install/status defaults should be explicit and comprehensive to avoid
  // per-backend footguns in multi-SB repos.
  return [CLAUDE_CODE, CODEX, GEMINI];
}

// ============================================================================
// Git Worktree Discovery
// ============================================================================

function listWorktreePaths(cwd: string): string[] {
  try {
    const output = execSync('git worktree list --porcelain', {
      cwd,
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return output
      .split('\n')
      .filter((line) => line.startsWith('worktree '))
      .map((line) => line.slice('worktree '.length));
  } catch {
    return [cwd]; // fallback to current directory
  }
}

// ============================================================================
// Stdin Parsing
// ============================================================================

async function readStdin(): Promise<Record<string, unknown>> {
  // If stdin is a TTY (interactive), return empty object
  if (process.stdin.isTTY) return {};

  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => {
      if (!data.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(data) as Record<string, unknown>);
      } catch {
        resolve({});
      }
    });
    // Timeout after 100ms if no data
    setTimeout(() => {
      if (!data) resolve({});
    }, 100);
  });
}

// ============================================================================
// Inkwell Client Helper
// ============================================================================

function getPcpConfig(): PcpConfig | null {
  const configPath = join(homedir(), '.ink', 'config.json');
  if (existsSync(configPath)) {
    try {
      return JSON.parse(readFileSync(configPath, 'utf-8'));
    } catch {
      return null;
    }
  }
  return null;
}

function getPcpServerUrl(): string {
  return process.env.INK_SERVER_URL || 'http://localhost:3001';
}

let jsonRpcId = 1;

export async function callPcpTool(
  tool: string,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const serverUrl = getPcpServerUrl();
  const url = `${serverUrl}/mcp`;
  const hasInjectedEnvToken = Boolean(process.env.INK_ACCESS_TOKEN?.trim());
  const delegatedAgentId =
    typeof args.agentId === 'string' && args.agentId.trim().length > 0
      ? args.agentId.trim().toLowerCase()
      : null;

  // Propagate Inkwell session/studio IDs so the server can resolve studio scope and
  // attribute tool calls to the correct session context.
  const pcpSessionId = process.env.INK_SESSION_ID?.trim() || undefined;
  const pcpStudioId = process.env.INK_STUDIO_ID?.trim() || undefined;

  const baseHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'x-ink-caller-profile': 'runtime',
    // Forward-looking runtime identity signal for stricter server-side enforcement.
    // Today, effective agent identity is still sourced from JWT claims.
    ...(delegatedAgentId ? { 'x-ink-agent-id': delegatedAgentId } : {}),
    ...(pcpSessionId ? { 'x-ink-session-id': pcpSessionId } : {}),
    ...(pcpStudioId ? { 'x-ink-studio-id': pcpStudioId } : {}),
  };

  const callOnce = async (token: string | null): Promise<Response> => {
    const headers = { ...baseHeaders };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    return fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: tool, arguments: args },
        id: jsonRpcId++,
      }),
    });
  };

  // Attach CLI auth token so hooks pass OAuth checks on the MCP server.
  // Prefer runtime-injected env token, then local auth file.
  let usedDelegatedTokenOnFirstAttempt = false;
  const resolveHookToken = async (options?: {
    allowEnvToken?: boolean;
    skipDelegated?: boolean;
  }): Promise<{ token: string | null; source: 'delegated' | 'base' }> => {
    if (delegatedAgentId && !options?.skipDelegated) {
      const delegatedToken = getValidDelegatedAccessToken(delegatedAgentId);
      if (delegatedToken) {
        return { token: delegatedToken, source: 'delegated' };
      }
    }
    return { token: await getValidAccessToken(serverUrl, options), source: 'base' };
  };

  const firstToken = await resolveHookToken();
  usedDelegatedTokenOnFirstAttempt = firstToken.source === 'delegated';
  let response = await callOnce(firstToken.token);

  // Retry once if a runtime token was injected OR if we attempted a delegated token.
  // This allows fallback to local auth token when the first credential is rejected.
  if (response.status === 401 && (hasInjectedEnvToken || usedDelegatedTokenOnFirstAttempt)) {
    // Drain first response body before retrying so the underlying HTTP client
    // can cleanly release the stream (avoids occasional undici body warnings).
    try {
      await response.text();
    } catch {
      // Best-effort: failure to read the body should not block retry.
    }

    sbDebugLog('hooks', 'mcp_auth_retry_without_env_token', {
      tool,
      status: 401,
      reason: usedDelegatedTokenOnFirstAttempt ? 'delegated_token_rejected' : 'env_token_rejected',
      skipDelegatedOnRetry: usedDelegatedTokenOnFirstAttempt,
    });
    if (hasInjectedEnvToken) {
      console.error(
        chalk.yellow(
          '⚠ Inkwell hook auth token was rejected; retrying with local ~/.ink/auth.json token fallback.'
        )
      );
    }
    const retryToken = await resolveHookToken({
      allowEnvToken: false,
      skipDelegated: usedDelegatedTokenOnFirstAttempt,
    });
    response = await callOnce(retryToken.token);
  }

  if (!response.ok) {
    throw new Error(`Inkwell call failed (${response.status}): ${await response.text()}`);
  }

  // The MCP server uses Streamable HTTP transport, which may respond with
  // text/event-stream (SSE) even for single JSON-RPC responses. Parse
  // accordingly based on the Content-Type header.
  const contentType = response.headers.get('content-type') || '';
  let payload: Record<string, unknown>;

  if (contentType.includes('text/event-stream')) {
    // Parse SSE: extract the last `data:` line from the stream
    const text = await response.text();
    const dataLines = text
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => line.slice(6));
    const lastData = dataLines[dataLines.length - 1];
    if (!lastData) {
      throw new Error('Inkwell SSE response contained no data lines');
    }
    payload = JSON.parse(lastData) as Record<string, unknown>;
  } else {
    payload = (await response.json()) as Record<string, unknown>;
  }

  // JSON-RPC error
  if (payload.error) {
    const err = payload.error as { message?: string; code?: number };
    throw new Error(`Inkwell tool error (${err.code}): ${err.message}`);
  }

  // Unwrap JSON-RPC result → MCP tool response → content text
  const result = payload.result as
    | { content?: Array<{ text?: string }>; isError?: boolean }
    | undefined;
  if (result?.isError) {
    const rawText = result.content
      ?.map((entry) => (typeof entry?.text === 'string' ? entry.text : ''))
      .filter(Boolean)
      .join('\n')
      .trim();

    let message = rawText || 'Unknown MCP tool error';
    if (rawText) {
      try {
        const parsed = JSON.parse(rawText) as { error?: string; message?: string };
        if (typeof parsed.error === 'string' && parsed.error.trim()) {
          message = parsed.error.trim();
        } else if (typeof parsed.message === 'string' && parsed.message.trim()) {
          message = parsed.message.trim();
        }
      } catch {
        // Keep raw text as best-effort error.
      }
    }

    throw new Error(`Inkwell tool error: ${message}`);
  }

  const mcpText = result?.content?.[0]?.text;

  if (typeof mcpText === 'string') {
    try {
      return JSON.parse(mcpText) as Record<string, unknown>;
    } catch {
      return { text: mcpText };
    }
  }

  return (result as Record<string, unknown>) ?? payload;
}

// ============================================================================
// Runtime State Helpers
// ============================================================================

function getRuntimeDir(cwd: string): string {
  return join(cwd, '.ink', 'runtime');
}

function ensureRuntimeDir(cwd: string): string {
  const dir = getRuntimeDir(cwd);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function readRuntimeFile(cwd: string, filename: string): string | null {
  const filePath = join(getRuntimeDir(cwd), filename);
  if (existsSync(filePath)) {
    try {
      return readFileSync(filePath, 'utf-8').trim();
    } catch {
      return null;
    }
  }
  return null;
}

function writeRuntimeFile(cwd: string, filename: string, content: string): void {
  const dir = ensureRuntimeDir(cwd);
  writeFileSync(join(dir, filename), content);
}

function normalizeSessionBackend(backendName: string): string {
  // Hook backend names and session/backend adapter names differ for Claude:
  // - hooks backend: "claude-code"
  // - session/backend adapter: "claude"
  return backendName === 'claude-code' ? 'claude' : backendName;
}

function resolveActivePcpSessionId(cwd: string): string | undefined {
  // 1. INK_SESSION_ID env var — canonical, set by all CLI backends at spawn
  const envSessionId = process.env.INK_SESSION_ID?.trim();
  if (envSessionId) return envSessionId;

  const detectedBackend = detectBackend(cwd);
  const sessionBackend = normalizeSessionBackend(detectedBackend.name);
  const { studioId } = getIdentitySessionContext(cwd);
  const agentId = resolveAgentId() || 'unknown';

  // 2. INK_RUNTIME_LINK_ID → sessions.json lookup (server-spawned sessions)
  const runtimeLinkId = process.env.INK_RUNTIME_LINK_ID;
  if (runtimeLinkId) {
    const linked = findRuntimeSessionByLinkId(cwd, runtimeLinkId, {
      backend: sessionBackend,
      agentId,
      ...(studioId ? { studioId } : {}),
    });
    if (linked?.pcpSessionId) return linked.pcpSessionId;
  }

  // 3. sessions.json current pointer (CLI-launched sessions)
  const current = getCurrentRuntimeSession(cwd, sessionBackend);
  if (current?.pcpSessionId) return current.pcpSessionId;

  return undefined;
}

function getIdentitySessionContext(cwd: string): {
  studioId?: string;
  identityId?: string;
  studioName?: string;
  role?: string;
} {
  const identityPath = join(cwd, '.ink', 'identity.json');
  if (!existsSync(identityPath)) return {};

  try {
    const identity = JSON.parse(readFileSync(identityPath, 'utf-8')) as {
      studioId?: string;
      identityId?: string;
      studio?: string;
      role?: string;
    };
    return {
      studioId: identity.studioId,
      identityId: identity.identityId,
      studioName: identity.studio,
      role: identity.role,
    };
  } catch {
    return {};
  }
}

function getRuntimeLinkId(): string | undefined {
  const candidate = process.env.INK_RUNTIME_LINK_ID;
  if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  return undefined;
}

async function findPcpSessionByBackendSessionId(
  config: PcpConfig | null,
  agentId: string,
  sessionBackend: string,
  backendSessionId: string,
  studioId?: string
): Promise<{ pcpSessionId?: string; threadKey?: string }> {
  try {
    const listArgs: Record<string, unknown> = {
      email: config?.email,
      agentId,
      limit: 50,
      ...(studioId ? { studioId } : {}),
    };
    const listed = await callPcpTool('list_sessions', listArgs);
    const sessions = Array.isArray(listed.sessions)
      ? (listed.sessions as Array<Record<string, unknown>>)
      : [];

    const matched = sessions.find((session) => {
      if (session.endedAt) return false;
      if (
        typeof session.backend === 'string' &&
        session.backend &&
        session.backend !== sessionBackend
      ) {
        return false;
      }
      const backendCandidate =
        (typeof session.backendSessionId === 'string' ? session.backendSessionId : undefined) ||
        (typeof session.claudeSessionId === 'string' ? session.claudeSessionId : undefined);
      return backendCandidate === backendSessionId;
    });

    if (!matched || typeof matched.id !== 'string') return {};

    return {
      pcpSessionId: matched.id,
      ...(typeof matched.threadKey === 'string' ? { threadKey: matched.threadKey } : {}),
    };
  } catch {
    return {};
  }
}

async function reconcileBackendSignal(
  cwd: string,
  config: PcpConfig | null,
  agentId: string,
  stdin: Record<string, unknown>,
  options?: {
    initialPcpSessionId?: string;
    initialThreadKey?: string;
    startedAt?: string;
    hookBackend?: string;
  }
): Promise<{ pcpSessionId?: string; threadKey?: string; backendSessionId?: string }> {
  const detectedBackend = options?.hookBackend
    ? getBackendByName(options.hookBackend)
    : detectBackend(cwd);
  const sessionBackend = normalizeSessionBackend(detectedBackend.name);
  const backendSessionId = extractBackendSessionId(stdin, sessionBackend);
  const runtimeLinkId = getRuntimeLinkId();
  sbDebugLog('hooks', 'reconcile_start', {
    sessionBackend,
    agentId,
    initialPcpSessionId: options?.initialPcpSessionId || null,
    initialThreadKey: options?.initialThreadKey || null,
    extractedBackendSessionId: backendSessionId || null,
    runtimeLinkId: runtimeLinkId || null,
    stdinKeys: Object.keys(stdin),
  });
  const { studioId, identityId } = getIdentitySessionContext(cwd);

  let pcpSessionId = options?.initialPcpSessionId || resolveActivePcpSessionId(cwd);
  let threadKey = options?.initialThreadKey;

  if (!pcpSessionId && runtimeLinkId) {
    const linked = findRuntimeSessionByLinkId(cwd, runtimeLinkId, {
      backend: sessionBackend,
      agentId,
      ...(studioId ? { studioId } : {}),
    });
    if (linked?.pcpSessionId) {
      pcpSessionId = linked.pcpSessionId;
      if (linked.threadKey) threadKey = linked.threadKey;
      sbDebugLog('hooks', 'reconcile_match_runtime_link', {
        sessionBackend,
        runtimeLinkId,
        matchedPcpSessionId: linked.pcpSessionId,
        matchedThreadKey: linked.threadKey || null,
      });
    }
  }

  if (!pcpSessionId && backendSessionId) {
    const linkedByBackendSessionId = listRuntimeSessions(cwd, sessionBackend).find(
      (session) =>
        session.agentId === agentId &&
        (!studioId || session.studioId === studioId) &&
        (session.backendSessionId === backendSessionId ||
          session.backendSessionIds?.includes(backendSessionId))
    );
    if (linkedByBackendSessionId?.pcpSessionId) {
      pcpSessionId = linkedByBackendSessionId.pcpSessionId;
      if (linkedByBackendSessionId.threadKey) threadKey = linkedByBackendSessionId.threadKey;
      sbDebugLog('hooks', 'reconcile_match_local_backend_link', {
        sessionBackend,
        backendSessionId,
        matchedPcpSessionId: linkedByBackendSessionId.pcpSessionId,
        matchedThreadKey: linkedByBackendSessionId.threadKey || null,
      });
    }
  }

  let hasLocalBackendLink = false;
  if (backendSessionId && pcpSessionId) {
    const local = listRuntimeSessions(cwd, sessionBackend).find(
      (session) =>
        session.pcpSessionId === pcpSessionId &&
        session.agentId === agentId &&
        (!studioId || session.studioId === studioId)
    );
    hasLocalBackendLink = !!(
      local &&
      (local.backendSessionId === backendSessionId ||
        local.backendSessionIds?.includes(backendSessionId))
    );
  }

  if (backendSessionId && !hasLocalBackendLink) {
    // Reconcile mismatched pcpSessionId/backendSessionId by checking existing server-side links first.
    const matched = await findPcpSessionByBackendSessionId(
      config,
      agentId,
      sessionBackend,
      backendSessionId,
      studioId
    );

    if (matched.pcpSessionId) {
      pcpSessionId = matched.pcpSessionId;
      threadKey = matched.threadKey || threadKey;
      sbDebugLog('hooks', 'reconcile_match_server_backend_link', {
        sessionBackend,
        backendSessionId,
        matchedPcpSessionId: matched.pcpSessionId,
        matchedThreadKey: matched.threadKey || null,
      });
    }
  }

  if (!pcpSessionId) {
    sbDebugLog('hooks', 'reconcile_result', {
      sessionBackend,
      pcpSessionId: null,
      threadKey: threadKey || null,
      backendSessionId: backendSessionId || null,
      studioId: studioId || null,
      identityId: identityId || null,
    });
    return {
      ...(backendSessionId ? { backendSessionId } : {}),
      ...(threadKey ? { threadKey } : {}),
    };
  }

  upsertRuntimeSession(cwd, {
    pcpSessionId,
    backend: sessionBackend,
    agentId,
    ...(identityId ? { identityId } : {}),
    ...(studioId ? { studioId } : {}),
    ...(threadKey ? { threadKey } : {}),
    ...(runtimeLinkId ? { runtimeLinkId } : {}),
    ...(backendSessionId ? { backendSessionId } : {}),
    ...(options?.startedAt ? { startedAt: options.startedAt } : {}),
    updatedAt: new Date().toISOString(),
  });
  setCurrentRuntimeSession(cwd, pcpSessionId, sessionBackend, {
    agentId,
    ...(identityId ? { identityId } : {}),
    ...(studioId ? { studioId } : {}),
  });
  sbDebugLog('hooks', 'reconcile_result', {
    sessionBackend,
    pcpSessionId,
    threadKey: threadKey || null,
    backendSessionId: backendSessionId || null,
    studioId: studioId || null,
    identityId: identityId || null,
  });

  return {
    pcpSessionId,
    ...(threadKey ? { threadKey } : {}),
    ...(backendSessionId ? { backendSessionId } : {}),
  };
}

async function updateRuntimeGenerationState(
  cwd: string,
  _config: PcpConfig | null,
  agentId: string,
  lifecycle: 'running' | 'idle' | 'compacting'
): Promise<void> {
  const sessionId = resolveActivePcpSessionId(cwd);
  if (!sessionId) return;

  try {
    const serverUrl = getPcpServerUrl();
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const token = await getValidAccessToken(serverUrl);
    if (token) headers.Authorization = `Bearer ${token}`;
    const resp = await fetch(`${serverUrl}/api/hooks/lifecycle`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ sessionId, lifecycle, agentId, workingDir: cwd }),
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      sbDebugLog('hooks', 'lifecycle_update_failed', {
        sessionId,
        lifecycle,
        status: resp.status,
        body,
      });
    }
  } catch {
    // Non-fatal; hook execution should not fail due to transient session sync issues.
  }
}

export function extractBackendSessionId(
  stdin: Record<string, unknown>,
  sessionBackend?: string
): string | undefined {
  // Claude hook payload session_id values are not stable conversation IDs.
  // They can rotate on each run and poison backendSessionId mapping.
  //
  // Real-world failure we observed:
  // 1) fallback repair correctly set backendSessionId to a resumable id
  // 2) later hook events emitted a new transient UUID
  // 3) hook reconciliation overwrote backendSessionId with that transient id
  // 4) next launch failed on --resume <transient-id>
  //
  // Therefore hooks MUST NOT source Claude backendSessionId from stdin payloads.
  // For Claude, backendSessionId should be captured by sb launch path from
  // explicit "claude --resume <id>" output, not hook stdin fields.
  if (sessionBackend === 'claude') {
    sbDebugLog('hooks', 'backend_session_extract_skip', {
      sessionBackend,
      reason: 'claude_transient_ids_blocked',
    });
    return undefined;
  }

  const candidates: Array<{ source: string; value: unknown }> = [
    { source: 'stdin.session_id', value: stdin.session_id },
    { source: 'stdin.sessionId', value: stdin.sessionId },
    {
      source: 'stdin.session.id',
      value: (stdin.session as Record<string, unknown> | undefined)?.id,
    },
    {
      source: 'stdin.session.session_id',
      value: (stdin.session as Record<string, unknown> | undefined)?.session_id,
    },
    {
      source: 'stdin.data.session_id',
      value: (stdin.data as Record<string, unknown> | undefined)?.session_id,
    },
    {
      source: 'stdin.data.sessionId',
      value: (stdin.data as Record<string, unknown> | undefined)?.sessionId,
    },
  ];

  for (const candidate of candidates) {
    if (typeof candidate.value === 'string' && candidate.value.trim()) {
      const normalized = candidate.value.trim();
      sbDebugLog('hooks', 'backend_session_extract_success', {
        sessionBackend: sessionBackend || 'unknown',
        source: candidate.source,
        backendSessionId: normalized,
      });
      return normalized;
    }
  }

  sbDebugLog('hooks', 'backend_session_extract_none', {
    sessionBackend: sessionBackend || 'unknown',
    stdinKeys: Object.keys(stdin),
  });
  return undefined;
}

// ============================================================================
// Template Loading
// ============================================================================

function loadTemplate(name: string): string {
  // Try compiled output path first
  const distPath = join(__dirname, '..', 'templates', `${name}.md`);
  if (existsSync(distPath)) return readFileSync(distPath, 'utf-8');

  // Fallback: source tree (development)
  const srcPath = join(__dirname, '..', '..', 'src', 'templates', `${name}.md`);
  if (existsSync(srcPath)) return readFileSync(srcPath, 'utf-8');

  throw new Error(`Template not found: ${name}`);
}

function renderTemplate(template: string, vars: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`{{${key}}}`, value);
  }
  // Clean up empty placeholder lines (blocks that had no data)
  return result.replace(/\n{3,}/g, '\n\n').trim();
}

// ============================================================================
// Shared Block Builders
// ============================================================================

export function buildIdentityBlock(bootstrapResult: Record<string, unknown>): string {
  const files = bootstrapResult?.identityFiles as Record<string, string> | undefined;
  if (!files) return '';

  const sections: string[] = [];

  // Render identity files in a meaningful order
  const fileOrder = ['self', 'soul', 'values', 'process', 'user', 'heartbeat'];
  for (const key of fileOrder) {
    const content = files[key];
    if (content && typeof content === 'string') {
      sections.push(content.trim());
    }
  }

  if (sections.length === 0) return '';
  return sections.join('\n\n---\n\n');
}

function buildInboxBlock(messages: Array<Record<string, unknown>> | undefined): string {
  if (!messages || messages.length === 0) return '';
  const lines = [`### Inbox (${messages.length} message${messages.length === 1 ? '' : 's'})`];
  for (const msg of messages) {
    lines.push(`- **${msg.from || 'unknown'}**: ${msg.content || msg.subject || '(no content)'}`);
  }
  return lines.join('\n');
}

/**
 * Check if the InkMail channel plugin is registered in .mcp.json.
 * When active, the channel handles real-time inbox delivery — hook-based
 * injection is skipped to avoid duplicate messages.
 */
function hasActiveChannelPlugin(cwd: string): boolean {
  try {
    const mcpJsonPath = join(cwd, '.mcp.json');
    if (!existsSync(mcpJsonPath)) return false;
    const mcpConfig = JSON.parse(readFileSync(mcpJsonPath, 'utf-8'));
    return Boolean(mcpConfig?.mcpServers?.['inkmail']);
  } catch {
    return false;
  }
}

function buildInboxTag(messages: Array<Record<string, unknown>> | undefined): string {
  if (!messages || messages.length === 0) return '';
  const lines = [`<inkmail count="${messages.length}">`];
  for (const msg of messages) {
    lines.push(`- **${msg.from || 'unknown'}**: ${msg.content || msg.subject || '(no content)'}`);
  }
  lines.push('</inkmail>');
  return lines.join('\n');
}

function buildMemoriesBlock(memories: Array<Record<string, unknown>> | undefined): string {
  if (!memories || memories.length === 0) return '';
  const lines = ['### Recent Memories'];
  for (const mem of memories.slice(0, 5)) {
    lines.push(`- ${mem.content || mem.key || JSON.stringify(mem)}`);
  }
  return lines.join('\n');
}

function buildSessionsBlock(sessions: Array<Record<string, unknown>> | undefined): string {
  if (!sessions || sessions.length === 0) return '';
  const lines = ['### Active Sessions'];
  for (const s of sessions) {
    lines.push(
      `- ${(s.id as string)?.substring(0, 8) || 'unknown'}: ${s.summary || s.status || 'active'}`
    );
  }
  return lines.join('\n');
}

function buildSkillsBlock(skills: Array<Record<string, unknown>> | undefined): string {
  if (!skills || skills.length === 0) return '';

  const lines = ['### Available Skills'];
  lines.push('');
  lines.push('Call `get_skill` with a skill name for full instructions.');
  lines.push('');

  const guideContents: string[] = [];

  for (const skill of skills) {
    const name = skill.name as string;
    const type = skill.type as string;
    const desc = skill.description as string;
    const displayName = (skill.displayName as string) || name;
    // triggers comes as a flat keywords array from list_skills summary
    const triggers = skill.triggers as string[] | undefined;
    const triggerStr = triggers?.length ? ` — triggers: ${triggers.join(', ')}` : '';

    if (type === 'guide' && skill.content) {
      lines.push(`- **${displayName}** (guide): ${desc}${triggerStr} — *active, see below*`);
      guideContents.push(`#### ${displayName}\n\n${skill.content}`);
    } else {
      lines.push(`- **${displayName}** (${type}): ${desc}${triggerStr}`);
    }
  }

  if (guideContents.length > 0) {
    lines.push('');
    lines.push(...guideContents);
  }

  return lines.join('\n');
}

// ============================================================================
// Install / Uninstall / Status
// ============================================================================

/** Marker used to identify Ink-managed hook entries (JSON backends) */
const PCP_MARKER = 'ink-managed';
/** Marker used to identify Ink-managed Codex hook block (TOML) */
const CODEX_HOOKS_START_MARKER = '# ink-managed:hooks:start';
const CODEX_HOOKS_END_MARKER = '# ink-managed:hooks:end';
// Back-compat with earlier Codex hook marker format.
const CODEX_LEGACY_HOOKS_START_MARKER = '# ink-managed';
const CODEX_LEGACY_HOOKS_END_MARKER = '# end ink-managed';
const PCP_HOOK_SIGNATURES = [
  'hooks on-session-start',
  'hooks on-stop',
  'hooks on-prompt',
  'hooks pre-compact',
  'hooks post-compact',
];

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function looksLikeSbEntrypoint(path: string): boolean {
  const normalized = path.replace(/\\/g, '/');
  const baseName = normalized.split('/').pop() || '';
  return (
    normalized.endsWith('/packages/cli/dist/cli.js') ||
    normalized.endsWith('/packages/cli/src/cli.ts') ||
    normalized.endsWith('/node_modules/.bin/ink') ||
    normalized.endsWith('/ink') ||
    /^ink(?:[-_.][a-z0-9_-]+)?$/i.test(baseName)
  );
}

function buildSbCommandPrefix(path: string): string {
  if (/\.(mjs|cjs|js|ts)$/i.test(path)) {
    return `${shellQuote(process.execPath)} ${shellQuote(path)}`;
  }
  return shellQuote(path);
}

/**
 * Resolve absolute path to the `ink` CLI binary from the main worktree's
 * node_modules/.bin/ink. This ensures hooks work from PM2 and other
 * environments where ~/.local/bin may not be in PATH.
 */
function resolveSbBinaryPath(cwd: string): string {
  const invokedPath = process.argv[1];
  if (invokedPath && existsSync(invokedPath) && looksLikeSbEntrypoint(invokedPath)) {
    return buildSbCommandPrefix(invokedPath);
  }

  const worktrees = listWorktreePaths(cwd);
  const mainWorktree = worktrees[0] || cwd;
  const binPath = join(mainWorktree, 'node_modules', '.bin', 'ink');
  if (existsSync(binPath)) return buildSbCommandPrefix(binPath);
  // Fallback: bare `ink` (relies on PATH)
  return 'ink';
}

/** Check if a hook command is Inkwell-managed (handles both bare `ink` and absolute paths) */
function isPcpHookCommand(cmd: string | undefined): boolean {
  if (!cmd) return false;
  return (
    /\bink hooks\b/.test(cmd) || PCP_HOOK_SIGNATURES.some((signature) => cmd.includes(signature))
  );
}

type InstallResult = 'installed' | 'already-installed' | 'conflict';

function hasCodexPcpHooks(content: string): boolean {
  if (!content.trim()) return false;
  return (
    /session_start\s*=\s*".*hooks on-session-start[^"]*"/.test(content) &&
    /session_end\s*=\s*".*hooks on-stop[^"]*"/.test(content) &&
    /user_prompt\s*=\s*".*hooks on-prompt[^"]*"/.test(content)
  );
}

function buildManagedHookCommand(sbPath: string, hookName: string, backendName: string): string {
  return `${sbPath} hooks ${hookName} --backend ${backendName}`;
}

function formatHookHint(backendName: string, hookName: string): string {
  return `ink hooks ${hookName} --backend ${backendName}`;
}

function buildClaudeCodeHooks(sbPath: string): Record<string, unknown> {
  return {
    hooks: {
      PreCompact: [
        {
          hooks: [
            {
              type: 'command',
              command: buildManagedHookCommand(sbPath, 'pre-compact', CLAUDE_CODE.name),
            },
          ],
        },
      ],
      SessionStart: [
        {
          matcher: 'compact',
          hooks: [
            {
              type: 'command',
              command: buildManagedHookCommand(sbPath, 'post-compact', CLAUDE_CODE.name),
            },
          ],
        },
        {
          matcher: 'startup',
          hooks: [
            {
              type: 'command',
              command: buildManagedHookCommand(sbPath, 'on-session-start', CLAUDE_CODE.name),
            },
          ],
        },
      ],
      PreToolUse: [
        {
          hooks: [
            {
              type: 'command',
              command: buildManagedHookCommand(sbPath, 'on-tool-approval', CLAUDE_CODE.name),
            },
          ],
        },
      ],
      UserPromptSubmit: [
        {
          hooks: [
            {
              type: 'command',
              command: buildManagedHookCommand(sbPath, 'on-prompt', CLAUDE_CODE.name),
            },
          ],
        },
      ],
      Stop: [
        {
          hooks: [
            {
              type: 'command',
              command: buildManagedHookCommand(sbPath, 'on-stop', CLAUDE_CODE.name),
            },
          ],
        },
      ],
    },
  };
}

/** Check if existing Claude Code hooks already match the Inkwell hooks we'd write */
function claudeCodeHooksMatch(existing: Record<string, unknown>, cwd: string): boolean {
  const sbPath = resolveSbBinaryPath(cwd);
  const target = buildClaudeCodeHooks(sbPath);
  const existingHooksStr = JSON.stringify(existing.hooks);
  const targetHooksStr = JSON.stringify(target.hooks);
  return existingHooksStr === targetHooksStr;
}

function installClaudeCode(cwd: string, force: boolean): InstallResult {
  const configPath = join(cwd, CLAUDE_CODE.configPath);
  const configDir = join(cwd, '.claude');
  mkdirSync(configDir, { recursive: true });

  let existing: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      existing = JSON.parse(readFileSync(configPath, 'utf-8'));
    } catch {
      // overwrite if unparseable
    }
  }

  // Check for existing hooks
  const existingHooks = existing.hooks as Record<string, unknown> | undefined;
  if (existingHooks && !force) {
    // Check if Inkwell hooks already match exactly
    if (claudeCodeHooksMatch(existing, cwd)) {
      return 'already-installed';
    }

    // Check if any non-Inkwell hooks exist
    const hasNonPcpHooks = Object.entries(existingHooks).some(([, entries]) => {
      if (!Array.isArray(entries)) return false;
      return entries.some((entry: Record<string, unknown>) => {
        const hooks = entry.hooks as Array<Record<string, unknown>> | undefined;
        if (!hooks) return false;
        return hooks.some((h) => !isPcpHookCommand(h.command as string | undefined));
      });
    });

    if (hasNonPcpHooks) {
      return 'conflict';
    }
  }

  const sbPath = resolveSbBinaryPath(cwd);
  const pcpHooks = buildClaudeCodeHooks(sbPath);

  // Merge: keep existing non-hooks settings, replace hooks
  const merged = { ...existing, ...pcpHooks };
  writeFileSync(configPath, JSON.stringify(merged, null, 2) + '\n');
  return 'installed';
}

function installGemini(cwd: string, force: boolean): InstallResult {
  const configDir = join(cwd, '.gemini');
  const configPath = join(cwd, GEMINI.configPath);
  mkdirSync(configDir, { recursive: true });

  let existing: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      existing = JSON.parse(readFileSync(configPath, 'utf-8'));
    } catch {
      // overwrite
    }
  }

  const sbPath = resolveSbBinaryPath(cwd);
  const pcpHooks: Record<string, unknown> = {
    // SessionStart: startup matcher only. PreCompress/postCompact disabled —
    // Gemini has no post-compression SessionStart event so lifecycle gets stuck.
    [GEMINI.events.sessionStart!]: [
      {
        matcher: 'startup',
        hooks: [
          {
            type: 'command',
            command: buildManagedHookCommand(sbPath, 'on-session-start', GEMINI.name),
          },
        ],
      },
    ],
    [GEMINI.events.onPrompt!]: [
      {
        hooks: [
          {
            type: 'command',
            command: buildManagedHookCommand(sbPath, 'on-prompt', GEMINI.name),
          },
        ],
      },
    ],
    [GEMINI.events.onStop!]: [
      {
        hooks: [
          {
            type: 'command',
            command: buildManagedHookCommand(sbPath, 'on-stop', GEMINI.name),
          },
        ],
      },
    ],
  };

  const entryHasCommand = (entry: unknown, targetCommand: string): boolean => {
    if (!entry || typeof entry !== 'object') return false;
    const entryObj = entry as Record<string, unknown>;
    if (typeof entryObj.command === 'string') {
      return entryObj.command === targetCommand;
    }
    const hooks = entryObj.hooks as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(hooks)) return false;
    return hooks.some((h) => h && typeof h.command === 'string' && h.command === targetCommand);
  };

  const entryHasNonPcpCommand = (entry: unknown): boolean => {
    if (!entry || typeof entry !== 'object') return false;
    const entryObj = entry as Record<string, unknown>;
    if (typeof entryObj.command === 'string') {
      return !isPcpHookCommand(entryObj.command);
    }
    const hooks = entryObj.hooks as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(hooks)) return false;
    return hooks.some(
      (h) => h && typeof h.command === 'string' && !isPcpHookCommand(h.command as string)
    );
  };

  if (existing.hooks && !force) {
    // Check if our hooks are already there
    const hooksObj = existing.hooks as Record<string, unknown>;
    const allPresent = Object.entries(pcpHooks).every(([event, targetEntries]) => {
      const existingEntries = hooksObj[event];
      if (!Array.isArray(existingEntries)) return false;
      // Verify ALL target entries are present (e.g. SessionStart has both compress + startup)
      return (targetEntries as Array<Record<string, unknown>>).every((targetEntry) => {
        const targetCmd = (targetEntry.hooks as Array<Record<string, unknown>> | undefined)?.[0]
          ?.command as string | undefined;
        if (!targetCmd) return false;
        return existingEntries.some((entry) => entryHasCommand(entry, targetCmd));
      });
    });

    if (allPresent) {
      return 'already-installed';
    }

    // Check for any non-Inkwell hooks in these specific events
    const hasConflict = Object.keys(pcpHooks).some((event) => {
      const entries = hooksObj[event];
      if (!Array.isArray(entries)) return false;
      return entries.some((entry) => entryHasNonPcpCommand(entry));
    });

    if (hasConflict) {
      return 'conflict';
    }
  }

  const merged = {
    ...existing,
    hooks: {
      ...((existing.hooks as Record<string, unknown>) || {}),
      ...pcpHooks,
    },
  };

  writeFileSync(configPath, JSON.stringify(merged, null, 2) + '\n');
  return 'installed';
}

function installCodex(cwd: string, force: boolean): InstallResult {
  const configDir = join(cwd, '.codex');
  const configPath = join(cwd, CODEX.configPath);
  mkdirSync(configDir, { recursive: true });

  let existingContent = '';
  if (existsSync(configPath)) {
    existingContent = readFileSync(configPath, 'utf-8');
  }

  if (hasCodexPcpHooks(existingContent) && !force) {
    return 'already-installed';
  }

  if (existingContent.includes('[hooks]') && !hasCodexPcpHooks(existingContent) && !force) {
    return 'conflict';
  }

  // Remove existing Inkwell-managed hooks section if present
  const cleaned = removePcpTomlSection(existingContent);

  const sbPath = resolveSbBinaryPath(cwd);
  const pcpSection = [
    '',
    CODEX_HOOKS_START_MARKER,
    '[hooks]',
    `session_start = "${buildManagedHookCommand(sbPath, 'on-session-start', CODEX.name)}"`,
    `session_end = "${buildManagedHookCommand(sbPath, 'on-stop', CODEX.name)}"`,
    `user_prompt = "${buildManagedHookCommand(sbPath, 'on-prompt', CODEX.name)}"`,
    CODEX_HOOKS_END_MARKER,
    '',
  ].join('\n');

  writeFileSync(configPath, cleaned.trimEnd() + '\n' + pcpSection);
  return 'installed';
}

function removePcpTomlSection(content: string): string {
  const markerPairs = [
    [CODEX_HOOKS_START_MARKER, CODEX_HOOKS_END_MARKER],
    [CODEX_LEGACY_HOOKS_START_MARKER, CODEX_LEGACY_HOOKS_END_MARKER],
  ] as const;

  for (const [startMarker, endMarker] of markerPairs) {
    const startIdx = content.indexOf(startMarker);
    if (startIdx === -1) continue;
    const endIdx = content.indexOf(endMarker);
    if (endIdx === -1) continue;
    const before = content.substring(0, startIdx);
    const after = content.substring(endIdx + endMarker.length);
    return before + after;
  }

  return content;
}

/**
 * Programmatic hooks installer. Returns the result without printing.
 * Used by `ink hooks install`, `ink studio create`, and `ink init`.
 */
export function installHooks(
  cwd: string,
  options?: { backend?: string; force?: boolean }
): { result: InstallResult; backend: HookCapabilities } {
  const backend = options?.backend ? getBackendByName(options.backend) : detectBackend(cwd);
  let result: InstallResult = 'conflict';

  switch (backend.name) {
    case 'claude-code':
      result = installClaudeCode(cwd, !!options?.force);
      break;
    case 'gemini':
      result = installGemini(cwd, !!options?.force);
      break;
    case 'codex':
      result = installCodex(cwd, !!options?.force);
      break;
  }

  return { result, backend };
}

function printInstallResult(
  targetDir: string,
  result: InstallResult,
  backend: HookCapabilities
): void {
  if (result === 'already-installed') {
    console.log(chalk.dim(`  · ${targetDir} — up to date (${backend.name})`));
    return;
  }

  if (result === 'conflict') {
    console.log(chalk.yellow(`  ○ ${targetDir} — conflict (use --force)`));
    return;
  }

  console.log(chalk.green(`  ✓ ${targetDir} — installed (${backend.name})`));
  const events = backend.events;
  if (events.preCompact)
    console.log(
      chalk.dim(`      ${events.preCompact} → ${formatHookHint(backend.name, 'pre-compact')}`)
    );
  if (events.postCompact) {
    const compactMatcher = backend.name === 'gemini' ? 'compress' : 'compact';
    console.log(
      chalk.dim(
        `      ${events.postCompact} (${compactMatcher}) → ${formatHookHint(backend.name, 'post-compact')}`
      )
    );
  }
  if (events.sessionStart)
    console.log(
      chalk.dim(
        `      ${events.sessionStart} (startup) → ${formatHookHint(backend.name, 'on-session-start')}`
      )
    );
  if (events.onPrompt)
    console.log(
      chalk.dim(`      ${events.onPrompt} → ${formatHookHint(backend.name, 'on-prompt')}`)
    );
  if (events.onStop)
    console.log(chalk.dim(`      ${events.onStop} → ${formatHookHint(backend.name, 'on-stop')}`));
}

async function installCommand(options: {
  backend?: string;
  local?: boolean;
  force?: boolean;
  all?: boolean;
}): Promise<void> {
  const cwd = process.cwd();
  const backends = options.backend ? [getBackendByName(options.backend)] : getDefaultBackends();

  if (options.all) {
    const worktrees = listWorktreePaths(cwd);
    console.log(
      chalk.bold(
        `\nInstalling Inkwell hooks across ${worktrees.length} worktree(s) for ${backends
          .map((backend) => backend.name)
          .join(', ')}:\n`
      )
    );

    let hasConflict = false;
    for (const wt of worktrees) {
      for (const backend of backends) {
        const { result } = installHooks(wt, {
          backend: backend.name,
          force: options.force,
        });
        printInstallResult(wt, result, backend);
        if (result === 'conflict') hasConflict = true;
      }
    }

    console.log('');
    if (hasConflict) {
      console.log(chalk.yellow('Some worktrees had conflicts. Use --force to overwrite.'));
    } else {
      console.log(chalk.dim('Done.'));
    }
    return;
  }

  console.log(chalk.dim(`Backends: ${backends.map((backend) => backend.name).join(', ')}`));

  let hasConflict = false;
  for (const backend of backends) {
    const { result } = installHooks(cwd, {
      backend: backend.name,
      force: options.force,
    });

    if (result === 'already-installed') {
      console.log(
        chalk.green(`\nInkwell hooks already installed and up to date (${backend.name}).`)
      );
      console.log(chalk.dim(`Config: ${backend.configPath}`));
      continue;
    }

    if (result === 'conflict') {
      hasConflict = true;
      console.error(
        chalk.yellow(
          `\nExisting non-Inkwell hooks detected (${backend.name}). Use --force to overwrite.`
        )
      );
      continue;
    }

    console.log(chalk.green(`\nInkwell hooks installed (${backend.name}):`));
    const events = backend.events;
    if (events.preCompact)
      console.log(
        chalk.dim(`  ${events.preCompact} → ${formatHookHint(backend.name, 'pre-compact')}`)
      );
    if (events.postCompact) {
      const compactMatcher = backend.name === 'gemini' ? 'compress' : 'compact';
      console.log(
        chalk.dim(
          `  ${events.postCompact} (${compactMatcher}) → ${formatHookHint(backend.name, 'post-compact')}`
        )
      );
    }
    if (events.sessionStart)
      console.log(
        chalk.dim(
          `  ${events.sessionStart} (startup) → ${formatHookHint(backend.name, 'on-session-start')}`
        )
      );
    if (events.onPrompt)
      console.log(chalk.dim(`  ${events.onPrompt} → ${formatHookHint(backend.name, 'on-prompt')}`));
    if (events.onStop)
      console.log(chalk.dim(`  ${events.onStop} → ${formatHookHint(backend.name, 'on-stop')}`));
    console.log(chalk.dim(`Config: ${backend.configPath}`));
  }

  if (hasConflict) process.exit(1);
}

function uninstallFromDir(targetDir: string, backendName?: string): boolean {
  const backend = backendName ? getBackendByName(backendName) : detectBackend(targetDir);
  const configPath = join(targetDir, backend.configPath);

  if (!existsSync(configPath)) return false;

  switch (backend.name) {
    case 'claude-code':
    case 'gemini': {
      const config = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
      if (!config.hooks) return false;
      delete config.hooks;
      writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
      break;
    }
    case 'codex': {
      const content = readFileSync(configPath, 'utf-8');
      if (!hasCodexPcpHooks(content)) return false;
      const cleaned = removePcpTomlSection(content);
      if (cleaned === content) return false;
      writeFileSync(configPath, cleaned);
      break;
    }
  }

  return true;
}

async function uninstallCommand(options: { backend?: string; all?: boolean }): Promise<void> {
  const cwd = process.cwd();

  if (options.all) {
    const worktrees = listWorktreePaths(cwd);
    console.log(chalk.bold(`\nRemoving Inkwell hooks across ${worktrees.length} worktree(s):\n`));

    for (const wt of worktrees) {
      const backend = options.backend ? getBackendByName(options.backend) : detectBackend(wt);
      const removed = uninstallFromDir(wt, options.backend);
      if (removed) {
        console.log(chalk.green(`  ✓ ${wt} — removed (${backend.name})`));
      } else {
        console.log(chalk.dim(`  · ${wt} — no hooks found`));
      }
    }

    console.log(chalk.dim('\nDone.'));
    return;
  }

  const backend = options.backend ? getBackendByName(options.backend) : detectBackend(cwd);
  const configPath = join(cwd, backend.configPath);

  if (!existsSync(configPath)) {
    console.log(chalk.yellow('No config file found. Nothing to uninstall.'));
    return;
  }

  const removed = uninstallFromDir(cwd, options.backend);
  if (removed) {
    console.log(chalk.green(`Inkwell hooks removed from ${backend.configPath}`));
  } else {
    console.log(chalk.yellow('No Inkwell hooks found to remove.'));
  }
}

async function statusCommand(options: { backend?: string }): Promise<void> {
  const cwd = process.cwd();
  const backends = options.backend ? [getBackendByName(options.backend)] : getDefaultBackends();

  for (const backend of backends) {
    const configPath = join(cwd, backend.configPath);
    console.log(chalk.bold(`\nHook Status (${backend.name}):\n`));
    console.log(chalk.dim(`  Config: ${backend.configPath}`));

    if (!existsSync(configPath)) {
      console.log(chalk.yellow('\n  No config file found. Hooks not installed.'));
      console.log(chalk.dim(`  Run: ink hooks install -b ${backend.name}`));
      console.log('');
      continue;
    }

    let hasHooks = false;

    switch (backend.name) {
      case 'claude-code':
      case 'gemini': {
        try {
          const config = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
          const hooks = config.hooks as Record<string, unknown> | undefined;
          if (hooks && Object.keys(hooks).length > 0) {
            hasHooks = true;
            console.log(chalk.green('\n  Hooks installed:'));
            for (const [event, entries] of Object.entries(hooks)) {
              if (!Array.isArray(entries)) continue;
              for (const entry of entries) {
                const entryObj = entry as Record<string, unknown>;
                const hookList = entryObj.hooks as Array<Record<string, unknown>> | undefined;
                const matcher = entryObj.matcher as string | undefined;
                const command = entryObj.command as string | undefined;

                if (hookList) {
                  for (const h of hookList) {
                    const cmd = h.command as string;
                    const matcherSuffix = matcher ? ` (${matcher})` : '';
                    const icon = isPcpHookCommand(cmd) ? chalk.green('●') : chalk.dim('○');
                    console.log(`    ${icon} ${event}${matcherSuffix} → ${cmd}`);
                  }
                } else if (command) {
                  // Gemini/simpler format
                  const icon = isPcpHookCommand(command) ? chalk.green('●') : chalk.dim('○');
                  console.log(`    ${icon} ${event} → ${command}`);
                }
              }
            }
          }
        } catch {
          console.log(chalk.red('\n  Failed to parse config file.'));
        }
        break;
      }
      case 'codex': {
        const content = readFileSync(configPath, 'utf-8');
        if (hasCodexPcpHooks(content)) {
          hasHooks = true;
          console.log(chalk.green('\n  Inkwell hooks installed (TOML)'));
          const sessionStart = content.match(/session_start\s*=\s*"([^"]+)"/)?.[1];
          const sessionEnd = content.match(/session_end\s*=\s*"([^"]+)"/)?.[1];
          const userPrompt = content.match(/user_prompt\s*=\s*"([^"]+)"/)?.[1];
          if (sessionStart) console.log(chalk.dim(`    ● session_start → ${sessionStart}`));
          if (sessionEnd) console.log(chalk.dim(`    ● session_end → ${sessionEnd}`));
          if (userPrompt) console.log(chalk.dim(`    ● user_prompt → ${userPrompt}`));
        }
        break;
      }
    }

    if (!hasHooks) {
      console.log(chalk.yellow('\n  No hooks installed.'));
      console.log(chalk.dim(`  Run: ink hooks install -b ${backend.name}`));
    }

    // Show capabilities
    console.log(chalk.dim('\n  Capabilities:'));
    console.log(
      chalk.dim(
        `    Compaction: ${backend.supportsCompaction ? chalk.green('yes') : chalk.yellow('no')}`
      )
    );
    console.log(
      chalk.dim(
        `    Prompt hook: ${backend.supportsPromptHook ? chalk.green('yes') : chalk.yellow('no')}`
      )
    );
    console.log('');
  }
}

// ============================================================================
// Hook Handlers
// ============================================================================

async function preCompactHandler(options?: { backend?: string }): Promise<void> {
  await readStdin(); // consume stdin but we don't need it

  const cwd = process.cwd();
  const config = getPcpConfig();
  const agentId = resolveAgentId() || 'unknown';
  const backend = resolveLifecycleBackend(cwd, options?.backend);

  // Only set 'compacting' lifecycle if this backend has a postCompact event
  // that will reset it to 'idle'. Without postCompact (e.g., Gemini/PreCompress),
  // the lifecycle gets stuck at 'compacting' permanently.
  if (backend.events.postCompact) {
    await updateRuntimeGenerationState(cwd, config, agentId, 'compacting');
  }

  process.stdout.write(loadTemplate('hook-pre-compact'));
}

async function postCompactHandler(): Promise<void> {
  await readStdin();

  const cwd = process.cwd();
  const config = getPcpConfig();
  const agentId = resolveAgentId() || 'unknown';

  // Reset lifecycle from compacting back to idle
  await updateRuntimeGenerationState(cwd, config, agentId, 'idle');

  let identityBlock = '';
  let memoriesBlock = '';
  let inboxBlock = '';
  let skillsBlock = '';

  // Bootstrap identity
  try {
    const bootstrap = await callPcpTool('bootstrap', {
      email: config?.email,
      agentId,
      postCompact: true,
    });
    identityBlock = buildIdentityBlock(bootstrap);
    memoriesBlock = buildMemoriesBlock(
      bootstrap.recentMemories as Array<Record<string, unknown>> | undefined
    );
  } catch {
    identityBlock =
      '*FAILED: Could not reach Inkwell server for `bootstrap`. You should call the `bootstrap` MCP tool manually to reload your identity context.*';
  }

  // Check inbox
  try {
    const inbox = await callPcpTool('get_inbox', {
      email: config?.email,
      agentId,
    });
    inboxBlock = buildInboxBlock(inbox.messages as Array<Record<string, unknown>> | undefined);
    writeRuntimeFile(cwd, 'last-inbox-check', new Date().toISOString());
  } catch {
    inboxBlock =
      '*FAILED: Could not reach Inkwell server for `get_inbox`. You should call the `get_inbox` MCP tool manually to check for messages.*';
  }

  // Load available skills
  try {
    const skillsResult = await callPcpTool('list_skills', { includeContent: true });
    skillsBlock = buildSkillsBlock(
      skillsResult.skills as Array<Record<string, unknown>> | undefined
    );
  } catch {
    // Non-fatal
  }

  const template = loadTemplate('hook-post-compact');
  const output = renderTemplate(template, {
    AGENT_ID: agentId,
    IDENTITY_BLOCK: identityBlock,
    MEMORIES_BLOCK: memoriesBlock,
    SKILLS_BLOCK: skillsBlock,
    INBOX_BLOCK: inboxBlock,
  });

  process.stdout.write(output);
}

function resolveLifecycleBackend(cwd: string, backendOverride?: string): HookCapabilities {
  if (backendOverride?.trim()) return getBackendByName(backendOverride.trim());
  if (process.env.INK_HOOK_BACKEND?.trim())
    return getBackendByName(process.env.INK_HOOK_BACKEND.trim());
  return detectBackend(cwd);
}

async function onSessionStartHandler(options?: { backend?: string }): Promise<void> {
  const stdin = await readStdin();
  const cwd = process.cwd();
  const config = getPcpConfig();
  const agentId = resolveAgentId() || 'unknown';
  const resolvedBackend = resolveLifecycleBackend(cwd, options?.backend);

  hookLog('on_session_start', {
    agentId,
    backend: resolvedBackend.name,
    hasInkContextToken: !!process.env.INK_CONTEXT_TOKEN,
    hasInkSessionId: !!process.env.INK_SESSION_ID,
    hasInkStudioId: !!process.env.INK_STUDIO_ID,
  });
  sbDebugLog('hooks', 'on_session_start_begin', {
    stdinKeys: Object.keys(stdin),
    hookBackendOverride: options?.backend || process.env.INK_HOOK_BACKEND || null,
  });

  let { studioId, studioName, role } = getIdentitySessionContext(cwd);
  const studioLine = studioName ? `Studio: ${studioName}` : '';

  let identityBlock = '';
  let memoriesBlock = '';
  let sessionsBlock = '';
  let inboxBlock = '';
  let skillsBlock = '';
  let roleBlock = '';

  // Load ROLE.md if present in this studio
  const roleMd = readRoleMd(cwd);
  if (roleMd) {
    const identity = readIdentityJson(cwd);
    const roleName = identity?.role || 'Studio Role';
    roleBlock = `## ${roleName}\n\n${roleMd}`;
  }

  // Bootstrap
  try {
    const bootstrapArgs: Record<string, unknown> = {
      email: config?.email,
      agentId,
    };
    if (studioId) bootstrapArgs.studioId = studioId;

    const bootstrap = await callPcpTool('bootstrap', bootstrapArgs);
    identityBlock = buildIdentityBlock(bootstrap);
    memoriesBlock = buildMemoriesBlock(
      bootstrap.recentMemories as Array<Record<string, unknown>> | undefined
    );
    sessionsBlock = buildSessionsBlock(
      bootstrap.activeSessions as Array<Record<string, unknown>> | undefined
    );
  } catch {
    identityBlock =
      '*FAILED: Could not reach Inkwell server for `bootstrap`. You should call the `bootstrap` MCP tool manually to reload your identity context.*';
  }

  // Auto-register CLI-created studio in the cloud if not yet tracked
  if (studioName && !studioId) {
    try {
      const gitRoot = execSync('git rev-parse --show-toplevel', {
        cwd,
        encoding: 'utf-8',
      }).trim();

      const createArgs: Record<string, unknown> = {
        email: config?.email,
        agentId,
        repoRoot: gitRoot,
        slug: studioName,
        skipGitOperations: true,
      };
      if (role) createArgs.roleTemplate = role;

      const created = await callPcpTool('create_studio', createArgs);
      // create_studio returns { studio: { id, ... } }, not { workspace: ... }
      const ws = (created.studio || created.workspace) as Record<string, unknown> | undefined;
      if (ws && typeof ws.id === 'string') {
        studioId = ws.id;
        // Persist studioId back to identity.json for future sessions
        const identityPath = join(cwd, '.ink', 'identity.json');
        if (existsSync(identityPath)) {
          try {
            const identityData = JSON.parse(readFileSync(identityPath, 'utf-8'));
            identityData.studioId = studioId;
            writeFileSync(identityPath, JSON.stringify(identityData, null, 2));
          } catch {
            // Non-fatal: studio registered but identity.json update failed
          }
        }
      }
    } catch {
      // Non-fatal: studio auto-registration failed (server may be unreachable)
    }
  }

  // Check inbox
  try {
    const inbox = await callPcpTool('get_inbox', {
      email: config?.email,
      agentId,
    });
    inboxBlock = buildInboxBlock(inbox.messages as Array<Record<string, unknown>> | undefined);
    writeRuntimeFile(cwd, 'last-inbox-check', new Date().toISOString());
  } catch {
    inboxBlock =
      '*FAILED: Could not reach Inkwell server for `get_inbox`. You should call the `get_inbox` MCP tool manually to check for messages.*';
  }

  // Load available skills (guide content included inline)
  try {
    const skillsResult = await callPcpTool('list_skills', { includeContent: true });
    skillsBlock = buildSkillsBlock(
      skillsResult.skills as Array<Record<string, unknown>> | undefined
    );
  } catch {
    // Non-fatal: skills are a nice-to-have at session start
  }

  // Register Inkwell session with detected backend
  const detectedBackend = resolveLifecycleBackend(cwd, options?.backend);
  const sessionBackend = normalizeSessionBackend(detectedBackend.name);
  let pcpSessionId: string | undefined;
  let pcpThreadKey: string | undefined;
  // If provided by sb launcher, prefer that explicit session id.
  if (process.env.INK_SESSION_ID) {
    pcpSessionId = process.env.INK_SESSION_ID;
  }

  try {
    if (!pcpSessionId) {
      const startArgs: Record<string, unknown> = {
        email: config?.email,
        agentId,
        backend: sessionBackend,
      };
      if (studioId) startArgs.studioId = studioId;
      const started = await callPcpTool('start_session', startArgs);
      const startedSession = started.session as Record<string, unknown> | undefined;
      if (startedSession && typeof startedSession.id === 'string') {
        pcpSessionId = startedSession.id;
        if (typeof startedSession.threadKey === 'string') {
          pcpThreadKey = startedSession.threadKey;
        }
      }
    }
  } catch {
    // Session tracking failure isn't shown to the SB (no block for it),
    // but it means the session won't be tracked. The bootstrap failure
    // message above will already alert about server connectivity.
  }

  const startedAt = new Date().toISOString();
  const reconciled = await reconcileBackendSignal(cwd, config, agentId, stdin, {
    initialPcpSessionId: pcpSessionId,
    initialThreadKey: pcpThreadKey,
    startedAt,
    hookBackend: detectedBackend.name,
  });
  sbDebugLog('hooks', 'on_session_start_reconciled', {
    pcpSessionId: reconciled.pcpSessionId || pcpSessionId || null,
    threadKey: reconciled.threadKey || pcpThreadKey || null,
    backendSessionId: reconciled.backendSessionId || null,
  });
  pcpSessionId = reconciled.pcpSessionId || pcpSessionId;
  pcpThreadKey = reconciled.threadKey || pcpThreadKey;
  const backendSessionId = reconciled.backendSessionId;

  // Set lifecycle to idle on startup (ready for user input).
  if (pcpSessionId) {
    try {
      const updateArgs: Record<string, unknown> = {
        email: config?.email,
        agentId,
        sessionId: pcpSessionId,
        lifecycle: 'idle',
        workingDir: cwd,
      };
      if (backendSessionId) updateArgs.backendSessionId = backendSessionId;
      await callPcpTool('update_session_phase', updateArgs);
    } catch {
      // Non-fatal; startup should continue even if linkage fails.
    }
  }

  // Build session identity block so the agent always has its own IDs in context
  const sessionIdentityParts: string[] = [];
  if (pcpSessionId) sessionIdentityParts.push(`Inkwell Session: \`${pcpSessionId}\``);
  if (backendSessionId) sessionIdentityParts.push(`Backend Session: \`${backendSessionId}\``);
  if (studioId) {
    const studioLabel = studioName ? `${studioId} (${studioName})` : studioId;
    sessionIdentityParts.push(`Studio: \`${studioLabel}\``);
  }
  if (pcpThreadKey) sessionIdentityParts.push(`Thread: \`${pcpThreadKey}\``);
  const sessionIdentityBlock =
    sessionIdentityParts.length > 0 ? sessionIdentityParts.map((p) => `- ${p}`).join('\n') : '';

  const template = loadTemplate('hook-session-start');
  const output = renderTemplate(template, {
    AGENT_ID: agentId,
    WORKSPACE_LINE: studioLine,
    SESSION_IDENTITY: sessionIdentityBlock,
    ROLE_BLOCK: roleBlock,
    IDENTITY_BLOCK: identityBlock,
    MEMORIES_BLOCK: memoriesBlock,
    SESSIONS_BLOCK: sessionsBlock,
    SKILLS_BLOCK: skillsBlock,
    INBOX_BLOCK: inboxBlock,
  });

  sbDebugLog('hooks', 'on_session_start_output_emitted', {
    backend: detectedBackend.name,
    backendSessionId: backendSessionId || null,
    pcpSessionId: pcpSessionId || null,
    threadKey: pcpThreadKey || null,
    outputBytes: Buffer.byteLength(output, 'utf-8'),
    outputSha256: createHash('sha256').update(output, 'utf-8').digest('hex'),
    hasRoleBlock: roleBlock.trim().length > 0,
    hasIdentityBlock: identityBlock.trim().length > 0,
    hasMemoriesBlock: memoriesBlock.trim().length > 0,
    hasSessionsBlock: sessionsBlock.trim().length > 0,
    hasSkillsBlock: skillsBlock.trim().length > 0,
    hasInboxBlock: inboxBlock.trim().length > 0,
  });

  process.stdout.write(output);
}

// ============================================================================
// on-tool-approval — PreToolUse intercept for 2FA permission grants
// ============================================================================

/**
 * Load the approval-required tool patterns from studio settings.
 * Falls back to empty array if no config exists.
 */
function loadApprovalSet(cwd: string): string[] {
  try {
    const settingsPath = join(cwd, '.claude', 'settings.local.json');
    if (!existsSync(settingsPath)) return [];
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    return settings.approvalRequired || [];
  } catch {
    return [];
  }
}

/**
 * Check if a tool call matches any pattern in the approval set.
 * Supports glob-style patterns: "Bash(docker push *)", "mcp__supabase__apply_migration"
 */
function matchesApprovalSet(toolName: string, toolInput: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    // Exact tool match (no args pattern)
    if (pattern === toolName) return true;

    // Pattern with args: "Bash(docker push *)"
    const parenIdx = pattern.indexOf('(');
    if (parenIdx === -1) continue;

    const patternTool = pattern.substring(0, parenIdx);
    if (patternTool !== toolName) continue;

    const argsPattern = pattern.substring(parenIdx + 1, pattern.length - 1); // strip parens
    // Simple glob: convert * to regex .*
    const regex = new RegExp(
      '^' + argsPattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*') + '$'
    );
    if (regex.test(toolInput)) return true;
  }
  return false;
}

async function onToolApprovalHandler(options?: { backend?: string }): Promise<void> {
  const stdin = await readStdin();
  const cwd = process.cwd();

  // Claude Code PreToolUse passes: { tool_name, tool_input }
  const toolName = (stdin.tool_name as string) || '';
  const toolInput =
    typeof stdin.tool_input === 'string'
      ? stdin.tool_input
      : JSON.stringify(stdin.tool_input || '');

  hookLog('on_tool_approval', { toolName, toolInputPreview: toolInput.substring(0, 100) });

  // Check against approval set
  const approvalSet = loadApprovalSet(cwd);
  if (approvalSet.length === 0 || !matchesApprovalSet(toolName, toolInput, approvalSet)) {
    // Not in the approval set — allow through
    process.exit(0);
  }

  hookLog('on_tool_approval_match', { toolName, toolInput: toolInput.substring(0, 200) });

  // Create an approval request on the server
  const serverUrl = getPcpServerUrl();
  const token = await getValidAccessToken(serverUrl);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  // Forward context header so server knows the agent/studio
  const contextToken = process.env.INK_CONTEXT_TOKEN?.trim();
  if (contextToken) headers['x-ink-context'] = contextToken;

  const sessionId = process.env.INK_SESSION_ID?.trim() || undefined;
  const studioId = process.env.INK_STUDIO_ID?.trim() || undefined;

  let requestId: string;
  try {
    const resp = await fetch(`${serverUrl}/api/admin/approval-requests`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        tool: toolName,
        args: toolInput,
        reason: `Tool requires 2FA approval`,
        studioId,
        sessionId,
        timeoutSeconds: 300,
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (!resp.ok) {
      hookLog('on_tool_approval_create_failed', { status: resp.status });
      // Fail closed — this is a security gate, don't allow through on errors
      process.stdout.write(
        `\n⚠️ Permission blocked: could not create approval request (server returned ${resp.status}).\n`
      );
      process.exit(1);
    }

    const body = (await resp.json()) as { requestId: string };
    requestId = body.requestId;
    hookLog('on_tool_approval_created', { requestId });
  } catch (err) {
    hookLog('on_tool_approval_create_error', { error: String(err) });
    // Fail closed — security gate must not silently bypass on errors
    process.stdout.write(
      `\n⚠️ Permission blocked: could not reach approval server (${String(err)}).\n`
    );
    process.exit(1);
  }

  // Poll for resolution (up to 5 min, check every 3s)
  const pollInterval = 3000;
  const maxPollTime = 300_000;
  const startTime = Date.now();

  while (Date.now() - startTime < maxPollTime) {
    await new Promise((r) => setTimeout(r, pollInterval));

    try {
      const statusResp = await fetch(
        `${serverUrl}/api/admin/approval-requests/${requestId}/status`,
        { headers, signal: AbortSignal.timeout(5000) }
      );

      if (!statusResp.ok) continue;

      const status = (await statusResp.json()) as {
        status: string;
        action?: string;
        grantedTools?: string[];
      };

      if (status.status === 'pending') continue;

      if (status.status === 'granted') {
        hookLog('on_tool_approval_granted', { requestId, action: status.action });
        // TODO: Apply permission overlay for grant-session/allow actions
        process.exit(0); // Allow the tool
      }

      // denied, expired, or cancelled
      hookLog('on_tool_approval_denied', { requestId, status: status.status });
      // Output a message explaining the denial
      process.stdout.write(
        `\n⚠️ Permission denied: ${toolName} requires approval. ` +
          `Request ${requestId} was ${status.status}.\n`
      );
      process.exit(1); // Block the tool
    } catch {
      // Transient error, keep polling
    }
  }

  // Timeout — deny
  hookLog('on_tool_approval_timeout', { requestId });
  process.stdout.write(
    `\n⚠️ Permission timeout: ${toolName} approval request expired after 5 minutes.\n`
  );
  process.exit(1);
}

async function onPromptHandler(options?: { backend?: string }): Promise<void> {
  const stdin = await readStdin();
  const cwd = process.cwd();
  const lifecycleBackend = resolveLifecycleBackend(cwd, options?.backend);
  sbDebugLog('hooks', 'on_prompt_begin', {
    stdinKeys: Object.keys(stdin),
    hookBackend: lifecycleBackend.name,
  });

  const config = getPcpConfig();
  const agentId = resolveAgentId() || 'unknown';
  hookLog('on_prompt', {
    agentId,
    backend: lifecycleBackend.name,
  });

  const reconciled = await reconcileBackendSignal(cwd, config, agentId, stdin, {
    hookBackend: lifecycleBackend.name,
  });
  hookLog('on_prompt_reconciled', {
    agentId,
    backend: lifecycleBackend.name,
    pcpSessionId: reconciled.pcpSessionId || null,
    threadKey: reconciled.threadKey || null,
    backendSessionId: reconciled.backendSessionId || null,
  });
  sbDebugLog('hooks', 'on_prompt_reconciled', {
    pcpSessionId: reconciled.pcpSessionId || null,
    threadKey: reconciled.threadKey || null,
    backendSessionId: reconciled.backendSessionId || null,
  });

  // Mark session as actively generating at prompt start.
  await updateRuntimeGenerationState(cwd, config, agentId, 'running');

  // Mark session as CLI-attached (human present at REPL).
  // Uses the REST lifecycle endpoint, NOT MCP — cliAttached is a runtime
  // signal that must bypass MCP schema validation (additionalProperties: false
  // strips it). The REST endpoint is purpose-built for hook-managed state.
  if (reconciled.pcpSessionId) {
    try {
      const serverUrl = getPcpServerUrl();
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      const token = await getValidAccessToken(serverUrl);
      if (token) headers.Authorization = `Bearer ${token}`;
      const lifecycleResp = await fetch(`${serverUrl}/api/hooks/lifecycle`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          sessionId: reconciled.pcpSessionId,
          cliAttached: true,
        }),
        signal: AbortSignal.timeout(5000),
      });
      hookLog('cli_attached_set', {
        agentId,
        backend: lifecycleBackend.name,
        sessionId: reconciled.pcpSessionId,
        status: lifecycleResp.status,
        ok: lifecycleResp.ok,
      });
    } catch (err) {
      hookLog('cli_attached_failed', {
        agentId,
        backend: lifecycleBackend.name,
        sessionId: reconciled.pcpSessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  } else {
    hookLog('cli_attached_skipped', {
      agentId,
      backend: lifecycleBackend.name,
      reason: 'no pcpSessionId',
      backendSessionId: reconciled.backendSessionId || null,
    });
  }

  // Skip inbox injection when the channel plugin is active — it handles
  // real-time delivery via the Channels API. Fall back to hook-based
  // injection when the channel plugin is not present.
  if (hasActiveChannelPlugin(cwd)) {
    return;
  }

  // No channel plugin — use hook-based inbox injection as fallback.
  // Drain pending message queue first — these are trigger messages
  // routed here because cli_attached=true.
  try {
    const pending = await callPcpTool('get_pending_messages', {
      channel: 'agent',
    });
    const pendingMessages = pending.messages as Array<Record<string, unknown>> | undefined;
    if (pendingMessages?.length) {
      const pendingTag = buildInboxTag(
        pendingMessages.map((m) => ({
          ...m,
          senderAgentId:
            typeof m.sender === 'object' ? (m.sender as Record<string, unknown>).id : m.sender,
          messageType: 'trigger',
        }))
      );
      if (pendingTag) {
        process.stdout.write(pendingTag);
      }
      // Mark as read so they don't replay on next prompt
      const messageIds = pendingMessages.map((m) => m.id as string).filter(Boolean);
      if (messageIds.length) {
        await callPcpTool('mark_messages_read', { messageIds }).catch(() => {});
      }
    }
  } catch {
    // Silent — pending queue may not have messages
  }

  // Check if inbox check is stale (> 5 minutes)
  const lastCheck = readRuntimeFile(cwd, 'last-inbox-check');
  const staleThresholdMs = 5 * 60 * 1000;

  if (lastCheck) {
    const lastCheckTime = new Date(lastCheck).getTime();
    const elapsed = Date.now() - lastCheckTime;
    if (elapsed < staleThresholdMs) {
      return;
    }
  }

  // Inbox is stale or never checked — poll
  try {
    const inbox = await callPcpTool('get_inbox', {
      email: config?.email,
      agentId,
    });

    writeRuntimeFile(cwd, 'last-inbox-check', new Date().toISOString());

    const messages = inbox.messages as Array<Record<string, unknown>> | undefined;
    const inboxTag = buildInboxTag(messages);
    if (inboxTag) {
      process.stdout.write(inboxTag);
    }
  } catch {
    // Silent failure — don't interrupt the user's prompt
  }
}

async function onStopHandler(options?: { backend?: string }): Promise<void> {
  const stdin = await readStdin();
  const cwd = process.cwd();
  const lifecycleBackend = resolveLifecycleBackend(cwd, options?.backend);

  const config = getPcpConfig();
  const agentId = resolveAgentId() || 'unknown';
  hookLog('on_stop', {
    agentId,
    backend: lifecycleBackend.name,
  });
  sbDebugLog('hooks', 'on_stop_begin', {
    stdinKeys: Object.keys(stdin),
    hookBackend: lifecycleBackend.name,
  });

  const parts: string[] = [];
  const reconciled = await reconcileBackendSignal(cwd, config, agentId, stdin, {
    hookBackend: lifecycleBackend.name,
  });
  sbDebugLog('hooks', 'on_stop_reconciled', {
    pcpSessionId: reconciled.pcpSessionId || null,
    threadKey: reconciled.threadKey || null,
    backendSessionId: reconciled.backendSessionId || null,
  });

  // Mark session as idle after each completed backend turn.
  await updateRuntimeGenerationState(cwd, config, agentId, 'idle');

  // Increment tool call counter
  const countStr = readRuntimeFile(cwd, 'tool-count');
  const count = (countStr ? parseInt(countStr, 10) : 0) + 1;
  writeRuntimeFile(cwd, 'tool-count', String(count));

  // Every ~30 calls, nudge to log session
  if (count % 30 === 0) {
    const template = loadTemplate('hook-on-stop');
    parts.push(renderTemplate(template, { TOOL_COUNT: String(count) }));
  }

  // Skip inbox injection when channel plugin handles it
  if (hasActiveChannelPlugin(cwd)) {
    if (parts.length > 0) {
      process.stdout.write(parts.join('\n\n'));
    }
    return;
  }

  // Check inbox if stale (fallback when no channel plugin)
  const lastCheck = readRuntimeFile(cwd, 'last-inbox-check');
  const staleThresholdMs = 5 * 60 * 1000;
  let shouldCheckInbox = !lastCheck;
  if (lastCheck) {
    const elapsed = Date.now() - new Date(lastCheck).getTime();
    shouldCheckInbox = elapsed >= staleThresholdMs;
  }

  if (shouldCheckInbox) {
    try {
      const inbox = await callPcpTool('get_inbox', {
        email: config?.email,
        agentId,
      });

      writeRuntimeFile(cwd, 'last-inbox-check', new Date().toISOString());

      const inboxTag = buildInboxTag(inbox.messages as Array<Record<string, unknown>> | undefined);
      if (inboxTag) parts.push(inboxTag);
    } catch {
      // Silent
    }
  }

  if (parts.length > 0) {
    process.stdout.write(parts.join('\n\n'));
  }
}

// ============================================================================
// Register Commands
// ============================================================================

export function registerHooksCommands(program: Command): void {
  const hooks = program
    .command('hooks')
    .description('Manage CLI lifecycle hooks for Inkwell integration');

  hooks
    .command('install')
    .description('Install Inkwell hooks into the detected backend config')
    .option('-b, --backend <name>', 'Backend to target (claude-code, codex, gemini)')
    .option('--local', 'Write to local config (default for Claude Code)', true)
    .option('-f, --force', 'Overwrite existing hooks')
    .option('-a, --all', 'Install across all git worktrees')
    .action(installCommand);

  hooks
    .command('uninstall')
    .description('Remove Inkwell-managed hooks from backend config')
    .option('-b, --backend <name>', 'Backend to target')
    .option('-a, --all', 'Uninstall from all git worktrees')
    .action(uninstallCommand);

  hooks
    .command('status')
    .description('Show installed hook status for the detected backend')
    .option('-b, --backend <name>', 'Backend to check')
    .action(statusCommand);

  // Hook handlers — invoked by the backend, not the user
  hooks
    .command('pre-compact')
    .description('Hook: output pre-compaction reminder')
    .option('--backend <name>', 'Backend context for this hook invocation')
    .action((opts) => preCompactHandler(opts));

  hooks
    .command('post-compact')
    .description('Hook: post-compaction bootstrap and inbox check')
    .option('--backend <name>', 'Backend context for this hook invocation')
    .action(postCompactHandler);

  hooks
    .command('on-session-start')
    .description('Hook: bootstrap identity and context at session start')
    .option('--backend <name>', 'Backend context for this hook invocation')
    .action((opts) => onSessionStartHandler(opts));

  hooks
    .command('on-tool-approval')
    .description('Hook: 2FA approval check before tool execution (PreToolUse)')
    .option('--backend <name>', 'Backend context for this hook invocation')
    .action((opts) => onToolApprovalHandler(opts));

  hooks
    .command('on-prompt')
    .description('Hook: periodic inbox check on user prompt')
    .option('--backend <name>', 'Backend context for this hook invocation')
    .action((opts) => onPromptHandler(opts));

  hooks
    .command('on-stop')
    .description('Hook: session nudge and inbox check on stop')
    .option('--backend <name>', 'Backend context for this hook invocation')
    .action((opts) => onStopHandler(opts));
}
