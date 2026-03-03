import { Command } from 'commander';
import chalk from 'chalk';
import { createInterface } from 'readline/promises';
import { stdin as input, stdout as output } from 'process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unwatchFile,
  watchFile,
} from 'fs';
import { isAbsolute, join } from 'path';
import { readIdentityJson, resolveAgentId } from '../backends/identity.js';
import { PcpClient } from '../lib/pcp-client.js';
import { runBackendTurn } from '../repl/backend-runner.js';
import { ContextLedger, estimateTokens } from '../repl/context-ledger.js';
import { parseSlashCommand } from '../repl/slash.js';
import { ToolMode, ToolPolicyScopeKind, ToolPolicyState } from '../repl/tool-policy.js';
import { formatBackendTokenUsage, type BackendTokenUsage } from '../repl/token-usage.js';
import { discoverSkills, loadSkillInstruction, type SkillInstruction } from '../repl/skills.js';
import { applyToolApprovalChoice, parseToolApprovalInput } from '../repl/tool-approval.js';
import { ensurePcpToolAllowed } from '../repl/tool-gate.js';
import { executeToolCalls, type ToolCallResult } from '../repl/tool-call-executor.js';
import { applyProfile, formatProfileList, isValidProfileId } from '../repl/tool-profiles.js';
import { ApprovalRequestManager } from '../repl/approval-request.js';
import {
  parsePermissionGrant,
  applyPermissionGrant,
  buildPermissionGrantMetadata,
  type PermissionGrantAction,
} from '../repl/permission-grant.js';
import { canActivateSkill, filterSkillsByPolicy } from '../repl/skill-policy.js';
import {
  formatHumanTime,
  formatNow,
  isOlderThan24Hours,
  isOlderThan5Days,
  LiveStatusLane,
  renderCollapsedInbox,
  renderMessageLine,
  renderTimedBlock,
  separator,
  startWaitingIndicator,
} from '../repl/tui-components.js';
import { renderInkChat, InkExitSignal, type InkRepl } from '../repl/ink/index.js';
import {
  classifyError,
  decodeDelegationToken,
  mintDelegationToken,
  verifyDelegationToken,
  type DelegationTokenPayload,
} from '@personal-context/shared';

type ChatOptions = {
  agent?: string;
  backend?: string;
  model?: string;
  toolRouting?: string;
  ui?: string;
  threadKey?: string;
  autoRun?: boolean;
  new?: boolean;
  attach?: string | boolean;
  attachLatest?: string | boolean;
  sessionId?: string;
  maxContextTokens?: string;
  pollSeconds?: string;
  tools?: string;
  profile?: string;
  message?: string;
  nonInteractive?: boolean;
  tailTranscript?: string;
  verbose?: boolean;
  fullscreen?: boolean;
};

interface InboxMessage {
  id: string;
  content: string;
  from?: string;
  subject?: string;
  createdAt?: string;
  threadKey?: string;
  messageType?: string;
  relatedSessionId?: string;
  recipientStudioId?: string;
  delegationToken?: string;
  metadata?: Record<string, unknown>;
}

interface ChatRuntime {
  backend: string;
  model?: string;
  verbose: boolean;
  toolMode: ToolMode;
  toolRouting: 'backend' | 'local';
  uiMode: 'scroll' | 'live';
  threadKey?: string;
  workspaceId?: string;
  studioId?: string;
  userTimezone?: string;
  backendTokenWindow: number;
  sessionId?: string;
  maxContextTokens: number;
  pollSeconds: number;
  showSessionsWatch: boolean;
  eventPolling: boolean;
  autoRunInbox: boolean;
  awayMode: boolean;
  transcriptPath: string;
  activeSkills: SkillInstruction[];
  bootstrapContext?: string;
}

interface SessionSummary {
  id: string;
  agentId?: string;
  workspaceId?: string;
  workspaceName?: string;
  studioId?: string;
  studioName?: string;
  status?: string;
  currentPhase?: string;
  threadKey?: string;
  startedAt?: string;
  backend?: string;
  model?: string;
  backendSessionId?: string;
  claudeSessionId?: string;
}

interface ActivitySummary {
  id: string;
  type?: string;
  subtype?: string;
  content?: string;
  agentId?: string;
  sessionId?: string;
  createdAt?: string;
}

interface DelegationState {
  token: string;
  payload: DelegationTokenPayload;
}

interface McpServerSummary {
  name: string;
  transport?: string;
  url?: string;
  command?: string;
}

interface LocalToolCall {
  tool: string;
  args: Record<string, unknown>;
  raw: string;
}

interface SessionTranscriptMetadata {
  transcriptPath: string;
  messageCount: number;
  userCount: number;
  assistantCount: number;
  inboxCount: number;
  lastMessageAt?: string;
}

interface HistoryHydrationResult {
  loaded: number;
  messageCount: number;
  source: 'repl-transcript' | 'pcp-session-context' | 'none';
  transcriptPath?: string;
  tailPreview: Array<{ role: 'user' | 'assistant' | 'inbox'; content: string; ts?: string }>;
  seenInboxIds?: string[];
  seenActivityIds?: string[];
}

interface SessionContextMessage {
  role: 'user' | 'assistant' | 'inbox' | 'system';
  content: string;
  ts?: string;
  source: string;
}

const LEDGER_COMPACT_CHARS = 420;
const AUTO_TRIM_KEEP_RECENT_ENTRIES = 6;
const DEFAULT_TRIM_TARGET_PCT = 70;
const CTRL_C_EXIT_WINDOW_MS = 3000;
const DEFAULT_BACKEND_TOKEN_WINDOW = 1_000_000;
const HISTORY_PREVIEW_MAX = 200;
function resolveBackendTokenWindow(_backend: string, _model?: string): number {
  // Current policy: claude/codex/gemini all default to 1M effective context window.
  return DEFAULT_BACKEND_TOKEN_WINDOW;
}

function formatTokenCount(value: number): string {
  return value.toLocaleString();
}

function getDelegationSecret(): string | undefined {
  const fromEnv = process.env.PCP_DELEGATION_SECRET?.trim();
  if (fromEnv) return fromEnv;
  const jwtSecret = process.env.JWT_SECRET?.trim();
  if (jwtSecret) return jwtSecret;
  return undefined;
}

function parseToolScopes(raw: string): string[] {
  return Array.from(
    new Set(
      raw
        .split(',')
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean)
    )
  );
}

function ensureRuntimeTranscriptPath(sessionId?: string): string {
  const dir = join(process.cwd(), '.pcp', 'runtime', 'repl');
  mkdirSync(dir, { recursive: true });
  const safeSession = sessionId || 'local';
  return join(dir, `${safeSession}-${Date.now()}.jsonl`);
}

function findLatestTranscriptForSession(sessionId: string): string | undefined {
  const dir = join(process.cwd(), '.pcp', 'runtime', 'repl');
  if (!existsSync(dir)) return undefined;
  const sessionPrefix = `${sessionId}-`;
  const candidates = readdirSync(dir)
    .filter((entry) => entry.startsWith(sessionPrefix) && entry.endsWith('.jsonl'))
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

function resolveTranscriptTarget(target: string): string {
  const trimmed = target.trim();
  if (!trimmed) throw new Error('Empty transcript target');
  if (isAbsolute(trimmed)) return trimmed;
  if (trimmed.includes('/') || trimmed.endsWith('.jsonl')) {
    return join(process.cwd(), trimmed);
  }
  const matched = findLatestTranscriptForSession(trimmed);
  if (!matched) {
    throw new Error(`No transcript found for session ${trimmed}`);
  }
  return matched;
}

function readTranscriptEvents(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  try {
    const lines = readFileSync(path, 'utf-8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const events: Array<Record<string, unknown>> = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        events.push(parsed);
      } catch {
        // ignore malformed lines
      }
    }
    return events;
  } catch {
    return [];
  }
}

function getSessionTranscriptMetadata(sessionId: string): SessionTranscriptMetadata | null {
  const path = findLatestTranscriptForSession(sessionId);
  if (!path) return null;
  const events = readTranscriptEvents(path);
  if (events.length === 0) return null;

  let userCount = 0;
  let assistantCount = 0;
  let inboxCount = 0;
  let lastMessageAt: string | undefined;

  for (const event of events) {
    const type = typeof event.type === 'string' ? event.type : '';
    if (type === 'user') {
      userCount += 1;
      if (typeof event.ts === 'string') lastMessageAt = event.ts;
      continue;
    }
    if (type === 'assistant') {
      assistantCount += 1;
      if (typeof event.ts === 'string') lastMessageAt = event.ts;
      continue;
    }
    if (type === 'inbox') {
      inboxCount += 1;
      if (typeof event.ts === 'string') lastMessageAt = event.ts;
    }
  }

  const messageCount = userCount + assistantCount + inboxCount;
  return {
    transcriptPath: path,
    messageCount,
    userCount,
    assistantCount,
    inboxCount,
    lastMessageAt,
  };
}

function hydrateLedgerFromTranscript(
  ledger: ContextLedger,
  transcriptPath: string
): {
  loaded: number;
  messageCount: number;
  tailPreview: HistoryHydrationResult['tailPreview'];
  seenInboxIds: string[];
  seenActivityIds: string[];
} {
  const events = readTranscriptEvents(transcriptPath);
  let loaded = 0;
  let messageCount = 0;
  const preview: HistoryHydrationResult['tailPreview'] = [];
  const seenInboxIds = new Set<string>();
  const seenActivityIds = new Set<string>();

  const pushPreview = (role: 'user' | 'assistant' | 'inbox', content: string, ts?: string) => {
    preview.push({ role, content: compactForHistoryPreview(role, content), ts });
    if (preview.length > HISTORY_PREVIEW_MAX) {
      preview.shift();
    }
  };

  for (const event of events) {
    const type = typeof event.type === 'string' ? event.type : '';
    if (type === 'user' && typeof event.content === 'string') {
      ledger.addEntry('user', event.content, 'repl-history');
      loaded += 1;
      messageCount += 1;
      pushPreview('user', event.content, typeof event.ts === 'string' ? event.ts : undefined);
      continue;
    }
    if (type === 'assistant' && typeof event.content === 'string') {
      const source = typeof event.backend === 'string' ? event.backend : 'backend-history';
      ledger.addEntry('assistant', event.content, source);
      loaded += 1;
      messageCount += 1;
      pushPreview('assistant', event.content, typeof event.ts === 'string' ? event.ts : undefined);
      continue;
    }
    if (type === 'inbox' && typeof event.rendered === 'string') {
      ledger.addEntry('inbox', compactForLedger(event.rendered), 'pcp-inbox-history');
      loaded += 1;
      messageCount += 1;
      pushPreview('inbox', event.rendered, typeof event.ts === 'string' ? event.ts : undefined);
      if (typeof event.messageId === 'string') {
        seenInboxIds.add(event.messageId);
      }
      continue;
    }
    if (type === 'activity' && typeof event.content === 'string') {
      const actor = typeof event.agentId === 'string' ? event.agentId : 'system';
      const activityType = typeof event.activityType === 'string' ? event.activityType : 'activity';
      ledger.addEntry(
        'system',
        compactForLedger(`⚡ ${actor} ${activityType} — ${event.content}`, 320),
        'pcp-activity-history'
      );
      loaded += 1;
      if (typeof event.activityId === 'string') {
        seenActivityIds.add(event.activityId);
      }
    }
  }

  return {
    loaded,
    messageCount,
    tailPreview: preview,
    seenInboxIds: Array.from(seenInboxIds),
    seenActivityIds: Array.from(seenActivityIds),
  };
}

function printTranscriptLine(rawLine: string): void {
  if (!rawLine.trim()) return;
  try {
    const parsed = JSON.parse(rawLine) as Record<string, unknown>;
    const ts = typeof parsed.ts === 'string' ? parsed.ts : '';
    const type = typeof parsed.type === 'string' ? parsed.type : 'event';
    const prefix = ts ? `${ts} ${type}` : type;

    if (type === 'user' || type === 'assistant' || type === 'inbox') {
      const content =
        typeof parsed.content === 'string'
          ? parsed.content
          : typeof parsed.rendered === 'string'
            ? parsed.rendered
            : '';
      console.log(`${chalk.dim(prefix)} ${content}`);
      return;
    }
    if (type === 'pcp_tool') {
      console.log(
        `${chalk.dim(prefix)} ${String(parsed.tool || '')} ${JSON.stringify(parsed.args || {}, null, 0)}`
      );
      return;
    }
    console.log(`${chalk.dim(prefix)} ${JSON.stringify(parsed)}`);
  } catch {
    console.log(rawLine);
  }
}

async function tailTranscript(target: string): Promise<void> {
  const filePath = resolveTranscriptTarget(target);
  if (!existsSync(filePath)) {
    throw new Error(`Transcript not found: ${filePath}`);
  }

  const initial = readFileSync(filePath, 'utf-8');
  const initialLines = initial.split('\n').filter(Boolean);
  for (const line of initialLines) {
    printTranscriptLine(line);
  }

  let lastSize = Buffer.byteLength(initial, 'utf-8');
  console.log(chalk.dim(`\nWatching transcript: ${filePath}`));
  console.log(chalk.dim('Press Ctrl+C to stop.\n'));

  await new Promise<void>((resolve) => {
    const pollMs = 750;
    const handler = () => {
      try {
        const current = readFileSync(filePath, 'utf-8');
        const currentSize = Buffer.byteLength(current, 'utf-8');
        if (currentSize <= lastSize) return;
        const appended = current.slice(lastSize);
        lastSize = currentSize;
        const lines = appended.split('\n').filter(Boolean);
        for (const line of lines) {
          printTranscriptLine(line);
        }
      } catch {
        // no-op
      }
    };

    watchFile(filePath, { interval: pollMs }, handler);
    const stop = () => {
      unwatchFile(filePath, handler);
      process.off('SIGINT', stop);
      resolve();
    };
    process.on('SIGINT', stop);
  });
}

