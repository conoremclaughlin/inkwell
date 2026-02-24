/**
 * Backend Runner
 *
 * Spawns the selected AI CLI backend with identity injection,
 * passthrough flags, and session tracking.
 */

import { spawn } from 'child_process';
import chalk from 'chalk';
import { randomUUID } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { getBackend, resolveAgentId } from '../backends/index.js';
import { getValidAccessToken } from '../auth/tokens.js';
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
}

interface ListSessionsResult {
  sessions?: PcpSessionSummary[];
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

function getPcpServerUrl(): string {
  return process.env.PCP_SERVER_URL || 'http://localhost:3001';
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

function hasBackendSessionOverride(
  backend: string,
  passthroughArgs: string[],
  promptParts: string[]
): boolean {
  const lowered = passthroughArgs.map((arg) => arg.toLowerCase());
  const has = (flag: string) => lowered.includes(flag.toLowerCase());

  const promptLowered = promptParts.map((part) => part.toLowerCase());
  if (backend === 'codex' && promptLowered[0] === 'resume') {
    return true;
  }

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

async function callPcpTool<T = Record<string, unknown>>(tool: string, args: object): Promise<T> {
  const response = await fetch(`${getPcpServerUrl()}/api/mcp/call`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool, args }),
  });

  if (!response.ok) {
    throw new Error(`PCP tool ${tool} failed: ${response.status} ${await response.text()}`);
  }

  return (await response.json()) as T;
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

async function persistBackendSessionLink(
  options: {
    pcpSessionId?: string;
    backendSessionId?: string;
    backend: string;
    agentId: string;
    runtimeLinkId?: string;
    studioId?: string;
    identityId?: string;
    email?: string;
  }
): Promise<void> {
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
    });
  } catch {
    // Best-effort linkage update only.
  }
}

async function ensurePcpSessionContext(
  agentId: string,
  backend: string,
  passthroughArgs: string[],
  promptParts: string[],
  verbose: boolean
): Promise<{ pcpSessionId?: string; backendSessionId?: string }> {
  if (hasBackendSessionOverride(backend, passthroughArgs, promptParts)) return {};

  const config = getPcpConfig();
  const email = config?.email;
  if (!email) return {};

  const cwd = process.cwd();
  const { studioId, identityId } = getIdentityContextFromIdentityJson(cwd);

  // Fast path: runtime already knows current session for this backend.
  const existing = getCurrentRuntimeSession(cwd, backend);
  if (existing?.pcpSessionId) {
    return {
      pcpSessionId: existing.pcpSessionId,
      backendSessionId: existing.backendSessionId,
    };
  }

  // Pull active session list so caller can resume or start new.
  let activeSessions: PcpSessionSummary[] = [];
  try {
    const listed = await callPcpTool<ListSessionsResult>('list_sessions', {
      email,
      agentId,
      ...(studioId ? { studioId } : {}),
      limit: 20,
    });
    activeSessions = (listed.sessions || []).filter((s) => !s.endedAt);
  } catch {
    // Non-fatal; fallback to start new below.
  }

  let chosen: PcpSessionSummary | undefined;

  if (process.stdin.isTTY) {
    const choices = activeSessions.map((s) => ({
      name: `Resume ${s.id.slice(0, 8)}${s.threadKey ? ` (${s.threadKey})` : ''}${s.currentPhase ? ` — ${s.currentPhase}` : ''}`,
      value: s.id,
    }));
    choices.unshift({ name: 'Start new session', value: '__new__' });

    try {
      const { select } = await import('@inquirer/prompts');
      const selection = await select({
        message: `Session for ${agentId}/${backend}`,
        choices,
      });
      if (selection === '__new__') {
        const newSessionId = randomUUID();
        const started = await callPcpTool<{ session?: PcpSessionSummary }>('start_session', {
          email,
          agentId,
          ...(studioId ? { studioId } : {}),
          backend,
          forceNew: true,
          sessionId: newSessionId,
        });
        chosen = started.session || { id: newSessionId, startedAt: new Date().toISOString() };
      } else {
        chosen = activeSessions.find((s) => s.id === selection);
      }
    } catch (err) {
      if (isPromptCancelError(err)) {
        console.log(chalk.yellow('\nSession selection canceled.'));
        process.exit(130);
      }
      // Prompt canceled or unavailable; fallback to start new.
    }
  }

  if (!chosen) {
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
      chosen = started.session || { id: newSessionId, startedAt: new Date().toISOString() };
    } catch {
      chosen = { id: newSessionId, startedAt: new Date().toISOString() };
    }
  }

  if (!chosen?.id) return {};

  upsertRuntimeSession(cwd, {
    pcpSessionId: chosen.id,
    backend,
    agentId,
    ...(identityId ? { identityId } : {}),
    ...(studioId ? { studioId } : {}),
    ...(chosen.threadKey ? { threadKey: chosen.threadKey } : {}),
    ...((!chosen.backend || chosen.backend === backend) &&
    (chosen.backendSessionId || chosen.claudeSessionId)
      ? { backendSessionId: chosen.backendSessionId || chosen.claudeSessionId || undefined }
      : {}),
    startedAt: chosen.startedAt,
  });
  setCurrentRuntimeSession(cwd, chosen.id, backend, {
    agentId,
    ...(identityId ? { identityId } : {}),
    ...(studioId ? { studioId } : {}),
  });

  if (verbose) {
    console.log(chalk.dim(`PCP session: ${chosen.id}`));
  }

  const backendSessionId =
    !chosen.backend || chosen.backend === backend
      ? chosen.backendSessionId || chosen.claudeSessionId || undefined
      : undefined;

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
    console.error(chalk.dim('Run `sb init` to set up PCP in this repo, or `sb awaken` to create a new SB.'));
    console.error(chalk.dim('Or pass `-a <agent>` to specify one directly.'));
    process.exit(1);
  }
  const adapter = getBackend(options.backend);
  const sessionContext = options.session
    ? await ensurePcpSessionContext(agentId, options.backend, passthroughArgs, promptParts, options.verbose)
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
      ...(sessionContext.backendSessionId ? { backendSessionId: sessionContext.backendSessionId } : {}),
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
  let capturedBackendSessionId = sessionContext.backendSessionId;
  let stdoutLineBuffer = '';
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
    prepared.cleanup();
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

    if (code !== 0) process.exit(code || 1);
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
    console.error(chalk.dim('Run `sb init` to set up PCP in this repo, or `sb awaken` to create a new SB.'));
    console.error(chalk.dim('Or pass `-a <agent>` to specify one directly.'));
    process.exit(1);
  }
  const adapter = getBackend(options.backend);
  const sessionContext = options.session
    ? await ensurePcpSessionContext(agentId, options.backend, passthroughArgs, [], options.verbose)
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
      ...(sessionContext.backendSessionId ? { backendSessionId: sessionContext.backendSessionId } : {}),
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

  const child = spawn(prepared.binary, prepared.args, {
    stdio: 'inherit',
    env: {
      ...process.env,
      ...authEnv,
      ...prepared.env,
      ...(runtimeLinkId ? { PCP_RUNTIME_LINK_ID: runtimeLinkId } : {}),
    },
  });

  child.on('close', (code) => {
    prepared.cleanup();
    process.exit(code || 0);
  });
}