function appendTranscript(path: string, event: Record<string, unknown>): void {
  appendFileSync(path, JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n');
}

function compactForLedger(content: string, maxChars = LEDGER_COMPACT_CHARS): string {
  const normalized = content.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(1, maxChars - 1))}…`;
}

function compactForHistoryPreview(role: 'user' | 'assistant' | 'inbox', content: string): string {
  if (role === 'inbox') {
    return compactForLedger(content.replace(/\s+/g, ' ').trim(), 180);
  }
  // Preserve newlines but collapse runs of spaces/tabs within lines
  return content
    .replace(/[^\S\n]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractLocalToolCalls(responseText: string): LocalToolCall[] {
  const matches = Array.from(responseText.matchAll(/```pcp-tool\s*([\s\S]*?)```/gi));
  const calls: LocalToolCall[] = [];
  for (const match of matches) {
    const payload = (match[1] || '').trim();
    if (!payload) continue;
    try {
      const parsed = JSON.parse(payload) as Record<string, unknown>;
      const tool = typeof parsed.tool === 'string' ? parsed.tool.trim() : '';
      if (!tool) continue;
      const args =
        parsed.args && typeof parsed.args === 'object' && !Array.isArray(parsed.args)
          ? (parsed.args as Record<string, unknown>)
          : {};
      calls.push({ tool, args, raw: match[0] || '' });
    } catch {
      continue;
    }
  }
  return calls;
}

function stripLocalToolBlocks(responseText: string): string {
  return responseText.replace(/```pcp-tool[\s\S]*?```/gi, '').trim();
}

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: string }).code;
  const name = (error as { name?: string }).name;
  return code === 'ABORT_ERR' || name === 'AbortError';
}

function isReadlineClosedError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: string }).code;
  const message = (error as { message?: string }).message;
  return (
    code === 'ERR_USE_AFTER_CLOSE' ||
    Boolean(message?.toLowerCase().includes('readline was closed'))
  );
}

function listConfiguredMcpServers(cwd = process.cwd()): McpServerSummary[] {
  const configPath = join(cwd, '.mcp.json');
  if (!existsSync(configPath)) return [];

  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf-8')) as {
      mcpServers?: Record<string, Record<string, unknown>>;
    };
    const servers = parsed.mcpServers || {};
    return Object.entries(servers).map(([name, config]) => ({
      name,
      transport:
        typeof config.type === 'string'
          ? config.type
          : typeof config.url === 'string'
            ? 'http'
            : typeof config.command === 'string'
              ? 'stdio'
              : undefined,
      url: typeof config.url === 'string' ? config.url : undefined,
      command: typeof config.command === 'string' ? config.command : undefined,
    }));
  } catch {
    return [];
  }
}

function extractSessionId(result: Record<string, unknown> | null | undefined): string | undefined {
  if (!result) return undefined;
  const direct = result.sessionId;
  if (typeof direct === 'string') return direct;

  const session = result.session as Record<string, unknown> | undefined;
  if (session && typeof session.id === 'string') return session.id;

  const data = result.data as Record<string, unknown> | undefined;
  const dataSession = data?.session as Record<string, unknown> | undefined;
  if (dataSession && typeof dataSession.id === 'string') return dataSession.id;

  return undefined;
}

function extractInboxMessages(result: Record<string, unknown> | null | undefined): InboxMessage[] {
  if (!result) return [];
  const candidate =
    (Array.isArray(result.messages) ? result.messages : undefined) ||
    (Array.isArray(result.inbox) ? result.inbox : undefined) ||
    [];

  return candidate
    .map((entry): InboxMessage | undefined => {
      const msg = entry as Record<string, unknown>;
      const id = msg.id;
      if (typeof id !== 'string') return undefined;
      const metadata = msg.metadata as Record<string, unknown> | undefined;
      const delegationToken =
        typeof metadata?.delegationToken === 'string'
          ? metadata.delegationToken
          : typeof msg.delegationToken === 'string'
            ? msg.delegationToken
            : undefined;
      return {
        id,
        content: String(msg.content || ''),
        from: msg.senderAgentId
          ? String(msg.senderAgentId)
          : msg.from
            ? String(msg.from)
            : undefined,
        subject: msg.subject ? String(msg.subject) : undefined,
        createdAt:
          typeof msg.createdAt === 'string'
            ? msg.createdAt
            : typeof msg.created_at === 'string'
              ? msg.created_at
              : undefined,
        threadKey: msg.threadKey ? String(msg.threadKey) : undefined,
        messageType:
          typeof msg.messageType === 'string'
            ? msg.messageType
            : typeof msg.message_type === 'string'
              ? msg.message_type
              : typeof metadata?.messageType === 'string'
                ? metadata.messageType
                : undefined,
        relatedSessionId:
          typeof msg.relatedSessionId === 'string'
            ? msg.relatedSessionId
            : typeof msg.related_session_id === 'string'
              ? msg.related_session_id
              : typeof msg.recipientSessionId === 'string'
                ? msg.recipientSessionId
                : typeof msg.recipient_session_id === 'string'
                  ? msg.recipient_session_id
                  : typeof metadata?.relatedSessionId === 'string'
                    ? metadata.relatedSessionId
                    : typeof metadata?.recipientSessionId === 'string'
                      ? metadata.recipientSessionId
                      : undefined,
        recipientStudioId:
          typeof msg.recipientStudioId === 'string'
            ? msg.recipientStudioId
            : typeof msg.recipient_studio_id === 'string'
              ? msg.recipient_studio_id
              : typeof metadata?.recipientStudioId === 'string'
                ? metadata.recipientStudioId
                : undefined,
        delegationToken,
        metadata: metadata && typeof metadata === 'object' ? metadata : undefined,
      } satisfies InboxMessage;
    })
    .filter((m): m is InboxMessage => Boolean(m));
}

function extractSessionSummaries(
  result: Record<string, unknown> | null | undefined
): SessionSummary[] {
  if (!result) return [];
  const candidate =
    (Array.isArray(result.sessions) ? result.sessions : undefined) ||
    (Array.isArray(result.data) ? result.data : undefined) ||
    [];

  return candidate
    .map((entry): SessionSummary | undefined => {
      const row = entry as Record<string, unknown>;
      const studio = row.studio as Record<string, unknown> | undefined;
      const id = row.id;
      if (typeof id !== 'string') return undefined;
      return {
        id,
        agentId: typeof row.agentId === 'string' ? row.agentId : undefined,
        workspaceId:
          typeof row.workspaceId === 'string'
            ? row.workspaceId
            : typeof row.workspace_id === 'string'
              ? row.workspace_id
              : undefined,
        workspaceName:
          typeof row.workspaceName === 'string'
            ? row.workspaceName
            : typeof row.workspace_name === 'string'
              ? row.workspace_name
              : typeof studio?.worktreeFolder === 'string'
                ? studio.worktreeFolder
                : undefined,
        studioId:
          typeof row.studioId === 'string'
            ? row.studioId
            : typeof row.studio_id === 'string'
              ? row.studio_id
              : typeof studio?.id === 'string'
                ? studio.id
                : undefined,
        studioName:
          typeof row.studioName === 'string'
            ? row.studioName
            : typeof row.studio_name === 'string'
              ? row.studio_name
              : typeof studio?.worktreeFolder === 'string'
                ? studio.worktreeFolder
                : typeof studio?.branch === 'string'
                  ? studio.branch
                  : undefined,
        status: typeof row.status === 'string' ? row.status : undefined,
        currentPhase: typeof row.currentPhase === 'string' ? row.currentPhase : undefined,
        threadKey: typeof row.threadKey === 'string' ? row.threadKey : undefined,
        startedAt: typeof row.startedAt === 'string' ? row.startedAt : undefined,
        backend:
          typeof row.backend === 'string'
            ? row.backend
            : typeof row.backend_name === 'string'
              ? row.backend_name
              : undefined,
        model:
          typeof row.model === 'string'
            ? row.model
            : typeof row.model_name === 'string'
              ? row.model_name
              : undefined,
        backendSessionId:
          typeof row.backendSessionId === 'string'
            ? row.backendSessionId
            : typeof row.backend_session_id === 'string'
              ? row.backend_session_id
              : undefined,
        claudeSessionId:
          typeof row.claudeSessionId === 'string'
            ? row.claudeSessionId
            : typeof row.claude_session_id === 'string'
              ? row.claude_session_id
              : undefined,
      };
    })
    .filter((session): session is SessionSummary => Boolean(session));
}

function extractActivitySummaries(
  result: Record<string, unknown> | null | undefined
): ActivitySummary[] {
  if (!result) return [];
  const candidate =
    (Array.isArray(result.activities) ? result.activities : undefined) ||
    (Array.isArray(result.data) ? result.data : undefined) ||
    [];

  return candidate
    .map((entry): ActivitySummary | undefined => {
      const row = entry as Record<string, unknown>;
      const id = row.id;
      if (typeof id !== 'string') return undefined;
      return {
        id,
        type: typeof row.type === 'string' ? row.type : undefined,
        subtype: typeof row.subtype === 'string' ? row.subtype : undefined,
        content: typeof row.content === 'string' ? row.content : undefined,
        agentId:
          typeof row.agentId === 'string'
            ? row.agentId
            : typeof row.agent_id === 'string'
              ? row.agent_id
              : undefined,
        sessionId:
          typeof row.sessionId === 'string'
            ? row.sessionId
            : typeof row.session_id === 'string'
              ? row.session_id
              : undefined,
        createdAt:
          typeof row.createdAt === 'string'
            ? row.createdAt
            : typeof row.created_at === 'string'
              ? row.created_at
              : undefined,
      };
    })
    .filter((activity): activity is ActivitySummary => Boolean(activity));
}

function extractSessionContextMessages(
  result: Record<string, unknown> | null | undefined
): SessionContextMessage[] {
  if (!result) return [];
  const candidate = (Array.isArray(result.context) ? result.context : undefined) || [];

  return candidate
    .map((entry): SessionContextMessage | undefined => {
      const row = entry as Record<string, unknown>;
      const content = typeof row.content === 'string' ? row.content.trim() : '';
      if (!content) return undefined;

      const type =
        typeof row.type === 'string'
          ? row.type
          : typeof row.activityType === 'string'
            ? row.activityType
            : 'unknown';
      const source =
        typeof row.subtype === 'string'
          ? `${type}:${row.subtype}`
          : typeof row.source === 'string'
            ? row.source
            : type;
      const ts =
        typeof row.createdAt === 'string'
          ? row.createdAt
          : typeof row.created_at === 'string'
            ? row.created_at
            : undefined;

      if (type === 'message_in' || type === 'user') {
        return {
          role: 'user',
          content,
          ts,
          source,
        };
      }
      if (type === 'message_out' || type === 'assistant') {
        return {
          role: 'assistant',
          content,
          ts,
          source,
        };
      }
      if (
        type === 'inbox' ||
        type === 'notification' ||
        type === 'task_request' ||
        type === 'session_resume'
      ) {
        return {
          role: 'inbox',
          content,
          ts,
          source,
        };
      }

      return {
        role: 'system',
        content,
        ts,
        source,
      };
    })
    .filter((entry): entry is SessionContextMessage => Boolean(entry));
}

function hydrateLedgerFromSessionContext(
  ledger: ContextLedger,
  messages: SessionContextMessage[]
): HistoryHydrationResult {
  let loaded = 0;
  let messageCount = 0;
  const preview: HistoryHydrationResult['tailPreview'] = [];
  const pushPreview = (role: 'user' | 'assistant' | 'inbox', content: string, ts?: string) => {
    preview.push({ role, content: compactForHistoryPreview(role, content), ts });
    if (preview.length > HISTORY_PREVIEW_MAX) preview.shift();
  };

  for (const message of messages) {
    if (message.role === 'user') {
      ledger.addEntry('user', message.content, `pcp-history:${message.source}`);
      loaded += 1;
      messageCount += 1;
      pushPreview('user', message.content, message.ts);
      continue;
    }
    if (message.role === 'assistant') {
      ledger.addEntry('assistant', message.content, `pcp-history:${message.source}`);
      loaded += 1;
      messageCount += 1;
      pushPreview('assistant', message.content, message.ts);
      continue;
    }
    if (message.role === 'inbox') {
      ledger.addEntry('inbox', compactForLedger(message.content), `pcp-history:${message.source}`);
      loaded += 1;
      messageCount += 1;
      pushPreview('inbox', message.content, message.ts);
      continue;
    }

    ledger.addEntry(
      'system',
      compactForLedger(message.content, 320),
      `pcp-history:${message.source}`
    );
    loaded += 1;
  }

  return {
    loaded,
    messageCount,
    source: 'pcp-session-context',
    tailPreview: preview,
  };
}

function summarizeForSessionEnd(ledger: ContextLedger): string {
  const entries = ledger.listEntries().slice(-8);
  const snippets = entries
    .filter((entry) => entry.role === 'assistant' || entry.role === 'user')
    .slice(-4)
    .map((entry) => `${entry.role}: ${entry.content.slice(0, 180).replace(/\s+/g, ' ').trim()}`);
  if (snippets.length === 0) return 'Ended REPL session.';
  return `REPL summary:\n${snippets.map((s) => `- ${s}`).join('\n')}`;
}

function buildTokenMeter(pct: number, width = 24): string {
  const clamped = Math.max(0, Math.min(100, pct));
  const filled = Math.round((clamped / 100) * width);
  const empty = Math.max(0, width - filled);
  return `${'█'.repeat(filled)}${'░'.repeat(empty)}`;
}

function buildContextStatusSummary(params: {
  ledger: ContextLedger;
  maxContextTokens: number;
  backendTokenWindow: number;
  pendingTurns: number;
  backend: string;
  bootstrapTokens?: number;
}): string {
  const transcriptTokens = params.ledger.totalTokens();
  const bootstrapTokens = params.bootstrapTokens || 0;
  const total = transcriptTokens + bootstrapTokens;
  const pct = params.maxContextTokens > 0 ? (total / params.maxContextTokens) * 100 : 0;
  const queue = params.pendingTurns > 0 ? `queue:${params.pendingTurns}` : 'queue:idle';
  const breakdown =
    bootstrapTokens > 0
      ? `${transcriptTokens.toLocaleString()} transcript + ${bootstrapTokens.toLocaleString()} identity`
      : `${total.toLocaleString()}`;
  return `${breakdown} / ${params.maxContextTokens.toLocaleString()} (${pct.toFixed(
    1
  )}%) ${queue} backend:${params.backend}`;
}

function printUsage(
  ledger: ContextLedger,
  maxContextTokens: number,
  previousTotal?: number,
  lastBackendUsage?: BackendTokenUsage,
  backendTokenWindow?: number
): number {
  const entries = ledger.listEntries();
  const total = ledger.totalTokens();
  const pct = maxContextTokens > 0 ? Math.min((total / maxContextTokens) * 100, 999) : 0;
  const displayPct = Math.min(pct, 100);
  const delta = previousTotal === undefined ? 0 : total - previousTotal;
  const deltaLabel =
    previousTotal === undefined ? '' : `  ${delta >= 0 ? '+' : ''}${delta.toLocaleString()} tok`;

  let user = 0;
  let assistant = 0;
  let inbox = 0;
  let system = 0;
  for (const entry of entries) {
    if (entry.role === 'user') user += entry.approxTokens;
    else if (entry.role === 'assistant') assistant += entry.approxTokens;
    else if (entry.role === 'inbox') inbox += entry.approxTokens;
    else system += entry.approxTokens;
  }

  const bar = buildTokenMeter(displayPct);
  const color =
    pct >= 95
      ? chalk.red
      : pct >= 80
        ? chalk.yellow
        : pct >= 60
          ? chalk.hex('#f59e0b')
          : chalk.green;
  const windowLabel =
    backendTokenWindow && backendTokenWindow !== maxContextTokens
      ? `  backend-window:${backendTokenWindow.toLocaleString()}`
      : '';
  const header = `Context: ~${total.toLocaleString()} / ${maxContextTokens.toLocaleString()} tok (${pct.toFixed(
    1
  )}%)${deltaLabel}${windowLabel}`;
  console.log(color(header));
  console.log(
    color(`[${bar}]`) +
      chalk.dim(
        `  entries:${entries.length}  user:${user.toLocaleString()}  assistant:${assistant.toLocaleString()}  inbox:${inbox.toLocaleString()}  system:${system.toLocaleString()}`
      )
  );
  if (lastBackendUsage) {
    console.log(chalk.dim(`Last backend usage: ${formatBackendTokenUsage(lastBackendUsage)}`));
  }

  return total;
}

function formatStartedAt(value?: string): string {
  if (!value) return '-';
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return value;
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function formatTimestampForSessionList(value?: string, timezone?: string): string {
  if (!value) return '-';
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return value;
  try {
    return new Date(ms).toLocaleTimeString([], {
      hour: 'numeric',
      minute: '2-digit',
      timeZone: timezone,
    });
  } catch {
    return new Date(ms).toLocaleTimeString([], {
      hour: 'numeric',
      minute: '2-digit',
    });
  }
}

function safeDateMs(value?: string): number {
  if (!value) return 0;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? 0 : ms;
}

function formatStudioForDisplay(studioId?: string, mode: 'short' | 'full' = 'short'): string {
  if (!studioId) return '-';
  return mode === 'short' ? studioId.slice(0, 8) : studioId;
}

function sessionStudioLabel(
  session: Pick<SessionSummary, 'studioId' | 'studioName' | 'workspaceId' | 'workspaceName'>,
  mode: 'short' | 'full' = 'short'
): string {
  const name = session.studioName || session.workspaceName;
  // Prefer name over UUID — UUIDs are noise for humans
  if (name) return name;
  const id = session.studioId || session.workspaceId;
  return formatStudioForDisplay(id, mode);
}

function sessionBackendLabel(session: SessionSummary): string {
  const declared = [session.backend, session.model ? `(${session.model})` : '']
    .filter(Boolean)
    .join(' ');
  if (declared) return declared;
  // Don't show raw session UUIDs — they're not useful to the user
  if (session.backendSessionId || session.claudeSessionId) return 'claude-code';
  return '-';
}

function sessionHistoryLabel(meta: SessionTranscriptMetadata | null): string {
  if (!meta) return 'remote';
  return `${meta.messageCount} msgs`;
}

function chip(label: string, value: string, color: (text: string) => string): string {
  return `${chalk.dim(`${label}:`)} ${color(value)}`;
}

function printSessionsSnapshot(sessions: SessionSummary[], options?: { timezone?: string }): void {
  if (sessions.length === 0) {
    console.log(chalk.dim('No active sessions found.'));
    return;
  }

  console.log(chalk.bold('\nActive sessions'));
  console.log(
    chalk.dim(
      'id       agent   status/phase            studio            thread        started   backend            history    last-msg'
    )
  );
  for (const session of sessions) {
    const transcriptMeta = getSessionTranscriptMetadata(session.id);
    const id = session.id.slice(0, 7).padEnd(7);
    const agent = (session.agentId || '-').slice(0, 6).padEnd(6);
    const status = (session.currentPhase || session.status || '-').slice(0, 22).padEnd(22);
    const studio = sessionStudioLabel(session, 'short').slice(0, 16).padEnd(16);
    const thread = (session.threadKey || '-').slice(0, 12).padEnd(12);
    const started = formatStartedAt(session.startedAt);
    const backend = sessionBackendLabel(session).slice(0, 18).padEnd(18);
    const history = sessionHistoryLabel(transcriptMeta).slice(0, 9).padEnd(9);
    const lastMessage = formatTimestampForSessionList(
      transcriptMeta?.lastMessageAt,
      options?.timezone
    ).padEnd(8, ' ');
    console.log(
      chalk.dim(
        `${id}  ${agent}  ${status}  ${studio}  ${thread}  ${started.padEnd(7)}  ${backend}  ${history}  ${lastMessage}`
      )
    );
  }
  console.log('');
}

function printToolPolicySnapshot(
  toolPolicy: ToolPolicyState,
  sessionId: string | undefined,
  activeSkills: SkillInstruction[]
): void {
  const gate = toolPolicy.getBackendToolGate();
  console.log(chalk.bold('\nTool policy'));
  console.log(chalk.dim(`Path: ${toolPolicy.getPolicyPath()}`));
  console.log(chalk.dim(`Effective mode: ${toolPolicy.getMode()}`));
  console.log(chalk.dim(`Mutation scope: ${toolPolicy.getMutationScopeLabel()}`));
  console.log(chalk.dim(`Active scopes: ${toolPolicy.listActiveScopeLabels().join(' -> ')}`));
  console.log(chalk.dim(`Skill trust mode: ${toolPolicy.getSkillTrustMode()}`));
  console.log(chalk.dim(`Session visibility: ${toolPolicy.getSessionVisibility()}`));
  if (gate.mode === 'backend') {
    console.log(
      chalk.dim(
        `Backend passthrough allowlist (${gate.allowedTools.length}): ${
          gate.allowedTools.length > 0
            ? gate.allowedTools.join(', ')
            : '(empty; backend tools disabled)'
        }`
      )
    );
    if (gate.unresolvedPatterns.length > 0) {
      console.log(
        chalk.yellow(
          `Backend wildcard patterns require local/prompt execution: ${gate.unresolvedPatterns.join(', ')}`
        )
      );
    }
  }
  if (gate.mode === 'off') {
    console.log(chalk.dim('Backend passthrough mode is off (no backend tool calls permitted).'));
  }
  if (gate.mode === 'privileged') {
    console.log(
      chalk.dim('Backend passthrough mode is privileged (backend tool allowlist not clamped).')
    );
  }

  const grants = toolPolicy.listGrants();
  if (grants.length > 0) {
    console.log(
      chalk.dim(`Grants: ${grants.map((entry) => `${entry.tool}(${entry.uses})`).join(', ')}`)
    );
  }
  const allow = toolPolicy.listAllowTools();
  if (allow.length > 0) console.log(chalk.dim(`Allow: ${allow.join(', ')}`));
  const deny = toolPolicy.listDenyTools();
  if (deny.length > 0) console.log(chalk.dim(`Deny: ${deny.join(', ')}`));
  const prompt = toolPolicy.listPromptTools();
  if (prompt.length > 0) console.log(chalk.dim(`Prompt: ${prompt.join(', ')}`));

  const readAllow = toolPolicy.listReadPathAllow();
  const writeAllow = toolPolicy.listWritePathAllow();
  if (readAllow.length > 0) console.log(chalk.dim(`Read path allow: ${readAllow.join(', ')}`));
  if (writeAllow.length > 0) console.log(chalk.dim(`Write path allow: ${writeAllow.join(', ')}`));

  const skills = toolPolicy.listAllowedSkills();
  if (skills.length > 0) console.log(chalk.dim(`Allowed skills: ${skills.join(', ')}`));
  const sessionGrants = toolPolicy.listSessionGrants(sessionId);
  if (sessionGrants.length > 0) {
    console.log(
      chalk.dim(
        `Session grants: ${sessionGrants.map((entry) => `${entry.tool}(${entry.uses})`).join(', ')}`
      )
    );
  }
  const scoped = toolPolicy.listActiveScopeSnapshots();
  if (scoped.length > 0) {
    console.log(chalk.dim('Scope pipeline:'));
    for (const scope of scoped) {
      const fragments: string[] = [];
      if (scope.mode) fragments.push(`mode=${scope.mode}`);
      if (scope.skillTrustMode) fragments.push(`trust=${scope.skillTrustMode}`);
      if (scope.sessionVisibility) fragments.push(`visibility=${scope.sessionVisibility}`);
      if (scope.allowTools.length > 0) fragments.push(`allow=${scope.allowTools.join('|')}`);
      if (scope.denyTools.length > 0) fragments.push(`deny=${scope.denyTools.join('|')}`);
      if (scope.promptTools.length > 0) fragments.push(`prompt=${scope.promptTools.join('|')}`);
      if (scope.allowedSkills.length > 0) fragments.push(`skills=${scope.allowedSkills.join('|')}`);
      if (scope.readPathAllow.length > 0) fragments.push(`read=${scope.readPathAllow.join('|')}`);
      if (scope.writePathAllow.length > 0)
        fragments.push(`write=${scope.writePathAllow.join('|')}`);
      if (scope.grants.length > 0) {
        fragments.push(
          `grants=${scope.grants.map((entry) => `${entry.tool}(${entry.uses})`).join('|')}`
        );
      }
      console.log(
        chalk.dim(`  - ${scope.label}${fragments.length > 0 ? ` :: ${fragments.join('  ')}` : ''}`)
      );
    }
  }
  if (activeSkills.length > 0) {
    console.log(chalk.dim(`Active skills: ${activeSkills.map((skill) => skill.name).join(', ')}`));
  }
  console.log('');
}

function inboxMessageMatchesSessionScope(runtime: ChatRuntime, message: InboxMessage): boolean {
  if (
    runtime.sessionId &&
    message.relatedSessionId &&
    message.relatedSessionId !== runtime.sessionId
  ) {
    return false;
  }
  if (runtime.threadKey && message.threadKey && message.threadKey !== runtime.threadKey) {
    return false;
  }
  if (
    runtime.studioId &&
    message.recipientStudioId &&
    message.recipientStudioId !== runtime.studioId
  ) {
    return false;
  }
  if (runtime.threadKey) {
    if (message.threadKey) return message.threadKey === runtime.threadKey;
    if (runtime.sessionId && message.relatedSessionId) {
      return message.relatedSessionId === runtime.sessionId;
    }
    return false;
  }
  return true;
}

function filterSessionsByPolicy(
  sessions: SessionSummary[],
  runtime: ChatRuntime,
  agentId: string,
  toolPolicy: ToolPolicyState,
  action: 'list' | 'attach'
): SessionSummary[] {
  return sessions.filter(
    (session) =>
      toolPolicy.canAccessSession({
        action,
        requester: {
          sessionId: runtime.sessionId,
          threadKey: runtime.threadKey,
          studioId: runtime.studioId,
          workspaceId: runtime.workspaceId,
          agentId,
        },
        target: {
          sessionId: session.id,
          threadKey: session.threadKey,
          studioId: session.studioId,
          workspaceId: session.workspaceId,
          agentId: session.agentId,
        },
      }).allowed
  );
}

function buildAutoRunPromptFromInbox(runtime: ChatRuntime, message: InboxMessage): string {
  const from = message.from || 'unknown';
  const parts = [
    `Inbox task from ${from}${message.subject ? ` (${message.subject})` : ''}.`,
    message.threadKey ? `Thread: ${message.threadKey}.` : '',
    message.messageType ? `Message type: ${message.messageType}.` : '',
    '',
    message.content.trim(),
    '',
    'Handle this request now. If follow-up to sender is needed, send it before finishing.',
  ].filter(Boolean);

  return parts.join('\n');
}

function matchesAttachQuery(session: SessionSummary, query?: string): boolean {
  if (!query) return true;
  const haystack = `${session.id} ${session.agentId || ''} ${session.threadKey || ''} ${
    session.currentPhase || session.status || ''
  } ${session.backend || ''} ${session.model || ''} ${session.backendSessionId || session.claudeSessionId || ''} ${
    session.studioId || ''
  } ${session.workspaceId || ''}`.toLowerCase();
  return haystack.includes(query.toLowerCase());
}

async function pickSessionToAttach(
  sessions: SessionSummary[],
  query?: string,
  options?: { timezone?: string; studioId?: string }
): Promise<SessionSummary | undefined> {
  const candidates = sessions
    .filter((session) => matchesAttachQuery(session, query))
    .sort((a, b) => {
      const aStudioMatch = options?.studioId && a.studioId === options.studioId ? 1 : 0;
      const bStudioMatch = options?.studioId && b.studioId === options.studioId ? 1 : 0;
      if (aStudioMatch !== bStudioMatch) return bStudioMatch - aStudioMatch;

      const aMeta = getSessionTranscriptMetadata(a.id);
      const bMeta = getSessionTranscriptMetadata(b.id);
      const aHasHistory = (aMeta?.messageCount || 0) > 0 ? 1 : 0;
      const bHasHistory = (bMeta?.messageCount || 0) > 0 ? 1 : 0;
      if (aHasHistory !== bHasHistory) return bHasHistory - aHasHistory;

      const ams = a.startedAt ? Date.parse(a.startedAt) : 0;
      const bms = b.startedAt ? Date.parse(b.startedAt) : 0;
      return bms - ams;
    });
  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates[0];

  console.log(chalk.bold('\nSelect session to attach:\n'));
  for (let i = 0; i < candidates.length; i += 1) {
    const session = candidates[i]!;
    const phase = session.currentPhase || session.status || '-';
    const transcriptMeta = getSessionTranscriptMetadata(session.id);
    const historyMeta = sessionHistoryLabel(transcriptMeta);
    const lastMsg = formatTimestampForSessionList(transcriptMeta?.lastMessageAt, options?.timezone);
    const studioName = session.studioName || session.workspaceName;
    const thread = session.threadKey || '';

    // Compact two-line format: number + id + phase on line 1, details on line 2
    const num = String(i + 1).padStart(2, ' ');
    const parts = [
      phase,
      historyMeta,
      lastMsg !== '-' ? `last ${lastMsg}` : null,
      thread ? `thread:${thread}` : null,
      studioName || null,
    ].filter(Boolean);
    console.log(
      `  ${chalk.white(`${num}.`)} ${chalk.cyan(session.id.slice(0, 8))}  ${chalk.dim(parts.join('  ·  '))}`
    );
  }
  console.log('');

  const rl = createInterface({ input, output });
  try {
    const answer = (
      await rl.question(chalk.green('Attach which session? [number, Enter=cancel]: '))
    ).trim();
    if (!answer) return undefined;
    const index = Number.parseInt(answer, 10);
    if (Number.isNaN(index) || index < 1 || index > candidates.length) return undefined;
    return candidates[index - 1];
  } catch (error) {
    if (isAbortError(error) || isReadlineClosedError(error)) {
      console.log(chalk.dim('\nAttach cancelled.\n'));
      return undefined;
    }
    throw error;
  } finally {
    rl.close();
  }
}

function pickLatestSession(
  sessions: SessionSummary[],
  query?: string,
  options?: { studioId?: string }
): SessionSummary | undefined {
  const candidates = sessions.filter((session) => matchesAttachQuery(session, query));
  if (candidates.length === 0) return undefined;
  return candidates.sort((a, b) => {
    const aStudioMatch = options?.studioId && a.studioId === options.studioId ? 1 : 0;
    const bStudioMatch = options?.studioId && b.studioId === options.studioId ? 1 : 0;
    if (aStudioMatch !== bStudioMatch) return bStudioMatch - aStudioMatch;

    const aMeta = getSessionTranscriptMetadata(a.id);
    const bMeta = getSessionTranscriptMetadata(b.id);
    const aHasHistory = (aMeta?.messageCount || 0) > 0 ? 1 : 0;
    const bHasHistory = (bMeta?.messageCount || 0) > 0 ? 1 : 0;
    if (aHasHistory !== bHasHistory) return bHasHistory - aHasHistory;

    const ams = a.startedAt ? Date.parse(a.startedAt) : 0;
    const bms = b.startedAt ? Date.parse(b.startedAt) : 0;
    return bms - ams;
  })[0];
}

async function promptForToolApproval(
  rl: ReturnType<typeof createInterface> | null,
  toolPolicy: ToolPolicyState,
  sessionId: string | undefined,
  tool: string,
  reason: string,
  inkRepl?: InkRepl | null
): Promise<boolean> {
  let answer: string;
  if (inkRepl) {
    // Render a visually distinct permission prompt in Ink
    inkRepl.addMessage(
      'system',
      [
        `🔐 ${tool}`,
        reason,
        '',
        '[y] once · [s] session · [a] always · [d] deny · [n] cancel',
      ].join('\n'),
      { label: '🔐 permission' }
    );
    answer = (await inkRepl.waitForInput()).trim();
  } else if (rl) {
    console.log(chalk.yellow(`🔐 ${tool} — ${reason}`));
    answer = (
      await rl.question(
        chalk.yellow(`Allow? [y] once, [s] session, [a] always, [d] deny, [n] cancel: `)
      )
    ).trim();
  } else {
    return false;
  }

  const result = applyToolApprovalChoice({
    policy: toolPolicy,
    tool,
    sessionId,
    choice: parseToolApprovalInput(answer),
  });
  if (result.message) {
    if (inkRepl) {
      const label = result.approved ? '✅ granted' : '🚫 denied';
      inkRepl.addMessage('grant', `${tool}: ${result.message}`, { label });
    } else {
      const printer = result.approved ? chalk.green : chalk.yellow;
      console.log(printer(result.message));
    }
  }
  return result.approved;
}

function renderActiveSkills(skills: SkillInstruction[]): string {
  if (skills.length === 0) return '';
  return skills
    .map(
      (skill) =>
        `\n[Active skill: ${skill.name} from ${skill.source}]\n${skill.content || '(no skill content loaded)'}`
    )
    .join('\n');
}

/**
 * Format bootstrap result into a compact identity context string for prompt injection.
 * This is the primary mechanism for the backend to know who it is, who it's talking to,
 * and what it cares about.
 */
function formatBootstrapContext(result: Record<string, unknown>, agentId: string): string {
  const sections: string[] = [];

  // Identity files — the core of who the agent is
  const files = result.identityFiles as Record<string, string> | undefined;
  if (files) {
    if (files.values) sections.push(`--- VALUES.md ---\n${files.values.trim()}`);
    if (files.user) sections.push(`--- USER.md ---\n${files.user.trim()}`);
    if (files.soul) sections.push(`--- SOUL.md ---\n${files.soul.trim()}`);
    if (files.self) sections.push(`--- IDENTITY.md ---\n${files.self.trim()}`);
    if (files.process) sections.push(`--- PROCESS.md ---\n${files.process.trim()}`);
  }

  // Active projects + focus
  const ctx = result.activeContext as Record<string, unknown> | undefined;
  if (ctx) {
    const focus = ctx.focus as Record<string, string> | undefined;
    if (focus?.summary) {
      sections.push(`--- Current Focus ---\n${focus.summary}`);
    }
    const projects = ctx.projects as Array<Record<string, unknown>> | undefined;
    if (projects && projects.length > 0) {
      const lines = projects.map((p) => `- ${p.name} (${p.status}): ${p.description}`);
      sections.push(`--- Active Projects ---\n${lines.join('\n')}`);
    }
  }

  // Recent memories (knowledgeSummary is pre-formatted by bootstrap)
  const memories = result.knowledgeSummary as string | undefined;
  if (memories) {
    sections.push(`--- Recent Memories ---\n${memories}`);
  }

  // Skills
  const skills = result.skills as Array<Record<string, unknown>> | undefined;
  if (skills && skills.length > 0) {
    const eligible = skills.filter((s) => s.eligible);
    if (eligible.length > 0) {
      const lines = eligible.map((s) => `- ${s.displayName}: ${s.description}`);
      sections.push(`--- Available Skills ---\n${lines.join('\n')}`);
    }
  }

  if (sections.length === 0) return '';
  return sections.join('\n\n');
}

function buildPromptEnvelope(
  agentId: string,
  runtime: ChatRuntime,
  ledger: ContextLedger,
  userMessage: string
): string {
  // Reserve bootstrap context budget (not counted against transcript budget)
  const bootstrapTokens = runtime.bootstrapContext ? estimateTokens(runtime.bootstrapContext) : 0;
  const transcriptBudget = Math.max(0, runtime.maxContextTokens - bootstrapTokens);

  const transcript = ledger.buildPromptTranscript({
    maxTokens: transcriptBudget,
    includeSources: true,
  });

  return [
    `You are ${agentId}.`,
    'You are running inside sb chat (first-class PCP REPL).',
    'Answer in plain text. Be concise but complete.',
    `Current backend: ${runtime.backend}${runtime.model ? ` (${runtime.model})` : ''}.`,
    `Tool mode: ${runtime.toolMode}.`,
    `Tool routing: ${runtime.toolRouting}.`,
    runtime.toolMode === 'off'
      ? 'Do not call backend-native tools. Provide reasoning and instructions only.'
      : '',
    runtime.toolMode === 'privileged'
      ? 'Backend-native tools are enabled and external actions are allowed when needed.'
      : '',
    runtime.toolRouting === 'local'
      ? 'Backend-native tool calling is disabled for this run. If you need PCP tool access, emit fenced blocks in this exact format: ```pcp-tool {"tool":"tool_name","args":{}} ``` and continue with your plain-text answer.'
      : '',
    runtime.activeSkills.length > 0
      ? `Active skills: ${runtime.activeSkills.map((skill) => skill.name).join(', ')}`
      : '',
    runtime.threadKey ? `Thread key: ${runtime.threadKey}.` : '',
    // Identity context from bootstrap — always included
    runtime.bootstrapContext
      ? `\n=== Identity Context (from PCP bootstrap) ===\n${runtime.bootstrapContext}\n=== End Identity Context ===`
      : '',
    '',
    'Conversation transcript:',
    transcript || '(empty)',
    runtime.activeSkills.length > 0
      ? `\nSkill instructions:${renderActiveSkills(runtime.activeSkills)}`
      : '',
    '',
    'Latest user message:',
    userMessage,
  ]
    .filter(Boolean)
    .join('\n');
}

export async function runChat(options: ChatOptions): Promise<void> {
  if (options.tailTranscript) {
    await tailTranscript(options.tailTranscript);
    return;
  }

  const resolvedAgentId = resolveAgentId(options.agent);
  if (!resolvedAgentId) {
    throw new Error('Could not resolve agent identity. Run `sb init` or pass `--agent <id>`.');
  }
  const agentId: string = resolvedAgentId;
  const pcp = new PcpClient();
  const identity = readIdentityJson(process.cwd());
  let autoAttachedLatest = false;
  let contextBudgetAuto = !options.maxContextTokens;
  const initialBackend = options.backend || 'claude';
  const initialBackendTokenWindow = resolveBackendTokenWindow(initialBackend, options.model);
  const configuredMaxContextTokens = Number.parseInt(
    options.maxContextTokens || String(initialBackendTokenWindow),
    10
  );

  const runtime: ChatRuntime = {
    backend: initialBackend,
    model: options.model,
    verbose: options.verbose ?? false,
    toolMode:
      options.tools === 'off' ? 'off' : options.tools === 'privileged' ? 'privileged' : 'backend',
    toolRouting: options.toolRouting === 'local' ? 'local' : 'backend',
    uiMode: options.ui === 'scroll' ? 'scroll' : 'live',
    threadKey: options.threadKey,
    workspaceId: identity?.workspaceId,
    studioId: identity?.workspaceId,
    userTimezone: undefined,
    backendTokenWindow: initialBackendTokenWindow,
    sessionId: options.sessionId?.trim() || undefined,
    maxContextTokens: Number.isNaN(configuredMaxContextTokens)
      ? initialBackendTokenWindow
      : configuredMaxContextTokens,
    pollSeconds: Number.parseInt(options.pollSeconds || '20', 10),
    showSessionsWatch: false,
    eventPolling: true,
    autoRunInbox: options.autoRun ?? false,
    awayMode: false,
    transcriptPath: ensureRuntimeTranscriptPath(),
    activeSkills: [],
  };
  const approvalManager = new ApprovalRequestManager();
  const policyPathFromEnv = process.env.PCP_TOOL_POLICY_PATH?.trim();
  const toolPolicy = new ToolPolicyState(
    runtime.toolMode,
    policyPathFromEnv ? { policyPath: policyPathFromEnv } : undefined
  );
  toolPolicy.setContext({
    agentId,
    workspaceId: runtime.workspaceId,
    studioId: runtime.studioId,
  });
  if (runtime.studioId) {
    toolPolicy.setMutationScope('studio');
  } else if (runtime.workspaceId) {
    toolPolicy.setMutationScope('workspace');
  } else {
    toolPolicy.setMutationScope('agent');
  }
  runtime.toolMode = toolPolicy.getMode();

  // Apply --profile flag if provided
  if (options.profile) {
    if (isValidProfileId(options.profile)) {
      const profileResult = applyProfile(toolPolicy, options.profile);
      if (profileResult.success) {
        runtime.toolMode = toolPolicy.getMode();
        console.log(chalk.green(profileResult.message));
      }
    } else {
      console.log(
        chalk.yellow(
          `Unknown profile: ${options.profile}. Valid: minimal, safe, collaborative, full`
        )
      );
    }
  }

  const useInk = runtime.uiMode === 'live' && Boolean(output.isTTY);
  const statusLane = new LiveStatusLane(!useInk && Boolean(output.isTTY), runtime.userTimezone);
  // Build the info items used by both Ink and legacy dock
  const cwd = process.cwd();
  const parts = cwd.replace(process.env.HOME || '', '~').split('/');
  const shortCwd = parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : parts.join('/');
  let gitBranch = '';
  try {
    const { execSync } = await import('child_process');
    gitBranch = execSync('git rev-parse --abbrev-ref HEAD', { cwd, encoding: 'utf-8' }).trim();
  } catch {
    /* not a git repo */
  }
  const initialInfoItems = ['/help', 'ctrl+c ×2 quit', shortCwd, gitBranch].filter(Boolean);
  statusLane.setInfoItems(initialInfoItems);

  // Ink renderer — created lazily after the banner section has printed
  let inkRepl: InkRepl | null = null;

  let restorePromptAfterWrite: (() => void) | null = null;
  const printLine = (line = '') => {
    if (inkRepl) {
      // Strip empty lines — Ink handles spacing via layout
      if (line.trim()) {
        inkRepl.printSystem(line);
      }
      return;
    }
    statusLane.printLine(line);
    restorePromptAfterWrite?.();
  };

  const ledger = new ContextLedger();
  const seenInboxIds = new Set<string>();
  const seenActivityIds = new Set<string>();
  let pollTimer: NodeJS.Timeout | null = null;
  let sessionsCache: SessionSummary[] = [];
  let sessionsCacheAt = 0;
  let activitySince = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  let lastBackendUsage: BackendTokenUsage | undefined;
  let lastDelegation: DelegationState | undefined;
  let forceQuitAfterTurn = false;
  let readyForAutoRun = false;
  let enqueueAutoRunFromInbox: ((message: InboxMessage) => Promise<void>) | null = null;

  const bootstrapResult = (await pcp
    .callTool('bootstrap', { agentId })
    .catch((error) => ({ error: String(error) }))) as Record<string, unknown>;

  if (bootstrapResult.error) {
    console.log(chalk.yellow(`bootstrap unavailable: ${String(bootstrapResult.error)}`));
  } else {
    const suggestion = (bootstrapResult.reflectionStatus as Record<string, unknown> | undefined)
      ?.suggestion;
    const timezone = (bootstrapResult.user as Record<string, unknown> | undefined)?.timezone;
    if (typeof timezone === 'string' && timezone.trim()) {
      runtime.userTimezone = timezone;
      statusLane.setTimezone(timezone);
    }

    // Format and inject the full bootstrap context into the prompt envelope.
    // This is what gives the backend its identity, values, and memories.
    const ctx = formatBootstrapContext(bootstrapResult, agentId);
    if (ctx) {
      runtime.bootstrapContext = ctx;
      const ctxTokens = estimateTokens(ctx);
      console.log(
        chalk.dim(
          `Identity context loaded: ~${ctxTokens.toLocaleString()} tokens injected into prompt`
        )
      );
    }

    ledger.addEntry(
      'system',
      `Bootstrapped as ${agentId}${timezone ? ` (${String(timezone)})` : ''}${
        suggestion ? `. ${String(suggestion)}` : ''
      }`,
      'bootstrap'
    );
  }

  let attachedSessionSummary: SessionSummary | undefined;

  if ((options.attach || options.attachLatest) && !runtime.sessionId) {
    const attachQuery = typeof options.attach === 'string' ? options.attach.trim() : undefined;
    const attachLatestQuery =
      typeof options.attachLatest === 'string' ? options.attachLatest.trim() : undefined;
    const query = attachLatestQuery || attachQuery;
    const sessionsResult = (await pcp
      .callTool('list_sessions', { agentId, status: 'active', limit: 30 })
      .catch((error) => ({ error: String(error) }))) as Record<string, unknown>;

    if ((sessionsResult as Record<string, unknown>).error) {
      const modeLabel = options.attachLatest ? '--attach-latest' : '--attach';
      console.log(
        chalk.yellow(
          `Warning: ${modeLabel} unavailable (${String(
            (sessionsResult as { error?: string }).error
          )}). Unable to fetch active sessions; starting a new session instead.`
        )
      );
    } else {
      const sessions = filterSessionsByPolicy(
        extractSessionSummaries(sessionsResult),
        runtime,
        agentId,
        toolPolicy,
        'attach'
      );
      const selected = options.attachLatest
        ? pickLatestSession(sessions, query, { studioId: runtime.studioId })
        : await pickSessionToAttach(sessions, query, {
            timezone: runtime.userTimezone,
            studioId: runtime.studioId,
          });
      if (!selected) {
        throw new Error('No matching active session selected for attach.');
      }
      attachedSessionSummary = selected;
      runtime.sessionId = selected.id;
      if (selected.workspaceId) {
        runtime.workspaceId = selected.workspaceId;
      }
      if (selected.studioId) {
        runtime.studioId = selected.studioId;
      }
      if (!runtime.threadKey && selected.threadKey) {
        runtime.threadKey = selected.threadKey;
      }
      toolPolicy.setContext({
        agentId,
        workspaceId: runtime.workspaceId,
        studioId: runtime.studioId,
      });
      const currentScope = toolPolicy.getMutationScope();
      if (currentScope.scope !== 'global') {
        toolPolicy.setMutationScope(currentScope.scope);
      }
      runtime.toolMode = toolPolicy.getMode();
    }
  }

  if (
    !runtime.sessionId &&
    !options.new &&
    !options.attach &&
    !options.attachLatest &&
    !runtime.threadKey
  ) {
    const sessionsResult = (await pcp
      .callTool('list_sessions', { agentId, status: 'active', limit: 30 })
      .catch(() => null)) as Record<string, unknown> | null;
    const sessions = filterSessionsByPolicy(
      extractSessionSummaries(sessionsResult),
      runtime,
      agentId,
      toolPolicy,
      'attach'
    );
    const selected = pickLatestSession(sessions, undefined, { studioId: runtime.studioId });
    if (selected) {
      attachedSessionSummary = selected;
      runtime.sessionId = selected.id;
      if (selected.workspaceId) {
        runtime.workspaceId = selected.workspaceId;
      }
      if (selected.studioId) {
        runtime.studioId = selected.studioId;
      }
      if (!runtime.threadKey && selected.threadKey) {
        runtime.threadKey = selected.threadKey;
      }
      autoAttachedLatest = true;
      toolPolicy.setContext({
        agentId,
        workspaceId: runtime.workspaceId,
        studioId: runtime.studioId,
      });
      const currentScope = toolPolicy.getMutationScope();
      if (currentScope.scope !== 'global') {
        toolPolicy.setMutationScope(currentScope.scope);
      }
      runtime.toolMode = toolPolicy.getMode();
    }
  }

  const attachedToExistingSession = Boolean(runtime.sessionId);
  if (!runtime.sessionId) {
    const startArgs: Record<string, unknown> = { agentId };
    if (runtime.threadKey) startArgs.threadKey = runtime.threadKey;
    if (identity?.workspaceId) {
      startArgs.studioId = identity.workspaceId;
      // Backward compatibility for older server builds.
      startArgs.workspaceId = identity.workspaceId;
    }

    const sessionStartResult = (await pcp
      .callTool('start_session', startArgs)
      .catch((error) => ({ error: String(error) }))) as Record<string, unknown>;
    runtime.sessionId = extractSessionId(sessionStartResult);
  }

  if (attachedToExistingSession && runtime.sessionId && !attachedSessionSummary) {
    const sessionsResult = (await pcp
      .callTool('list_sessions', { agentId, status: 'active', limit: 80 })
      .catch(() => null)) as Record<string, unknown> | null;
    attachedSessionSummary = extractSessionSummaries(sessionsResult).find(
      (session) => session.id === runtime.sessionId
    );
    if (attachedSessionSummary) {
      if (!runtime.workspaceId && attachedSessionSummary.workspaceId) {
        runtime.workspaceId = attachedSessionSummary.workspaceId;
      }
      if (!runtime.studioId && attachedSessionSummary.studioId) {
        runtime.studioId = attachedSessionSummary.studioId;
      }
      if (!runtime.threadKey && attachedSessionSummary.threadKey) {
        runtime.threadKey = attachedSessionSummary.threadKey;
      }
    }
  }

  const existingTranscript =
    runtime.sessionId && attachedToExistingSession
      ? findLatestTranscriptForSession(runtime.sessionId)
      : undefined;
  runtime.transcriptPath = existingTranscript || ensureRuntimeTranscriptPath(runtime.sessionId);
  let historyHydration: HistoryHydrationResult | null = null;
  if (attachedToExistingSession && existingTranscript) {
    const hydrated = hydrateLedgerFromTranscript(ledger, existingTranscript);
    historyHydration = {
      loaded: hydrated.loaded,
      messageCount: hydrated.messageCount,
      source: 'repl-transcript',
      transcriptPath: existingTranscript,
      tailPreview: hydrated.tailPreview,
      seenInboxIds: hydrated.seenInboxIds,
      seenActivityIds: hydrated.seenActivityIds,
    };
    for (const inboxId of hydrated.seenInboxIds) {
      seenInboxIds.add(inboxId);
    }
    for (const activityId of hydrated.seenActivityIds) {
      seenActivityIds.add(activityId);
    }
  } else if (attachedToExistingSession && runtime.sessionId) {
    const sessionContextResult = (await pcp
      .callTool('get_session_context', { sessionId: runtime.sessionId, limit: 120 })
      .catch(() => null)) as Record<string, unknown> | null;
    const contextMessages = extractSessionContextMessages(sessionContextResult);
    if (contextMessages.length > 0) {
      historyHydration = hydrateLedgerFromSessionContext(ledger, contextMessages);
    } else {
      historyHydration = {
        loaded: 0,
        messageCount: 0,
        source: 'none',
        tailPreview: [],
      };
    }
  }

  appendTranscript(runtime.transcriptPath, {
    type: attachedToExistingSession ? 'session_attach' : 'session_start',
    agentId,
    backend: runtime.backend,
    model: runtime.model || null,
    threadKey: runtime.threadKey || null,
    sessionId: runtime.sessionId || null,
    studioId: runtime.studioId || null,
    workspaceId: runtime.workspaceId || null,
    historySource: historyHydration?.source || null,
    attachedBackend: attachedSessionSummary?.backend || null,
    attachedModel: attachedSessionSummary?.model || null,
  });

  if (runtime.sessionId && !attachedToExistingSession) {
    await pcp
      .callTool('update_session_phase', {
        agentId,
        sessionId: runtime.sessionId,
        phase: 'investigating',
        status: 'active',
      })
      .catch(() => undefined);
  }

  // ── Banner (prints before Ink mounts, goes to terminal scrollback) ──
  {
    const bannerWidth = Math.min(process.stdout.columns || 80, 60);
    const bar = '━'.repeat(Math.max(0, bannerWidth - 2));
    console.log(chalk.magentaBright(`\n✦${bar}✦`));
    console.log(chalk.bold.white('  SB Chat'));
    console.log(chalk.magentaBright(`✦${bar}✦`));
  }
  // Use studio slug/name where available, fall back to short ID
  const studioSlug =
    attachedSessionSummary?.studioName ||
    attachedSessionSummary?.workspaceName ||
    (identity?.workspaceId ? formatStudioForDisplay(identity.workspaceId, 'short') : undefined);
  const bannerParts = [
    chip('agent', agentId, chalk.cyan),
    chip(
      'backend',
      `${runtime.backend}${runtime.model ? ` (${runtime.model})` : ''}`,
      chalk.yellow
    ),
    studioSlug ? chip('studio', studioSlug, chalk.cyan) : null,
    chip('window', `${formatTokenCount(runtime.backendTokenWindow)} tok`, chalk.green),
    chip('time', formatNow(runtime.userTimezone), chalk.magenta),
  ].filter(Boolean);
  console.log(bannerParts.join(chalk.dim('  •  ')));
  if (runtime.threadKey) console.log(chalk.dim(`Thread: ${runtime.threadKey}`));
  if (attachedToExistingSession) {
    console.log(
      chalk.dim(
        autoAttachedLatest ? 'Auto-attached to latest session' : 'Attached to existing session'
      )
    );
  }
  if (historyHydration && historyHydration.messageCount > 0) {
    console.log(chalk.dim(`History: ${historyHydration.messageCount} prior message(s) loaded`));
  }
  console.log(chalk.dim('Type /help for commands.\n'));

  const refreshSessionsSnapshot = async (force = false): Promise<SessionSummary[]> => {
    const stale = Date.now() - sessionsCacheAt > 15_000;
    if (!force && !stale) return sessionsCache;
    const result = (await pcp
      .callTool('list_sessions', { limit: 20, status: 'active' })
      .catch(() => null)) as Record<string, unknown> | null;
    sessionsCache = filterSessionsByPolicy(
      extractSessionSummaries(result),
      runtime,
      agentId,
      toolPolicy,
      'list'
    );
    sessionsCacheAt = Date.now();
    return sessionsCache;
  };

  const trimContextToPercent = async (
    targetPercent: number,
    reason: string
  ): Promise<{ removed: number; removedTokens: number }> => {
    const targetTokens = Math.max(
      1,
      Math.floor((runtime.maxContextTokens * Math.max(1, Math.min(99, targetPercent))) / 100)
    );
    const trim = ledger.trimOldestToTokenBudget(targetTokens, AUTO_TRIM_KEEP_RECENT_ENTRIES);
    if (trim.removedEntries.length === 0) {
      return { removed: 0, removedTokens: 0 };
    }

    const note = `Trimmed ${trim.removedEntries.length} entries (~${trim.removedTokens} tok) to ${targetPercent}% budget (${reason}).`;
    console.log(chalk.yellow(note));
    appendTranscript(runtime.transcriptPath, {
      type: 'context_trim',
      reason,
      targetPercent,
      removedCount: trim.removedEntries.length,
      removedTokens: trim.removedTokens,
      totalAfter: trim.totalAfter,
    });

    return { removed: trim.removedEntries.length, removedTokens: trim.removedTokens };
  };

  const pollInbox = async (force = false): Promise<number> => {
    const inboxResult = (await pcp
      .callTool('get_inbox', { agentId, status: 'unread', limit: 10 })
      .catch(() => null)) as Record<string, unknown> | null;
    const messages = extractInboxMessages(inboxResult);
    const fresh = messages
      .filter((msg) => !seenInboxIds.has(msg.id))
      .filter((msg) => inboxMessageMatchesSessionScope(runtime, msg))
      .filter(
        (msg) =>
          toolPolicy.canAccessSession({
            action: 'inbox',
            requester: {
              sessionId: runtime.sessionId,
              threadKey: runtime.threadKey,
              studioId: runtime.studioId,
              workspaceId: runtime.workspaceId,
              agentId,
            },
            target: {
              sessionId: msg.relatedSessionId,
              threadKey: msg.threadKey,
              studioId: msg.recipientStudioId,
              workspaceId: runtime.workspaceId,
              agentId,
            },
          }).allowed
      )
      .sort((a, b) => safeDateMs(a.createdAt) - safeDateMs(b.createdAt));
    let autoRuns = 0;

    // Process permission grants separately — they modify local policy, not chat flow.
    const permissionGrants = fresh.filter((msg) => msg.messageType === 'permission_grant');
    const nonGrantMessages = fresh.filter((msg) => msg.messageType !== 'permission_grant');
    for (const msg of permissionGrants) {
      seenInboxIds.add(msg.id);
      const grant = parsePermissionGrant(msg.metadata);
      if (!grant) {
        printLine(
          chalk.yellow(
            `Received malformed permission grant from ${msg.from || 'unknown'} — ignoring.`
          )
        );
        continue;
      }
      const result = applyPermissionGrant({
        policy: toolPolicy,
        grant,
        sessionId: runtime.sessionId,
      });

      // Resolve pending approval requests if this grant matches
      if (grant.requestId && approvalManager.hasPending(grant.requestId)) {
        const decision = grant.action === 'deny' ? 'denied' : 'approved';
        approvalManager.resolve(grant.requestId, decision, msg.from);
      } else {
        // Try matching by tool name for grants without explicit requestId
        for (const tool of grant.tools) {
          const pending = approvalManager.findPendingForTool(tool);
          if (pending) {
            const decision = grant.action === 'deny' ? 'denied' : 'approved';
            approvalManager.resolve(pending.id, decision, msg.from);
          }
        }
      }

      const from = msg.from || 'remote';
      const action = grant.action;
      const label =
        action === 'deny' ? '🚫 denied' : action === 'revoke' ? '↩ revoked' : '✅ granted';
      if (inkRepl) {
        inkRepl.addMessage('grant', result.summary, {
          label,
          time: formatHumanTime(msg.createdAt, runtime.userTimezone),
          trailingMeta: `from ${from}`,
        });
      } else {
        printLine('');
        printLine(
          renderMessageLine('grant', result.summary, {
            label,
            timezone: runtime.userTimezone,
            ts: msg.createdAt,
            trailingMeta: `from ${from}`,
          })
        );
      }
      appendTranscript(runtime.transcriptPath, {
        type: 'permission_grant',
        messageId: msg.id,
        action,
        tools: grant.tools,
        summary: result.summary,
        from,
        createdAt: msg.createdAt || null,
      });
    }

    // Partition non-grant messages into collapsed (old) and expanded (recent).
    // Ink uses a 24-hour threshold; legacy uses 5-day.
    const isCollapsed = inkRepl
      ? (msg: InboxMessage) => isOlderThan24Hours(msg.createdAt)
      : (msg: InboxMessage) => isOlderThan5Days(msg.createdAt);
    const oldMessages = nonGrantMessages.filter(isCollapsed);
    const recentMessages = nonGrantMessages.filter((msg) => !isCollapsed(msg));
    // Show collapsed summary for old messages
    if (oldMessages.length > 0) {
      for (const msg of oldMessages) {
        seenInboxIds.add(msg.id);
        if (!runtime.threadKey && msg.threadKey) {
          runtime.threadKey = msg.threadKey;
        }
        const from = msg.from || 'unknown';
        const heading = msg.subject ? `${from} — ${msg.subject}` : from;
        const rendered = `📥 ${heading}: ${msg.content}`.trim();
        ledger.addEntry('inbox', compactForLedger(rendered), 'pcp-inbox');
        appendTranscript(runtime.transcriptPath, {
          type: 'inbox',
          messageId: msg.id,
          rendered,
          createdAt: msg.createdAt || null,
          delegationToken: msg.delegationToken || null,
          messageType: msg.messageType || null,
          relatedSessionId: msg.relatedSessionId || null,
        });
      }
      if (inkRepl) {
        // Show one-line summaries for each collapsed message
        const summaries = oldMessages.map((msg) => {
          const from = msg.from || 'unknown';
          const subj = msg.subject ? ` — ${msg.subject}` : '';
          return `${from}${subj}`;
        });
        inkRepl.addMessage(
          'system',
          `${oldMessages.length} older message(s): ${summaries.join(', ')}. Use /inbox to expand.`
        );
      } else {
        printLine('');
        printLine(renderCollapsedInbox(oldMessages.length));
      }
    }
    for (const msg of recentMessages) {
      seenInboxIds.add(msg.id);
      if (!runtime.threadKey && msg.threadKey) {
        runtime.threadKey = msg.threadKey;
      }
      const from = msg.from || 'unknown';
      const heading = msg.subject ? `${from} — ${msg.subject}` : from;
      let delegationLabel = '';
      if (msg.delegationToken) {
        const secret = getDelegationSecret();
        if (!secret) {
          delegationLabel = ' [delegation:unverified:no-secret]';
        } else {
          const verified = verifyDelegationToken(msg.delegationToken, secret, {
            expectedDelegateeAgentId: agentId,
            expectedThreadKey: runtime.threadKey ?? undefined,
          });
          if (verified.valid && verified.payload) {
            const scopes = verified.payload.scopes.join(',');
            delegationLabel = ` [delegation:${verified.payload.iss}->${verified.payload.sub}:${scopes}]`;
          } else {
            delegationLabel = ` [delegation:invalid:${verified.error}]`;
          }
        }
      }
      const rendered = `📥 ${heading}${delegationLabel}: ${msg.content}`.trim();
      ledger.addEntry('inbox', compactForLedger(rendered), 'pcp-inbox');
      appendTranscript(runtime.transcriptPath, {
        type: 'inbox',
        messageId: msg.id,
        rendered,
        createdAt: msg.createdAt || null,
        delegationToken: msg.delegationToken || null,
        messageType: msg.messageType || null,
        relatedSessionId: msg.relatedSessionId || null,
      });
      if (inkRepl) {
        // Emoji in label, clean content without emoji prefix
        const inboxContent = `${heading}${delegationLabel}: ${msg.content}`.trim();
        inkRepl.addMessage('inbox', inboxContent, {
          label: '📬 inbox',
          time: formatHumanTime(msg.createdAt, runtime.userTimezone),
        });
      } else {
        printLine('');
        printLine(separator());
        printLine(
          renderMessageLine('inbox', rendered, {
            timezone: runtime.userTimezone,
            ts: msg.createdAt,
          })
        );
        printLine(separator());
      }

      const eligibleForAutoRun =
        runtime.autoRunInbox &&
        readyForAutoRun &&
        enqueueAutoRunFromInbox &&
        (msg.from || '').toLowerCase() !== agentId.toLowerCase() &&
        msg.messageType !== 'notification' &&
        msg.content.trim().length > 0;

      const autoRunHandler = enqueueAutoRunFromInbox;
      if (eligibleForAutoRun && autoRunHandler) {
        await autoRunHandler(msg);
        autoRuns += 1;
      }
    }

    if (force && fresh.length === 0) {
      printLine(chalk.dim('No new inbox messages.'));
    }
    if (autoRuns > 0) {
      printLine(
        chalk.green(`Auto-run processed ${autoRuns} inbox message${autoRuns === 1 ? '' : 's'}.`)
      );
    }
    emitStatusLaneIfChanged();
    return fresh.length;
  };

  const pollActivity = async (force = false): Promise<number> => {
    const activityResult = (await pcp
      .callTool('get_activity', {
        agentId,
        limit: 40,
        since: activitySince,
      })
      .catch(() => null)) as Record<string, unknown> | null;

    const activities = extractActivitySummaries(activityResult)
      .filter((activity) => !seenActivityIds.has(activity.id))
      // Ignore raw local transcript echoes for this same session; inbox handles human-facing notices.
      .filter(
        (activity) =>
          !(activity.sessionId && runtime.sessionId && activity.sessionId === runtime.sessionId)
      )
      .filter(
        (activity) =>
          toolPolicy.canAccessSession({
            action: 'events',
            requester: {
              sessionId: runtime.sessionId,
              threadKey: runtime.threadKey,
              studioId: runtime.studioId,
              workspaceId: runtime.workspaceId,
              agentId,
            },
            target: {
              sessionId: activity.sessionId,
              threadKey: runtime.threadKey,
              studioId: runtime.studioId,
              workspaceId: runtime.workspaceId,
              agentId: activity.agentId,
            },
          }).allowed
      )
      .sort((a, b) => safeDateMs(a.createdAt) - safeDateMs(b.createdAt));

    for (const activity of activities) {
      seenActivityIds.add(activity.id);
      if (activity.createdAt && activity.createdAt > activitySince) {
        activitySince = activity.createdAt;
      }

      const type = activity.subtype
        ? `${activity.type}:${activity.subtype}`
        : activity.type || 'activity';
      const actor = activity.agentId || 'system';
      const preview = (activity.content || '').replace(/\\s+/g, ' ').trim().slice(0, 200);
      const rendered = `⚡ ${actor} ${type}${preview ? ` — ${preview}` : ''}`;

      ledger.addEntry('system', compactForLedger(rendered, 320), 'pcp-activity');
      appendTranscript(runtime.transcriptPath, {
        type: 'activity',
        activityId: activity.id,
        activityType: activity.type || null,
        activitySubtype: activity.subtype || null,
        agentId: activity.agentId || null,
        sessionId: activity.sessionId || null,
        createdAt: activity.createdAt || null,
        content: activity.content || null,
      });
      if (inkRepl) {
        inkRepl.addMessage('activity', `${actor} ${type}${preview ? ` — ${preview}` : ''}`, {
          label: '⚡',
        });
      } else {
        printLine('');
        printLine(
          renderMessageLine('activity', `${actor} ${type}${preview ? ` — ${preview}` : ''}`, {
            label: '⚡',
            timezone: runtime.userTimezone,
            ts: activity.createdAt,
          })
        );
      }
    }

    if (force && activities.length === 0) {
      printLine(chalk.dim('No new activity events.'));
    }
    emitStatusLaneIfChanged();
    return activities.length;
  };

  const runUserTurn = async (raw: string, source: 'user' | 'inbox-auto' = 'user') => {
    if (!raw.trim()) return;
    if (source === 'user') {
      // Echo the user's message
      if (inkRepl) {
        inkRepl.addMessage('user', raw, { label: 'you' });
      } else {
        printLine(
          renderMessageLine('user', raw, {
            label: 'you',
            timezone: runtime.userTimezone,
          })
        );
        printLine('');
      }
      ledger.addEntry('user', raw, 'repl');
      appendTranscript(runtime.transcriptPath, { type: 'user', content: raw });
    } else {
      ledger.addEntry('system', compactForLedger(`[auto-run inbox] ${raw}`, 500), 'auto-run');
      appendTranscript(runtime.transcriptPath, { type: 'auto_turn', content: raw });
    }

    if (runtime.sessionId) {
      await pcp
        .callTool('update_session_phase', {
          agentId,
          sessionId: runtime.sessionId,
          phase: 'implementing',
          status: 'active',
        })
        .catch(() => undefined);
    }

    const prompt = buildPromptEnvelope(agentId, runtime, ledger, raw);
    const turnStartedAt = Date.now();
    const backendGate = toolPolicy.getBackendToolGate();
    const passthroughArgs =
      runtime.toolRouting !== 'backend'
        ? ['--allowedTools', '']
        : backendGate.mode === 'off'
          ? ['--allowedTools', '']
          : backendGate.mode === 'privileged'
            ? []
            : ['--allowedTools', backendGate.allowedTools.join(',')];

    if (runtime.toolRouting === 'backend' && backendGate.mode === 'backend' && runtime.verbose) {
      printLine(
        chalk.dim(
          `Backend tool gate: ${backendGate.allowedTools.length} allowed tool(s)${
            backendGate.unresolvedPatterns.length > 0
              ? `, unresolved patterns=${backendGate.unresolvedPatterns.join(', ')}`
              : ''
          }`
        )
      );
    }

    // Ink handles waiting via its own component; legacy uses animated indicator
    const stopWaiting = inkRepl
      ? (() => {
          /* Ink waiting managed by enqueueTurn via setWaiting */ return () => {};
        })()
      : startWaitingIndicator(runtime.backend, {
          statusLane,
          logger: printLine,
          renderAbovePrompt: true,
        });
    let turnDurationSeconds = 0;
    let turnCtrlCAt = 0;
    const onSigintDuringTurn = () => {
      const now = Date.now();
      if (turnCtrlCAt > 0 && now - turnCtrlCAt <= CTRL_C_EXIT_WINDOW_MS) {
        forceQuitAfterTurn = true;
        if (inkRepl) {
          inkRepl.printSystem('Will exit after current backend turn completes.');
        } else {
          statusLane.renderHint('Will exit after current backend turn completes.');
        }
        return;
      }
      turnCtrlCAt = now;
      if (inkRepl) {
        inkRepl.printSystem(
          'Backend turn in progress. Press Ctrl+C again to exit after this turn.'
        );
      } else {
        statusLane.renderHint(
          'Backend turn in progress. Press Ctrl+C again to exit after this turn.'
        );
      }
    };
    process.on('SIGINT', onSigintDuringTurn);
    const runResult = await runBackendTurn({
      backend: runtime.backend,
      agentId,
      model: runtime.model,
      prompt,
      verbose: runtime.verbose,
      passthroughArgs,
    }).finally(() => {
      process.off('SIGINT', onSigintDuringTurn);
      turnDurationSeconds = Math.max(0, Math.round((Date.now() - turnStartedAt) / 1000));
      stopWaiting();
    });

    // Log backend CLI turn completion to activity stream
    if (runtime.sessionId) {
      const turnStatus = runResult.success ? 'completed' : 'failed';
      const turnContent = runResult.success
        ? `Backend turn completed (${runtime.backend}, ${turnDurationSeconds}s)`
        : `Backend turn failed (${runtime.backend}, exit ${runResult.exitCode})`;
      const cliErrorClassification = !runResult.success
        ? classifyError({
            errorText: runResult.stderr,
            backend: runtime.backend,
            exitCode: runResult.exitCode,
          })
        : null;

      pcp
        .callTool('log_activity', {
          agentId,
          type: runResult.success ? 'agent_complete' : 'error',
          subtype: `backend_cli:${runtime.backend}`,
          content: turnContent,
          sessionId: runtime.sessionId,
          status: turnStatus,
          payload: {
            backend: runtime.backend,
            exitCode: runResult.exitCode,
            durationMs: turnDurationSeconds * 1000,
            studioId: runtime.studioId,
            ...(runResult.success ? {} : { stderr: runResult.stderr.slice(0, 2000) }),
            ...(cliErrorClassification
              ? {
                  errorCategory: cliErrorClassification.category,
                  errorSummary: cliErrorClassification.summary,
                  retryable: cliErrorClassification.retryable,
                }
              : {}),
            ...(runResult.usage ? { usage: runResult.usage } : {}),
          },
        })
        .catch(() => undefined);
    }

    let responseText = runResult.stdout.trim();
    if (!responseText && runResult.stderr.trim()) {
      responseText = runResult.stderr.trim();
    }
    if (!responseText) {
      responseText = '(no output)';
    }

    const localToolCalls =
      runtime.toolRouting === 'local' ? extractLocalToolCalls(responseText).slice(0, 5) : [];
    if (localToolCalls.length > 0) {
      await executeToolCalls(localToolCalls, {
        policy: toolPolicy,
        callTool: (tool, args) => pcp.callTool(tool, args),
        sessionId: runtime.sessionId,
        promptForApproval: async (tool, reason) => {
          if (!runtime.awayMode) {
            return promptForToolApproval(rl, toolPolicy, runtime.sessionId, tool, reason, inkRepl);
          }
          // Remote approval: register request, send to inbox, wait for resolution
          const { request, promise } = approvalManager.register(tool, {}, reason);
          printLine(
            chalk.yellow(`⏳ Awaiting remote approval for ${tool} (${request.id.slice(0, 8)}…)`)
          );
          try {
            await pcp.callTool('send_to_inbox', {
              recipientAgentId: agentId,
              senderAgentId: agentId,
              content: `🔐 Tool approval needed: **${tool}**\n\nReason: ${reason}\n\nReply with a permission_grant to approve or deny.\nRequest ID: ${request.id}`,
              messageType: 'notification',
              metadata: { approvalRequestId: request.id, tool },
              ...(runtime.threadKey ? { threadKey: runtime.threadKey } : {}),
              trigger: false,
            });
          } catch {
            printLine(
              chalk.yellow('Failed to send remote approval request — falling back to local prompt')
            );
            approvalManager.expire(request.id);
            return promptForToolApproval(rl, toolPolicy, runtime.sessionId, tool, reason, inkRepl);
          }
          const response = await promise;
          if (response.decision === 'approved') {
            printLine(
              chalk.green(
                `✅ Remote approval granted for ${tool}${response.resolvedBy ? ` by ${response.resolvedBy}` : ''}`
              )
            );
            return true;
          } else if (response.decision === 'timeout') {
            printLine(chalk.yellow(`⏰ Remote approval timed out for ${tool}`));
            return false;
          } else {
            printLine(chalk.yellow(`🚫 Remote approval denied for ${tool}`));
            return false;
          }
        },
        onResult: (result: ToolCallResult) => {
          if (result.status === 'blocked' || result.status === 'denied') {
            const msg = `Local tool ${result.status} (${result.tool}): ${result.reason}`;
            printLine(chalk.yellow(msg));
            appendTranscript(runtime.transcriptPath, {
              type: 'local_tool_call',
              tool: result.tool,
              args: result.args,
              status: result.status,
              reason: result.reason,
            });
            ledger.addEntry('system', compactForLedger(msg, 400), 'local-tool');
          } else if (result.status === 'executed' || result.status === 'approved') {
            const resultJson = JSON.stringify(result.result);
            printLine(chalk.cyan(`🛠 local tool ${result.tool} ${resultJson}`));
            appendTranscript(runtime.transcriptPath, {
              type: 'local_tool_call',
              tool: result.tool,
              args: result.args,
              status: result.status,
              result: result.result,
            });
            ledger.addEntry(
              'system',
              compactForLedger(`local tool ${result.tool} -> ${resultJson}`, 500),
              'local-tool'
            );
          } else if (result.status === 'error') {
            const msg = `Local tool error (${result.tool}): ${result.error}`;
            printLine(chalk.red(msg));
            appendTranscript(runtime.transcriptPath, {
              type: 'local_tool_call',
              tool: result.tool,
              args: result.args,
              status: 'error',
              error: result.error,
            });
            ledger.addEntry('system', compactForLedger(msg, 400), 'local-tool');
          }
        },
      });
    }

    const assistantDisplayText =
      runtime.toolRouting === 'local'
        ? (() => {
            const stripped = stripLocalToolBlocks(responseText);
            if (stripped) return stripped;
            if (localToolCalls.length > 0)
              return '(local tool call emitted; see tool results above)';
            return responseText;
          })()
        : responseText;

    ledger.addEntry('assistant', assistantDisplayText, runtime.backend);
    appendTranscript(runtime.transcriptPath, {
      type: 'assistant',
      backend: runtime.backend,
      model: runtime.model || null,
      success: runResult.success,
      exitCode: runResult.exitCode,
      durationMs: runResult.durationMs,
      stderr: runResult.stderr || null,
      content: assistantDisplayText,
      rawContent: responseText,
      approxTokens: estimateTokens(assistantDisplayText),
      usage: runResult.usage || null,
    });
    lastBackendUsage = runResult.usage;

    if (!runResult.success) {
      printLine(chalk.red(`\n[${runtime.backend}] exit=${runResult.exitCode}`));
      if (runResult.stderr) {
        printLine(chalk.dim(runResult.stderr));
      }
    }

    if (inkRepl) {
      const usageMeta = runResult.usage ? formatBackendTokenUsage(runResult.usage) : undefined;
      const trailingParts = [`${turnDurationSeconds}s`, usageMeta].filter(Boolean).join('  ·  ');
      inkRepl.addMessage('assistant', assistantDisplayText, {
        label: agentId,
        trailingMeta: trailingParts,
      });
    } else {
      printLine('');
      printLine(
        renderMessageLine('assistant', assistantDisplayText, {
          label: agentId,
          timezone: runtime.userTimezone,
          trailingMeta: `${turnDurationSeconds}s`,
        })
      );
      if (runResult.usage) {
        printLine(chalk.dim(`    ↳ ${formatBackendTokenUsage(runResult.usage)}`));
      }
      printLine('');
    }
  };

  let turnQueue: Promise<void> = Promise.resolve();
  let pendingTurns = 0;
  let lastStatusSummary = '';
  const emitStatusLaneIfChanged = (force = false) => {
    const summary = buildContextStatusSummary({
      ledger,
      maxContextTokens: runtime.maxContextTokens,
      backendTokenWindow: runtime.backendTokenWindow,
      pendingTurns,
      backend: runtime.backend,
      bootstrapTokens: runtime.bootstrapContext ? estimateTokens(runtime.bootstrapContext) : 0,
    });
    if (inkRepl) {
      if (force || summary !== lastStatusSummary) {
        inkRepl.setStatus(summary);
        lastStatusSummary = summary;
      }
      return;
    }
    if (force || summary !== lastStatusSummary || statusLane.shouldRefreshAfterPrompt()) {
      statusLane.renderSummary(summary, force);
      lastStatusSummary = summary;
      statusLane.markPromptRefreshed();
    }
  };
  const enqueueTurn = (raw: string, source: 'user' | 'inbox-auto' = 'user'): Promise<void> => {
    pendingTurns += 1;
    emitStatusLaneIfChanged();
    const run = async () => {
      if (inkRepl) {
        inkRepl.setWaiting(true, runtime.backend);
      } else {
        statusLane.setTurnActive(true);
      }
      try {
        await runUserTurn(raw, source);
      } catch (error) {
        printLine(chalk.red(`Turn failed: ${String(error)}`));
      } finally {
        if (inkRepl) {
          inkRepl.setWaiting(false);
        } else {
          statusLane.setTurnActive(false);
        }
        pendingTurns = Math.max(0, pendingTurns - 1);
        emitStatusLaneIfChanged();
        // Restore the dock now that the turn is done (if prompt is waiting)
        restorePromptAfterWrite?.();
      }
    };
    turnQueue = turnQueue.then(run, run);
    return turnQueue;
  };

  enqueueAutoRunFromInbox = async (message: InboxMessage) => {
    const prompt = buildAutoRunPromptFromInbox(runtime, message);
    await enqueueTurn(prompt, 'inbox-auto');
  };
  readyForAutoRun = true;

  // Prime with current unread queue only after auto-run pipeline is ready.
  await pollInbox(false);
  await pollActivity(false);

  pollTimer = setInterval(
    () => {
      void pollInbox(false);
      if (runtime.eventPolling) {
        void pollActivity(false);
      }
    },
    Math.max(runtime.pollSeconds, 5) * 1000
  );
  // Status update deferred until after Ink/readline mount below
  if (!useInk) {
    emitStatusLaneIfChanged();
  }

  if (options.nonInteractive || options.message) {
    const message = options.message?.trim();
    if (!message) {
      throw new Error('--non-interactive requires --message "<text>"');
    }
    await enqueueTurn(message);
    if (pollTimer) clearInterval(pollTimer);
    const summary = summarizeForSessionEnd(ledger);
    if (runtime.sessionId && !attachedToExistingSession) {
      await pcp
        .callTool('end_session', { agentId, sessionId: runtime.sessionId, summary })
        .catch(() => undefined);
    }
    appendTranscript(runtime.transcriptPath, {
      type: 'session_end',
      sessionId: runtime.sessionId || null,
      summary,
      attached: attachedToExistingSession,
    });
    return;
  }

  // ── Mount the REPL input layer (Ink or legacy readline) ──

  let readlineClosed = false;
  let rl: ReturnType<typeof createInterface> | null = null;
  let keepRunning = true;
  let lastUsageTotal: number | undefined;
  let lastCtrlCAt = 0;
  let lastSigintAt = 0;
  let exitAfterTurnNoticeShown = false;
  let activePromptLabel = `${agentId}> `;

  if (useInk) {
    // ── Ink path ──
    inkRepl = renderInkChat({
      agentId,
      timezone: runtime.userTimezone,
      infoItems: initialInfoItems,
      fullscreen: !!options.fullscreen,
    });
    // Initial status update — ChatApp starts with 'waiting for input'
    // so push the real context budget summary immediately
    const initialSummary = buildContextStatusSummary({
      ledger,
      maxContextTokens: runtime.maxContextTokens,
      backendTokenWindow: runtime.backendTokenWindow,
      pendingTurns: 0,
      backend: runtime.backend,
      bootstrapTokens: runtime.bootstrapContext ? estimateTokens(runtime.bootstrapContext) : 0,
    });
    inkRepl.setStatus(initialSummary);
    lastStatusSummary = initialSummary;

    // Push prior messages into Ink scrollback so user sees conversation history
    if (historyHydration && historyHydration.tailPreview.length > 0) {
      for (const entry of historyHydration.tailPreview) {
        const role =
          entry.role === 'user'
            ? ('user' as const)
            : entry.role === 'assistant'
              ? ('assistant' as const)
              : ('inbox' as const);
        const label =
          entry.role === 'user' ? 'you' : entry.role === 'assistant' ? agentId : '📬 inbox';
        inkRepl.addMessage(role, entry.content, {
          label,
          time: formatHumanTime(entry.ts, runtime.userTimezone),
        });
      }
    }
  } else {
    // ── Legacy readline path ──
    const createRl = () => {
      const iface = createInterface({ input, output });
      iface.on('close', () => {
        readlineClosed = true;
      });
      return iface;
    };
    rl = createRl();
    const onPromptSigint = () => {
      lastSigintAt = Date.now();
    };
    process.on('SIGINT', onPromptSigint);
    restorePromptAfterWrite = () => {
      if (!statusLane.isLive() || !statusLane.isPromptActive() || readlineClosed) return;
      if (statusLane.isTurnActive()) return;
      const currentLine = (rl as unknown as { line?: string })?.line || '';
      output.write(chalk.green(statusLane.buildPromptLabel(activePromptLabel)));
      if (currentLine) {
        output.write(currentLine);
      }
    };
  }

  while (keepRunning) {
    // ── Pre-input checks ──
    if (!inkRepl && readlineClosed) {
      keepRunning = false;
      continue;
    }
    if (forceQuitAfterTurn) {
      if (!exitAfterTurnNoticeShown) {
        printLine('Exit requested; waiting for active turn to finish...');
        exitAfterTurnNoticeShown = true;
      }
      if (pendingTurns === 0) {
        keepRunning = false;
        continue;
      }
      await turnQueue;
      keepRunning = false;
      continue;
    }
    if (runtime.showSessionsWatch) {
      const snapshot = await refreshSessionsSnapshot(false);
      printSessionsSnapshot(snapshot, { timezone: runtime.userTimezone });
    }
    emitStatusLaneIfChanged();

    // ── Wait for user input ──
    let raw = '';
    if (inkRepl) {
      // Ink: waitForInput() resolves when user presses Enter, rejects on exit
      try {
        raw = (await inkRepl.waitForInput()).trim();
      } catch (error) {
        if (error instanceof InkExitSignal) {
          keepRunning = false;
          continue;
        }
        throw error;
      }
    } else if (rl) {
      // Legacy readline
      statusLane.setPromptActive(true);
      try {
        const promptLabel = pendingTurns > 0 ? `${agentId}+${pendingTurns}> ` : `${agentId}> `;
        activePromptLabel = promptLabel;
        const renderedPrompt = statusLane.buildPromptLabel(promptLabel);
        raw = (await rl.question(chalk.green(renderedPrompt))).trim();
        statusLane.clearDockFromScrollback();
        lastCtrlCAt = 0;
      } catch (error) {
        statusLane.clearDockFromScrollback();
        statusLane.setPromptActive(false);
        if (statusLane.shouldRefreshAfterPrompt()) {
          emitStatusLaneIfChanged(true);
        }
        if (isReadlineClosedError(error)) {
          const now = Date.now();
          if (lastCtrlCAt > 0 && now - lastCtrlCAt <= CTRL_C_EXIT_WINDOW_MS) {
            printLine(chalk.yellow('\nExiting chat (double Ctrl+C).\n'));
            keepRunning = false;
            continue;
          }
          if (now - lastSigintAt > 1_200) {
            printLine(chalk.dim('\nReadline closed. Exiting chat gracefully.\n'));
            keepRunning = false;
            continue;
          }
          lastCtrlCAt = now;
          rl = createInterface({ input, output });
          rl.on('close', () => {
            readlineClosed = true;
          });
          readlineClosed = false;
          statusLane.renderHint('Press Ctrl+C again to quit, or continue typing.');
          continue;
        }
        if (isAbortError(error)) {
          const now = Date.now();
          if (lastCtrlCAt > 0 && now - lastCtrlCAt <= CTRL_C_EXIT_WINDOW_MS) {
            printLine(chalk.yellow('\nExiting chat (double Ctrl+C).\n'));
            keepRunning = false;
            continue;
          }
          lastCtrlCAt = now;
          if (readlineClosed) {
            rl = createInterface({ input, output });
            rl.on('close', () => {
              readlineClosed = true;
            });
            readlineClosed = false;
          }
          statusLane.renderHint('Press Ctrl+C again to quit, or continue typing.');
          continue;
        }
        throw error;
      }
      statusLane.setPromptActive(false);
      statusLane.setHint('ready');
      if (statusLane.shouldRefreshAfterPrompt()) {
        emitStatusLaneIfChanged(true);
      }
    }
    if (!raw) continue;
    if (raw === '/') {
      console.log(
        [
          '',
          chalk.bold('Quick commands'),
          chalk.dim(
            '/help  /mcp  /capabilities  /skills  /profile  /policy  /away  /tool-routing  /ui  /trim  /quit'
          ),
          '',
        ].join('\n')
      );
      continue;
    }

    const slash = parseSlashCommand(raw);
    if (slash) {
      switch (slash.name) {
        case 'help': {
          console.log(
            [
              '',
              '/help                      Show this help',
              '/quit | /exit              End chat',
              '/refresh                   Re-bootstrap identity context from PCP',
              '/inbox                     Poll inbox now',
              '/inbox full                Show all unread messages expanded',
              '/events [now|on|off]       Poll/toggle merged activity stream',
              '/session                   Show active session info',
              '/autorun [on|off]          Toggle inbox auto-run execution',
              '/away [on|off]             Toggle remote approval mode (approvals via inbox)',
              '/tool-routing [backend|local]  Toggle backend tools vs local pcp-tool routing',
              '/ui [scroll|live]          Set status rendering mode',
              '/backend <name>            Switch backend (claude|codex|gemini)',
              '/model <id>                Set/clear model override',
              '/tools <backend|off|privileged>  Toggle backend-native tools/policy',
              '/grant <tool> [uses]       Grant blocked PCP tool for limited uses',
              '/grant-session <tool>      Allow a tool for this PCP session only',
              '/allow <tool>               Persistently allow PCP tool',
              '/deny <tool>                Persistently deny PCP tool',
              '/policy-scope [global|workspace|agent|studio] [id]  Set rule mutation scope',
              '/policy                     Show tool policy + storage path',
              '/mcp [servers|call ...]     List MCP servers or call PCP tool via /mcp call',
              '/mcp-servers                List configured MCP servers from .mcp.json',
              '/capabilities               Snapshot: MCP servers + skills + policy + grants',
              '/pcp <tool> [jsonArgs]     Call a PCP tool directly',
              '/thread [key]              Show/set active thread key',
              '/sessions [watch|off]      Show active sessions (or stream each turn)',
              '/skills                    List discovered local skills',
              '/skill-trust <all|trusted-only>  Set skill trust policy mode',
              '/session-visibility <self|thread|studio|workspace|agent|all>  Set session visibility policy',
              '/skill-allow <pattern>      Persistently allow skill(s) via pattern',
              '/path-allow-read <glob>      Persistently allow local reads for matching paths',
              '/path-allow-write <glob>     Persistently allow local writes for matching paths',
              '/profile [name]             Apply security profile (minimal/safe/collaborative/full)',
              '/policy-reset [global|workspace|agent|studio] [id]  Reset policy scope to defaults',
              '/delegate-create <to> <scopes> [ttlMin]  Mint delegation token',
              '/delegate-show               Show last minted delegation token payload',
              '/delegate-verify <token|last> Verify delegation token with local secret',
              '/delegate-send <to> <scopes> <message>  Send inbox message with delegation token',
              '/skill-use <name>           Activate a discovered skill for prompts',
              '/skill-clear [name]         Clear active skills (or one skill)',
              '/bookmark [label]          Set context bookmark',
              '/bookmarks                 List bookmarks',
              '/eject <bookmark|last>     Eject context up to bookmark',
              '/eject <bookmark|last> --force  Eject without confirmation',
              '/trim [targetPct]          Trim oldest context entries (default 70)',
              '/context                   Show recent context entries',
              '/usage                     Show context token estimate',
              '',
            ].join('\n')
          );
          break;
        }
        case 'quit':
        case 'exit':
          keepRunning = false;
          if (inkRepl) inkRepl.requestExit();
          break;
        case 'inbox':
          if (slash.args[0] === 'full' && inkRepl) {
            // Show all inbox messages fully expanded (re-fetch and display)
            const fullResult = (await pcp
              .callTool('get_inbox', { agentId, status: 'unread', limit: 20 })
              .catch(() => null)) as Record<string, unknown> | null;
            const allInbox = extractInboxMessages(fullResult).sort(
              (a, b) => safeDateMs(a.createdAt) - safeDateMs(b.createdAt)
            );
            if (allInbox.length === 0) {
              inkRepl.printSystem('No unread inbox messages.');
            } else {
              for (const msg of allInbox) {
                const from = msg.from || 'unknown';
                const heading = msg.subject ? `${from} — ${msg.subject}` : from;
                inkRepl.addMessage('inbox', `${heading}: ${msg.content}`.trim(), {
                  label: '📬 inbox',
                  time: formatHumanTime(msg.createdAt, runtime.userTimezone),
                });
              }
            }
          } else {
            await pollInbox(true);
          }
          break;
        case 'refresh': {
          console.log(chalk.dim('Refreshing identity context from PCP...'));
          const refreshResult = (await pcp
            .callTool('bootstrap', { agentId })
            .catch((error) => ({ error: String(error) }))) as Record<string, unknown>;
          if (refreshResult.error) {
            console.log(chalk.yellow(`Refresh failed: ${String(refreshResult.error)}`));
          } else {
            const ctx = formatBootstrapContext(refreshResult, agentId);
            if (ctx) {
              runtime.bootstrapContext = ctx;
              const ctxTokens = estimateTokens(ctx);
              console.log(
                chalk.green(`Identity context refreshed: ~${ctxTokens.toLocaleString()} tokens`)
              );
            } else {
              console.log(chalk.yellow('Bootstrap returned no identity context.'));
            }
          }
          break;
        }
        case 'events': {
          const mode = slash.args[0];
          if (mode === 'off') {
            runtime.eventPolling = false;
            console.log(chalk.yellow('Activity polling disabled.'));
          } else if (mode === 'on') {
            runtime.eventPolling = true;
            console.log(chalk.green('Activity polling enabled.'));
          } else {
            await pollActivity(true);
          }
          break;
        }
        case 'session':
          {
            const transcriptMeta = runtime.sessionId
              ? getSessionTranscriptMetadata(runtime.sessionId)
              : null;
            const sessionStudio = attachedSessionSummary
              ? sessionStudioLabel(attachedSessionSummary, 'full')
              : sessionStudioLabel(
                  { studioId: runtime.studioId, workspaceId: runtime.workspaceId },
                  'full'
                );
            console.log(
              chalk.dim(
                `session=${runtime.sessionId || 'none'} backend=${runtime.backend} model=${
                  runtime.model || '(default)'
                } routing=${runtime.toolRouting} thread=${runtime.threadKey || '(none)'} studio=${sessionStudio} events=${
                  runtime.eventPolling ? 'on' : 'off'
                } autorun=${
                  runtime.autoRunInbox ? 'on' : 'off'
                } ui=${runtime.uiMode} budget=${formatTokenCount(
                  runtime.maxContextTokens
                )} window=${formatTokenCount(
                  runtime.backendTokenWindow
                )} budgetMode=${contextBudgetAuto ? 'auto' : 'manual'} tools=${toolPolicy.getMode()} scope=${toolPolicy.getMutationScopeLabel()} visibility=${toolPolicy.getSessionVisibility()} history=${sessionHistoryLabel(
                  transcriptMeta
                )}`
              )
            );
          }
          break;
        case 'autorun':
        case 'auto-run': {
          const mode = (slash.args[0] || '').toLowerCase();
          if (!mode) {
            console.log(chalk.dim(`Inbox auto-run is ${runtime.autoRunInbox ? 'on' : 'off'}.`));
            break;
          }
          if (!['on', 'off'].includes(mode)) {
            console.log(chalk.yellow('Usage: /autorun [on|off]'));
            break;
          }
          runtime.autoRunInbox = mode === 'on';
          console.log(
            chalk.green(`Inbox auto-run ${runtime.autoRunInbox ? 'enabled' : 'disabled'}.`)
          );
          break;
        }
        case 'away': {
          const mode = (slash.args[0] || '').toLowerCase();
          if (!mode) {
            console.log(chalk.dim(`Away mode is ${runtime.awayMode ? 'on' : 'off'}.`));
            if (approvalManager.size > 0) {
              console.log(chalk.dim(`  ${approvalManager.size} pending approval request(s)`));
            }
            break;
          }
          if (!['on', 'off'].includes(mode)) {
            console.log(chalk.yellow('Usage: /away [on|off]'));
            break;
          }
          runtime.awayMode = mode === 'on';
          if (runtime.awayMode) {
            console.log(
              chalk.green(
                'Away mode enabled — tool approvals will be sent to your inbox for remote approval.'
              )
            );
          } else {
            console.log(chalk.green('Away mode disabled — tool approvals will prompt locally.'));
            if (approvalManager.size > 0) {
              approvalManager.cancelAll();
              console.log(chalk.dim('Cancelled pending remote approval requests.'));
            }
          }
          break;
        }
        case 'tool-routing': {
          const mode = (slash.args[0] || '').toLowerCase();
          if (!mode) {
            console.log(chalk.dim(`Tool routing is ${runtime.toolRouting}.`));
            break;
          }
          if (!['backend', 'local'].includes(mode)) {
            console.log(chalk.yellow('Usage: /tool-routing [backend|local]'));
            break;
          }
          runtime.toolRouting = mode as 'backend' | 'local';
          console.log(chalk.green(`Tool routing set to ${runtime.toolRouting}.`));
          if (runtime.toolRouting === 'local') {
            console.log(
              chalk.dim(
                'Local routing active: backend-native tools disabled; use pcp-tool blocks for local execution.'
              )
            );
          }
          break;
        }
        case 'ui': {
          if (inkRepl) {
            printLine('UI mode: ink (React). Switch to scroll with --ui scroll on start.');
            break;
          }
          const mode = (slash.args[0] || '').toLowerCase();
          if (!mode) {
            printLine(chalk.dim(`UI mode is ${runtime.uiMode}.`));
            break;
          }
          if (!['scroll', 'live'].includes(mode)) {
            printLine(chalk.yellow('Usage: /ui [scroll|live]'));
            break;
          }
          runtime.uiMode = mode as 'scroll' | 'live';
          statusLane.setLiveMode(runtime.uiMode === 'live' && Boolean(output.isTTY));
          printLine(chalk.green(`UI mode set to ${runtime.uiMode}.`));
          emitStatusLaneIfChanged(true);
          break;
        }
        case 'sessions': {
          const mode = slash.args[0];
          if (mode === 'watch') {
            runtime.showSessionsWatch = true;
            console.log(chalk.green('Session watch enabled.'));
          } else if (mode === 'off') {
            runtime.showSessionsWatch = false;
            console.log(chalk.green('Session watch disabled.'));
          } else {
            const snapshot = await refreshSessionsSnapshot(true);
            printSessionsSnapshot(snapshot, { timezone: runtime.userTimezone });
          }
          break;
        }
        case 'backend': {
          const next = slash.args[0];
          if (!next || !['claude', 'codex', 'gemini'].includes(next)) {
            console.log(chalk.yellow('Usage: /backend <claude|codex|gemini>'));
            break;
          }
          runtime.backend = next;
          runtime.backendTokenWindow = resolveBackendTokenWindow(runtime.backend, runtime.model);
          if (contextBudgetAuto) {
            runtime.maxContextTokens = runtime.backendTokenWindow;
          }
          console.log(chalk.green(`Switched backend to ${next}`));
          if (contextBudgetAuto) {
            console.log(
              chalk.dim(
                `Context budget auto-updated to backend window (${formatTokenCount(runtime.maxContextTokens)} tok).`
              )
            );
          }
          break;
        }
        case 'model': {
          const next = slash.args[0];
          runtime.model = next || undefined;
          runtime.backendTokenWindow = resolveBackendTokenWindow(runtime.backend, runtime.model);
          if (contextBudgetAuto) {
            runtime.maxContextTokens = runtime.backendTokenWindow;
          }
          console.log(chalk.green(`Model override: ${runtime.model || '(backend default)'}`));
          console.log(
            chalk.dim(
              `Backend window: ${formatTokenCount(runtime.backendTokenWindow)} tok (policy default).`
            )
          );
          break;
        }
        case 'tools': {
          const next = slash.args[0];
          if (!next) {
            const grants = toolPolicy.listGrants();
            console.log(chalk.dim(`Tool mode: ${toolPolicy.getMode()}`));
            console.log(chalk.dim(`Mutation scope: ${toolPolicy.getMutationScopeLabel()}`));
            console.log(chalk.dim(`Session visibility: ${toolPolicy.getSessionVisibility()}`));
            if (grants.length > 0) {
              console.log(
                chalk.dim(`Grants: ${grants.map((g) => `${g.tool}(${g.uses})`).join(', ')}`)
              );
            }
            const sessionGrants = toolPolicy.listSessionGrants(runtime.sessionId);
            if (sessionGrants.length > 0) {
              console.log(
                chalk.dim(
                  `Session grants: ${sessionGrants.map((g) => `${g.tool}(${g.uses})`).join(', ')}`
                )
              );
            }
            break;
          }
          if (next !== 'backend' && next !== 'off' && next !== 'privileged') {
            console.log(chalk.yellow('Usage: /tools <backend|off|privileged>'));
            break;
          }
          toolPolicy.setMode(next);
          runtime.toolMode = toolPolicy.getMode();
          console.log(
            chalk.green(`Tool mode set in ${toolPolicy.getMutationScopeLabel()} to ${next}.`)
          );
          if (runtime.toolMode !== next) {
            console.log(
              chalk.yellow(`Effective mode remains ${runtime.toolMode} due stricter active scope.`)
            );
          }
          break;
        }
        case 'grant': {
          const tool = slash.args[0];
          if (!tool) {
            console.log(chalk.yellow('Usage: /grant <tool> [uses]'));
            break;
          }
          const uses = Number.parseInt(slash.args[1] || '1', 10);
          toolPolicy.grantTool(tool, Number.isNaN(uses) ? 1 : uses);
          console.log(chalk.green(`Granted ${tool} for ${Number.isNaN(uses) ? 1 : uses} use(s).`));
          break;
        }
        case 'allow': {
          const tool = slash.args[0];
          if (!tool) {
            console.log(chalk.yellow('Usage: /allow <tool>'));
            break;
          }
          toolPolicy.allowTool(tool);
          console.log(chalk.green(`Persistently allowed ${tool}`));
          break;
        }
        case 'grant-session': {
          const tool = slash.args[0];
          if (!tool) {
            console.log(chalk.yellow('Usage: /grant-session <tool>'));
            break;
          }
          if (!runtime.sessionId) {
            console.log(chalk.yellow('No PCP session id available.'));
            break;
          }
          toolPolicy.grantToolForSession(runtime.sessionId, tool);
          console.log(chalk.green(`Granted ${tool} for this PCP session.`));
          break;
        }
        case 'grant-remote': {
          // /grant-remote <agent> <toolSpec> [scope]
          // Send a permission grant to another SB via inbox
          const targetAgent = slash.args[0];
          const toolSpec = slash.args[1];
          if (!targetAgent || !toolSpec) {
            console.log(
              chalk.yellow(
                'Usage: /grant-remote <agent> <toolSpec> [once|session|always|deny|revoke]'
              )
            );
            break;
          }
          const scopeArg = (slash.args[2] || 'session').toLowerCase();
          const actionMap: Record<string, PermissionGrantAction> = {
            once: 'grant',
            session: 'grant-session',
            always: 'allow',
            deny: 'deny',
            revoke: 'revoke',
          };
          const action = actionMap[scopeArg];
          if (!action) {
            console.log(
              chalk.yellow(`Unknown scope: ${scopeArg}. Use: once, session, always, deny, revoke`)
            );
            break;
          }
          const grantResult = await pcp
            .callTool('send_to_inbox', {
              recipientAgentId: targetAgent,
              senderAgentId: agentId,
              messageType: 'permission_grant',
              content: `Permission ${action}: ${toolSpec}`,
              trigger: true,
              metadata: buildPermissionGrantMetadata({
                action,
                tools: [toolSpec],
                uses: action === 'grant' ? 1 : undefined,
              }),
            })
            .catch((err: unknown) => {
              console.log(
                chalk.red(
                  `Failed to send grant: ${err instanceof Error ? err.message : String(err)}`
                )
              );
              return null;
            });
          if (grantResult) {
            console.log(chalk.green(`Sent ${action} for ${toolSpec} to ${targetAgent}.`));
          }
          break;
        }
        case 'deny': {
          const tool = slash.args[0];
          if (!tool) {
            console.log(chalk.yellow('Usage: /deny <tool>'));
            break;
          }
          toolPolicy.denyTool(tool);
          console.log(chalk.green(`Persistently denied ${tool}`));
          break;
        }
        case 'policy-scope': {
          const scopeRaw = (slash.args[0] || '').trim().toLowerCase();
          if (!scopeRaw) {
            console.log(chalk.dim(`Mutation scope: ${toolPolicy.getMutationScopeLabel()}`));
            console.log(
              chalk.dim(`Active scopes: ${toolPolicy.listActiveScopeLabels().join(' -> ')}`)
            );
            break;
          }
          if (!['global', 'workspace', 'agent', 'studio'].includes(scopeRaw)) {
            console.log(chalk.yellow('Usage: /policy-scope [global|workspace|agent|studio] [id]'));
            break;
          }
          const id = slash.args.slice(1).join(' ').trim() || undefined;
          const result = toolPolicy.setMutationScope(scopeRaw as ToolPolicyScopeKind, id);
          if (!result.success) {
            console.log(chalk.yellow(result.message));
          } else {
            runtime.toolMode = toolPolicy.getMode();
            console.log(chalk.green(result.message));
          }
          break;
        }
        case 'policy-reset': {
          const scopeRaw = (slash.args[0] || '').trim().toLowerCase();
          const explicitScope =
            scopeRaw && ['global', 'workspace', 'agent', 'studio'].includes(scopeRaw)
              ? ({
                  scope: scopeRaw as ToolPolicyScopeKind,
                  id: slash.args.slice(1).join(' ').trim() || undefined,
                } as const)
              : undefined;
          if (scopeRaw && !explicitScope) {
            console.log(chalk.yellow('Usage: /policy-reset [global|workspace|agent|studio] [id]'));
            break;
          }
          const result = toolPolicy.clearScopeRules(explicitScope);
          if (!result.success) {
            console.log(chalk.yellow(result.message));
            break;
          }
          runtime.toolMode = toolPolicy.getMode();
          console.log(chalk.green(result.message));
          break;
        }
        case 'profile': {
          const profileArg = (slash.args[0] || '').trim().toLowerCase();
          if (!profileArg) {
            console.log(chalk.bold('Tool Profiles'));
            console.log(formatProfileList());
            console.log(chalk.dim('\nUsage: /profile <minimal|safe|collaborative|full>'));
            break;
          }
          if (!isValidProfileId(profileArg)) {
            console.log(chalk.yellow(`Unknown profile: ${profileArg}`));
            console.log(formatProfileList());
            break;
          }
          const profileResult = applyProfile(toolPolicy, profileArg);
          if (profileResult.success) {
            runtime.toolMode = toolPolicy.getMode();
            console.log(chalk.green(profileResult.message));
          } else {
            console.log(chalk.yellow(profileResult.message));
          }
          break;
        }
        case 'policy': {
          printToolPolicySnapshot(toolPolicy, runtime.sessionId, runtime.activeSkills);
          break;
        }
        case 'mcp': {
          const sub = (slash.args[0] || 'servers').toLowerCase();
          if (sub === 'servers' || sub === 'list') {
            const servers = listConfiguredMcpServers(process.cwd());
            if (servers.length === 0) {
              console.log(chalk.dim('No MCP servers configured in .mcp.json'));
              break;
            }
            console.log(chalk.bold(`MCP servers (${servers.length})`));
            for (const server of servers) {
              const endpoint = server.url || server.command || '(unknown)';
              console.log(
                chalk.dim(`- ${server.name} [${server.transport || 'unknown'}] ${endpoint}`)
              );
            }
            console.log('');
            break;
          }
          if (sub === 'call') {
            const tool = slash.args[1];
            if (!tool) {
              console.log(chalk.yellow('Usage: /mcp call <tool> [jsonArgs]'));
              break;
            }
            let pcpArgs: Record<string, unknown> = {};
            const rawArgs = raw.split(/\s+/).slice(3).join(' ').trim();
            if (rawArgs) {
              try {
                pcpArgs = JSON.parse(rawArgs) as Record<string, unknown>;
              } catch {
                console.log(
                  chalk.yellow(
                    'Invalid JSON args. Example: /mcp call get_inbox {"agentId":"lumen"}'
                  )
                );
                break;
              }
            }
            const approved = await ensurePcpToolAllowed({
              policy: toolPolicy,
              tool,
              sessionId: runtime.sessionId,
              prompt: (reason) =>
                promptForToolApproval(rl, toolPolicy, runtime.sessionId, tool, reason, inkRepl),
            });
            if (!approved) {
              console.log(chalk.yellow(`Skipped ${tool}`));
              break;
            }
            const result = await pcp
              .callTool(tool, pcpArgs)
              .catch((error) => ({ error: String(error) }));
            const rendered = JSON.stringify(result, null, 2);
            ledger.addEntry('system', compactForLedger(`PCP ${tool} -> ${rendered}`, 500), 'pcp');
            appendTranscript(runtime.transcriptPath, {
              type: 'pcp_tool',
              tool,
              args: pcpArgs,
              result,
            });
            console.log(rendered);
            break;
          }
          console.log(chalk.yellow('Usage: /mcp [servers|list|call <tool> [jsonArgs]]'));
          break;
        }
        case 'mcp-servers': {
          const servers = listConfiguredMcpServers(process.cwd());
          if (servers.length === 0) {
            console.log(chalk.dim('No MCP servers configured in .mcp.json'));
            break;
          }
          console.log(chalk.bold(`MCP servers (${servers.length})`));
          for (const server of servers) {
            const endpoint = server.url || server.command || '(unknown)';
            console.log(
              chalk.dim(`- ${server.name} [${server.transport || 'unknown'}] ${endpoint}`)
            );
          }
          console.log('');
          break;
        }
        case 'capabilities': {
          const servers = listConfiguredMcpServers(process.cwd());
          const skills = discoverSkills(process.cwd());
          const filtered = filterSkillsByPolicy(skills, toolPolicy);

          console.log(chalk.bold('\nCapabilities snapshot'));
          console.log(
            chalk.dim(
              `Backend=${runtime.backend}${runtime.model ? `(${runtime.model})` : ''} thread=${
                runtime.threadKey || '(none)'
              } session=${runtime.sessionId || '(none)'}`
            )
          );

          if (servers.length === 0) {
            console.log(chalk.dim('MCP servers: none configured in .mcp.json'));
          } else {
            console.log(chalk.bold(`MCP servers (${servers.length})`));
            for (const server of servers) {
              const endpoint = server.url || server.command || '(unknown)';
              console.log(
                chalk.dim(`- ${server.name} [${server.transport || 'unknown'}] ${endpoint}`)
              );
            }
          }

          console.log(chalk.bold(`Skills (${skills.length} discovered)`));
          if (filtered.visible.length === 0) {
            console.log(chalk.dim('- none visible under current policy'));
          } else {
            for (const skill of filtered.visible.slice(0, 20)) {
              const active = runtime.activeSkills.some((entry) => entry.path === skill.path)
                ? ' *active*'
                : '';
              console.log(
                chalk.dim(`- ${skill.name} [${skill.source}] trust=${skill.trustLevel}${active}`)
              );
            }
            if (filtered.visible.length > 20) {
              console.log(chalk.dim(`... and ${filtered.visible.length - 20} more visible skills`));
            }
          }
          if (filtered.blockedBySkill.length > 0) {
            console.log(
              chalk.yellow(`Blocked by skill allowlist: ${filtered.blockedBySkill.length}`)
            );
          }
          if (filtered.blockedByPath.length > 0) {
            console.log(chalk.yellow(`Blocked by path policy: ${filtered.blockedByPath.length}`));
          }
          if (filtered.blockedByTrust.length > 0) {
            console.log(chalk.yellow(`Blocked by trust mode: ${filtered.blockedByTrust.length}`));
          }

          printToolPolicySnapshot(toolPolicy, runtime.sessionId, runtime.activeSkills);
          break;
        }
        case 'pcp': {
          const tool = slash.args[0];
          if (!tool) {
            console.log(chalk.yellow('Usage: /pcp <tool> [jsonArgs]'));
            break;
          }
          let pcpArgs: Record<string, unknown> = {};
          const rawArgs = raw.split(/\s+/).slice(2).join(' ').trim();
          if (rawArgs) {
            try {
              pcpArgs = JSON.parse(rawArgs) as Record<string, unknown>;
            } catch {
              console.log(
                chalk.yellow('Invalid JSON args. Example: /pcp get_inbox {"agentId":"lumen"}')
              );
              break;
            }
          }
          const approved = await ensurePcpToolAllowed({
            policy: toolPolicy,
            tool,
            sessionId: runtime.sessionId,
            prompt: (reason) =>
              promptForToolApproval(rl, toolPolicy, runtime.sessionId, tool, reason, inkRepl),
          });
          if (!approved) {
            console.log(chalk.yellow(`Skipped ${tool}`));
            break;
          }
          const result = await pcp
            .callTool(tool, pcpArgs)
            .catch((error) => ({ error: String(error) }));
          const rendered = JSON.stringify(result, null, 2);
          ledger.addEntry('system', compactForLedger(`PCP ${tool} -> ${rendered}`, 500), 'pcp');
          appendTranscript(runtime.transcriptPath, {
            type: 'pcp_tool',
            tool,
            args: pcpArgs,
            result,
          });
          console.log(rendered);
          break;
        }
        case 'skills': {
          const skills = discoverSkills(process.cwd());
          if (skills.length === 0) {
            console.log(chalk.dim('No local skills discovered.'));
            break;
          }
          const filtered = filterSkillsByPolicy(skills, toolPolicy);
          const visible = filtered.visible;
          const blockedByPolicy = filtered.blockedBySkill.length;
          const blockedByPath = filtered.blockedByPath.length;
          const blockedByTrust = filtered.blockedByTrust.length;
          console.log(chalk.bold(`Discovered skills (${skills.length})`));
          for (const skill of visible.slice(0, 80)) {
            const active = runtime.activeSkills.some((entry) => entry.path === skill.path)
              ? ' *active*'
              : '';
            const trust =
              skill.trustLevel === 'trusted' ? chalk.green(skill.trustLevel) : skill.trustLevel;
            const provenance = skill.provenance?.registry
              ? ` registry:${skill.provenance.registry}`
              : '';
            console.log(
              chalk.dim(`- ${skill.name} [${skill.source}] trust=${trust}${provenance}${active}`)
            );
          }
          if (visible.length > 80) {
            console.log(chalk.dim(`... and ${visible.length - 80} more visible skills`));
          }
          if (blockedByPolicy > 0) {
            console.log(chalk.yellow(`${blockedByPolicy} skills hidden by skill allowlist policy`));
          }
          if (blockedByPath > 0) {
            console.log(
              chalk.yellow(`${blockedByPath} skills hidden by read-path allowlist policy`)
            );
          }
          if (blockedByTrust > 0) {
            console.log(chalk.yellow(`${blockedByTrust} skills hidden by trust policy mode`));
          }
          break;
        }
        case 'skill-trust': {
          const mode = (slash.args[0] || '').trim();
          if (!mode || !['all', 'trusted-only'].includes(mode)) {
            console.log(chalk.yellow('Usage: /skill-trust <all|trusted-only>'));
            break;
          }
          toolPolicy.setSkillTrustMode(mode as 'all' | 'trusted-only');
          console.log(chalk.green(`Skill trust mode set to ${mode}`));
          break;
        }
        case 'session-visibility': {
          const value = (slash.args[0] || '').trim().toLowerCase();
          if (!value) {
            console.log(chalk.dim(`Session visibility is ${toolPolicy.getSessionVisibility()}.`));
            break;
          }
          if (!['self', 'thread', 'studio', 'workspace', 'agent', 'all'].includes(value)) {
            console.log(
              chalk.yellow('Usage: /session-visibility <self|thread|studio|workspace|agent|all>')
            );
            break;
          }
          toolPolicy.setSessionVisibility(
            value as 'self' | 'thread' | 'studio' | 'workspace' | 'agent' | 'all'
          );
          console.log(
            chalk.green(
              `Session visibility set in ${toolPolicy.getMutationScopeLabel()} to ${value}.`
            )
          );
          break;
        }
        case 'skill-allow': {
          const skill = slash.args.join(' ').trim();
          if (!skill) {
            console.log(chalk.yellow('Usage: /skill-allow <name>'));
            break;
          }
          toolPolicy.allowSkill(skill);
          console.log(chalk.green(`Allowed skill: ${skill}`));
          break;
        }
        case 'path-allow-read': {
          const pattern = slash.args.join(' ').trim();
          if (!pattern) {
            console.log(chalk.yellow('Usage: /path-allow-read <glob>'));
            break;
          }
          toolPolicy.addReadPathAllow(pattern);
          console.log(chalk.green(`Allowed read path: ${pattern}`));
          break;
        }
        case 'path-allow-write': {
          const pattern = slash.args.join(' ').trim();
          if (!pattern) {
            console.log(chalk.yellow('Usage: /path-allow-write <glob>'));
            break;
          }
          toolPolicy.addWritePathAllow(pattern);
          console.log(chalk.green(`Allowed write path: ${pattern}`));
          break;
        }
        case 'skill-use': {
          const name = slash.args.join(' ').trim();
          if (!name) {
            console.log(chalk.yellow('Usage: /skill-use <name>'));
            break;
          }
          const skills = discoverSkills(process.cwd()).filter((skill) => skill.name === name);
          if (skills.length === 0) {
            console.log(chalk.yellow(`Skill not found: ${name}`));
            break;
          }
          const [skill] = skills;
          const activation = canActivateSkill(skill, toolPolicy);
          if (!activation.allowed) {
            console.log(chalk.yellow(activation.reason || 'Skill blocked by policy'));
            break;
          }
          const loaded = loadSkillInstruction(skill);
          runtime.activeSkills = [
            ...runtime.activeSkills.filter((entry) => entry.path !== loaded.path),
            loaded,
          ];
          console.log(chalk.green(`Activated skill ${loaded.name}`));
          break;
        }
        case 'skill-clear': {
          const name = slash.args.join(' ').trim();
          if (!name) {
            runtime.activeSkills = [];
            console.log(chalk.green('Cleared all active skills.'));
            break;
          }
          const before = runtime.activeSkills.length;
          runtime.activeSkills = runtime.activeSkills.filter((skill) => skill.name !== name);
          const removed = before - runtime.activeSkills.length;
          if (removed === 0) {
            console.log(chalk.yellow(`No active skill matched: ${name}`));
          } else {
            console.log(chalk.green(`Cleared ${removed} active skill(s) for ${name}`));
          }
          break;
        }
        case 'delegate-create': {
          const toAgent = (slash.args[0] || '').trim().toLowerCase();
          const scopeSpec = (slash.args[1] || '').trim();
          const ttlMinutes = Number.parseInt(slash.args[2] || '15', 10);
          const secret = getDelegationSecret();
          if (!secret) {
            console.log(
              chalk.yellow('Delegation secret missing. Set PCP_DELEGATION_SECRET (or JWT_SECRET).')
            );
            break;
          }
          if (!toAgent || !scopeSpec) {
            console.log(
              chalk.yellow('Usage: /delegate-create <to-agent> <scope1,scope2> [ttl-minutes]')
            );
            break;
          }
          const scopes = parseToolScopes(scopeSpec);
          if (scopes.length === 0) {
            console.log(chalk.yellow('Provide at least one scope.'));
            break;
          }
          const token = mintDelegationToken(
            {
              issuerAgentId: agentId,
              delegateeAgentId: toAgent,
              scopes,
              ttlSeconds: Number.isFinite(ttlMinutes) ? Math.max(1, ttlMinutes) * 60 : 15 * 60,
              sessionId: runtime.sessionId,
              threadKey: runtime.threadKey,
              studioId: identity?.workspaceId,
            },
            secret
          );
          const payload = decodeDelegationToken(token);
          lastDelegation = { token, payload };

          const summary = `Delegation token minted: ${payload.iss} -> ${payload.sub} scopes=${payload.scopes.join(',')} exp=${new Date(payload.exp * 1000).toISOString()}`;
          ledger.addEntry('system', summary, 'delegation');
          appendTranscript(runtime.transcriptPath, {
            type: 'delegation_create',
            payload,
            token,
          });
          console.log(chalk.green(summary));
          console.log(chalk.dim(token));
          break;
        }
        case 'delegate-show': {
          if (!lastDelegation) {
            console.log(chalk.dim('No delegation token minted in this chat session yet.'));
            break;
          }
          console.log(JSON.stringify(lastDelegation.payload, null, 2));
          console.log(chalk.dim(lastDelegation.token));
          break;
        }
        case 'delegate-verify': {
          const target = (slash.args[0] || 'last').trim();
          const token = target === 'last' ? lastDelegation?.token : target;
          if (!token) {
            console.log(
              chalk.yellow('No token available. Use /delegate-create first or pass a token.')
            );
            break;
          }
          const secret = getDelegationSecret();
          if (!secret) {
            console.log(
              chalk.yellow('Delegation secret missing. Set PCP_DELEGATION_SECRET (or JWT_SECRET).')
            );
            break;
          }
          const verified = verifyDelegationToken(token, secret);
          if (!verified.valid || !verified.payload) {
            console.log(chalk.red(`Invalid delegation token: ${verified.error}`));
            break;
          }
          console.log(chalk.green('Delegation token valid.'));
          console.log(JSON.stringify(verified.payload, null, 2));
          break;
        }
        case 'delegate-send': {
          const toAgent = (slash.args[0] || '').trim().toLowerCase();
          const scopeSpec = (slash.args[1] || '').trim();
          const message = slash.args.slice(2).join(' ').trim();
          if (!toAgent || !scopeSpec || !message) {
            console.log(
              chalk.yellow('Usage: /delegate-send <to-agent> <scope1,scope2> <message...>')
            );
            break;
          }
          const secret = getDelegationSecret();
          if (!secret) {
            console.log(
              chalk.yellow('Delegation secret missing. Set PCP_DELEGATION_SECRET (or JWT_SECRET).')
            );
            break;
          }

          const scopes = parseToolScopes(scopeSpec);
          if (scopes.length === 0) {
            console.log(chalk.yellow('Provide at least one scope.'));
            break;
          }

          const token = mintDelegationToken(
            {
              issuerAgentId: agentId,
              delegateeAgentId: toAgent,
              scopes,
              ttlSeconds: 15 * 60,
              sessionId: runtime.sessionId,
              threadKey: runtime.threadKey,
              studioId: identity?.workspaceId,
            },
            secret
          );
          const payload = decodeDelegationToken(token);
          lastDelegation = { token, payload };

          const approved = await ensurePcpToolAllowed({
            policy: toolPolicy,
            tool: 'send_to_inbox',
            sessionId: runtime.sessionId,
            prompt: (reason) =>
              promptForToolApproval(
                rl,
                toolPolicy,
                runtime.sessionId,
                'send_to_inbox',
                reason,
                inkRepl
              ),
          });
          if (!approved) {
            console.log(chalk.yellow('Skipped delegated send_to_inbox (policy blocked).'));
            break;
          }

          const inboxArgs: Record<string, unknown> = {
            recipientAgentId: toAgent,
            senderAgentId: agentId,
            messageType: 'task_request',
            subject: `Delegated task from ${agentId}`,
            content: message,
            trigger: true,
            ...(runtime.threadKey ? { threadKey: runtime.threadKey } : {}),
            metadata: {
              delegationToken: token,
              delegation: {
                iss: payload.iss,
                sub: payload.sub,
                scopes: payload.scopes,
                exp: payload.exp,
                iat: payload.iat,
                threadKey: payload.threadKey || null,
                sessionId: payload.sessionId || null,
                studioId: payload.studioId || null,
              },
            },
          };
          const result = await pcp
            .callTool('send_to_inbox', inboxArgs)
            .catch((error) => ({ error: String(error) }));
          appendTranscript(runtime.transcriptPath, {
            type: 'delegation_send',
            toAgent,
            scopes,
            message,
            result,
          });
          console.log(chalk.green(`Delegated message sent to ${toAgent}.`));
          console.log(JSON.stringify(result, null, 2));
          break;
        }
        case 'thread': {
          const next = slash.args[0];
          if (next) {
            runtime.threadKey = next;
            console.log(chalk.green(`Thread key set to ${next}`));
          } else {
            console.log(chalk.dim(`Thread key: ${runtime.threadKey || '(none)'}`));
          }
          break;
        }
        case 'bookmark': {
          const bookmark = ledger.createBookmark(slash.args.join(' '));
          console.log(chalk.green(`Created bookmark ${bookmark.id} (${bookmark.label})`));
          break;
        }
        case 'bookmarks': {
          const bookmarks = ledger.listBookmarks();
          if (bookmarks.length === 0) {
            console.log(chalk.dim('No bookmarks yet.'));
            break;
          }
          for (const bookmark of bookmarks) {
            console.log(
              chalk.dim(
                `${bookmark.id}  ${bookmark.label}  entry#${bookmark.entryId}  ~${bookmark.approxTokensAtCreation} tok`
              )
            );
          }
          break;
        }
        case 'eject': {
          const force = slash.args.includes('--force') || slash.args.includes('force');
          const ref = slash.args.find((arg) => arg !== '--force' && arg !== 'force') || 'last';
          const preview = ledger.previewEjectToBookmark(ref);
          if (!preview) {
            console.log(chalk.yellow(`Bookmark not found: ${ref}`));
            break;
          }
          const removedCount = preview.removedEntries.length;

          if (!force && removedCount > 0) {
            const maybeLargeEject = preview.removedTokens >= 1500 || removedCount >= 8;
            if (maybeLargeEject) {
              const previewLines = preview.removedEntries
                .slice(-3)
                .map(
                  (entry) => `- ${entry.role}: ${entry.content.slice(0, 80).replace(/\\s+/g, ' ')}`
                );
              console.log(
                chalk.yellow(
                  `About to eject ${removedCount} entries (~${preview.removedTokens} tok) up to ${preview.bookmark.id}.`
                )
              );
              if (previewLines.length) {
                console.log(chalk.dim('Recent entries in eject range:'));
                for (const line of previewLines) console.log(chalk.dim(line));
              }
              const confirm = (
                await rl!.question(chalk.yellow('Proceed with ejection? [y/N]: '))
              ).trim();
              if (!['y', 'yes'].includes(confirm.toLowerCase())) {
                console.log(chalk.dim('Ejection cancelled.'));
                break;
              }
            }
          }

          const result = ledger.ejectToBookmark(ref);
          if (!result) {
            console.log(chalk.yellow(`Bookmark not found: ${ref}`));
            break;
          }

          console.log(
            chalk.green(
              `Ejected ${removedCount} entries (~${result.removedTokens} tok) up to ${result.bookmark.id}`
            )
          );

          const summary = result.removedEntries
            .slice(-6)
            .map((entry) => `${entry.role}: ${entry.content.slice(0, 120).replace(/\s+/g, ' ')}`)
            .join('\n');
          if (summary) {
            await pcp
              .callTool('remember', {
                agentId,
                ...(runtime.sessionId ? { sessionId: runtime.sessionId } : {}),
                content: `Context ejection at ${result.bookmark.id} (${result.bookmark.label}).\n${summary}`,
                topics: 'repl,context-ejection',
                salience: 'medium',
              })
              .catch(() => undefined);
          }
          appendTranscript(runtime.transcriptPath, {
            type: 'context_eject',
            bookmarkId: result.bookmark.id,
            bookmarkLabel: result.bookmark.label,
            removedCount,
            removedTokens: result.removedTokens,
          });
          break;
        }
        case 'trim': {
          const targetPctRaw = slash.args[0] || `${DEFAULT_TRIM_TARGET_PCT}`;
          const targetPct = Number.parseInt(targetPctRaw, 10);
          if (
            !Number.isFinite(targetPct) ||
            Number.isNaN(targetPct) ||
            targetPct < 10 ||
            targetPct > 95
          ) {
            console.log(chalk.yellow('Usage: /trim [targetPercent 10-95]'));
            break;
          }
          const trimResult = await trimContextToPercent(targetPct, 'manual');
          if (trimResult.removed === 0) {
            console.log(chalk.dim('No trim needed; context already within target budget.'));
          }
          break;
        }
        case 'context': {
          const entries = ledger.listEntries().slice(-12);
          if (entries.length === 0) {
            console.log(chalk.dim('Context is empty.'));
            break;
          }
          for (const entry of entries) {
            const prefix = `${entry.role}${entry.source ? `/${entry.source}` : ''}`;
            console.log(chalk.dim(`${prefix}: ${entry.content.slice(0, 180)}`));
          }
          break;
        }
        case 'usage':
          if (pendingTurns > 0) {
            await turnQueue;
          }
          lastUsageTotal = printUsage(
            ledger,
            runtime.maxContextTokens,
            lastUsageTotal,
            lastBackendUsage,
            runtime.backendTokenWindow
          );
          break;
        default:
          console.log(chalk.yellow(`Unknown command: /${slash.name}`));
      }
      continue;
    }
    void enqueueTurn(raw);
  }

  // ── Cleanup ──
  if (inkRepl) {
    inkRepl.cleanup();
    inkRepl = null;
  }
  if (rl && !readlineClosed) {
    rl.close();
  }
  restorePromptAfterWrite = null;
  if (pollTimer) clearInterval(pollTimer);

  if (pendingTurns > 0) {
    console.log(chalk.dim(`Waiting for ${pendingTurns} pending turn(s) to finish...`));
    await turnQueue;
  }

  // Cancel any pending remote approval requests
  approvalManager.cancelAll();

  const summary = summarizeForSessionEnd(ledger);
  if (runtime.sessionId && !attachedToExistingSession) {
    await pcp
      .callTool('end_session', { agentId, sessionId: runtime.sessionId, summary })
      .catch(() => undefined);
  }
  appendTranscript(runtime.transcriptPath, {
    type: 'session_end',
    sessionId: runtime.sessionId || null,
    summary,
  });

  if (runtime.sessionId) {
    console.log(chalk.dim(`Reattach: sb chat -a ${agentId} --attach ${runtime.sessionId}`));
  }
  console.log(chalk.dim('\nChat ended.\n'));
}

export function registerChatCommand(program: Command): void {
  const register = (name: string, description: string) =>
    program
      .command(name)
      .description(description)
      .option('-a, --agent <id>', 'Agent identity to use')
      .option('-b, --backend <name>', 'Backend: claude, codex, gemini', 'claude')
      .option('-m, --model <model>', 'Model override for backend')
      .option(
        '--tool-routing <mode>',
        'Tool routing mode: backend (native backend tools) or local (pcp-tool blocks handled by sb chat)',
        'backend'
      )
      .option('--ui <mode>', 'UI mode: live (default) or scroll status rendering', 'live')
      .option('--thread-key <key>', 'Thread key for PCP session routing')
      .option('--new', 'Always start a new session (disable auto-attach to latest)')
      .option('--attach [query]', 'Attach to an active session for this SB (optional query filter)')
      .option(
        '--attach-latest [query]',
        'Attach to newest active session for this SB (optional query filter)'
      )
      .option('--session-id <id>', 'Attach chat to an existing PCP session id')
      .option(
        '--max-context-tokens <n>',
        'Approximate context budget for transcript (default: backend window policy, currently 1,000,000)'
      )
      .option('--poll-seconds <n>', 'Inbox polling interval seconds', '20')
      .option('--tools <mode>', 'Tool mode: backend|off|privileged', 'backend')
      .option('--profile <name>', 'Apply security profile: minimal|safe|collaborative|full')
      .option('--auto-run', 'Automatically execute backend turns for new inbox task messages')
      .option('--message <text>', 'Single-turn message for non-interactive mode')
      .option('--non-interactive', 'Run one turn and exit (requires --message)')
      .option(
        '--tail-transcript <pathOrSession>',
        'Tail transcript output by file path or session id'
      )
      .option('-v, --verbose', 'Verbose backend passthrough output')
      .option('--fullscreen', 'Fullscreen alternate buffer mode (app-controlled scrolling)')
      .action((options: ChatOptions) => runChat(options));

  register('chat', 'Start first-class PCP REPL (experimental)');
  register('alpha', 'Alias for `sb chat` (experimental)');
}
