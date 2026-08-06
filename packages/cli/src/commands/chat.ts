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
import { randomUUID } from 'crypto';
import {
  readIdentityJson,
  resolveAgentId,
  saveRuntimePreferences,
  type RuntimePreferences,
} from '../backends/identity.js';
import { PcpClient } from '../lib/pcp-client.js';
import { initSbDebug, sbDebugLog } from '../lib/sb-debug.js';
import {
  getBackendAuthStatus,
  runBackendInteractiveLogin,
  type BackendAuthBackend,
} from '../lib/backend-auth.js';
import { startBackendTurn, runBackendTurn } from '../repl/backend-runner.js';
import type { BackendTurnEvent } from '../backends/stream.js';
import { startSessionEventStream, type SessionEvent } from '../repl/session-event-stream.js';
import {
  ContextLedger,
  entryRefHash,
  estimateTokens,
  type LedgerRole,
} from '../repl/context-ledger.js';
import {
  resolveModelContextWindow as resolveBackendTokenWindow,
  contextBudgetForWindow as defaultContextBudget,
} from '../repl/context-limits.js';
import { parseSlashCommand } from '../repl/slash.js';
import {
  parseEvictSelection,
  selectEvictionEntries,
  formatEvictCandidate,
} from '../repl/evict-selection.js';
import {
  resolveAttachments,
  buildAttachmentBlock,
  collectAttachmentDirs,
} from '../repl/attachments.js';
import { classifyActivity } from '../repl/activity-render.js';
import { ToolMode, ToolPolicyScopeKind, ToolPolicyState } from '../repl/tool-policy.js';
import { formatBackendTokenUsage, type BackendTokenUsage } from '../repl/token-usage.js';
import { discoverSkills, loadSkillInstruction, type SkillInstruction } from '../repl/skills.js';
import { applyToolApprovalChoice, parseToolApprovalInput } from '../repl/tool-approval.js';
import { ensurePcpToolAllowed } from '../repl/tool-gate.js';
import { executeToolCalls, type ToolCallResult } from '../repl/tool-call-executor.js';
import {
  resolveCredentialRefs,
  loadKeychainCredentials,
  buildResolverEnv,
} from '../repl/credential-resolver.js';
import {
  isClientLocalTool,
  handleClientLocalTool,
  getLastSignal,
  clearLastSignal,
} from '../repl/context-tools.js';
import { SbHookRegistry } from '../repl/hook-registry.js';
import { registerBuiltinHooks } from '../repl/builtin-hooks.js';
import { applyProfile, formatProfileList, isValidProfileId } from '../repl/tool-profiles.js';
import { isPiTool, callPiTool } from '../repl/pi-tools.js';
import { ApprovalRequestManager } from '../repl/approval-request.js';
import { requestToolApproval } from '../repl/approval-api.js';
import {
  type ApprovalChannel,
  type ApprovalResponseDecision,
  JsonlApprovalChannel,
  AutoApprovalChannel,
} from '../repl/approval-channel.js';
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
  renderContextCutoff,
  renderMessageLine,
  renderTimedBlock,
  separator,
  startWaitingIndicator,
} from '../repl/tui-components.js';
import {
  renderInkChat,
  renderSessionPicker,
  InkExitSignal,
  type InkRepl,
  type SessionPickerEntry,
} from '../repl/ink/index.js';
import { formatContextLines, type ContextSections } from '../repl/ink/context-viewer.js';
import {
  classifyError,
  decodeDelegationToken,
  mintDelegationToken,
  verifyDelegationToken,
  type DelegationTokenPayload,
} from '@inklabs/shared';

type ChatOptions = {
  agent?: string;
  backend?: string;
  model?: string;
  toolRouting?: string;
  ui?: string;
  threadKey?: string;
  sender?: string;
  contactId?: string;
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
  messageLabel?: string;
  attachFile?: string[];
  nonInteractive?: boolean;
  maxTurns?: string;
  backendTimeoutSeconds?: string;
  tailTranscript?: string;
  sbStrictTools?: boolean;
  sbDebug?: boolean;
  verbose?: boolean;
  fullscreen?: boolean;
  dynamic?: boolean;
  approvalMode?: string;
  away?: boolean;
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
  studioId?: string;
  contactId?: string;
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
  strictTools: boolean;
  backendTurnTimeoutMs?: number;
  /**
   * Idle/token-flow timeout for a backend turn (ms). The primary reaper on the
   * non-interactive path: a turn is killed only after NO output flows for this
   * long (a real "tokens stopped" signal), replacing the old blunt hard wall.
   */
  backendIdleTimeoutMs?: number;
  approvalMode: 'interactive' | 'jsonl' | 'auto-deny' | 'auto-approve';
  approvalChannel?: ApprovalChannel;
}

interface SessionSummary {
  id: string;
  agentId?: string;
  studioId?: string;
  studioName?: string;
  status?: string;
  currentPhase?: string;
  threadKey?: string;
  startedAt?: string;
  backend?: string;
  provider?: string;
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
  /** Originating platform for message activities (telegram, discord, …) */
  platform?: string;
}

function isBackendAuthBackend(value: string): value is BackendAuthBackend {
  return value === 'claude' || value === 'codex' || value === 'gemini';
}

async function ensureBackendAuthReady(
  backend: string,
  mode: { nonInteractive: boolean; hasMessage: boolean; verbose: boolean }
): Promise<void> {
  if (process.env.SB_SKIP_BACKEND_AUTH_CHECK === '1' || process.env.VITEST) {
    return;
  }
  if (!isBackendAuthBackend(backend)) return;

  const status = await getBackendAuthStatus(backend);
  sbDebugLog('chat', 'backend_auth_status', {
    backend,
    authenticated: status.authenticated,
    detail: status.detail,
    canInteractiveLogin: status.canInteractiveLogin,
    loginCommand: status.loginCommand || null,
    mode,
  });
  if (status.authenticated) {
    if (mode.verbose) {
      console.log(chalk.dim(`Backend auth: ${backend} (${status.detail})`));
    }
    return;
  }

  const guidance = `Backend ${backend} is not authenticated (${status.detail}).`;
  const loginHint =
    status.loginCommand ||
    (backend === 'gemini' ? 'Start `gemini` once and complete login in the Gemini CLI' : null);

  if (mode.nonInteractive || mode.hasMessage) {
    sbDebugLog('chat', 'backend_auth_required_non_interactive', {
      backend,
      detail: status.detail,
      loginCommand: loginHint || null,
      mode,
    });
    throw new Error(
      `${guidance}${loginHint ? `\nRun: ${loginHint}` : '\nAuthenticate backend CLI and retry.'}`
    );
  }

  console.log(chalk.yellow(`⚠ ${guidance}`));
  if (!status.canInteractiveLogin || !status.loginCommand) {
    if (loginHint) console.log(chalk.dim(`  Run: ${loginHint}`));
    return;
  }
  if (!input.isTTY || !output.isTTY) {
    console.log(chalk.dim(`  Run: ${status.loginCommand}`));
    return;
  }

  const prompt = createInterface({ input, output });
  try {
    const answer = (
      await prompt.question(chalk.cyan(`Run ${status.loginCommand} now? [Y/n] `))
    ).trim();
    if (answer && !['y', 'yes'].includes(answer.toLowerCase())) {
      console.log(chalk.dim(`  Skipping login. Run manually: ${status.loginCommand}`));
      return;
    }
  } finally {
    prompt.close();
  }

  const exitCode = await runBackendInteractiveLogin(backend);
  if (exitCode !== 0) {
    throw new Error(
      `Backend ${backend} login exited with code ${exitCode}. Run \`${status.loginCommand}\` and retry.`
    );
  }
  const recheck = await getBackendAuthStatus(backend);
  if (!recheck.authenticated) {
    throw new Error(
      `Backend ${backend} still appears unauthenticated (${recheck.detail}). Run \`${status.loginCommand}\` and retry.`
    );
  }
  console.log(chalk.green(`✓ Backend ${backend} authenticated (${recheck.detail})`));
}

type BackendToolGateSnapshot = {
  mode: ToolMode;
  allowedTools: string[];
  unresolvedPatterns: string[];
};

function buildBackendToolPassthrough(
  backend: string,
  toolRouting: 'backend' | 'local',
  gate: BackendToolGateSnapshot,
  strictTools: boolean
): { passthroughArgs: string[]; warning?: string } {
  const shouldDisableBackendTools = toolRouting !== 'backend' || gate.mode === 'off';

  if (backend === 'claude') {
    if (shouldDisableBackendTools) {
      return { passthroughArgs: ['--allowedTools', ''] };
    }
    if (gate.mode === 'privileged') {
      return { passthroughArgs: [] };
    }
    return { passthroughArgs: ['--allowedTools', gate.allowedTools.join(',')] };
  }

  if (backend === 'gemini') {
    if (shouldDisableBackendTools) {
      return { passthroughArgs: ['--allowed-tools', ''] };
    }
    if (gate.mode === 'privileged') {
      return { passthroughArgs: [] };
    }
    return { passthroughArgs: ['--allowed-tools', gate.allowedTools.join(',')] };
  }

  if (backend === 'codex') {
    if (toolRouting === 'local' && strictTools) {
      return {
        passthroughArgs: [
          // Keep Codex execution deterministic in one-shot mode.
          // NOTE: for Codex `exec`, these are subcommand options and therefore
          // must be placed after `exec` (adapter handles ordering).
          '--color',
          'never',
          '--sandbox',
          'read-only',
          '--skip-git-repo-check',
          '--config',
          'features.apps=false',
          '--config',
          'mcp_servers.inkwell.enabled=false',
          '--config',
          'mcp_servers.next-devtools.enabled=false',
          '--config',
          'mcp_servers.github.enabled=false',
          '--config',
          'mcp_servers.supabase.enabled=false',
          '--config',
          'mcp_servers={}',
        ],
        warning:
          'Codex strict-tools mode enabled: forcing read-only sandbox, no color UI, and disabling known backend MCP servers.',
      };
    }
    if (shouldDisableBackendTools || gate.mode === 'backend') {
      return {
        passthroughArgs: [],
        warning:
          toolRouting === 'local'
            ? 'Codex CLI has no allowlist passthrough flag; relying on ink local-tool routing prompt guard.'
            : 'Codex CLI has no allowlist passthrough flag; backend tool gating is not enforced by CLI flags.',
      };
    }
  }

  return { passthroughArgs: [] };
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
  /** Transcript file size in bytes — quick toxic-session indicator */
  transcriptBytes: number;
  messageCount: number;
  userCount: number;
  assistantCount: number;
  inboxCount: number;
  lastMessageAt?: string;
  lastMessageRole?: 'user' | 'assistant' | 'inbox';
  lastMessagePreview?: string;
}

interface HistoryHydrationResult {
  loaded: number;
  messageCount: number;
  source: 'repl-transcript' | 'pcp-session-context' | 'none';
  transcriptPath?: string;
  tailPreview: Array<{
    /** 'event' rows are dim progress lines (tool calls) — not messages */
    role: 'user' | 'assistant' | 'inbox' | 'system' | 'event';
    content: string;
    ts?: string;
    /** Display label for system entries (e.g., "heartbeat", "continuation") */
    label?: string;
    /** Transcript event id (for eviction filtering of the replay) */
    eid?: number;
  }>;
  seenInboxIds?: string[];
  seenActivityIds?: string[];
  /** True when hydration collapsed history at a compaction event */
  compactionCollapsed?: boolean;
}

/** An entry excluded from the window by a context_evict event — kept for display */
interface EvictedEntryRecord {
  role: LedgerRole;
  content: string;
  source?: string;
  eid?: number;
  actor?: string;
  reason?: string;
}

const EVICTED_DISPLAY_MAX = 100;

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
// Working context budget + per-model window resolution live in ../repl/
// context-limits.js (imported above as defaultContextBudget /
// resolveBackendTokenWindow). ink derives its budget from the model's REAL
// window so it always compacts before the provider would — that module owns the
// conservative per-model table and the provider-headroom math.
// Compact when transcript+identity utilization crosses this fraction of budget
const AUTO_COMPACT_THRESHOLD_PCT = 0.8;
// Entries kept verbatim after the compaction summary (the working tail)
const AUTO_COMPACT_KEEP_RECENT_ENTRIES = 12;
const HISTORY_PREVIEW_MAX = 200;

function formatTokenCount(value: number): string {
  return value.toLocaleString();
}

function getDelegationSecret(): string | undefined {
  const fromEnv = process.env.INK_DELEGATION_SECRET?.trim();
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
  const dir = join(process.cwd(), '.ink', 'runtime', 'repl');
  mkdirSync(dir, { recursive: true });
  const safeSession = sessionId || 'local';
  return join(dir, `${safeSession}-${Date.now()}.jsonl`);
}

function findLatestTranscriptForSession(sessionId: string): string | undefined {
  const dir = join(process.cwd(), '.ink', 'runtime', 'repl');
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
  let lastMessageRole: SessionTranscriptMetadata['lastMessageRole'];
  let lastMessagePreview: string | undefined;

  const compactSessionMessagePreview = (raw: string): string => {
    const singleLine = raw.replace(/\s+/g, ' ').trim();
    if (!singleLine) return '';
    const maxChars = 120;
    if (singleLine.length <= maxChars) return singleLine;
    return `${singleLine.slice(0, Math.max(1, maxChars - 1))}…`;
  };

  const recordLastMessage = (
    role: 'user' | 'assistant' | 'inbox',
    content: string | undefined,
    ts?: string
  ) => {
    if (ts) lastMessageAt = ts;
    lastMessageRole = role;
    const compacted = content ? compactSessionMessagePreview(content) : '';
    lastMessagePreview = compacted || undefined;
  };

  for (const event of events) {
    const type = typeof event.type === 'string' ? event.type : '';
    if (type === 'user') {
      userCount += 1;
      recordLastMessage(
        'user',
        typeof event.content === 'string' ? event.content : undefined,
        typeof event.ts === 'string' ? event.ts : undefined
      );
      continue;
    }
    if (type === 'assistant') {
      assistantCount += 1;
      recordLastMessage(
        'assistant',
        typeof event.content === 'string' ? event.content : undefined,
        typeof event.ts === 'string' ? event.ts : undefined
      );
      continue;
    }
    if (type === 'inbox') {
      inboxCount += 1;
      recordLastMessage(
        'inbox',
        typeof event.rendered === 'string'
          ? event.rendered
          : typeof event.content === 'string'
            ? event.content
            : undefined,
        typeof event.ts === 'string' ? event.ts : undefined
      );
    }
  }

  const messageCount = userCount + assistantCount + inboxCount;
  let transcriptBytes = 0;
  try {
    transcriptBytes = statSync(path).size;
  } catch {
    // File raced away between read and stat — size stays 0
  }
  return {
    transcriptPath: path,
    transcriptBytes,
    messageCount,
    userCount,
    assistantCount,
    inboxCount,
    lastMessageAt,
    lastMessageRole,
    lastMessagePreview,
  };
}

// Exported for tests — verifies compaction events rehydrate summary + kept tail
export function hydrateLedgerFromTranscript(
  ledger: ContextLedger,
  transcriptPath: string
): {
  loaded: number;
  messageCount: number;
  tailPreview: HistoryHydrationResult['tailPreview'];
  seenInboxIds: string[];
  seenActivityIds: string[];
  recoveredMemoryIds: string[];
  compactionCollapsed: boolean;
  /** Entries excluded by context_evict events — for evicted-content display */
  evictedEntries: EvictedEntryRecord[];
  /** Tool calls replayed from the transcript (for the context inspector) */
  toolCalls: Array<{ tool: string; status: string; at: string; args?: string }>;
  /** Highest event id seen — seeds the append counter so new eids continue */
  maxEid: number;
} {
  const events = readTranscriptEvents(transcriptPath);
  let loaded = 0;
  let messageCount = 0;
  let compactionCollapsed = false;
  let maxEid = 0;
  const preview: HistoryHydrationResult['tailPreview'] = [];
  const seenInboxIds = new Set<string>();
  const seenActivityIds = new Set<string>();
  const recoveredMemoryIds: string[] = [];
  const evictedEntries: EvictedEntryRecord[] = [];
  const toolCalls: Array<{ tool: string; status: string; at: string; args?: string }> = [];
  // Entries added by THIS hydration pass — a compaction event collapses them
  // (and only them; entries that pre-date hydration are left alone).
  const hydratedEntryIds: number[] = [];

  const pushPreview = (
    role: 'user' | 'assistant' | 'inbox' | 'system' | 'event',
    content: string,
    ts?: string,
    label?: string,
    eid?: number
  ) => {
    preview.push({ role, content: compactForHistoryPreview(role, content), ts, label, eid });
    if (preview.length > HISTORY_PREVIEW_MAX) {
      preview.shift();
    }
  };

  for (const event of events) {
    const type = typeof event.type === 'string' ? event.type : '';
    const eid = typeof event.eid === 'number' ? event.eid : undefined;
    if (eid !== undefined && eid > maxEid) maxEid = eid;
    if (type === 'context_evict' && Array.isArray(event.refs)) {
      // Apply the eviction exactly as it happened live: remove matching
      // entries that exist at this point in the replay. Entries appended
      // AFTER this event (even with identical content) are unaffected —
      // in-stream ordering gives exclusion the right semantics for free.
      const refs = (event.refs as Array<Record<string, unknown>>)
        .filter((r) => r && typeof r === 'object')
        .map((r) => ({
          eid: typeof r.eid === 'number' ? r.eid : undefined,
          hash: typeof r.hash === 'string' ? r.hash : undefined,
        }));
      const hydratedSet = new Set(hydratedEntryIds);
      const matchIds = ledger.findEntriesByRefs(refs).filter((id) => hydratedSet.has(id));
      if (matchIds.length === 0) continue;
      const evictResult = ledger.evictEntries(matchIds);
      const removedLedgerIds = new Set(evictResult.removedEntries.map((e) => e.id));
      for (let i = hydratedEntryIds.length - 1; i >= 0; i--) {
        if (removedLedgerIds.has(hydratedEntryIds[i])) hydratedEntryIds.splice(i, 1);
      }
      // Drop evicted entries from the visible replay and adjust counts.
      // Eid-preferred matching: rows with eids are filtered ONLY by eid —
      // content-key matching is reserved for eid-less (legacy) removals.
      // Otherwise evicting one of two identical-content entries by eid
      // would also drop the survivor's preview row.
      const removedEids = new Set(
        evictResult.removedEntries.map((e) => e.eid).filter((v): v is number => v !== undefined)
      );
      const removedKeysWithoutEid = new Set(
        evictResult.removedEntries
          .filter((e) => e.eid === undefined)
          .map((e) => `${e.role} ${compactForHistoryPreview(e.role, e.content)}`)
      );
      for (let i = preview.length - 1; i >= 0; i--) {
        const p = preview[i];
        const matchesByEid = p.eid !== undefined && removedEids.has(p.eid);
        const matchesByKey =
          p.eid === undefined && removedKeysWithoutEid.has(`${p.role} ${p.content}`);
        if (matchesByEid || matchesByKey) {
          preview.splice(i, 1);
        }
      }
      let removedMessages = 0;
      for (const removed of evictResult.removedEntries) {
        if (
          removed.role === 'user' ||
          removed.role === 'assistant' ||
          removed.role === 'inbox' ||
          (removed.role === 'system' &&
            (removed.source === 'continuation' ||
              !INTERNAL_SYSTEM_SOURCES.has(removed.source || '')))
        ) {
          removedMessages += 1;
        }
        evictedEntries.push({
          role: removed.role,
          content: removed.content,
          source: removed.source,
          eid: removed.eid,
          actor: typeof event.actor === 'string' ? event.actor : undefined,
          reason: typeof event.reason === 'string' ? event.reason : undefined,
        });
      }
      if (evictedEntries.length > EVICTED_DISPLAY_MAX) {
        evictedEntries.splice(0, evictedEntries.length - EVICTED_DISPLAY_MAX);
      }
      messageCount = Math.max(0, messageCount - removedMessages);
      loaded = Math.max(0, loaded - evictResult.removedEntries.length);
      continue;
    }
    if (type === 'compaction' && typeof event.summary === 'string') {
      // Compaction marks a new start state: everything replayed before this
      // point is superseded by the event's summary + kept tail. The tail's
      // original events precede this marker in the file, so they were just
      // evicted — re-seed them from the event to match the live session's
      // post-compaction ledger exactly.
      ledger.evictEntries(hydratedEntryIds);
      hydratedEntryIds.length = 0;
      const summaryEntry = ledger.addEntry('system', event.summary, 'compaction-history');
      hydratedEntryIds.push(summaryEntry.id);
      loaded = 1;
      messageCount = 0;
      // Reset the visible replay too — pre-compaction turns are out of
      // context and must not appear below the cutoff divider. The kept
      // tail is re-added below from the event's keptEntries.
      preview.length = 0;
      compactionCollapsed = true;
      const keptEntries = Array.isArray(event.keptEntries) ? event.keptEntries : [];
      for (const kept of keptEntries) {
        if (!kept || typeof kept !== 'object') continue;
        const keptRecord = kept as Record<string, unknown>;
        if (typeof keptRecord.content !== 'string') continue;
        const role: LedgerRole =
          keptRecord.role === 'user' ||
          keptRecord.role === 'assistant' ||
          keptRecord.role === 'inbox' ||
          keptRecord.role === 'system'
            ? keptRecord.role
            : 'system';
        const source =
          typeof keptRecord.source === 'string' ? keptRecord.source : 'compaction-tail';
        const keptEid = typeof keptRecord.eid === 'number' ? keptRecord.eid : undefined;
        const entry = ledger.addEntry(role, keptRecord.content, source, keptEid);
        hydratedEntryIds.push(entry.id);
        loaded += 1;
        if (role === 'user' || role === 'assistant' || role === 'inbox') {
          messageCount += 1;
          pushPreview(
            role,
            keptRecord.content,
            typeof event.ts === 'string' ? event.ts : undefined,
            undefined,
            keptEid
          );
        } else if (role === 'system' && !INTERNAL_SYSTEM_SOURCES.has(source)) {
          // Kept system turns with a meaningful channel label (heartbeat,
          // telegram, …) stay visible in the replay
          pushPreview(
            'system',
            keptRecord.content,
            typeof event.ts === 'string' ? event.ts : undefined,
            source,
            keptEid
          );
        }
      }
      continue;
    }
    if (type === 'user' && typeof event.content === 'string') {
      const entry = ledger.addEntry('user', event.content, 'repl-history', eid);
      hydratedEntryIds.push(entry.id);
      loaded += 1;
      messageCount += 1;
      pushPreview(
        'user',
        event.content,
        typeof event.ts === 'string' ? event.ts : undefined,
        undefined,
        eid
      );
      continue;
    }
    if (type === 'assistant') {
      if (event.cancelled === true || event.content === '(no output)') continue;
      if (typeof event.content !== 'string') continue;
      const source = typeof event.backend === 'string' ? event.backend : 'backend-history';
      const entry = ledger.addEntry('assistant', event.content, source, eid);
      hydratedEntryIds.push(entry.id);
      loaded += 1;
      messageCount += 1;
      pushPreview(
        'assistant',
        event.content,
        typeof event.ts === 'string' ? event.ts : undefined,
        undefined,
        eid
      );
      continue;
    }
    if (type === 'inbox' && typeof event.rendered === 'string') {
      const entry = ledger.addEntry(
        'inbox',
        compactForLedger(event.rendered),
        'inkmail-history',
        eid
      );
      hydratedEntryIds.push(entry.id);
      loaded += 1;
      messageCount += 1;
      pushPreview(
        'inbox',
        event.rendered,
        typeof event.ts === 'string' ? event.ts : undefined,
        undefined,
        eid
      );
      if (typeof event.messageId === 'string') {
        seenInboxIds.add(event.messageId);
      }
      continue;
    }
    if (type === 'system_turn' && typeof event.content === 'string') {
      // Synthetic turn input (heartbeat trigger, continuation prompt, etc.)
      const label = typeof event.label === 'string' ? event.label : 'system';
      const entry = ledger.addEntry('system', event.content, label, eid);
      hydratedEntryIds.push(entry.id);
      loaded += 1;
      messageCount += 1;
      // Continuation prompts are repetitive noise — keep delivered messages
      // (heartbeat triggers, channel messages) visible in the replay.
      if (label !== 'continuation') {
        pushPreview(
          'system',
          event.content,
          typeof event.ts === 'string' ? event.ts : undefined,
          label,
          eid
        );
      }
      continue;
    }
    if (type === 'hook_injection' && typeof event.content === 'string') {
      const source = typeof event.source === 'string' ? event.source : 'hook-history';
      const entry = ledger.addEntry('system', event.content, source, eid);
      hydratedEntryIds.push(entry.id);
      loaded += 1;
      if (typeof event.memoryId === 'string') {
        recoveredMemoryIds.push(event.memoryId);
      }
      continue;
    }
    if (type === 'local_tool_call' && typeof event.tool === 'string') {
      // Tool calls are part of the story — when the assistant says "I sent
      // him a heads-up via Telegram", the send_response call is the receipt.
      // Replay them as dim event lines (display only — tool RESULTS are not
      // reconstructed into the ledger here). The inline row is a one-line
      // teaser; fuller args land in the context inspector's Tool Calls
      // section (Ctrl+T) via the toolCalls collected here.
      const status = typeof event.status === 'string' ? event.status : 'executed';
      const argsJson = event.args ? JSON.stringify(event.args).replace(/\s+/g, ' ') : '';
      const argsPreview = argsJson.length > 100 ? `${argsJson.slice(0, 100)}…` : argsJson;
      pushPreview(
        'event',
        `🛠 ${event.tool} (${status})${argsPreview ? ` — ${argsPreview}` : ''}`,
        typeof event.ts === 'string' ? event.ts : undefined,
        undefined,
        eid
      );
      toolCalls.push({
        tool: event.tool,
        status,
        at: typeof event.ts === 'string' ? event.ts : '',
        args: argsJson
          ? argsJson.length > 400
            ? `${argsJson.slice(0, 400)}…`
            : argsJson
          : undefined,
      });
      if (toolCalls.length > 100) {
        toolCalls.splice(0, toolCalls.length - 100);
      }
      continue;
    }
    if (type === 'activity' && typeof event.content === 'string') {
      const actor = typeof event.agentId === 'string' ? event.agentId : 'system';
      const activityType = typeof event.activityType === 'string' ? event.activityType : 'activity';
      const entry = ledger.addEntry(
        'system',
        compactForLedger(`⚡ ${actor} ${activityType} — ${event.content}`, 320),
        'pcp-activity-history',
        eid
      );
      hydratedEntryIds.push(entry.id);
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
    recoveredMemoryIds,
    compactionCollapsed,
    evictedEntries,
    toolCalls,
    maxEid,
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

// Per-transcript monotonic event id counters. Every appended event gets an
// `eid` so persistent operations (context_evict) can reference events
// precisely across reattach. Seeded from the file's max eid on hydration.
const transcriptEidCounters = new Map<string, number>();

export function seedTranscriptEidCounter(path: string, maxSeen: number): void {
  const current = transcriptEidCounters.get(path) ?? 0;
  if (maxSeen > current) transcriptEidCounters.set(path, maxSeen);
}

function appendTranscript(path: string, event: Record<string, unknown>): number {
  const eid = (transcriptEidCounters.get(path) ?? 0) + 1;
  transcriptEidCounters.set(path, eid);
  appendFileSync(path, JSON.stringify({ ts: new Date().toISOString(), eid, ...event }) + '\n');
  return eid;
}

function compactForLedger(content: string, maxChars = LEDGER_COMPACT_CHARS): string {
  const normalized = content.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(1, maxChars - 1))}…`;
}

// System-entry sources that are runtime bookkeeping, not conversation —
// excluded from the visible history replay (they stay in the ledger).
const INTERNAL_SYSTEM_SOURCES = new Set([
  'continuation',
  'compaction-tail',
  'compaction-history',
  'pcp-activity',
  'pcp-activity-history',
  'passive-recall',
  'budget-monitor',
  'auto-run',
  'hook-history',
  'bootstrap',
]);

function compactForHistoryPreview(
  role: 'user' | 'assistant' | 'inbox' | 'system' | 'event',
  content: string
): string {
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
  const matches = Array.from(responseText.matchAll(/```ink-tool\s*([\s\S]*?)```/gi));
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
  return responseText.replace(/```ink-tool[\s\S]*?```/gi, '').trim();
}

/**
 * True when a signal_status tool result reports a TERMINAL status
 * (completed or blocked) — the agent explicitly ending its turn.
 *
 * The local-tool loop re-invokes the backend as long as any tool executed, and
 * signal_status counts as an executed tool. Without treating a terminal signal
 * as a stop condition, a single turn keeps re-invoking the backend up to the
 * iteration cap; the agent, re-prompted to "continue", just re-signals
 * completion each round — the multiplied signal_status calls and duplicate
 * backend/Claude sessions seen per heartbeat. 'continuing' is NOT terminal: the
 * agent is asking for another round, so the loop should proceed.
 */
export function isTerminalSignalToolResult(result: unknown): boolean {
  const text = (result as { content?: Array<{ text?: string }> } | undefined)?.content?.[0]?.text;
  if (!text) return false;
  try {
    const status = (JSON.parse(text)?.signal as { status?: string } | undefined)?.status;
    return status === 'completed' || status === 'blocked';
  } catch {
    return false;
  }
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
        provider: typeof row.provider === 'string' ? row.provider : undefined,
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
        platform: typeof row.platform === 'string' ? row.platform : undefined,
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
  )}%) ${queue} provider:${params.backend}`;
}

function formatUsageLines(
  ledger: ContextLedger,
  maxContextTokens: number,
  previousTotal?: number,
  lastBackendUsage?: BackendTokenUsage,
  backendTokenWindow?: number
): { lines: string[]; total: number } {
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
  const windowLabel =
    backendTokenWindow && backendTokenWindow !== maxContextTokens
      ? `  backend-window:${backendTokenWindow.toLocaleString()}`
      : '';
  const header = `Context: ~${total.toLocaleString()} / ${maxContextTokens.toLocaleString()} tok (${pct.toFixed(
    1
  )}%)${deltaLabel}${windowLabel}`;
  const lines = [
    header,
    `[${bar}]  entries:${entries.length}  user:${user.toLocaleString()}  assistant:${assistant.toLocaleString()}  inbox:${inbox.toLocaleString()}  system:${system.toLocaleString()}`,
  ];
  if (lastBackendUsage) {
    lines.push(`Last backend usage: ${formatBackendTokenUsage(lastBackendUsage)}`);
  }
  return { lines, total };
}

function printUsage(
  ledger: ContextLedger,
  maxContextTokens: number,
  previousTotal?: number,
  lastBackendUsage?: BackendTokenUsage,
  backendTokenWindow?: number
): number {
  const { lines, total } = formatUsageLines(
    ledger,
    maxContextTokens,
    previousTotal,
    lastBackendUsage,
    backendTokenWindow
  );
  for (const line of lines) console.log(line);
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

function formatRelativeTime(ms: number, timezone?: string): string {
  const now = Date.now();
  const diffMs = now - ms;
  if (diffMs < 0) return 'just now';
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  try {
    return new Date(ms).toLocaleDateString([], {
      month: 'short',
      day: 'numeric',
      timeZone: timezone,
    });
  } catch {
    return new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric' });
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
  session: Pick<SessionSummary, 'studioId' | 'studioName'>,
  mode: 'short' | 'full' = 'short'
): string {
  // Prefer name over UUID — UUIDs are noise for humans
  if (session.studioName) return session.studioName;
  return formatStudioForDisplay(session.studioId, mode);
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

/** Human file size for transcript footprints: 412KB, 1.2MB, 24MB. Exported for tests. */
export function formatTranscriptSize(bytes: number): string {
  if (bytes <= 0) return '';
  const mb = bytes / (1024 * 1024);
  if (mb < 1) return `${Math.max(1, Math.round(bytes / 1024))}KB`;
  if (mb < 10) return `${mb.toFixed(1)}MB`;
  return `${Math.round(mb)}MB`;
}

function sessionHistoryLabel(meta: SessionTranscriptMetadata | null): string {
  if (!meta) return 'remote';
  const size = formatTranscriptSize(meta.transcriptBytes);
  return size ? `${meta.messageCount} msgs · ${size}` : `${meta.messageCount} msgs`;
}

function sessionLatestMessagePreview(
  session: Pick<SessionSummary, 'agentId'>,
  meta: SessionTranscriptMetadata | null
): string | null {
  if (!meta?.lastMessagePreview) return null;
  const speaker =
    meta.lastMessageRole === 'assistant'
      ? session.agentId || 'assistant'
      : meta.lastMessageRole === 'inbox'
        ? 'inbox'
        : 'you';
  return `${speaker}: ${meta.lastMessagePreview}`;
}

function chip(label: string, value: string, color: (text: string) => string): string {
  return `${chalk.dim(`${label}:`)} ${color(value)}`;
}

function formatSessionsLines(
  sessions: SessionSummary[],
  options?: { timezone?: string }
): string[] {
  if (sessions.length === 0) {
    return ['No active sessions found.'];
  }
  const lines = [
    'Active sessions',
    'id       agent   status/phase            studio            thread        started   backend            history             last-msg',
  ];
  for (const session of sessions) {
    const transcriptMeta = getSessionTranscriptMetadata(session.id);
    const id = session.id.slice(0, 7).padEnd(7);
    const agent = (session.agentId || '-').slice(0, 6).padEnd(6);
    const status = (session.currentPhase || session.status || '-').slice(0, 22).padEnd(22);
    const studio = sessionStudioLabel(session, 'short').slice(0, 16).padEnd(16);
    const thread = (session.threadKey || '-').slice(0, 12).padEnd(12);
    const started = formatStartedAt(session.startedAt);
    const backend = sessionBackendLabel(session).slice(0, 18).padEnd(18);
    const history = sessionHistoryLabel(transcriptMeta).slice(0, 18).padEnd(18);
    const lastMessage = formatTimestampForSessionList(
      transcriptMeta?.lastMessageAt,
      options?.timezone
    ).padEnd(8, ' ');
    lines.push(
      `${id}  ${agent}  ${status}  ${studio}  ${thread}  ${started.padEnd(7)}  ${backend}  ${history}  ${lastMessage}`
    );
  }
  return lines;
}

function printSessionsSnapshot(sessions: SessionSummary[], options?: { timezone?: string }): void {
  const lines = formatSessionsLines(sessions, options);
  for (const line of lines) console.log(chalk.dim(line));
  console.log('');
}

function formatToolPolicyLines(
  toolPolicy: ToolPolicyState,
  sessionId: string | undefined,
  activeSkills: SkillInstruction[]
): string[] {
  const gate = toolPolicy.getBackendToolGate();
  const lines: string[] = [
    'Tool policy',
    `Path: ${toolPolicy.getPolicyPath()}`,
    `Effective mode: ${toolPolicy.getMode()}`,
    `Mutation scope: ${toolPolicy.getMutationScopeLabel()}`,
    `Active scopes: ${toolPolicy.listActiveScopeLabels().join(' -> ')}`,
    `Skill trust mode: ${toolPolicy.getSkillTrustMode()}`,
    `Session visibility: ${toolPolicy.getSessionVisibility()}`,
  ];
  if (gate.mode === 'backend') {
    lines.push(
      `Backend passthrough allowlist (${gate.allowedTools.length}): ${
        gate.allowedTools.length > 0
          ? gate.allowedTools.join(', ')
          : '(empty; backend tools disabled)'
      }`
    );
    if (gate.unresolvedPatterns.length > 0) {
      lines.push(
        `Backend wildcard patterns require local/prompt: ${gate.unresolvedPatterns.join(', ')}`
      );
    }
  }
  if (gate.mode === 'off') {
    lines.push('Backend passthrough mode is off (no backend tool calls permitted).');
  }
  if (gate.mode === 'privileged') {
    lines.push('Backend passthrough mode is privileged (allowlist not clamped).');
  }

  const grants = toolPolicy.listGrants();
  if (grants.length > 0) {
    lines.push(`Grants: ${grants.map((entry) => `${entry.tool}(${entry.uses})`).join(', ')}`);
  }
  const allow = toolPolicy.listAllowTools();
  if (allow.length > 0) lines.push(`Allow: ${allow.join(', ')}`);
  const deny = toolPolicy.listDenyTools();
  if (deny.length > 0) lines.push(`Deny: ${deny.join(', ')}`);
  const prompt = toolPolicy.listPromptTools();
  if (prompt.length > 0) lines.push(`Prompt: ${prompt.join(', ')}`);

  const readAllow = toolPolicy.listReadPathAllow();
  const writeAllow = toolPolicy.listWritePathAllow();
  if (readAllow.length > 0) lines.push(`Read path allow: ${readAllow.join(', ')}`);
  if (writeAllow.length > 0) lines.push(`Write path allow: ${writeAllow.join(', ')}`);

  const skills = toolPolicy.listAllowedSkills();
  if (skills.length > 0) lines.push(`Allowed skills: ${skills.join(', ')}`);
  const sessionGrants = toolPolicy.listSessionGrants(sessionId);
  if (sessionGrants.length > 0) {
    lines.push(
      `Session grants: ${sessionGrants.map((entry) => `${entry.tool}(${entry.uses})`).join(', ')}`
    );
  }
  const scoped = toolPolicy.listActiveScopeSnapshots();
  if (scoped.length > 0) {
    lines.push('Scope pipeline:');
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
      lines.push(`  ${scope.label}${fragments.length > 0 ? ` :: ${fragments.join('  ')}` : ''}`);
    }
  }
  if (activeSkills.length > 0) {
    lines.push(`Active skills: ${activeSkills.map((skill) => skill.name).join(', ')}`);
  }
  return lines;
}

function printToolPolicySnapshot(
  toolPolicy: ToolPolicyState,
  sessionId: string | undefined,
  activeSkills: SkillInstruction[]
): void {
  const lines = formatToolPolicyLines(toolPolicy, sessionId, activeSkills);
  for (const line of lines) console.log(chalk.dim(line));
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
          agentId,
        },
        target: {
          sessionId: session.id,
          threadKey: session.threadKey,
          studioId: session.studioId,
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
  }`.toLowerCase();
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
    const preview = sessionLatestMessagePreview(session, transcriptMeta);
    const studioName = session.studioName;
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
    if (preview) {
      console.log(chalk.dim(`      ↳ ${preview}`));
    }
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

function sanitizeArgsForApproval(tool: string, args: Record<string, unknown>): string {
  const policyName = tool.replace(/^mcp__inkwell__/, '');
  switch (policyName) {
    case 'bash':
      return typeof args.command === 'string' ? args.command.slice(0, 500) : '';
    case 'write':
    case 'edit': {
      const path = (args.path ?? args.file_path ?? args.filePath) as string | undefined;
      return path ? path.slice(0, 200) : '';
    }
    case 'read':
    case 'ls':
    case 'grep':
    case 'find': {
      const path = (args.path ?? args.file_path ?? args.filePath ?? args.pattern) as
        | string
        | undefined;
      return path ? path.slice(0, 200) : '';
    }
    default:
      return '';
  }
}

async function promptForToolApproval(
  rl: ReturnType<typeof createInterface> | null,
  toolPolicy: ToolPolicyState,
  sessionId: string | undefined,
  tool: string,
  reason: string,
  inkRepl?: InkRepl | null,
  approvalChannel?: ApprovalChannel,
  args?: Record<string, unknown>
): Promise<boolean> {
  let choice: import('../repl/tool-approval.js').ToolApprovalChoice;

  const argsDisplay = args ? sanitizeArgsForApproval(tool, args) : '';

  if (approvalChannel) {
    // JSONL or auto channel — structured approval protocol
    const response = await approvalChannel.requestApproval({
      tool,
      args: args ?? {},
      reason,
      sessionId,
    });
    // Map channel response decision to tool approval choice
    choice = response.decision as import('../repl/tool-approval.js').ToolApprovalChoice;
  } else if (inkRepl) {
    // Render a visually distinct permission prompt in Ink
    const lines = [`🔐 ${tool}`];
    if (argsDisplay) lines.push(argsDisplay);
    lines.push(reason, '', '[y] once · [s] session · [a] always · [d] deny · [n] cancel');
    inkRepl.addMessage('system', lines.join('\n'), { label: '🔐 permission' });
    const answer = (await inkRepl.waitForInput()).trim();
    choice = parseToolApprovalInput(answer);
  } else if (rl) {
    const detail = argsDisplay ? ` (${argsDisplay})` : '';
    console.log(chalk.yellow(`🔐 ${tool}${detail} — ${reason}`));
    const answer = (
      await rl.question(
        chalk.yellow(`Allow? [y] once, [s] session, [a] always, [d] deny, [n] cancel: `)
      )
    ).trim();
    choice = parseToolApprovalInput(answer);
  } else {
    return false;
  }

  const result = applyToolApprovalChoice({
    policy: toolPolicy,
    tool,
    sessionId,
    choice,
  });
  if (result.message) {
    if (approvalChannel) {
      // In JSONL mode, emit a log line but don't use TUI
      console.error(
        result.approved ? `✅ ${tool}: ${result.message}` : `🚫 ${tool}: ${result.message}`
      );
    } else if (inkRepl) {
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

/**
 * Detect claude's "resume failed because the session no longer exists locally"
 * signal from stderr. Mirrors the same check in the server runners
 * (ink-runner.ts / claude-runner.ts) so the CLI recovers the same way.
 */
export function isResumeFailedNoSession(stderr: string): boolean {
  const lower = (stderr || '').toLowerCase();
  return lower.includes('session not found') || lower.includes('no such session');
}

/**
 * Recover the live provider-native session id from a reattached transcript so a
 * fresh process (the next server heartbeat, or a reattach) resumes the SAME
 * native session instead of fragmenting into a new jsonl. Returns the id of the
 * last `backend_session` marker. A `compaction` marker clears the candidate:
 * after ink compacts we deliberately roll to a fresh provider session, so a
 * pre-compaction id must never be resumed (it would drag the pre-compaction
 * window back in).
 */
export function findLastBackendSessionId(transcriptPath: string): string | undefined {
  if (!transcriptPath || !existsSync(transcriptPath)) return undefined;
  let content: string;
  try {
    content = readFileSync(transcriptPath, 'utf-8');
  } catch {
    return undefined;
  }
  let found: string | undefined;
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    let event: { type?: unknown; id?: unknown };
    try {
      event = JSON.parse(line) as { type?: unknown; id?: unknown };
    } catch {
      continue;
    }
    if (event.type === 'backend_session' && typeof event.id === 'string') {
      found = event.id;
    } else if (
      event.type === 'compaction' ||
      event.type === 'context_evict' ||
      event.type === 'context_trim'
    ) {
      // A context-boundary mutation rolled the provider session. Abandon any
      // prior id — a backend_session marker after this point re-establishes it.
      found = undefined;
    }
  }
  return found;
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

  const toolInstruction =
    runtime.toolRouting === 'local'
      ? 'IMPORTANT: To call tools, you MUST emit fenced code blocks in this exact format:\n\n```ink-tool\n{"tool":"tool_name","args":{}}\n```\n\nDo NOT use ToolSearch, mcp__inkwell__*, or native MCP tool calling — those will not work in this runtime. Only the fenced block format above will execute tools. You can emit multiple ink-tool blocks in one response.\n\nInkwell tools (server round-trip): get_inbox, recall, remember, list_tasks, send_response, save_link, create_task, update_session_state, bootstrap, etc.\n\nCoding tools (in-process, scoped to working directory):\n- read: Read a file. Args: path (string), offset (number, optional), limit (number, optional).\n- edit: Edit a file by find-and-replace. Args: path (string), edits (array of {oldText, newText}).\n- write: Create or overwrite a file. Args: path (string), content (string).\n- bash: Execute a shell command. Args: command (string), timeout (number, optional).\n- grep: Search file contents. Args: pattern (string), path (string, optional), include (string, optional).\n- find: Find files by name/pattern. Args: pattern (string), path (string, optional).\n- ls: List directory contents. Args: path (string, optional).\n\nClient-local tools (no server round-trip):\n- list_context: Introspect your context window — see all entries with IDs, token counts, sources, and previews.\n- evict_context: Remove specific entries from your context to reclaim tokens. Args: entryIds (number[]), source (string), or role (string).\n- signal_status: Signal your session status. Args: status ("completed" | "blocked" | "continuing"), reason (string, optional). Use this at the end of your work to tell the runtime whether you are done, blocked on something, or need another turn.'
      : runtime.toolMode === 'off'
        ? 'Do not call backend-native tools. Provide reasoning and instructions only.'
        : runtime.toolMode === 'privileged'
          ? 'Backend-native tools are enabled and external actions are allowed when needed.'
          : '';

  return [
    `You are ${agentId}.`,
    'You are running inside ink chat (first-class Ink REPL).',
    'Answer in plain text. Be concise but complete.',
    `Current backend: ${runtime.backend}${runtime.model ? ` (${runtime.model})` : ''}.`,
    `Tool mode: ${runtime.toolMode}.`,
    `Tool routing: ${runtime.toolRouting}.`,
    runtime.strictTools ? 'Strict tools mode: ON.' : '',
    toolInstruction,
    runtime.activeSkills.length > 0
      ? `Active skills: ${runtime.activeSkills.map((skill) => skill.name).join(', ')}`
      : '',
    runtime.threadKey ? `Thread key: ${runtime.threadKey}.` : '',
    // Identity context from bootstrap — always included
    runtime.bootstrapContext
      ? `\n=== Identity Context (from Inkwell bootstrap) ===\n${runtime.bootstrapContext}\n=== End Identity Context ===`
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

/**
 * A stable signature of everything buildPromptEnvelope renders that does NOT
 * change per turn — the static "shape" a seeded provider session already holds:
 * system framing, tool instructions (from tool mode/routing), strict flag,
 * skills, thread key, and identity context. Excludes the transcript/recall/raw,
 * which ARE the intended per-turn delta. When this drifts mid-session — /backend,
 * /model, /tool-routing, /skill-use, /skill-clear, /refresh, profile changes —
 * the resumed native session would be stale (e.g. seeded with backend
 * tool-routing, then /tool-routing local leaves it without ink-tool
 * instructions), so runUserTurn invalidates and reseeds. Subsumes the backend
 * check (backend is part of the shape). Hashed so the stored key stays small.
 * Keep this in sync with buildPromptEnvelope's static (non-transcript) fields.
 */
export function envelopeShapeKey(runtime: ChatRuntime): string {
  const shape = [
    runtime.backend,
    runtime.model ?? '',
    runtime.toolMode,
    runtime.toolRouting,
    runtime.strictTools ? '1' : '0',
    runtime.threadKey ?? '',
    runtime.activeSkills.map((s) => s.name).join(','),
    runtime.bootstrapContext ?? '',
  ].join('');
  // djb2 — cheap, kept in int32 each step; collision-resistant enough to detect
  // config drift (we only need change-detection, not cryptographic strength).
  let hash = 5381;
  for (let i = 0; i < shape.length; i++) {
    hash = ((hash << 5) + hash + shape.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}

export async function runChat(options: ChatOptions): Promise<void> {
  const debugFile = initSbDebug({
    enabled: options.sbDebug,
    context: {
      command: 'chat',
      argv: process.argv.slice(2),
      backend: options.backend,
      agent: options.agent,
    },
  });

  if (options.tailTranscript) {
    await tailTranscript(options.tailTranscript);
    return;
  }

  const resolvedAgentId = resolveAgentId(options.agent);
  if (!resolvedAgentId) {
    throw new Error('Could not resolve agent identity. Run `ink init` or pass `--agent <id>`.');
  }
  const agentId: string = resolvedAgentId;
  const pcp = new PcpClient();
  const identity = readIdentityJson(process.cwd());
  let autoAttachedLatest = false;
  let contextBudgetAuto = !options.maxContextTokens;
  const initialBackend = options.backend || 'claude';
  const initialBackendTokenWindow = resolveBackendTokenWindow(initialBackend, options.model);
  const configuredMaxContextTokens = Number.parseInt(
    options.maxContextTokens || String(defaultContextBudget(initialBackendTokenWindow)),
    10
  );
  const parsedBackendTimeoutSeconds =
    options.backendTimeoutSeconds !== undefined
      ? Number.parseInt(options.backendTimeoutSeconds, 10)
      : Number.NaN;
  // Hard ceiling: an explicit --backend-timeout-seconds override, else undefined
  // (→ backend-runner's generous ~20-min backstop). The old blunt 120s
  // non-interactive wall is GONE — it killed legitimately long turns at the
  // completion boundary (exit 124 → false backend-error). Long turns are now
  // governed by the idle/token-flow timeout below, not wall-clock.
  const backendTurnTimeoutMs =
    Number.isFinite(parsedBackendTimeoutSeconds) && parsedBackendTimeoutSeconds > 0
      ? parsedBackendTimeoutSeconds * 1000
      : undefined;
  // Idle/token-flow timeout — the primary reaper for server (non-interactive)
  // turns: kill only after 15 min with NO output. With stream-json the backend
  // emits continuously, so this fires only on a genuine stall. 15 min clears the
  // 300s away-mode approval poll with wide margin (a 5-min value would RACE it
  // and could SIGTERM a turn mid-approval). Sits below the outer InkRunner
  // inactivity window (1 h) so a stalled turn is reaped here (clean exit 124)
  // instead of escalating to the outer SIGTERM.
  const backendIdleTimeoutMs = options.nonInteractive ? 15 * 60 * 1000 : undefined;

  // Persisted runtime preferences from .ink/identity.json — CLI flags override these
  const persisted = identity?.runtime;

  const runtime: ChatRuntime = {
    backend: initialBackend,
    model: options.model,
    verbose: options.verbose ?? false,
    toolMode:
      options.tools === 'off' ? 'off' : options.tools === 'privileged' ? 'privileged' : 'backend',
    toolRouting: options.toolRouting
      ? options.toolRouting === 'backend'
        ? 'backend'
        : 'local'
      : persisted?.toolRouting || 'local',
    uiMode: options.ui === 'scroll' ? 'scroll' : 'live',
    threadKey: options.threadKey,
    studioId: identity?.studioId,
    userTimezone: undefined,
    backendTokenWindow: initialBackendTokenWindow,
    sessionId: options.sessionId?.trim() || undefined,
    maxContextTokens: Number.isNaN(configuredMaxContextTokens)
      ? defaultContextBudget(initialBackendTokenWindow)
      : configuredMaxContextTokens,
    pollSeconds: Number.parseInt(options.pollSeconds || '20', 10),
    showSessionsWatch: false,
    eventPolling: true,
    autoRunInbox: options.autoRun ?? false,
    awayMode: options.away ?? false,
    transcriptPath: ensureRuntimeTranscriptPath(),
    activeSkills: [],
    strictTools: options.sbStrictTools ?? persisted?.strictTools ?? false,
    backendTurnTimeoutMs,
    backendIdleTimeoutMs,
    approvalMode:
      options.approvalMode === 'jsonl' || persisted?.approvalMode === 'jsonl'
        ? 'jsonl'
        : options.approvalMode === 'auto-approve'
          ? 'auto-approve'
          : options.nonInteractive || options.message
            ? options.profile === 'full'
              ? 'auto-approve' // --profile full + non-interactive = trust all tools
              : options.away
                ? 'interactive' // --away + non-interactive = route approvals to inbox
                : 'auto-deny'
            : 'interactive',
  };
  // Resolve --sender or --contact-id for per-sender session isolation
  if (options.contactId) {
    runtime.contactId = options.contactId;
  } else if (options.sender) {
    // --sender resolves platform:id to a contact via the admin API
    const colonIdx = options.sender.indexOf(':');
    if (colonIdx === -1) {
      console.error(chalk.red('--sender must be in format platform:id (e.g., telegram:99887766)'));
      process.exit(1);
    }
    const platform = options.sender.split(':')[0];
    const platformId = options.sender.slice(colonIdx + 1);
    try {
      const { getPcpServerUrl } = await import('../lib/pcp-mcp.js');
      const { getValidAccessToken } = await import('../auth/tokens.js');
      const serverUrl = getPcpServerUrl().replace(/\/+$/, '');
      const token = await getValidAccessToken(serverUrl);
      if (!token) throw new Error('Not authenticated');

      const resp = await fetch(`${serverUrl}/api/admin/contacts/resolve`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ platform, platformId, autoCreate: true }),
      });
      if (resp.ok) {
        const data = (await resp.json()) as { contact?: { id?: string; name?: string } };
        if (data.contact?.id) {
          runtime.contactId = data.contact.id;
          console.log(
            chalk.dim(
              `Resolved sender ${platform}:${platformId} → contact ${data.contact.name || data.contact.id}`
            )
          );
        }
      } else {
        const errText = await resp.text().catch(() => '');
        console.log(
          chalk.yellow(
            `Could not resolve sender: ${errText || resp.statusText}. Continuing without contact scope.`
          )
        );
      }
    } catch (error) {
      console.log(
        chalk.yellow(
          `Failed to resolve sender: ${error instanceof Error ? error.message : String(error)}. ` +
            `Use --contact-id <uuid> for direct contact scoping.`
        )
      );
    }
  }

  await ensureBackendAuthReady(runtime.backend, {
    nonInteractive: Boolean(options.nonInteractive),
    hasMessage: Boolean(options.message?.trim()),
    verbose: runtime.verbose,
  });
  const approvalManager = new ApprovalRequestManager();

  // Initialize approval channel based on mode
  if (runtime.approvalMode === 'jsonl') {
    runtime.approvalChannel = new JsonlApprovalChannel(process.stderr, process.stdin);
  } else if (runtime.approvalMode === 'auto-deny') {
    runtime.approvalChannel = new AutoApprovalChannel('cancel');
  } else if (runtime.approvalMode === 'auto-approve') {
    runtime.approvalChannel = new AutoApprovalChannel('once');
  }
  // 'interactive' mode uses the existing TUI prompt (no channel needed)
  const policyPathFromEnv = process.env.INK_TOOL_POLICY_PATH?.trim();
  const toolPolicy = new ToolPolicyState(
    runtime.toolMode,
    policyPathFromEnv ? { policyPath: policyPathFromEnv } : undefined
  );
  toolPolicy.setContext({
    agentId,
    studioId: runtime.studioId,
  });
  if (runtime.studioId) {
    toolPolicy.setMutationScope('studio');
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
  const initialInfoItems = [shortCwd, gitBranch].filter(Boolean);
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

  // Compact progress/status lines (tool runs, signals, dividers, surfaced
  // memories): rendered as dim unlabeled events in Ink mode rather than
  // "system"-labeled message blocks. Legacy mode prints them as-is.
  const printEvent = (line: string) => {
    if (inkRepl) {
      if (line.trim()) {
        inkRepl.printEvent(line);
      }
      return;
    }
    statusLane.printLine(line);
    restorePromptAfterWrite?.();
  };

  // Non-interactive event stream. When running headless (server-spawned via
  // InkRunner with --non-interactive), emit structured NDJSON lines to stdout
  // as the turn progresses. Purpose: give the runner a mid-turn liveness signal
  // (for an inactivity-based timeout) and a live tool-by-tool progress feed.
  // These lines sit alongside human-readable status chrome — the runner parses
  // JSON lines and ignores the rest. The authoritative end-of-run summary is
  // still the single `type:'result'` line emitted at completion. No-op in
  // interactive mode: nothing consumes stdout there and raw JSON would corrupt
  // the rendered UI.
  const emitStreamEvent = (evt: Record<string, unknown>): void => {
    if (!options.nonInteractive) return;
    try {
      process.stdout.write(`${JSON.stringify(evt)}\n`);
    } catch {
      // A stdout write failure must never abort the turn.
    }
  };

  // Bridge normalized backend stream events onto the live feed. Backend tool
  // calls (the provider calling MCP tools mid-turn) now surface in real time —
  // before stream-json the feed was silent during a backend-routed generation.
  // Assistant text lands in the final response; per-token deltas are a follow-on.
  const handleBackendEvent = (evt: BackendTurnEvent): void => {
    if (evt.kind === 'tool-use') {
      emitStreamEvent({
        type: 'tool_call',
        toolName: evt.name,
        status: 'running',
        layer: 'backend',
      });
    }
  };

  const ledger = new ContextLedger();
  const hookRegistry = new SbHookRegistry();
  let hookTurnCount = 0;

  // Session-level tool call log — surfaced in the Ctrl+O context inspector
  const recentToolCalls: Array<{ tool: string; status: string; at: string; args?: string }> = [];

  // Entries evicted from the window (hydration replay + live evictions) —
  // out of context but never out of sight; surfaced in the inspector
  const sessionEvictedEntries: EvictedEntryRecord[] = [];

  // Register built-in hooks (passive recall + budget monitor).
  // callRecall wraps pcp.callTool('recall', ...) into the shape hooks expect.
  const { passiveRecall: passiveRecallHandle } = registerBuiltinHooks(hookRegistry, {
    callRecall: async (query, limit) => {
      try {
        const result = await pcp.callTool('recall', {
          query,
          agentId,
          includeShared: true,
          limit,
          recallMode: 'hybrid',
        });
        // PcpClient.callTool() parses the JSON-RPC response and returns
        // the tool result directly (e.g., { success, memories, ... })
        const parsed = result as Record<string, unknown>;
        if (!parsed.success) return [];
        const memories = parsed.memories as Array<Record<string, unknown>> | undefined;
        return (memories || []).map((m) => ({
          id: m.id as string,
          content: m.content as string,
          summary: (m.summary as string) || null,
          topics: (m.topics as string[]) || [],
        }));
      } catch {
        return [];
      }
    },
  });

  const seenInboxIds = new Set<string>();
  const seenActivityIds = new Set<string>();
  let pollTimer: NodeJS.Timeout | null = null;
  let stopEventStream: (() => void) | null = null;
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

    // Pre-load Keychain credentials for the credential resolver.
    // Runs once at session start; the cache persists for the session lifetime.
    const keychainCreds = await loadKeychainCredentials();
    if (Object.keys(keychainCreds).length > 0) {
      console.log(chalk.dim(`Keychain: ${Object.keys(keychainCreds).length} credential(s) loaded`));
    }

    // Seed passive recall dedup with memory IDs already in bootstrap context
    const bootstrapMemoryIds = bootstrapResult.memoryIds as string[] | undefined;
    if (bootstrapMemoryIds && bootstrapMemoryIds.length > 0) {
      passiveRecallHandle.seedBootstrapIds(bootstrapMemoryIds);
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
      if (selected.studioId) {
        runtime.studioId = selected.studioId;
      }
      if (!runtime.threadKey && selected.threadKey) {
        runtime.threadKey = selected.threadKey;
      }
      toolPolicy.setContext({
        agentId,
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
      .callTool('list_sessions', { agentId, status: 'active', backend: 'ink', limit: 30 })
      .catch(() => null)) as Record<string, unknown> | null;
    const sessions = filterSessionsByPolicy(
      extractSessionSummaries(sessionsResult),
      runtime,
      agentId,
      toolPolicy,
      'attach'
    );

    const isInteractiveInk = useInk && !options.message && !options.nonInteractive;

    if (isInteractiveInk) {
      // Show interactive session picker
      const sessionsWithMeta = sessions.map((session) => {
        const transcriptMeta = getSessionTranscriptMetadata(session.id);
        const lastActivityMs = transcriptMeta?.lastMessageAt
          ? Date.parse(transcriptMeta.lastMessageAt)
          : session.startedAt
            ? Date.parse(session.startedAt)
            : 0;
        return { session, transcriptMeta, lastActivityMs };
      });

      sessionsWithMeta.sort((a, b) => {
        const aStudioMatch = runtime.studioId && a.session.studioId === runtime.studioId ? 1 : 0;
        const bStudioMatch = runtime.studioId && b.session.studioId === runtime.studioId ? 1 : 0;
        if (aStudioMatch !== bStudioMatch) return bStudioMatch - aStudioMatch;
        return b.lastActivityMs - a.lastActivityMs;
      });

      const pickerEntries: SessionPickerEntry[] = sessionsWithMeta.map(
        ({ session, transcriptMeta, lastActivityMs }) => ({
          id: session.id,
          label: session.id.slice(0, 8),
          phase: session.currentPhase || session.status,
          threadKey: session.threadKey,
          studioName: sessionStudioLabel(session),
          backend: sessionBackendLabel(session),
          historyLabel: sessionHistoryLabel(transcriptMeta),
          lastMessage: lastActivityMs
            ? formatRelativeTime(lastActivityMs, runtime.userTimezone)
            : undefined,
          preview: sessionLatestMessagePreview(session, transcriptMeta) || undefined,
        })
      );

      const picked = await renderSessionPicker(pickerEntries);
      if (picked === undefined) {
        // Cancel — exit without creating a session
        return;
      }
      if (picked) {
        const selected = sessions.find((s) => s.id === picked.id);
        if (selected) {
          attachedSessionSummary = selected;
          runtime.sessionId = selected.id;
          if (selected.studioId) {
            runtime.studioId = selected.studioId;
          }
          if (!runtime.threadKey && selected.threadKey) {
            runtime.threadKey = selected.threadKey;
          }
          toolPolicy.setContext({ agentId, studioId: runtime.studioId });
          const currentScope = toolPolicy.getMutationScope();
          if (currentScope.scope !== 'global') {
            toolPolicy.setMutationScope(currentScope.scope);
          }
          runtime.toolMode = toolPolicy.getMode();
        }
      }
      // picked === null means "New session" — fall through to create one
    } else {
      // Non-interactive or no sessions — auto-attach to latest (existing behavior)
      const selected = pickLatestSession(sessions, undefined, { studioId: runtime.studioId });
      if (selected) {
        attachedSessionSummary = selected;
        runtime.sessionId = selected.id;
        if (selected.studioId) {
          runtime.studioId = selected.studioId;
        }
        if (!runtime.threadKey && selected.threadKey) {
          runtime.threadKey = selected.threadKey;
        }
        autoAttachedLatest = true;
        toolPolicy.setContext({ agentId, studioId: runtime.studioId });
        const currentScope = toolPolicy.getMutationScope();
        if (currentScope.scope !== 'global') {
          toolPolicy.setMutationScope(currentScope.scope);
        }
        runtime.toolMode = toolPolicy.getMode();
      }
    }
  }

  const attachedToExistingSession = Boolean(runtime.sessionId);
  if (!runtime.sessionId) {
    const startArgs: Record<string, unknown> = {
      agentId,
      backend: 'ink',
      metadata: { provider: runtime.backend },
    };
    if (runtime.threadKey) startArgs.threadKey = runtime.threadKey;
    if (identity?.studioId) {
      startArgs.studioId = identity.studioId;
    }
    if (runtime.contactId) startArgs.contactId = runtime.contactId;

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

  // ── Provider session reuse (claude only) — Stage 2 ──
  // One provider-native session id per ink session, reused across turns AND
  // across processes. Seeded on the first backend spawn, resumed thereafter,
  // and reset at every ink-owned context-boundary change (compaction, trim,
  // eviction). Recovered from the reattached transcript below so a fresh
  // process (e.g. the next Myra heartbeat, which reattaches the same pcp
  // session) RESUMES the same native session — the jsonl accumulates one
  // coherent thread instead of fragmenting into a new file per message. ink
  // owns compaction; the provider never runs its own.
  let activeBackendSessionId: string | undefined;
  // Signature of the envelope's static shape at the time the session was seeded
  // (backend, model, tool mode/routing, strict flag, skills, thread key,
  // identity context). When it drifts mid-session — /backend, /model,
  // /tool-routing, /skill-use, /skill-clear, /refresh, profile changes — the
  // resumed native session would be stale, so runUserTurn invalidates and
  // reseeds. Subsumes the backend check (backend is part of the shape).
  let activeBackendSessionShape: string | undefined;

  let historyHydration: HistoryHydrationResult | null = null;
  if (attachedToExistingSession && existingTranscript) {
    const hydrated = hydrateLedgerFromTranscript(ledger, existingTranscript);
    // Resume the provider session the prior process left live (delta only),
    // unless a compaction/eviction rolled it — then the next turn seeds fresh.
    if (runtime.backend === 'claude') {
      // Recover the id only; the shape baseline is adopted on the first turn
      // below, AFTER all startup mutations, so a recovered session resumes
      // rather than spuriously reseeding on a startup-timing shape difference.
      activeBackendSessionId = findLastBackendSessionId(existingTranscript);
    }
    // Continue the event-id sequence from where the file left off
    seedTranscriptEidCounter(existingTranscript, hydrated.maxEid);
    sessionEvictedEntries.push(...hydrated.evictedEntries);
    // Replayed tool calls populate the inspector's Tool Calls section so
    // Ctrl+T shows the receipts behind prior turns, not just this session's
    recentToolCalls.push(...hydrated.toolCalls);
    historyHydration = {
      loaded: hydrated.loaded,
      messageCount: hydrated.messageCount,
      source: 'repl-transcript',
      transcriptPath: existingTranscript,
      tailPreview: hydrated.tailPreview,
      seenInboxIds: hydrated.seenInboxIds,
      seenActivityIds: hydrated.seenActivityIds,
      compactionCollapsed: hydrated.compactionCollapsed,
    };
    for (const inboxId of hydrated.seenInboxIds) {
      seenInboxIds.add(inboxId);
    }
    for (const activityId of hydrated.seenActivityIds) {
      seenActivityIds.add(activityId);
    }
    if (hydrated.recoveredMemoryIds.length > 0) {
      passiveRecallHandle.seedBootstrapIds(hydrated.recoveredMemoryIds);
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
    historySource: historyHydration?.source || null,
    attachedBackend: attachedSessionSummary?.backend || null,
    attachedModel: attachedSessionSummary?.model || null,
  });

  if (runtime.sessionId && !attachedToExistingSession) {
    await pcp
      .callTool('update_session_state', {
        agentId,
        sessionId: runtime.sessionId,
        phase: 'investigating',
        status: 'active',
      })
      .catch(() => undefined);
  }

  // ── Banner (prints before Ink mounts, goes to terminal scrollback) ──
  {
    const INKWELL_QUOTES = [
      { text: 'A word after a word after a word is power.', attr: 'Margaret Atwood' },
      { text: 'We write to taste life twice.', attr: 'Anaïs Nin' },
      { text: "I write entirely to find out what I'm thinking.", attr: 'Joan Didion' },
      { text: 'Memory is the diary we all carry about with us.', attr: 'Oscar Wilde' },
      {
        text: 'Fill your paper with the breathings of your heart.',
        attr: 'William Wordsworth',
      },
      {
        text: 'Either write something worth reading or do something worth writing.',
        attr: 'Benjamin Franklin',
      },
    ];

    const bannerWidth = Math.min(process.stdout.columns || 80, 60);
    const centerText = (s: string) =>
      ' '.repeat(Math.max(0, Math.floor((bannerWidth - s.length) / 2))) + s;

    // ── Dawn Skyline ASCII art (full width, tiling buildings) ──
    const termW = process.stdout.columns || 80;
    const cityW = 56;

    const _lerp = (a: number, b: number, t: number) => Math.round(a + (b - a) * t);
    const _lerpHex = (h1: string, h2: string, t: number) => {
      const p = (s: string, o: number) => parseInt(s.slice(o, o + 2), 16);
      const r = _lerp(p(h1, 1), p(h2, 1), t);
      const g = _lerp(p(h1, 3), p(h2, 3), t);
      const b = _lerp(p(h1, 5), p(h2, 5), t);
      return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
    };

    const skyStops = [
      '#0a0a1a',
      '#1a1040',
      '#2d1b69',
      '#5c3d8f',
      '#8b5fbf',
      '#c490d1',
      '#e8b4b8',
      '#f5d0a9',
      '#ffeebb',
    ];
    const _skyAt = (t: number) => {
      const idx = Math.floor(t * (skyStops.length - 1));
      const idx2 = Math.min(idx + 1, skyStops.length - 1);
      const frac = t * (skyStops.length - 1) - idx;
      return _lerpHex(skyStops[idx]!, skyStops[idx2]!, frac);
    };
    const titleStops = [
      '#c490d1',
      '#e8b4b8',
      '#f5d0a9',
      '#ffeebb',
      '#f5d0a9',
      '#e8b4b8',
      '#c490d1',
    ];
    const _titleAt = (t: number) => {
      const idx = Math.floor(t * (titleStops.length - 1));
      const idx2 = Math.min(idx + 1, titleStops.length - 1);
      const frac = t * (titleStops.length - 1) - idx;
      return _lerpHex(titleStops[idx]!, titleStops[idx2]!, frac);
    };

    let _seed = Date.now() & 0xffff;
    const _rand = () => {
      _seed = (_seed * 16807 + 0) % 2147483647;
      return (_seed & 0xffff) / 0x10000;
    };

    // Sky rows — full terminal width
    for (let r = 0; r < 4; r++) {
      const rc = _skyAt(r / 8);
      const rc2 = _skyAt((r + 1) / 8);
      let row = '';
      for (let i = 0; i < termW; i++) {
        const c = _lerpHex(rc, rc2, (i / Math.max(termW - 1, 1)) * 0.15);
        if (r < 2 && _rand() < 0.03) row += chalk.hex('#ffffff')('·');
        else if (r < 1 && _rand() < 0.02) row += chalk.hex('#ccccff')('✦');
        else row += chalk.hex(c).bgHex(c)('▄');
      }
      console.log(row);
    }

    // Buildings — tiling across full terminal width
    type BldgStyle = 'tower' | 'thin' | 'wide' | 'squat';
    interface Bldg {
      s: number;
      w: number;
      h: number;
      st: BldgStyle;
    }
    const bldgs: Bldg[] = [
      { s: 0, w: 4, h: 5, st: 'squat' },
      { s: 3, w: 2, h: 3, st: 'thin' },
      { s: 4, w: 7, h: 8, st: 'tower' },
      { s: 10, w: 3, h: 4, st: 'squat' },
      { s: 12, w: 2, h: 6, st: 'thin' },
      { s: 13, w: 5, h: 5, st: 'wide' },
      { s: 17, w: 3, h: 3, st: 'squat' },
      { s: 19, w: 8, h: 10, st: 'tower' },
      { s: 26, w: 2, h: 4, st: 'thin' },
      { s: 27, w: 5, h: 6, st: 'wide' },
      { s: 31, w: 3, h: 3, st: 'squat' },
      { s: 33, w: 6, h: 7, st: 'tower' },
      { s: 38, w: 2, h: 5, st: 'thin' },
      { s: 39, w: 4, h: 4, st: 'squat' },
      { s: 42, w: 3, h: 8, st: 'thin' },
      { s: 44, w: 5, h: 6, st: 'wide' },
      { s: 48, w: 2, h: 3, st: 'thin' },
      { s: 49, w: 7, h: 9, st: 'tower' },
    ];
    const bldgMaxH = 10;
    const bldgColor = '#12122a';
    const winPalette = ['#ffdd44', '#ff9944', '#ffcc33', '#44aaff', '#ffffff', '#88ddff'];

    for (let row = 0; row < bldgMaxH; row++) {
      let line = '';
      for (let x = 0; x < termW; x++) {
        const cx = ((x % cityW) + cityW) % cityW;
        let drawn = false;
        for (const b of bldgs) {
          if (cx >= b.s && cx < b.s + b.w && row >= bldgMaxH - b.h) {
            const lx = cx - b.s;
            const ly = row - (bldgMaxH - b.h);
            let isWin = false;
            if (b.st === 'tower')
              isWin =
                lx > 0 && lx < b.w - 1 && ly > 0 && ly % 2 === 1 && lx % 2 === 1 && _rand() < 0.55;
            else if (b.st === 'thin')
              isWin = lx === Math.floor(b.w / 2) && ly > 0 && ly % 2 === 0 && _rand() < 0.7;
            else if (b.st === 'wide')
              isWin = lx > 0 && lx < b.w - 1 && ly > 0 && (ly === 2 || ly === 4) && _rand() < 0.5;
            else isWin = lx > 0 && lx < b.w - 1 && ly > 0 && _rand() < 0.25;
            if (isWin) {
              line += chalk.hex(winPalette[Math.floor(_rand() * winPalette.length)]!)('▪');
            } else {
              line += chalk.hex(bldgColor).bgHex(bldgColor)('█');
            }
            drawn = true;
            break;
          }
        }
        if (!drawn) {
          const bgC = _skyAt(0.6 + (row / bldgMaxH) * 0.4);
          line += chalk.hex(bgC).bgHex(bgC)('▄');
        }
      }
      console.log(line);
    }

    // Block-letter INKWELL with dawn gradient
    const blockFont: Record<string, string[]> = {
      I: ['█████', '  █  ', '  █  ', '  █  ', '█████'],
      N: ['█   █', '██  █', '█ █ █', '█  ██', '█   █'],
      K: ['█  █', '█ █ ', '██  ', '█ █ ', '█  █'],
      W: ['█     █', '█  █  █', '█ █ █ █', '██   ██', '█     █'],
      E: ['█████', '█    ', '████ ', '█    ', '█████'],
      L: ['█   ', '█   ', '█   ', '█   ', '████'],
    };
    const blockWord = 'INKWELL';
    const blockSpacing = 2;
    const blockRows = [0, 1, 2, 3, 4].map((r) =>
      [...blockWord].map((ch) => blockFont[ch]![r]).join(' '.repeat(blockSpacing))
    );
    const blockTotalW = blockRows[0]!.length;
    const blockPadN = Math.max(0, Math.floor((termW - blockTotalW) / 2));

    console.log('');
    for (const bRow of blockRows) {
      let line = ' '.repeat(blockPadN);
      for (let i = 0; i < bRow.length; i++) {
        const ch = bRow[i];
        const t = bRow.length > 1 ? i / (bRow.length - 1) : 0;
        const c = _titleAt(t);
        line += ch === '█' ? chalk.hex(c)('█') : ' ';
      }
      console.log(line);
    }

    // Bottom gradient accent — thin warm line mirroring the horizon
    let bottomGlow = '';
    for (let i = 0; i < termW; i++) {
      const t = Math.abs(i / Math.max(termW - 1, 1) - 0.5) * 2;
      const c = _lerpHex('#f5d0a9', '#c490d1', t);
      bottomGlow += chalk.hex(c)('─');
    }
    console.log('');
    console.log(bottomGlow);

    // ── Quote (inline attribution) ──
    const quote = INKWELL_QUOTES[Math.floor(Math.random() * INKWELL_QUOTES.length)]!;
    const fullQuote = `”${quote.text}” ${quote.attr}`;
    const maxQW = Math.min(termW - 4, 80);
    const qWords = fullQuote.split(' ');
    const qLines: string[] = [];
    let qCur = '';
    for (const w of qWords) {
      const test = qCur ? `${qCur} ${w}` : w;
      if (test.length > maxQW && qCur) {
        qLines.push(qCur);
        qCur = w;
      } else {
        qCur = test;
      }
    }
    if (qCur) qLines.push(qCur);

    const qPad = ' '.repeat(
      Math.max(0, Math.floor((bannerWidth - Math.max(...qLines.map((l) => l.length))) / 2))
    );
    for (const line of qLines) {
      console.log(qPad + chalk.dim(line));
    }
    console.log('');
  }
  const studioSlug =
    attachedSessionSummary?.studioName ||
    (identity?.studioId ? formatStudioForDisplay(identity.studioId, 'short') : undefined);
  const bannerParts = [
    chip('inkling', agentId, chalk.cyan),
    chip('backend', 'ink', chalk.yellow),
    chip('provider', runtime.backend, chalk.yellow),
    studioSlug ? chip('studio', studioSlug, chalk.cyan) : null,
    chip('window', `${formatTokenCount(runtime.backendTokenWindow)} tok`, chalk.green),
    chip('time', formatNow(runtime.userTimezone), chalk.magenta),
  ].filter(Boolean);
  console.log('  ' + bannerParts.join(chalk.dim('  ·  ')));
  if (runtime.sessionId) console.log(chalk.dim(`  session ${runtime.sessionId}`));
  if (runtime.threadKey) console.log(chalk.dim(`  thread ${runtime.threadKey}`));
  if (attachedToExistingSession) {
    console.log(
      chalk.dim(
        autoAttachedLatest ? '  auto-attached to latest session' : '  attached to existing session'
      )
    );
  }
  if (historyHydration && historyHydration.messageCount > 0) {
    if (historyHydration.compactionCollapsed) {
      // Earlier history was compacted — mark where the loaded window begins
      console.log(
        renderContextCutoff(
          `earlier history compacted · ${formatTokenCount(ledger.totalTokens())} tok loaded`
        )
      );
    }
    console.log(chalk.dim(`  history: ${historyHydration.messageCount} prior message(s) loaded`));
  }
  console.log(chalk.dim('  /help for commands\n'));

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

  // ── Persistent eviction (single writer) ──
  // Every eviction — SB tool, user /evict, system trim — flows through here
  // so the transcript event shape and the live evicted-display list can't
  // drift between actors. The context_evict event is what makes the
  // eviction survive reattach; sessionEvictedEntries is what Ctrl+O and
  // /evicted show right now.
  const recordEviction = (
    actor: 'sb' | 'user' | 'system',
    reason: string,
    removedTokens: number,
    refs: Array<{
      eid?: number;
      hash: string;
      role: LedgerRole;
      source?: string;
      preview: string;
    }>
  ): void => {
    if (refs.length === 0) return;
    appendTranscript(runtime.transcriptPath, {
      type: 'context_evict',
      actor,
      reason,
      removedTokens,
      refs: refs.map((ref) => ({
        ...(typeof ref.eid === 'number' ? { eid: ref.eid } : {}),
        hash: ref.hash,
      })),
    });
    for (const ref of refs) {
      sessionEvictedEntries.push({
        role: ref.role,
        content: ref.preview,
        source: ref.source,
        eid: ref.eid,
        actor,
        reason,
      });
    }
    if (sessionEvictedEntries.length > EVICTED_DISPLAY_MAX) {
      sessionEvictedEntries.splice(0, sessionEvictedEntries.length - EVICTED_DISPLAY_MAX);
    }
    // A context-boundary mutation (SB evict_context, user /evict, system trim —
    // all route through this single writer) just removed entries from ink's
    // window. Roll the provider session so the next turn re-seeds from the
    // post-eviction ledger; otherwise a resumed native session would still hold
    // the evicted content. findLastBackendSessionId clears cross-process
    // recovery on the matching markers.
    activeBackendSessionId = undefined;
    activeBackendSessionShape = undefined;
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
    // Persist the trim as an eviction so it survives reattach (context_trim
    // alone is informational — hydration doesn't replay it)
    recordEviction(
      'system',
      `trim: ${reason}`,
      trim.removedTokens,
      trim.removedEntries.map((e) => ({
        ...(e.eid !== undefined ? { eid: e.eid } : {}),
        hash: entryRefHash(e.role, e.content),
        role: e.role,
        source: e.source,
        preview: e.content.slice(0, 100),
      }))
    );

    return { removed: trim.removedEntries.length, removedTokens: trim.removedTokens };
  };

  // ── Token-budget auto-compaction ──
  // When the transcript approaches the context budget, summarize the oldest
  // entries into a dense brief via the backend and replace them with it. The
  // `compaction` transcript event is the pointer to the new start state —
  // hydration collapses everything before it on reattach. If summarization
  // fails, fall back to a hard trim so the turn can still proceed.
  let compactionInFlight = false;

  const buildCompactionPrompt = (chunk: string): string =>
    [
      'You are compacting a conversation transcript into a dense continuation brief.',
      'Summarize the conversation below, preserving: decisions and their rationale,',
      'completed and in-progress work, key facts and constraints, open questions,',
      'commitments made, and any identifiers (PR numbers, session IDs, file paths, URLs).',
      'Write compact bullet points. Output ONLY the summary — no preamble.',
      '',
      '<conversation>',
      chunk,
      '</conversation>',
    ].join('\n');

  const maybeCompactContext = async (reason: string): Promise<void> => {
    if (compactionInFlight) return;
    const bootstrapReserve = runtime.bootstrapContext
      ? estimateTokens(runtime.bootstrapContext)
      : 0;
    const effectiveBudget = Math.max(1, runtime.maxContextTokens - bootstrapReserve);
    const threshold = Math.floor(effectiveBudget * AUTO_COMPACT_THRESHOLD_PCT);
    if (ledger.totalTokens() <= threshold) return;

    const entries = ledger.listEntries();
    const cutoff = Math.max(0, entries.length - AUTO_COMPACT_KEEP_RECENT_ENTRIES);
    if (cutoff === 0) return; // only the protected tail remains — nothing to compact

    compactionInFlight = true;
    try {
      const oldest = entries.slice(0, cutoff);
      const chunk = oldest
        .map((e) => `${e.role.toUpperCase()}${e.source ? ` [${e.source}]` : ''}: ${e.content}`)
        .join('\n\n');
      const before = ledger.totalTokens();
      printEvent(
        chalk.yellow(
          `  ⛁ Context at ${formatTokenCount(before)} tok (> ${formatTokenCount(threshold)} threshold) — compacting (${reason})`
        )
      );

      try {
        const turn = await runBackendTurn({
          backend: runtime.backend,
          agentId,
          model: runtime.model,
          prompt: buildCompactionPrompt(chunk),
          // Summarizing a large chunk takes longer than a normal turn
          timeoutMs: Math.max(runtime.backendTurnTimeoutMs ?? 0, 5 * 60 * 1000),
        });
        const summaryText = turn.success ? turn.stdout.trim() : '';
        if (!summaryText) {
          throw new Error(turn.stderr.trim().slice(0, 200) || `exit code ${turn.exitCode}`);
        }

        const summary = `[Conversation summary — compacted ${oldest.length} earlier entries]\n${summaryText}`;
        const result = ledger.compactToSummary(summary, AUTO_COMPACT_KEEP_RECENT_ENTRIES);
        // The compaction event is the COMPLETE new start state: summary plus
        // the verbatim recent tail. The tail's original events precede this
        // marker in the file, so hydration must get the tail from here —
        // otherwise reattach would keep only the summary and lose the
        // protected recent entries the live session still has.
        const keptEntries = ledger
          .listEntries()
          .slice(1) // entry 0 is the summary itself
          .map((e) => ({
            role: e.role,
            content: e.content,
            source: e.source,
            ...(e.eid !== undefined ? { eid: e.eid } : {}),
          }));
        appendTranscript(runtime.transcriptPath, {
          type: 'compaction',
          reason,
          summary,
          keptEntries,
          removedCount: result.removedEntries.length,
          removedTokens: result.removedTokens,
          summaryTokens: result.summaryTokens,
          totalAfter: result.totalAfter,
        });
        // Cutoff divider: everything above this line in the scrollback is
        // now out of the context window (replaced by the summary).
        printEvent(
          renderContextCutoff(
            `compacted ${result.removedEntries.length} entries · ${formatTokenCount(before)} → ${formatTokenCount(result.totalAfter)} tok`
          )
        );
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        printEvent(chalk.yellow(`  ⛁ Compaction summarization failed (${msg}) — hard-trimming`));
        await trimContextToPercent(DEFAULT_TRIM_TARGET_PCT, `${reason} (compaction fallback)`);
      }
    } finally {
      compactionInFlight = false;
      // ink just rolled the ledger — roll the provider session too so the next
      // turn seeds a fresh native session with the summary (we compact before
      // the provider ever would). No-op when nothing was compacted: the early
      // returns above never reach this block. Unconditional: for non-claude
      // these are already undefined.
      activeBackendSessionId = undefined;
      activeBackendSessionShape = undefined;
    }
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
              agentId,
            },
            target: {
              sessionId: msg.relatedSessionId,
              threadKey: msg.threadKey,
              studioId: msg.recipientStudioId,
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
        ledger.addEntry('inbox', compactForLedger(rendered), 'inkmail');
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
      ledger.addEntry('inbox', compactForLedger(rendered), 'inkmail');
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
      if (inkRepl) {
        inkRepl.setCommandOutput(['No new inbox messages.']);
      } else {
        printLine(chalk.dim('No new inbox messages.'));
      }
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
              agentId,
            },
            target: {
              sessionId: activity.sessionId,
              threadKey: runtime.threadKey,
              studioId: runtime.studioId,
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

      const rawType = activity.subtype
        ? `${activity.type}:${activity.subtype}`
        : activity.type || 'activity';
      const ACTIVITY_LABELS: Record<string, string> = {
        message_in: 'received',
        message_out: 'sent',
        agent_spawn: 'spawned',
        agent_complete: 'completed',
        state_change: 'state change',
        tool_call: 'tool call',
        tool_result: 'tool result',
        inkmail_dispatch: 'mail sent',
        inkmail_deliver: 'mail delivered',
        inkmail_fail: 'mail failed',
      };
      const type = ACTIVITY_LABELS[rawType] || rawType;
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
      // Tiered rendering: platform messages are real conversation and get
      // proper message blocks; the agent's own mechanics (tools, state,
      // backend turn lifecycle) are dim event lines; everything else stays
      // a ⚡ activity block.
      const plan = classifyActivity(activity, agentId);
      const activityTime = formatHumanTime(activity.createdAt, runtime.userTimezone);
      if (plan.mode === 'message-in' || plan.mode === 'message-out') {
        // Full content, not the 200-char preview — these ARE the conversation
        const messageContent = (activity.content || '').trim() || '(empty message)';
        if (inkRepl) {
          inkRepl.addMessage(plan.role!, messageContent, {
            label: plan.label,
            time: activityTime,
          });
        } else {
          printLine('');
          printLine(
            renderMessageLine(plan.role!, messageContent, {
              label: plan.label,
              timezone: runtime.userTimezone,
              ts: activity.createdAt,
            })
          );
        }
      } else if (plan.mode === 'bookkeeping') {
        printEvent(chalk.dim(`  ⚡ ${type}${preview ? ` — ${preview}` : ''} · ${activityTime}`));
      } else if (inkRepl) {
        inkRepl.addMessage('activity', `${actor} ${type}${preview ? ` — ${preview}` : ''}`, {
          label: '⚡',
          time: activityTime,
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
      if (inkRepl) {
        inkRepl.setCommandOutput(['No new activity events.']);
      } else {
        printLine(chalk.dim('No new activity events.'));
      }
    }
    emitStatusLaneIfChanged();
    return activities.length;
  };

  // ── Turn attachments (--attach-file) ──
  // Resolved once at startup; the block attaches to the FIRST turn (the
  // message the attachments belong to) and the directories stay granted
  // to the backend for the whole session so later turns can re-read the
  // files. Server spawns (InkRunner) pass --attach-file per media item.
  let pendingAttachmentBlock = '';
  let sessionAttachmentDirs: string[] = [];
  if (options.attachFile && options.attachFile.length > 0) {
    const resolvedAttachments = await resolveAttachments(options.attachFile);
    pendingAttachmentBlock = buildAttachmentBlock(resolvedAttachments);
    sessionAttachmentDirs = collectAttachmentDirs(resolvedAttachments);
    const missingAttachments = resolvedAttachments.filter((a) => a.missing);
    if (missingAttachments.length > 0) {
      console.log(
        chalk.yellow(
          `  ⚠ ${missingAttachments.length} attached file(s) not readable: ${missingAttachments
            .map((m) => m.path)
            .join(', ')}`
        )
      );
    }
  }

  const runUserTurn = async (
    raw: string,
    source: 'user' | 'inbox-auto' | 'system' = 'user',
    displayLabel?: string
  ) => {
    if (!raw.trim()) return;
    // Attach pending files to this turn — append the block so the backend
    // sees the paths inline with the message that delivered them.
    if (pendingAttachmentBlock) {
      raw = `${raw}\n\n${pendingAttachmentBlock}`;
      pendingAttachmentBlock = '';
    }
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
    } else if (source === 'system') {
      // Synthetic turn input: heartbeat triggers, server-delivered messages,
      // continuation prompts. Rendered as system (not "you") so transcripts
      // distinguish harness prompts from the human's words.
      const label = displayLabel || 'system';
      if (inkRepl) {
        inkRepl.addMessage('system', raw, { label });
      } else {
        printLine(
          renderMessageLine('system', raw, {
            label,
            timezone: runtime.userTimezone,
          })
        );
        printLine('');
      }
      ledger.addEntry('system', raw, label);
      appendTranscript(runtime.transcriptPath, { type: 'system_turn', content: raw, label });
    } else {
      ledger.addEntry('system', compactForLedger(`[auto-run inbox] ${raw}`, 500), 'auto-run');
      appendTranscript(runtime.transcriptPath, { type: 'auto_turn', content: raw });
    }

    if (runtime.sessionId && !options.nonInteractive) {
      await pcp
        .callTool('update_session_state', {
          agentId,
          sessionId: runtime.sessionId,
          phase: 'implementing',
          status: 'active',
        })
        .catch(() => undefined);
    }

    // ── Token-budget enforcement: compact before building the prompt ──
    // If the transcript has grown past the compaction threshold, summarize
    // the oldest entries into a new start state before this turn spends them.
    await maybeCompactContext('pre-turn budget check');

    // ── Fire prompt_build hooks (budget monitor, etc.) ──
    // Budget utilization must account for bootstrap tokens — the ledger only
    // holds transcript, but bootstrap is reserved from the total budget.
    const bootstrapReserve = runtime.bootstrapContext
      ? estimateTokens(runtime.bootstrapContext)
      : 0;
    const effectiveBudget = Math.max(1, runtime.maxContextTokens - bootstrapReserve);

    const promptHookResult = await hookRegistry.fire('prompt_build', {
      ledger,
      runtime: {
        sessionId: runtime.sessionId,
        agentId,
        backend: runtime.backend,
        budgetUtilization: ledger.totalTokens() / effectiveBudget,
        turnCount: hookTurnCount,
      },
      // Pass user input so passive recall can surface memories BEFORE the backend responds
      lastTurn: {
        userInput: raw,
        assistantResponse: '',
        turnIndex: hookTurnCount + 1,
      },
    });

    // Persist hook-injected entries to transcript so they survive reattach
    if (promptHookResult.injectedEntries.length > 0) {
      for (const entry of promptHookResult.injectedEntries) {
        appendTranscript(runtime.transcriptPath, {
          type: 'hook_injection',
          role: entry.role,
          content: entry.content,
          source: entry.source,
          memoryId: entry.memoryId,
        });
      }
    }

    // Print notifications from prompt_build hooks
    if (promptHookResult.injected > 0) {
      // Check if any were passive recall vs budget warnings
      const recallEntries = ledger
        .listEntries()
        .filter((e) => e.source === 'passive-recall')
        .slice(-promptHookResult.injected);
      const budgetEntries = ledger
        .listEntries()
        .filter((e) => e.source === 'budget-monitor')
        .slice(-promptHookResult.injected);

      if (recallEntries.length > 0) {
        const totalTok = recallEntries.reduce((sum, e) => sum + e.approxTokens, 0);
        if (inkRepl) {
          const details = recallEntries.map((entry) => {
            const preview = entry.content.replace(/^\[passive-recall\]\s*/, '').slice(0, 120);
            return `  💡 ${preview}${entry.content.length > 120 ? '...' : ''} (${entry.approxTokens} tok)`;
          });
          inkRepl.setSurfacedMemories(details);
          printEvent(
            chalk.dim(
              `  💡 ${recallEntries.length} ${recallEntries.length === 1 ? 'memory' : 'memories'} surfaced (${totalTok} tok) — ctrl+o to expand`
            )
          );
        } else {
          for (const entry of recallEntries) {
            const preview = entry.content.replace(/^\[passive-recall\]\s*/, '').slice(0, 120);
            printEvent(
              chalk.dim(
                `  💡 memory surfaced: "${preview}${entry.content.length > 120 ? '...' : ''}" (${entry.approxTokens} tok)`
              )
            );
          }
        }
      }

      if (budgetEntries.length > 0) {
        const util = Math.round((ledger.totalTokens() / effectiveBudget) * 100);
        printEvent(
          chalk.yellow(
            `  ⚠ Context at ${util}% — ${ledger.totalTokens().toLocaleString()} / ${effectiveBudget.toLocaleString()} tok (bootstrap: ${bootstrapReserve.toLocaleString()} reserved)`
          )
        );
      }
    }

    // Provider session seed/resume decision (claude only). The first backend
    // spawn of the session SEEDS a fresh provider session (--session-id) with
    // the FULL envelope; every later turn RESUMES it (--resume) sending only
    // this turn's delta — the new user message plus any passive-recall surfaced
    // this turn — because the provider already holds the system prompt, tools,
    // bootstrap, and prior turns. The tool-loop continuations below always
    // resume the same session. This collapses the whole conversation into ONE
    // coherent Claude jsonl and stops re-piping the transcript window on every
    // round-trip. Stateless backends (codex/gemini) always get the full
    // envelope.
    //
    // `canReuseBackendSession` is computed PER-TURN against the current backend
    // so a mid-session /backend switch is honored (not captured once at
    // startup). And a live session is invalidated when the envelope's static
    // SHAPE has drifted since it was seeded — /backend, /model, /tool-routing,
    // /skill-use, /skill-clear, /refresh, profile changes. Otherwise the resumed
    // native session would be stale (e.g. seeded with backend tool-routing, then
    // /tool-routing local leaves it without ink-tool instructions while native
    // tools are disabled). On drift we reseed fresh with the new envelope.
    const canReuseBackendSession = runtime.backend === 'claude';
    const currentEnvelopeShape = envelopeShapeKey(runtime);
    if (activeBackendSessionId !== undefined) {
      if (activeBackendSessionShape === undefined) {
        // Recovered from a prior process — adopt this turn's shape as the
        // baseline (no invalidation). Cross-process bootstrap drift is
        // tolerated; only in-process drift from here triggers a reseed.
        activeBackendSessionShape = currentEnvelopeShape;
      } else if (activeBackendSessionShape !== currentEnvelopeShape) {
        // In-process envelope drift — the resumed native session would be
        // stale, so invalidate and reseed fresh with the new envelope.
        activeBackendSessionId = undefined;
        activeBackendSessionShape = undefined;
      }
    }
    const resumeProviderSession = canReuseBackendSession && activeBackendSessionId !== undefined;
    let seedProviderSessionId: string | undefined;
    if (canReuseBackendSession && !resumeProviderSession) {
      seedProviderSessionId = randomUUID();
      activeBackendSessionId = seedProviderSessionId;
      activeBackendSessionShape = currentEnvelopeShape;
      // Persist the seed so a later process (next heartbeat / reattach) recovers
      // and RESUMES this native session instead of fragmenting into a new jsonl.
      appendTranscript(runtime.transcriptPath, {
        type: 'backend_session',
        id: seedProviderSessionId,
      });
    }

    let prompt: string;
    if (resumeProviderSession) {
      const recallDelta = promptHookResult.injectedEntries
        .filter((e) => e.source === 'passive-recall')
        .map((e) => e.content)
        .join('\n\n');
      prompt = recallDelta ? `${recallDelta}\n\n${raw}` : raw;
    } else {
      prompt = buildPromptEnvelope(agentId, runtime, ledger, raw);
    }

    const turnStartedAt = Date.now();
    const backendGate = toolPolicy.getBackendToolGate();
    const passthroughPlan = buildBackendToolPassthrough(
      runtime.backend,
      runtime.toolRouting,
      backendGate,
      runtime.strictTools
    );
    const passthroughArgs = passthroughPlan.passthroughArgs;

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
    if (passthroughPlan.warning && runtime.verbose) {
      printLine(chalk.yellow(passthroughPlan.warning));
    }
    sbDebugLog(
      'chat',
      'backend_turn_start',
      {
        backend: runtime.backend,
        sessionId: runtime.sessionId || null,
        toolRouting: runtime.toolRouting,
        toolMode: backendGate.mode,
        passthroughArgs,
        timeoutMs: runtime.backendTurnTimeoutMs ?? null,
      },
      debugFile ? { force: true, file: debugFile } : undefined
    );

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
    let currentTurnAbort: (() => void) | null = null;

    const abortCurrentTurn = () => {
      if (currentTurnAbort) {
        currentTurnAbort();
        currentTurnAbort = null;
        inkRepl?.setAbortHandler(null);
      }
    };

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
      abortCurrentTurn();
      if (inkRepl) {
        inkRepl.printSystem('Cancelling turn...');
      } else {
        statusLane.renderHint('Cancelling turn...');
      }
    };

    process.on('SIGINT', onSigintDuringTurn);
    const turn = startBackendTurn({
      backend: runtime.backend,
      agentId,
      model: runtime.model,
      prompt,
      verbose: runtime.verbose,
      passthroughArgs,
      timeoutMs: runtime.backendTurnTimeoutMs,
      idleTimeoutMs: runtime.backendIdleTimeoutMs,
      stream: true,
      onEvent: handleBackendEvent,
      attachmentDirs: sessionAttachmentDirs.length > 0 ? sessionAttachmentDirs : undefined,
      // Seed a fresh provider session (first spawn) OR resume the live one
      // (subsequent turns). Tool-loop continuations below always resume it.
      ...(seedProviderSessionId ? { backendSessionSeedId: seedProviderSessionId } : {}),
      ...(resumeProviderSession && activeBackendSessionId
        ? { backendSessionId: activeBackendSessionId }
        : {}),
    });
    currentTurnAbort = turn.abort;
    inkRepl?.setAbortHandler(abortCurrentTurn);

    let runResult = await turn.result.finally(() => {
      currentTurnAbort = null;
      inkRepl?.setAbortHandler(null);
      process.off('SIGINT', onSigintDuringTurn);
      turnDurationSeconds = Math.max(0, Math.round((Date.now() - turnStartedAt) / 1000));
      stopWaiting();
    });
    // If a resumed turn failed because the provider session vanished (jsonl
    // cleaned up / different machine), drop the live id so the NEXT turn seeds a
    // fresh one. Within a single interactive process this is near-impossible (we
    // seeded the id ourselves); the full mid-turn re-seed lands with the
    // server/cross-process path.
    if (
      resumeProviderSession &&
      !runResult.success &&
      (runResult.resumeFailedNoSession || isResumeFailedNoSession(runResult.stderr))
    ) {
      // The resumed provider session no longer exists locally (jsonl pruned /
      // different machine). Mint a fresh native session, re-send the FULL
      // envelope (the ledger already holds the history), and retry once so a
      // server heartbeat still produces output instead of dying on a stale id.
      // Mirrors ClaudeRunner/InkRunner's resume-not-found recovery.
      const reseedId = randomUUID();
      activeBackendSessionId = reseedId;
      activeBackendSessionShape = currentEnvelopeShape;
      appendTranscript(runtime.transcriptPath, { type: 'backend_session', id: reseedId });
      printEvent(
        chalk.yellow('  ⛁ provider session not found on resume — re-seeding a fresh native session')
      );
      process.on('SIGINT', onSigintDuringTurn);
      const reseedTurn = startBackendTurn({
        backend: runtime.backend,
        agentId,
        model: runtime.model,
        prompt: buildPromptEnvelope(agentId, runtime, ledger, raw),
        verbose: runtime.verbose,
        passthroughArgs,
        timeoutMs: runtime.backendTurnTimeoutMs,
        idleTimeoutMs: runtime.backendIdleTimeoutMs,
        stream: true,
        onEvent: handleBackendEvent,
        attachmentDirs: sessionAttachmentDirs.length > 0 ? sessionAttachmentDirs : undefined,
        backendSessionSeedId: reseedId,
      });
      currentTurnAbort = reseedTurn.abort;
      inkRepl?.setAbortHandler(abortCurrentTurn);
      runResult = await reseedTurn.result.finally(() => {
        currentTurnAbort = null;
        inkRepl?.setAbortHandler(null);
        process.off('SIGINT', onSigintDuringTurn);
      });
    }
    sbDebugLog(
      'chat',
      'backend_turn_result',
      {
        backend: runtime.backend,
        sessionId: runtime.sessionId || null,
        success: runResult.success,
        exitCode: runResult.exitCode,
        durationMs: runResult.durationMs,
        command: runResult.command,
        stderrPreview: runResult.stderr.slice(0, 500),
      },
      debugFile ? { force: true, file: debugFile } : undefined
    );

    if (runResult.success) {
      consecutiveBackendFailures = 0;
    } else {
      consecutiveBackendFailures += 1;
    }

    // Log backend CLI turn completion to activity stream.
    // Use 'ink' as the runner label (not the LLM backend like 'claude')
    // so the mission feed shows the correct execution layer.
    if (runtime.sessionId) {
      const turnStatus = runResult.success ? 'completed' : 'failed';
      const cliErrorClassification = !runResult.success
        ? classifyError({
            errorText: runResult.stderr || runResult.stdout,
            backend: runtime.backend,
            exitCode: runResult.exitCode,
          })
        : null;

      const runnerLabel = 'ink';
      pcp
        .callTool('log_activity', {
          agentId,
          type: runResult.success ? 'agent_complete' : 'error',
          subtype: `backend_cli:${runnerLabel}`,
          content: runResult.success
            ? `Backend turn completed (${runnerLabel}, ${turnDurationSeconds}s)`
            : `Backend turn failed (${runnerLabel}, ${cliErrorClassification?.category || 'exit ' + runResult.exitCode}): ${cliErrorClassification?.summary || runResult.stderr.slice(0, 200) || 'unknown error'}`,
          sessionId: runtime.sessionId,
          status: turnStatus,
          payload: {
            backend: runnerLabel,
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

    // ── Multi-turn tool loop ──
    // When local tool routing is active, the backend may emit ink-tool blocks.
    // We execute them locally, then re-invoke the backend with the results so it
    // can reason about them and potentially emit more tool calls. This continues
    // until the backend produces no tool calls or we hit the iteration limit.
    const MAX_TOOL_LOOP_ITERATIONS = 5;
    let toolLoopIteration = 0;
    let responseText = '';
    let localToolCalls: ReturnType<typeof extractLocalToolCalls> = [];
    let allToolResults: Array<{ tool: string; result: unknown; status: string; args?: unknown }> =
      [];

    // eslint-disable-next-line no-constant-condition
    while (true) {
      // In streaming mode `responseText` is the parsed assistant text; `stdout`
      // is the raw NDJSON event stream, so never use it as the reply there.
      responseText = (runResult.responseText ?? runResult.stdout).trim();
      if (!responseText && runResult.stderr.trim()) {
        responseText = runResult.stderr.trim();
      }
      if (!responseText) {
        responseText = '(no output)';
      }

      localToolCalls =
        runtime.toolRouting === 'local' ? extractLocalToolCalls(responseText).slice(0, 5) : [];

      if (localToolCalls.length === 0) break;

      // Execute tool calls through ink's policy pipeline
      const iterationResults: typeof allToolResults = [];
      await executeToolCalls(localToolCalls, {
        policy: toolPolicy,
        callTool: (tool, args) => {
          // Client-local tools (context management) are handled in-process
          if (isClientLocalTool(tool)) {
            const result = handleClientLocalTool(tool, args, ledger);
            if (result) return Promise.resolve(result);
          }
          // Pi coding tools (read, edit, write, bash, grep, find, ls) execute
          // in-process via @mariozechner/pi-coding-agent, scoped to cwd
          if (isPiTool(tool)) {
            return callPiTool(tool, args, process.cwd());
          }
          // Resolve credential references ($VAR / ${VAR}) in tool args.
          // The LLM emits references; actual values are injected here at the
          // execution layer so credentials never enter transcripts or context.
          const { args: resolvedArgs, resolutions } = resolveCredentialRefs(
            args,
            buildResolverEnv()
          );
          if (resolutions.length > 0 && runtime.verbose) {
            const refs = resolutions.map((r) => `${r.name} at ${r.path}`).join(', ');
            printLine(
              chalk.dim(`credential-resolver: resolved ${resolutions.length} ref(s): ${refs}`)
            );
          }
          // Strip MCP namespace prefix — the SB may emit mcp__inkwell__tool_name
          // but PcpClient expects bare tool names (get_inbox, recall, etc.)
          const bareTool = tool.replace(/^mcp__inkwell__/, '');
          return pcp.callTool(bareTool, resolvedArgs);
        },
        sessionId: runtime.sessionId,
        promptForApproval: async (tool, reason, args) => {
          if (!runtime.awayMode) {
            return promptForToolApproval(
              rl,
              toolPolicy,
              runtime.sessionId,
              tool,
              reason,
              inkRepl,
              runtime.approvalChannel,
              args
            );
          }
          // 2FA approval: create request on the PCP server, which sends
          // notifications to the user's connected platforms (Telegram, etc.).
          // The server handles all routing — we just poll for the result.
          printLine(chalk.yellow(`⏳ Requesting 2FA approval for ${tool}…`));
          // Sanitize args for the notification — show command/path but redact large content
          const sanitizedArgs = args ? sanitizeArgsForApproval(tool, args) : undefined;
          try {
            const result = await requestToolApproval({
              tool,
              args: sanitizedArgs,
              reason,
              sessionId: runtime.sessionId,
              studioId: runtime.studioId,
              onCreated: (id) => {
                printLine(
                  chalk.yellow(`   Request ${id.slice(0, 8)}… sent to connected platforms`)
                );
              },
            });

            if (result.status === 'granted') {
              // Apply persistent grants to the tool policy
              if (
                result.action === 'grant-agent' ||
                result.action === 'allow' ||
                result.action === 'grant-studio'
              ) {
                // Grant at the specific scope from the approval response.
                // persistentGrant writes the permanent grant at the target scope
                // and removes from promptTools at all scopes so the tool stops prompting.
                const grantScope = result.action === 'grant-studio' ? 'studio' : 'agent';
                const scopeId =
                  grantScope === 'studio'
                    ? toolPolicy.getContext()?.studioId
                    : toolPolicy.getContext()?.agentId;
                if (scopeId) {
                  toolPolicy.persistentGrant(tool, { scope: grantScope, id: scopeId });
                  printLine(
                    chalk.green(`✅ 2FA: ${tool} permanently approved (${grantScope}: ${scopeId})`)
                  );
                } else {
                  // Can't resolve scope — fall back to session grant instead of leaking to global
                  if (runtime.sessionId) {
                    toolPolicy.grantToolForSession(runtime.sessionId, tool);
                  }
                  printLine(
                    chalk.yellow(
                      `⚠️ 2FA: ${tool} approved for session only (could not resolve ${grantScope} scope)`
                    )
                  );
                }
              } else if (result.action === 'grant-session') {
                if (runtime.sessionId) {
                  toolPolicy.grantToolForSession(runtime.sessionId, tool);
                }
                printLine(chalk.green(`✅ 2FA: ${tool} approved for this session`));
              } else {
                printLine(chalk.green(`✅ 2FA approval granted for ${tool}`));
              }
              return true;
            } else if (result.status === 'timeout') {
              printLine(chalk.yellow(`⏰ 2FA approval timed out for ${tool}`));
              return false;
            } else if (result.status === 'error') {
              printLine(chalk.yellow(`⚠️ 2FA error: ${result.error}`));
              return false;
            } else {
              printLine(chalk.yellow(`🚫 2FA approval denied for ${tool}`));
              return false;
            }
          } catch {
            printLine(chalk.yellow('Failed to create 2FA approval request — denying tool call'));
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
            iterationResults.push({
              tool: result.tool,
              result: result.reason,
              status: result.status,
            });
          } else if (result.status === 'executed' || result.status === 'approved') {
            const resultJson = JSON.stringify(result.result);

            // Format context-management and signal tools with friendly output
            if (result.tool === 'evict_context') {
              const r = result.result as Record<string, unknown> | undefined;
              const content = (r?.content as Array<{ text: string }> | undefined)?.[0]?.text;
              if (content) {
                const parsed = JSON.parse(content);
                printEvent(
                  chalk.dim(
                    `  🗑 evicted ${parsed.evicted} entries (${parsed.tokensFreed} tok freed, ${parsed.totalAfter} tok remaining)`
                  )
                );
                // Persist the eviction so it survives reattach — without this,
                // hydration replays the raw events and evicted entries resurrect
                if (parsed.success && Array.isArray(parsed.evictRefs) && parsed.evicted > 0) {
                  const refs = parsed.evictRefs as Array<Record<string, unknown>>;
                  recordEviction(
                    'sb',
                    compactForLedger(JSON.stringify(result.args ?? {}), 200),
                    typeof parsed.tokensFreed === 'number' ? parsed.tokensFreed : 0,
                    refs
                      .filter((ref) => typeof ref.hash === 'string')
                      .map((ref) => ({
                        ...(typeof ref.eid === 'number' ? { eid: ref.eid } : {}),
                        hash: ref.hash as string,
                        role: (ref.role as LedgerRole) || 'system',
                        source: typeof ref.source === 'string' ? ref.source : undefined,
                        preview: typeof ref.preview === 'string' ? ref.preview : '',
                      }))
                  );
                }
              }
            } else if (result.tool === 'list_context') {
              const r = result.result as Record<string, unknown> | undefined;
              const content = (r?.content as Array<{ text: string }> | undefined)?.[0]?.text;
              if (content) {
                const parsed = JSON.parse(content);
                printLine(
                  chalk.dim(
                    `  📋 context: ${parsed.totalEntries} entries, ~${parsed.totalTokens} tok`
                  )
                );
                if (parsed.bySource) {
                  const sources = Object.entries(
                    parsed.bySource as Record<string, { count: number; tokens: number }>
                  )
                    .map(([src, { count, tokens }]) => `${src}(${count}/${tokens}t)`)
                    .join(' ');
                  printLine(chalk.dim(`     ${sources}`));
                }
              }
            } else if (result.tool === 'signal_status') {
              const r = result.result as Record<string, unknown> | undefined;
              const content = (r?.content as Array<{ text: string }> | undefined)?.[0]?.text;
              if (content) {
                const parsed = JSON.parse(content);
                const signal = parsed.signal as { status: string; reason?: string } | undefined;
                if (signal) {
                  const icon =
                    signal.status === 'completed'
                      ? '✅'
                      : signal.status === 'blocked'
                        ? '🚫'
                        : '➡️';
                  printEvent(
                    chalk.dim(
                      `  ${icon} signal: ${signal.status}${signal.reason ? ` — ${signal.reason}` : ''}`
                    )
                  );
                }
              }
            } else {
              printLine(chalk.cyan(`🛠 local tool ${result.tool} ${resultJson}`));
            }
            appendTranscript(runtime.transcriptPath, {
              type: 'local_tool_call',
              tool: result.tool,
              args: result.args,
              status: result.status,
              result: result.result,
            });
            // Context-management tools (list_context, evict_context) must NOT
            // persist their results back into the ledger — doing so pollutes the
            // context they're managing and reintroduces evicted content.
            if (!isClientLocalTool(result.tool)) {
              ledger.addEntry(
                'system',
                compactForLedger(`local tool ${result.tool} -> ${resultJson}`, 500),
                'local-tool'
              );
            }
            iterationResults.push({
              tool: result.tool,
              result: result.result,
              status: result.status,
              args: result.args,
            });
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
            iterationResults.push({ tool: result.tool, result: result.error, status: 'error' });
          }

          // Headless liveness + progress: one compact NDJSON line per tool as
          // it completes. Input is capped and results are omitted (can be large
          // or sensitive). send_response is intentionally NOT streamed here —
          // that tool already routes server-side, so re-emitting it as a
          // response line would risk double delivery.
          const streamArgs = result.args ? JSON.stringify(result.args) : '';
          emitStreamEvent({
            type: 'tool_call',
            toolName: result.tool,
            status: result.status,
            ...(streamArgs && streamArgs.length <= 2000 ? { input: result.args } : {}),
          });
        },
      });

      allToolResults.push(...iterationResults);
      for (const r of iterationResults) {
        const liveArgsJson = r.args ? JSON.stringify(r.args).replace(/\s+/g, ' ') : '';
        recentToolCalls.push({
          tool: r.tool,
          status: r.status,
          at: new Date().toISOString(),
          args: liveArgsJson
            ? liveArgsJson.length > 400
              ? `${liveArgsJson.slice(0, 400)}…`
              : liveArgsJson
            : undefined,
        });
      }
      if (recentToolCalls.length > 100) {
        recentToolCalls.splice(0, recentToolCalls.length - 100);
      }
      toolLoopIteration++;

      // Check if we should continue the loop
      const hasExecutedTools = iterationResults.some(
        (r) => r.status === 'executed' || r.status === 'approved'
      );
      // A terminal signal_status (completed/blocked) ends the turn immediately —
      // the agent said it's done. Without this the loop keeps re-invoking the
      // backend (signal_status counts as an executed tool), and each re-invoke
      // is a fresh backend/Claude session in which the re-prompted agent just
      // re-signals completion — the 4x signal_status + duplicate sessions per
      // heartbeat. This must be checked BEFORE hasExecutedTools so a turn that
      // both did work and signaled done still stops here.
      const signaledDone = iterationResults.some(
        (r) => r.tool === 'signal_status' && isTerminalSignalToolResult(r.result)
      );
      if (signaledDone || !hasExecutedTools || toolLoopIteration >= MAX_TOOL_LOOP_ITERATIONS) {
        if (!signaledDone && toolLoopIteration >= MAX_TOOL_LOOP_ITERATIONS) {
          printLine(
            chalk.dim(`(tool loop limit reached — ${MAX_TOOL_LOOP_ITERATIONS} iterations)`)
          );
        }
        break;
      }

      // Build continuation prompt with tool results and re-invoke backend
      const toolResultsSummary = iterationResults
        .map((r) => {
          const resultStr = typeof r.result === 'string' ? r.result : JSON.stringify(r.result);
          return `Tool ${r.tool} (${r.status}): ${resultStr}`;
        })
        .join('\n\n');
      const continuationBody = `[Tool results from previous turn]\n${toolResultsSummary}\n\nContinue your response based on these tool results. If you need more tools, emit ink-tool blocks. Otherwise, provide your final answer.`;
      // When resuming the same Claude session, the model already holds the full
      // transcript + tool instructions from the seeded turn — send ONLY the
      // delta. Otherwise (stateless backends) re-pack the full envelope so the
      // fresh spawn has the context it needs.
      const continuationPrompt =
        canReuseBackendSession && activeBackendSessionId
          ? continuationBody
          : buildPromptEnvelope(agentId, runtime, ledger, continuationBody);

      // Show continuation indicator naming the tools that just ran — this is
      // the SB working, not a system message
      const ranTools = Array.from(new Set(iterationResults.map((r) => r.tool))).join(', ');
      printEvent(
        chalk.dim(
          `  ⋯ ran ${ranTools} — continuing (${toolLoopIteration}/${MAX_TOOL_LOOP_ITERATIONS})…`
        )
      );
      const stopContinuation = inkRepl
        ? ((repl) => {
            repl.setWaiting(true, runtime.backend);
            return () => repl.setWaiting(false);
          })(inkRepl)
        : startWaitingIndicator(runtime.backend, {
            statusLane,
            logger: printLine,
            renderAbovePrompt: true,
          });

      const contTurn = startBackendTurn({
        backend: runtime.backend,
        agentId,
        model: runtime.model,
        prompt: continuationPrompt,
        verbose: runtime.verbose,
        passthroughArgs,
        timeoutMs: runtime.backendTurnTimeoutMs,
        idleTimeoutMs: runtime.backendIdleTimeoutMs,
        stream: true,
        onEvent: handleBackendEvent,
        attachmentDirs: sessionAttachmentDirs.length > 0 ? sessionAttachmentDirs : undefined,
        // Resume the live provider session so this round-trip appends to the
        // same Claude thread instead of re-piping the whole window.
        ...(activeBackendSessionId ? { backendSessionId: activeBackendSessionId } : {}),
      });
      currentTurnAbort = contTurn.abort;
      inkRepl?.setAbortHandler(abortCurrentTurn);
      process.on('SIGINT', onSigintDuringTurn);

      runResult = await contTurn.result.finally(() => {
        currentTurnAbort = null;
        inkRepl?.setAbortHandler(null);
        process.off('SIGINT', onSigintDuringTurn);
        stopContinuation();
      });

      if (!runResult.success) break;
    }

    const isAbortedTurn =
      !runResult.success && runResult.exitCode !== undefined && runResult.exitCode >= 128;

    const assistantDisplayText = isAbortedTurn
      ? ''
      : runtime.toolRouting === 'local'
        ? (() => {
            const stripped = stripLocalToolBlocks(responseText);
            if (stripped) return stripped;
            if (localToolCalls.length > 0 || allToolResults.length > 0)
              return '(local tool call emitted; see tool results above)';
            return responseText;
          })()
        : responseText;

    if (isAbortedTurn) {
      appendTranscript(runtime.transcriptPath, {
        type: 'assistant',
        backend: runtime.backend,
        model: runtime.model || null,
        success: false,
        exitCode: runResult.exitCode,
        durationMs: runResult.durationMs,
        stderr: runResult.stderr || null,
        content: null,
        cancelled: true,
        usage: runResult.usage || null,
      });
    } else {
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
    }
    lastBackendUsage = runResult.usage;

    // ── Fire turn_end hooks (passive recall, etc.) ──
    hookTurnCount++;
    const turnEndBootstrapReserve = runtime.bootstrapContext
      ? estimateTokens(runtime.bootstrapContext)
      : 0;
    const turnEndEffectiveBudget = Math.max(1, runtime.maxContextTokens - turnEndBootstrapReserve);

    hookRegistry
      .fire('turn_end', {
        ledger,
        runtime: {
          sessionId: runtime.sessionId,
          agentId,
          backend: runtime.backend,
          budgetUtilization: ledger.totalTokens() / turnEndEffectiveBudget,
          turnCount: hookTurnCount,
        },
        lastTurn: {
          userInput: raw,
          assistantResponse: assistantDisplayText,
          turnIndex: hookTurnCount,
        },
      })
      .then((hookResult) => {
        // Persist hook-injected entries to transcript so they survive reattach
        if (hookResult.injectedEntries.length > 0) {
          for (const entry of hookResult.injectedEntries) {
            appendTranscript(runtime.transcriptPath, {
              type: 'hook_injection',
              role: entry.role,
              content: entry.content,
              source: entry.source,
              memoryId: entry.memoryId,
            });
          }
        }

        // Notify the user about passive recall injections
        if (hookResult.injected > 0) {
          const recallEntries = ledger
            .listEntries()
            .filter((e) => e.source === 'passive-recall')
            .slice(-hookResult.injected);

          if (recallEntries.length > 0) {
            const totalTok = recallEntries.reduce((sum, e) => sum + e.approxTokens, 0);
            if (inkRepl) {
              const details = recallEntries.map((entry) => {
                const preview = entry.content.replace(/^\[passive-recall\]\s*/, '').slice(0, 120);
                return `  💡 ${preview}${entry.content.length > 120 ? '...' : ''} (${entry.approxTokens} tok)`;
              });
              inkRepl.setSurfacedMemories(details);
              printLine(
                chalk.dim(
                  `  💡 ${recallEntries.length} ${recallEntries.length === 1 ? 'memory' : 'memories'} surfaced (${totalTok} tok) — ctrl+o to expand`
                )
              );
            } else {
              for (const entry of recallEntries) {
                const preview = entry.content.replace(/^\[passive-recall\]\s*/, '').slice(0, 120);
                printLine(
                  chalk.dim(
                    `  💡 memory surfaced: "${preview}${entry.content.length > 120 ? '...' : ''}" (${entry.approxTokens} tok)`
                  )
                );
              }
            }
          }
        }
        if (hookResult.evicted > 0) {
          printLine(chalk.dim(`  🗑 ${hookResult.evicted} entries auto-evicted by hooks`));
        }
      })
      .catch(() => undefined); // never block the REPL

    if (!runResult.success && !isAbortedTurn) {
      printLine(chalk.red(`\n[${runtime.backend}] exit=${runResult.exitCode}`));
      if (runResult.stderr) {
        printLine(chalk.dim(runResult.stderr));
      }
    }

    if (inkRepl) {
      if (!isAbortedTurn) {
        const usageMeta = runResult.usage ? formatBackendTokenUsage(runResult.usage) : undefined;
        const trailingParts = [`${turnDurationSeconds}s`, usageMeta].filter(Boolean).join('  ·  ');
        inkRepl.addMessage('assistant', assistantDisplayText, {
          label: agentId,
          trailingMeta: trailingParts,
        });
      }
    } else if (!isAbortedTurn) {
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

  let rl: ReturnType<typeof createInterface> | null = null;

  let turnQueue: Promise<void> = Promise.resolve();
  let pendingTurns = 0;
  let consecutiveBackendFailures = 0;
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
  const enqueueTurn = (
    raw: string,
    source: 'user' | 'inbox-auto' | 'system' = 'user',
    displayLabel?: string
  ): Promise<void> => {
    pendingTurns += 1;
    emitStatusLaneIfChanged();
    const run = async () => {
      if (inkRepl) {
        inkRepl.setWaiting(true, runtime.backend);
      } else {
        statusLane.setTurnActive(true);
      }
      try {
        await runUserTurn(raw, source, displayLabel);
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

  // Live session stream: when attached to an EXISTING session, subscribe to the
  // server's SSE feed so a background worker's turn (a heartbeat, an incoming
  // message) renders live in this terminal as it churns — instead of surfacing
  // only via the 20s activity poll (which filters same-session events anyway).
  // Best-effort: if the stream can't connect, the activity poll remains the
  // fallback. Only the attached case needs this; a headless spawn IS the worker.
  if (
    !options.nonInteractive &&
    !options.message &&
    attachedToExistingSession &&
    runtime.sessionId
  ) {
    try {
      const { getPcpServerUrl } = await import('../lib/pcp-mcp.js');
      const { getValidAccessToken } = await import('../auth/tokens.js');
      const streamServerUrl = getPcpServerUrl().replace(/\/+$/, '');
      const streamToken = await getValidAccessToken(streamServerUrl);
      if (streamToken) {
        const renderSessionEvent = (evt: SessionEvent): void => {
          if (evt.type === 'connected') return;
          // SSE data is the bus SessionStreamEvent { sessionId, ts, type, data };
          // the worker's own NDJSON fields live one level down in `.data`.
          const wrapper = (evt.data ?? {}) as Record<string, unknown>;
          const payload = (wrapper.data ?? {}) as Record<string, unknown>;
          const at = typeof wrapper.ts === 'string' ? wrapper.ts : undefined;
          if (evt.type === 'tool_call') {
            const toolName = String(payload.toolName ?? payload.name ?? 'tool');
            const line = `${agentId} · ${toolName}`;
            if (inkRepl)
              inkRepl.addMessage('activity', line, {
                label: '⚡',
                time: formatHumanTime(at, runtime.userTimezone),
              });
            else printEvent(chalk.dim(`  ⚡ ${line}`));
          } else if (evt.type === 'result') {
            const text = String(payload.text ?? '').trim();
            if (!text) return;
            if (inkRepl)
              inkRepl.addMessage('activity', text, {
                label: 'live',
                time: formatHumanTime(at, runtime.userTimezone),
              });
            else
              printLine(
                renderMessageLine('activity', text, {
                  label: 'live',
                  timezone: runtime.userTimezone,
                  ts: at,
                })
              );
          }
        };
        stopEventStream = startSessionEventStream({
          serverUrl: streamServerUrl,
          sessionId: runtime.sessionId,
          token: streamToken,
          onEvent: renderSessionEvent,
        });
      }
    } catch {
      // Live stream is best-effort; the activity poll remains as fallback.
    }
  }

  // Status update deferred until after Ink/readline mount below
  if (!useInk) {
    emitStatusLaneIfChanged();
  }

  if (options.nonInteractive || options.message) {
    // Suppress MaxListenersExceeded for non-interactive spawns. Various
    // libraries (Commander, Ink renderer, MCP clients) each add SIGINT
    // handlers during init, easily exceeding the default limit of 10.
    // These are benign — the handlers are paired with cleanup.
    process.setMaxListeners(25);

    const message = options.message?.trim();
    if (!message) {
      throw new Error('--non-interactive requires --message "<text>"');
    }
    const maxTurns = parseInt(options.maxTurns || '1', 10);

    // Turn 1: the delivered message. When --message-label is set (server
    // spawns pass the originating channel, e.g. "heartbeat"), render as a
    // system message — it's harness-delivered, not typed by the human.
    const messageLabel = options.messageLabel?.trim();
    clearLastSignal();
    await enqueueTurn(message, messageLabel ? 'system' : 'user', messageLabel);

    // Check for signal or failure after turn 1
    let exitReason: string | undefined;
    const signal1 = getLastSignal();
    if (signal1?.status === 'completed' || signal1?.status === 'blocked') {
      exitReason = `${signal1.status}${signal1.reason ? `: ${signal1.reason}` : ''}`;
    }
    if (!exitReason && consecutiveBackendFailures > 0) {
      exitReason = 'backend_failure';
    }

    // Turns 2..N: continuation prompts — the SB signals when it's done
    if (!exitReason) {
      for (let turn = 2; turn <= maxTurns; turn++) {
        clearLastSignal();
        await enqueueTurn(
          'Continue working. Use signal_status to indicate when you are completed, blocked, or continuing.',
          'system',
          'continuation'
        );

        const signal = getLastSignal();
        if (signal?.status === 'completed' || signal?.status === 'blocked') {
          exitReason = `${signal.status}${signal.reason ? `: ${signal.reason}` : ''}`;
          break;
        }
        if (consecutiveBackendFailures >= 2) {
          exitReason = 'backend_failure';
          break;
        }
      }
    }

    if (pollTimer) clearInterval(pollTimer);
    stopEventStream?.();
    const summary = summarizeForSessionEnd(ledger);

    const isBackendFailure = exitReason === 'backend_failure';

    // Map the signal to a session phase. Don't end the session — leave it
    // resumable so the user or another SB can attach and follow up.
    const finalSignal = getLastSignal();
    const phase = isBackendFailure
      ? 'blocked:backend-error'
      : finalSignal?.status === 'blocked'
        ? 'blocked:needs-input'
        : finalSignal?.status === 'completed'
          ? 'idle:completed'
          : 'idle:awaiting-input';

    if (runtime.sessionId) {
      await pcp
        .callTool('update_session_state', {
          agentId,
          sessionId: runtime.sessionId,
          phase,
        })
        .catch(() => undefined);
    }
    appendTranscript(runtime.transcriptPath, {
      type: 'session_pause',
      sessionId: runtime.sessionId || null,
      summary,
      turnsCompleted: maxTurns,
      signal: finalSignal || undefined,
    });

    // Emit structured result for machine consumers (InkRunner, etc.).
    // Must come before human-readable status lines so parsers can
    // distinguish the assistant's response from CLI chrome.
    const lastAssistant = ledger
      .listEntries()
      .filter((e) => e.role === 'assistant')
      .pop();
    // Context utilization from our budget's view: transcript + identity.
    // The server (InkRunner) persists this so session-level token tracking
    // works for the ink backend — without it, sessions report 0 context
    // tokens and grow unbounded.
    const reportedContextTokens =
      ledger.totalTokens() +
      (runtime.bootstrapContext ? estimateTokens(runtime.bootstrapContext) : 0);
    console.log(
      JSON.stringify({
        type: 'result',
        text: lastAssistant?.content || null,
        sessionId: runtime.sessionId || null,
        phase,
        signal: finalSignal?.status || null,
        reason: finalSignal?.reason || (isBackendFailure ? 'backend_failure' : null),
        usage: {
          contextTokens: reportedContextTokens,
          inputTokens: lastBackendUsage?.inputTokens || 0,
          outputTokens: lastBackendUsage?.outputTokens || 0,
        },
        ...(isBackendFailure ? { backendFailure: true } : {}),
      })
    );

    if (isBackendFailure) {
      console.log(chalk.red(`\nSession aborted: backend returned consecutive failures.`));
      console.log(chalk.cyan(`  Resume with: ink chat --attach-latest ${agentId}\n`));
      process.exitCode = 1;
    } else if (finalSignal?.status === 'blocked') {
      console.log(chalk.yellow(`\nSession blocked: ${finalSignal.reason || 'needs input'}`));
    } else if (finalSignal?.status === 'completed') {
      console.log(chalk.green(`\nSession completed.`));
    } else {
      console.log(chalk.dim(`\nSession paused (${maxTurns} turn(s) completed).`));
    }
    if (!isBackendFailure) {
      console.log(chalk.cyan(`  Resume with: ink chat --attach-latest ${agentId}\n`));
    }

    // Clean up handles that would keep the process alive. Without this,
    // the non-interactive path skips the REPL cleanup at the end of
    // runChat() and Node hangs on open handles — blocking InkRunner's
    // heartbeat delivery callback indefinitely.
    readyForAutoRun = false;
    approvalManager.cancelAll();
    runtime.approvalChannel?.dispose();
    if (pendingTurns > 0) {
      await turnQueue;
    }
    // Unref stdio so lingering streams (e.g. piped stdin from InkRunner)
    // don't prevent the event loop from draining. Guarded: some stdin
    // stream types (already-closed pipes) don't implement unref.
    if (typeof process.stdin.unref === 'function') {
      process.stdin.unref();
    }
    return;
  }

  // ── Mount the REPL input layer (Ink or legacy readline) ──

  let readlineClosed = false;
  let keepRunning = true;
  let lastUsageTotal: number | undefined;
  let lastCtrlCAt = 0;
  let lastSigintAt = 0;
  let exitAfterTurnNoticeShown = false;
  let activePromptLabel = `${agentId}> `;

  // Helper: build context view lines from current state
  const buildContextViewLines = (): string[] => {
    const recallStats = passiveRecallHandle.getStats();
    const allEntries = ledger.listEntries();
    const recallEntries = allEntries.filter((e) => e.source === 'passive-recall');
    return formatContextLines({
      bootstrapSummary: runtime.bootstrapContext || undefined,
      passiveRecallEntries: recallEntries.map((e) => ({
        content: e.content,
        source: e.source,
      })),
      passiveRecallStats: {
        totalInjected: recallStats.totalInjected,
        uniqueMemories: recallStats.uniqueMemories,
        currentTurn: recallStats.currentTurn,
      },
      ledgerStats: {
        totalEntries: allEntries.length,
        tokenEstimate: ledger.totalTokens(),
        bootstrapTokens: runtime.bootstrapContext ? estimateTokens(runtime.bootstrapContext) : 0,
      },
      toolCalls: recentToolCalls,
      evicted: sessionEvictedEntries.map((e) => ({
        role: e.role,
        source: e.source,
        preview: e.content.slice(0, 100),
        actor: e.actor,
        reason: e.reason,
      })),
    });
  };

  if (useInk) {
    // ── Ink path ──
    inkRepl = renderInkChat({
      agentId,
      timezone: runtime.userTimezone,
      infoItems: initialInfoItems,
      fullscreen: !!options.fullscreen,
      dynamicMessages: !!options.dynamic,
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

    // Register Ctrl+O handler — opens context viewer via React state
    inkRepl.handle.setCtrlOHandler(() => {
      inkRepl!.showContextView(buildContextViewLines());
    });
    // Ctrl+T — same viewer, opened at the Tool Calls section (expands the
    // one-line 🛠 rows in the replay to full args)
    inkRepl.handle.setCtrlTHandler(() => {
      inkRepl!.showContextView(buildContextViewLines(), { initialSection: 't' });
    });

    // Push prior messages into Ink scrollback so user sees conversation history
    if (historyHydration && historyHydration.tailPreview.length > 0) {
      for (const entry of historyHydration.tailPreview) {
        if (entry.role === 'event') {
          // Tool calls and other progress lines — dim, unlabeled.
          // No manual indent: MessageLine's event role owns the column.
          inkRepl.printEvent(entry.content);
          continue;
        }
        const role =
          entry.role === 'user'
            ? ('user' as const)
            : entry.role === 'assistant'
              ? ('assistant' as const)
              : entry.role === 'system'
                ? ('system' as const)
                : ('inbox' as const);
        const label =
          entry.role === 'user'
            ? 'you'
            : entry.role === 'assistant'
              ? agentId
              : entry.role === 'system'
                ? entry.label || 'system'
                : '📬 inbox';
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
            '/help  /mcp  /capabilities  /skills  /profile  /policy  /away  /tool-routing  /save-config  /ui  /trim  /evict  /quit'
          ),
          '',
        ].join('\n')
      );
      continue;
    }

    const slash = parseSlashCommand(raw);
    if (slash) {
      const showInPanel = (lines: string[]) => {
        if (inkRepl) {
          inkRepl.setCommandOutput(lines);
        } else {
          console.log(lines.join('\n'));
        }
      };

      switch (slash.name) {
        case 'help': {
          showInPanel([
            '/help                      Show this help',
            '/quit | /exit              End chat',
            '/refresh                   Re-bootstrap identity context',
            '/inbox [full]              Poll inbox now',
            '/events [now|on|off]       Poll/toggle activity stream',
            '/session                   Show active session info',
            '/autorun [on|off]          Toggle inbox auto-run',
            '/away [on|off]             Toggle remote approval mode',
            '/tool-routing [backend|local]  Switch tool routing',
            '/save-config               Save runtime preferences',
            '/ui [scroll|live]          Set rendering mode',
            '/backend <name>            Switch backend',
            '/model <id>                Set/clear model override',
            '/tools <backend|off>       Toggle backend tools',
            '/grant <tool> [uses]       Grant tool for limited uses',
            '/allow <tool>              Persistently allow tool',
            '/deny <tool>               Persistently deny tool',
            '/policy                    Show tool policy',
            '/mcp [servers|call ...]    MCP servers / call tool',
            '/mcp-servers               List .mcp.json servers',
            '/capabilities              Full capability snapshot',
            '/ink <tool> [jsonArgs]     Call Inkwell tool directly',
            '/thread [key]              Show/set thread key',
            '/sessions [watch|off]      Show active sessions',
            '/skills                    List discovered skills',
            '/profile [name]            Apply security profile',
            '/bookmark [label]          Set context bookmark',
            '/bookmarks                 List bookmarks',
            '/eject <bookmark|last>     Eject context',
            '/trim [targetPct]          Trim oldest context',
            '/evict [sel] [--dry-run]   Evict entries (ids, source:<x>, role:<x>)',
            '/evicted                   Show evicted-from-context entries',
            '/context                   Show recent entries',
            '/usage                     Token estimate',
            'Ctrl+O                     Context inspector (e/t/m/b: jump sections)',
            'Ctrl+T                     Context inspector at Tool Calls',
          ]);
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
              showInPanel(['No unread inbox messages.']);
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
          showInPanel(['Refreshing identity context from Inkwell...']);
          const refreshResult = (await pcp
            .callTool('bootstrap', { agentId })
            .catch((error) => ({ error: String(error) }))) as Record<string, unknown>;
          if (refreshResult.error) {
            showInPanel([`Refresh failed: ${String(refreshResult.error)}`]);
          } else {
            const ctx = formatBootstrapContext(refreshResult, agentId);
            if (ctx) {
              runtime.bootstrapContext = ctx;
              const ctxTokens = estimateTokens(ctx);
              showInPanel([`Identity context refreshed: ~${ctxTokens.toLocaleString()} tokens`]);
            } else {
              showInPanel(['Bootstrap returned no identity context.']);
            }
            const refreshMemoryIds = refreshResult.memoryIds as string[] | undefined;
            if (refreshMemoryIds && refreshMemoryIds.length > 0) {
              passiveRecallHandle.seedBootstrapIds(refreshMemoryIds);
            }
          }
          break;
        }
        case 'events': {
          const mode = slash.args[0];
          if (mode === 'off') {
            runtime.eventPolling = false;
            showInPanel(['Activity polling disabled.']);
          } else if (mode === 'on') {
            runtime.eventPolling = true;
            showInPanel(['Activity polling enabled.']);
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
              : sessionStudioLabel({ studioId: runtime.studioId }, 'full');
            showInPanel([
              `session=${runtime.sessionId || 'none'}`,
              `backend=${runtime.backend} model=${runtime.model || '(default)'}`,
              `routing=${runtime.toolRouting} thread=${runtime.threadKey || '(none)'}`,
              `studio=${sessionStudio}`,
              `events=${runtime.eventPolling ? 'on' : 'off'} autorun=${runtime.autoRunInbox ? 'on' : 'off'}`,
              `ui=${runtime.uiMode} budget=${formatTokenCount(runtime.maxContextTokens)} window=${formatTokenCount(runtime.backendTokenWindow)}`,
              `budgetMode=${contextBudgetAuto ? 'auto' : 'manual'} tools=${toolPolicy.getMode()}`,
              `scope=${toolPolicy.getMutationScopeLabel()} visibility=${toolPolicy.getSessionVisibility()}`,
              `history=${sessionHistoryLabel(transcriptMeta)}`,
            ]);
          }
          break;
        case 'autorun':
        case 'auto-run': {
          const mode = (slash.args[0] || '').toLowerCase();
          if (!mode) {
            showInPanel([`Inbox auto-run is ${runtime.autoRunInbox ? 'on' : 'off'}.`]);
            break;
          }
          if (!['on', 'off'].includes(mode)) {
            showInPanel(['Usage: /autorun [on|off]']);
            break;
          }
          runtime.autoRunInbox = mode === 'on';
          showInPanel([`Inbox auto-run ${runtime.autoRunInbox ? 'enabled' : 'disabled'}.`]);
          break;
        }
        case 'away': {
          const mode = (slash.args[0] || '').toLowerCase();
          if (!mode) {
            const awayLines = [`Away mode is ${runtime.awayMode ? 'on' : 'off'}.`];
            if (approvalManager.size > 0) {
              awayLines.push(`  ${approvalManager.size} pending approval request(s)`);
            }
            showInPanel(awayLines);
            break;
          }
          if (!['on', 'off'].includes(mode)) {
            showInPanel(['Usage: /away [on|off]']);
            break;
          }
          runtime.awayMode = mode === 'on';
          if (runtime.awayMode) {
            showInPanel(['Away mode enabled — approvals sent to inbox for remote approval.']);
          } else {
            const awayOffLines = ['Away mode disabled — tool approvals will prompt locally.'];
            if (approvalManager.size > 0) {
              approvalManager.cancelAll();
              awayOffLines.push('Cancelled pending remote approval requests.');
            }
            showInPanel(awayOffLines);
          }
          break;
        }
        case 'tool-routing': {
          const mode = (slash.args[0] || '').toLowerCase();
          if (!mode) {
            showInPanel([`Tool routing is ${runtime.toolRouting}.`]);
            break;
          }
          if (!['backend', 'local'].includes(mode)) {
            showInPanel(['Usage: /tool-routing [backend|local]']);
            break;
          }
          runtime.toolRouting = mode as 'backend' | 'local';
          saveRuntimePreferences(process.cwd(), { toolRouting: runtime.toolRouting });
          const routingLines = [`Tool routing set to ${runtime.toolRouting}. (auto-saved)`];
          if (runtime.toolRouting === 'local') {
            routingLines.push('Local routing: backend tools disabled; use ink-tool blocks.');
          }
          showInPanel(routingLines);
          break;
        }
        case 'save-config': {
          const prefs: RuntimePreferences = {
            toolRouting: runtime.toolRouting,
            strictTools: runtime.strictTools,
            approvalMode: runtime.approvalMode === 'auto-deny' ? undefined : runtime.approvalMode,
          };
          const saved = saveRuntimePreferences(process.cwd(), prefs);
          if (saved) {
            const configLines = [
              'Runtime preferences saved to .ink/identity.json:',
              `  toolRouting: ${prefs.toolRouting}`,
              `  strictTools: ${prefs.strictTools}`,
            ];
            if (prefs.approvalMode) {
              configLines.push(`  approvalMode: ${prefs.approvalMode}`);
            }
            showInPanel(configLines);
          } else {
            showInPanel(['Failed to save runtime preferences.']);
          }
          break;
        }
        case 'ui': {
          if (inkRepl) {
            showInPanel(['UI mode: ink (React). Switch to scroll with --ui scroll on start.']);
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
            showInPanel(['Session watch enabled.']);
          } else if (mode === 'off') {
            runtime.showSessionsWatch = false;
            showInPanel(['Session watch disabled.']);
          } else {
            const snapshot = await refreshSessionsSnapshot(true);
            showInPanel(formatSessionsLines(snapshot, { timezone: runtime.userTimezone }));
          }
          break;
        }
        case 'backend': {
          const next = slash.args[0];
          if (!next || !['claude', 'codex', 'gemini'].includes(next)) {
            showInPanel(['Usage: /backend <claude|codex|gemini>']);
            break;
          }
          runtime.backend = next;
          runtime.backendTokenWindow = resolveBackendTokenWindow(runtime.backend, runtime.model);
          if (contextBudgetAuto) {
            runtime.maxContextTokens = defaultContextBudget(runtime.backendTokenWindow);
          }
          const backendLines = [`Switched backend to ${next}`];
          if (contextBudgetAuto) {
            backendLines.push(
              `Context budget auto-updated (${formatTokenCount(runtime.maxContextTokens)} tok).`
            );
          }
          showInPanel(backendLines);
          break;
        }
        case 'model': {
          const next = slash.args[0];
          runtime.model = next || undefined;
          runtime.backendTokenWindow = resolveBackendTokenWindow(runtime.backend, runtime.model);
          if (contextBudgetAuto) {
            runtime.maxContextTokens = defaultContextBudget(runtime.backendTokenWindow);
          }
          showInPanel([
            `Model override: ${runtime.model || '(backend default)'}`,
            `Backend window: ${formatTokenCount(runtime.backendTokenWindow)} tok`,
          ]);
          break;
        }
        case 'tools': {
          const next = slash.args[0];
          if (!next) {
            const grants = toolPolicy.listGrants();
            const toolsLines = [
              `Tool mode: ${toolPolicy.getMode()}`,
              `Mutation scope: ${toolPolicy.getMutationScopeLabel()}`,
              `Session visibility: ${toolPolicy.getSessionVisibility()}`,
            ];
            if (grants.length > 0) {
              toolsLines.push(`Grants: ${grants.map((g) => `${g.tool}(${g.uses})`).join(', ')}`);
            }
            const sessionGrants = toolPolicy.listSessionGrants(runtime.sessionId);
            if (sessionGrants.length > 0) {
              toolsLines.push(
                `Session grants: ${sessionGrants.map((g) => `${g.tool}(${g.uses})`).join(', ')}`
              );
            }
            showInPanel(toolsLines);
            break;
          }
          if (next !== 'backend' && next !== 'off' && next !== 'privileged') {
            showInPanel(['Usage: /tools <backend|off|privileged>']);
            break;
          }
          toolPolicy.setMode(next);
          runtime.toolMode = toolPolicy.getMode();
          const toolsModeLines = [
            `Tool mode set in ${toolPolicy.getMutationScopeLabel()} to ${next}.`,
          ];
          if (runtime.toolMode !== next) {
            toolsModeLines.push(
              `Effective mode remains ${runtime.toolMode} due stricter active scope.`
            );
          }
          showInPanel(toolsModeLines);
          break;
        }
        case 'grant': {
          const tool = slash.args[0];
          if (!tool) {
            showInPanel(['Usage: /grant <tool> [uses]']);
            break;
          }
          const uses = Number.parseInt(slash.args[1] || '1', 10);
          toolPolicy.grantTool(tool, Number.isNaN(uses) ? 1 : uses);
          showInPanel([`Granted ${tool} for ${Number.isNaN(uses) ? 1 : uses} use(s).`]);
          break;
        }
        case 'allow': {
          const tool = slash.args[0];
          if (!tool) {
            showInPanel(['Usage: /allow <tool>']);
            break;
          }
          toolPolicy.allowTool(tool);
          showInPanel([`Persistently allowed ${tool}`]);
          break;
        }
        case 'grant-session': {
          const tool = slash.args[0];
          if (!tool) {
            showInPanel(['Usage: /grant-session <tool>']);
            break;
          }
          if (!runtime.sessionId) {
            showInPanel(['No Inkwell session id available.']);
            break;
          }
          toolPolicy.grantToolForSession(runtime.sessionId, tool);
          showInPanel([`Granted ${tool} for this Inkwell session.`]);
          break;
        }
        case 'grant-remote': {
          const targetAgent = slash.args[0];
          const toolSpec = slash.args[1];
          if (!targetAgent || !toolSpec) {
            showInPanel([
              'Usage: /grant-remote <agent> <toolSpec> [once|session|always|deny|revoke]',
            ]);
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
            showInPanel([`Unknown scope: ${scopeArg}. Use: once, session, always, deny, revoke`]);
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
              showInPanel([
                `Failed to send grant: ${err instanceof Error ? err.message : String(err)}`,
              ]);
              return null;
            });
          if (grantResult) {
            showInPanel([`Sent ${action} for ${toolSpec} to ${targetAgent}.`]);
          }
          break;
        }
        case 'deny': {
          const tool = slash.args[0];
          if (!tool) {
            showInPanel(['Usage: /deny <tool>']);
            break;
          }
          toolPolicy.denyTool(tool);
          showInPanel([`Persistently denied ${tool}`]);
          break;
        }
        case 'prompt': {
          const tool = slash.args[0];
          if (!tool) {
            showInPanel(['Usage: /prompt <tool>']);
            break;
          }
          toolPolicy.addPromptTool(tool);
          showInPanel([`Tool ${tool} now requires per-call approval`]);
          break;
        }
        case 'policy-scope': {
          const scopeRaw = (slash.args[0] || '').trim().toLowerCase();
          if (!scopeRaw) {
            showInPanel([
              `Mutation scope: ${toolPolicy.getMutationScopeLabel()}`,
              `Active scopes: ${toolPolicy.listActiveScopeLabels().join(' -> ')}`,
            ]);
            break;
          }
          if (!['global', 'workspace', 'agent', 'studio'].includes(scopeRaw)) {
            showInPanel(['Usage: /policy-scope [global|workspace|agent|studio] [id]']);
            break;
          }
          const id = slash.args.slice(1).join(' ').trim() || undefined;
          const result = toolPolicy.setMutationScope(scopeRaw as ToolPolicyScopeKind, id);
          if (!result.success) {
            showInPanel([result.message]);
          } else {
            runtime.toolMode = toolPolicy.getMode();
            showInPanel([result.message]);
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
            showInPanel(['Usage: /policy-reset [global|workspace|agent|studio] [id]']);
            break;
          }
          const result = toolPolicy.clearScopeRules(explicitScope);
          if (!result.success) {
            showInPanel([result.message]);
            break;
          }
          runtime.toolMode = toolPolicy.getMode();
          showInPanel([result.message]);
          break;
        }
        case 'profile': {
          const profileArg = (slash.args[0] || '').trim().toLowerCase();
          if (!profileArg) {
            showInPanel([
              'Tool Profiles',
              formatProfileList(),
              'Usage: /profile <minimal|safe|collaborative|full>',
            ]);
            break;
          }
          if (!isValidProfileId(profileArg)) {
            showInPanel([`Unknown profile: ${profileArg}`, formatProfileList()]);
            break;
          }
          const profileResult = applyProfile(toolPolicy, profileArg);
          showInPanel([profileResult.message]);
          if (profileResult.success) {
            runtime.toolMode = toolPolicy.getMode();
          }
          break;
        }
        case 'policy': {
          showInPanel(formatToolPolicyLines(toolPolicy, runtime.sessionId, runtime.activeSkills));
          break;
        }
        case 'mcp': {
          const sub = (slash.args[0] || 'servers').toLowerCase();
          if (sub === 'servers' || sub === 'list') {
            const servers = listConfiguredMcpServers(process.cwd());
            if (servers.length === 0) {
              showInPanel(['No MCP servers configured in .mcp.json']);
              break;
            }
            const lines = [`MCP servers (${servers.length})`];
            for (const server of servers) {
              const endpoint = server.url || server.command || '(unknown)';
              lines.push(`  ${server.name} [${server.transport || 'unknown'}] ${endpoint}`);
            }
            showInPanel(lines);
            break;
          }
          if (sub === 'call') {
            const tool = slash.args[1];
            if (!tool) {
              showInPanel(['Usage: /mcp call <tool> [jsonArgs]']);
              break;
            }
            let pcpArgs: Record<string, unknown> = {};
            const rawArgs = raw.split(/\s+/).slice(3).join(' ').trim();
            if (rawArgs) {
              try {
                pcpArgs = JSON.parse(rawArgs) as Record<string, unknown>;
              } catch {
                showInPanel([
                  'Invalid JSON args. Example: /mcp call get_inbox {"agentId":"lumen"}',
                ]);
                break;
              }
            }
            const approved = await ensurePcpToolAllowed({
              policy: toolPolicy,
              tool,
              sessionId: runtime.sessionId,
              prompt: (reason) =>
                promptForToolApproval(
                  rl,
                  toolPolicy,
                  runtime.sessionId,
                  tool,
                  reason,
                  inkRepl,
                  runtime.approvalChannel
                ),
            });
            if (!approved) {
              showInPanel([`Skipped ${tool}`]);
              break;
            }
            const result = await pcp
              .callTool(tool, pcpArgs)
              .catch((error) => ({ error: String(error) }));
            const rendered = JSON.stringify(result, null, 2);
            ledger.addEntry('system', compactForLedger(`ink ${tool} -> ${rendered}`, 500), 'pcp');
            appendTranscript(runtime.transcriptPath, {
              type: 'pcp_tool',
              tool,
              args: pcpArgs,
              result,
            });
            showInPanel(rendered.split('\n'));
            break;
          }
          showInPanel(['Usage: /mcp [servers|list|call <tool> [jsonArgs]]']);
          break;
        }
        case 'mcp-servers': {
          const servers = listConfiguredMcpServers(process.cwd());
          if (servers.length === 0) {
            showInPanel(['No MCP servers configured in .mcp.json']);
            break;
          }
          const serverLines = [`MCP servers (${servers.length})`];
          for (const server of servers) {
            const endpoint = server.url || server.command || '(unknown)';
            serverLines.push(`  ${server.name} [${server.transport || 'unknown'}] ${endpoint}`);
          }
          showInPanel(serverLines);
          break;
        }
        case 'capabilities': {
          const servers = listConfiguredMcpServers(process.cwd());
          const skills = discoverSkills(process.cwd());
          const filtered = filterSkillsByPolicy(skills, toolPolicy);

          const capLines: string[] = [
            `Capabilities snapshot`,
            `Backend=${runtime.backend}${runtime.model ? `(${runtime.model})` : ''} thread=${runtime.threadKey || '(none)'} session=${runtime.sessionId || '(none)'}`,
            '',
          ];

          if (servers.length === 0) {
            capLines.push('MCP servers: none configured');
          } else {
            capLines.push(`MCP servers (${servers.length})`);
            for (const server of servers) {
              const endpoint = server.url || server.command || '(unknown)';
              capLines.push(`  ${server.name} [${server.transport || 'unknown'}] ${endpoint}`);
            }
          }

          capLines.push('', `Skills (${skills.length} discovered)`);
          if (filtered.visible.length === 0) {
            capLines.push('  none visible under current policy');
          } else {
            for (const skill of filtered.visible.slice(0, 20)) {
              const active = runtime.activeSkills.some((entry) => entry.path === skill.path)
                ? ' *active*'
                : '';
              capLines.push(`  ${skill.name} [${skill.source}] trust=${skill.trustLevel}${active}`);
            }
            if (filtered.visible.length > 20) {
              capLines.push(`  ... and ${filtered.visible.length - 20} more`);
            }
          }
          if (filtered.blockedBySkill.length > 0) {
            capLines.push(`Blocked by skill allowlist: ${filtered.blockedBySkill.length}`);
          }
          if (filtered.blockedByPath.length > 0) {
            capLines.push(`Blocked by path policy: ${filtered.blockedByPath.length}`);
          }
          if (filtered.blockedByTrust.length > 0) {
            capLines.push(`Blocked by trust mode: ${filtered.blockedByTrust.length}`);
          }

          capLines.push(
            '',
            ...formatToolPolicyLines(toolPolicy, runtime.sessionId, runtime.activeSkills)
          );
          showInPanel(capLines);
          break;
        }
        case 'pcp': {
          const tool = slash.args[0];
          if (!tool) {
            showInPanel(['Usage: /ink <tool> [jsonArgs]']);
            break;
          }
          let pcpArgs: Record<string, unknown> = {};
          const rawArgs = raw.split(/\s+/).slice(2).join(' ').trim();
          if (rawArgs) {
            try {
              pcpArgs = JSON.parse(rawArgs) as Record<string, unknown>;
            } catch {
              showInPanel(['Invalid JSON args. Example: /pcp get_inbox {"agentId":"lumen"}']);
              break;
            }
          }
          const approved = await ensurePcpToolAllowed({
            policy: toolPolicy,
            tool,
            sessionId: runtime.sessionId,
            prompt: (reason) =>
              promptForToolApproval(
                rl,
                toolPolicy,
                runtime.sessionId,
                tool,
                reason,
                inkRepl,
                runtime.approvalChannel
              ),
          });
          if (!approved) {
            showInPanel([`Skipped ${tool}`]);
            break;
          }
          const result = await pcp
            .callTool(tool, pcpArgs)
            .catch((error) => ({ error: String(error) }));
          const rendered = JSON.stringify(result, null, 2);
          ledger.addEntry('system', compactForLedger(`ink ${tool} -> ${rendered}`, 500), 'pcp');
          appendTranscript(runtime.transcriptPath, {
            type: 'pcp_tool',
            tool,
            args: pcpArgs,
            result,
          });
          showInPanel(rendered.split('\n'));
          break;
        }
        case 'skills': {
          const skills = discoverSkills(process.cwd());
          if (skills.length === 0) {
            showInPanel(['No local skills discovered.']);
            break;
          }
          const filtered = filterSkillsByPolicy(skills, toolPolicy);
          const visible = filtered.visible;
          const skillLines = [`Discovered skills (${skills.length})`];
          for (const skill of visible.slice(0, 80)) {
            const active = runtime.activeSkills.some((entry) => entry.path === skill.path)
              ? ' *active*'
              : '';
            const trust = skill.trustLevel;
            const provenance = skill.provenance?.registry
              ? ` registry:${skill.provenance.registry}`
              : '';
            skillLines.push(
              `  ${skill.name} [${skill.source}] trust=${trust}${provenance}${active}`
            );
          }
          if (visible.length > 80) {
            skillLines.push(`  ... and ${visible.length - 80} more`);
          }
          if (filtered.blockedBySkill.length > 0) {
            skillLines.push(`${filtered.blockedBySkill.length} hidden by skill allowlist`);
          }
          if (filtered.blockedByPath.length > 0) {
            skillLines.push(`${filtered.blockedByPath.length} hidden by read-path allowlist`);
          }
          if (filtered.blockedByTrust.length > 0) {
            skillLines.push(`${filtered.blockedByTrust.length} hidden by trust policy`);
          }
          showInPanel(skillLines);
          break;
        }
        case 'skill-trust': {
          const mode = (slash.args[0] || '').trim();
          if (!mode || !['all', 'trusted-only'].includes(mode)) {
            showInPanel(['Usage: /skill-trust <all|trusted-only>']);
            break;
          }
          toolPolicy.setSkillTrustMode(mode as 'all' | 'trusted-only');
          showInPanel([`Skill trust mode set to ${mode}`]);
          break;
        }
        case 'session-visibility': {
          const value = (slash.args[0] || '').trim().toLowerCase();
          if (!value) {
            showInPanel([`Session visibility is ${toolPolicy.getSessionVisibility()}.`]);
            break;
          }
          if (!['self', 'thread', 'studio', 'workspace', 'agent', 'all'].includes(value)) {
            showInPanel(['Usage: /session-visibility <self|thread|studio|workspace|agent|all>']);
            break;
          }
          toolPolicy.setSessionVisibility(
            value as 'self' | 'thread' | 'studio' | 'workspace' | 'agent' | 'all'
          );
          showInPanel([
            `Session visibility set in ${toolPolicy.getMutationScopeLabel()} to ${value}.`,
          ]);
          break;
        }
        case 'skill-allow': {
          const skill = slash.args.join(' ').trim();
          if (!skill) {
            showInPanel(['Usage: /skill-allow <name>']);
            break;
          }
          toolPolicy.allowSkill(skill);
          showInPanel([`Allowed skill: ${skill}`]);
          break;
        }
        case 'path-allow-read': {
          const pattern = slash.args.join(' ').trim();
          if (!pattern) {
            showInPanel(['Usage: /path-allow-read <glob>']);
            break;
          }
          toolPolicy.addReadPathAllow(pattern);
          showInPanel([`Allowed read path: ${pattern}`]);
          break;
        }
        case 'path-allow-write': {
          const pattern = slash.args.join(' ').trim();
          if (!pattern) {
            showInPanel(['Usage: /path-allow-write <glob>']);
            break;
          }
          toolPolicy.addWritePathAllow(pattern);
          showInPanel([`Allowed write path: ${pattern}`]);
          break;
        }
        case 'skill-use': {
          const name = slash.args.join(' ').trim();
          if (!name) {
            showInPanel(['Usage: /skill-use <name>']);
            break;
          }
          const skills = discoverSkills(process.cwd()).filter((skill) => skill.name === name);
          if (skills.length === 0) {
            showInPanel([`Skill not found: ${name}`]);
            break;
          }
          const [skill] = skills;
          const activation = canActivateSkill(skill, toolPolicy);
          if (!activation.allowed) {
            showInPanel([activation.reason || 'Skill blocked by policy']);
            break;
          }
          const loaded = loadSkillInstruction(skill);
          runtime.activeSkills = [
            ...runtime.activeSkills.filter((entry) => entry.path !== loaded.path),
            loaded,
          ];
          showInPanel([`Activated skill ${loaded.name}`]);
          break;
        }
        case 'skill-clear': {
          const name = slash.args.join(' ').trim();
          if (!name) {
            runtime.activeSkills = [];
            showInPanel(['Cleared all active skills.']);
            break;
          }
          const before = runtime.activeSkills.length;
          runtime.activeSkills = runtime.activeSkills.filter((skill) => skill.name !== name);
          const removed = before - runtime.activeSkills.length;
          if (removed === 0) {
            showInPanel([`No active skill matched: ${name}`]);
          } else {
            showInPanel([`Cleared ${removed} active skill(s) for ${name}`]);
          }
          break;
        }
        case 'delegate-create': {
          const toAgent = (slash.args[0] || '').trim().toLowerCase();
          const scopeSpec = (slash.args[1] || '').trim();
          const ttlMinutes = Number.parseInt(slash.args[2] || '15', 10);
          const secret = getDelegationSecret();
          if (!secret) {
            showInPanel(['Delegation secret missing. Set INK_DELEGATION_SECRET (or JWT_SECRET).']);
            break;
          }
          if (!toAgent || !scopeSpec) {
            showInPanel(['Usage: /delegate-create <to-agent> <scope1,scope2> [ttl-minutes]']);
            break;
          }
          const scopes = parseToolScopes(scopeSpec);
          if (scopes.length === 0) {
            showInPanel(['Provide at least one scope.']);
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
              studioId: identity?.studioId,
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
          showInPanel([summary, token]);
          break;
        }
        case 'delegate-show': {
          if (!lastDelegation) {
            showInPanel(['No delegation token minted in this chat session yet.']);
            break;
          }
          showInPanel([
            ...JSON.stringify(lastDelegation.payload, null, 2).split('\n'),
            lastDelegation.token,
          ]);
          break;
        }
        case 'delegate-verify': {
          const target = (slash.args[0] || 'last').trim();
          const token = target === 'last' ? lastDelegation?.token : target;
          if (!token) {
            showInPanel(['No token available. Use /delegate-create first or pass a token.']);
            break;
          }
          const secret = getDelegationSecret();
          if (!secret) {
            showInPanel(['Delegation secret missing. Set INK_DELEGATION_SECRET (or JWT_SECRET).']);
            break;
          }
          const verified = verifyDelegationToken(token, secret);
          if (!verified.valid || !verified.payload) {
            showInPanel([`Invalid delegation token: ${verified.error}`]);
            break;
          }
          showInPanel([
            'Delegation token valid.',
            ...JSON.stringify(verified.payload, null, 2).split('\n'),
          ]);
          break;
        }
        case 'delegate-send': {
          const toAgent = (slash.args[0] || '').trim().toLowerCase();
          const scopeSpec = (slash.args[1] || '').trim();
          const message = slash.args.slice(2).join(' ').trim();
          if (!toAgent || !scopeSpec || !message) {
            showInPanel(['Usage: /delegate-send <to-agent> <scope1,scope2> <message...>']);
            break;
          }
          const secret = getDelegationSecret();
          if (!secret) {
            showInPanel(['Delegation secret missing. Set INK_DELEGATION_SECRET (or JWT_SECRET).']);
            break;
          }

          const scopes = parseToolScopes(scopeSpec);
          if (scopes.length === 0) {
            showInPanel(['Provide at least one scope.']);
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
              studioId: identity?.studioId,
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
                inkRepl,
                runtime.approvalChannel
              ),
          });
          if (!approved) {
            showInPanel(['Skipped delegated send_to_inbox (policy blocked).']);
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
          showInPanel([
            `Delegated message sent to ${toAgent}.`,
            ...JSON.stringify(result, null, 2).split('\n'),
          ]);
          break;
        }
        case 'thread': {
          const next = slash.args[0];
          if (next) {
            runtime.threadKey = next;
            showInPanel([`Thread key set to ${next}`]);
          } else {
            showInPanel([`Thread key: ${runtime.threadKey || '(none)'}`]);
          }
          break;
        }
        case 'bookmark': {
          const bookmark = ledger.createBookmark(slash.args.join(' '));
          showInPanel([`Created bookmark ${bookmark.id} (${bookmark.label})`]);
          break;
        }
        case 'bookmarks': {
          const bookmarks = ledger.listBookmarks();
          if (bookmarks.length === 0) {
            showInPanel(['No bookmarks yet.']);
            break;
          }
          showInPanel(
            bookmarks.map(
              (b) => `${b.id}  ${b.label}  entry#${b.entryId}  ~${b.approxTokensAtCreation} tok`
            )
          );
          break;
        }
        case 'eject': {
          const force = slash.args.includes('--force') || slash.args.includes('force');
          const ref = slash.args.find((arg) => arg !== '--force' && arg !== 'force') || 'last';
          const preview = ledger.previewEjectToBookmark(ref);
          if (!preview) {
            showInPanel([`Bookmark not found: ${ref}`]);
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
              showInPanel([
                `About to eject ${removedCount} entries (~${preview.removedTokens} tok) up to ${preview.bookmark.id}.`,
                ...(previewLines.length ? ['Recent entries in eject range:', ...previewLines] : []),
              ]);
              const confirm = (
                await rl!.question(chalk.yellow('Proceed with ejection? [y/N]: '))
              ).trim();
              if (!['y', 'yes'].includes(confirm.toLowerCase())) {
                showInPanel(['Ejection cancelled.']);
                break;
              }
            }
          }

          const result = ledger.ejectToBookmark(ref);
          if (!result) {
            showInPanel([`Bookmark not found: ${ref}`]);
            break;
          }

          showInPanel([
            `Ejected ${removedCount} entries (~${result.removedTokens} tok) up to ${result.bookmark.id}`,
          ]);

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
            showInPanel(['Usage: /trim [targetPercent 10-95]']);
            break;
          }
          const trimResult = await trimContextToPercent(targetPct, 'manual');
          if (trimResult.removed === 0) {
            showInPanel(['No trim needed; context already within target budget.']);
          }
          break;
        }
        case 'evict': {
          const selection = parseEvictSelection(slash.args);
          if (selection.error) {
            showInPanel([
              selection.error,
              'Usage: /evict [ids | source:<name> | role:<role>] [--dry-run]',
            ]);
            break;
          }
          if (selection.list) {
            // No selector — show the pick list, never mutate
            const entries = ledger.listEntries();
            if (entries.length === 0) {
              showInPanel(['Context is empty — nothing to evict.']);
              break;
            }
            showInPanel([
              `Evictable entries (${entries.length}, ~${ledger.totalTokens().toLocaleString()} tok):`,
              ...entries.map((e) => formatEvictCandidate(e)),
              '',
              'Evict with: /evict <ids> | /evict source:<name> | /evict role:<role> [--dry-run]',
            ]);
            break;
          }
          const matched = selectEvictionEntries(ledger.listEntries(), selection);
          if (matched.length === 0) {
            showInPanel(['No context entries match that selection.']);
            break;
          }
          const matchedTokens = matched.reduce((sum, e) => sum + e.approxTokens, 0);
          if (selection.dryRun) {
            showInPanel([
              `Would evict ${matched.length} entries (~${matchedTokens.toLocaleString()} tok):`,
              ...matched.map((e) => formatEvictCandidate(e)),
              '',
              'Re-run without --dry-run to evict.',
            ]);
            break;
          }
          const evictResult = ledger.evictEntries(matched.map((e) => e.id));
          recordEviction(
            'user',
            `/evict ${slash.args.filter((a) => !a.startsWith('--')).join(' ')}`,
            evictResult.removedTokens,
            evictResult.removedEntries.map((e) => ({
              ...(e.eid !== undefined ? { eid: e.eid } : {}),
              hash: entryRefHash(e.role, e.content),
              role: e.role,
              source: e.source,
              preview: e.content.slice(0, 100),
            }))
          );
          printEvent(
            chalk.dim(
              `  🗑 evicted ${evictResult.removedEntries.length} entries (~${evictResult.removedTokens.toLocaleString()} tok freed, ~${evictResult.totalAfter.toLocaleString()} tok remaining) — /evicted to review`
            )
          );
          break;
        }
        case 'evicted': {
          if (sessionEvictedEntries.length === 0) {
            showInPanel(['Nothing evicted from context this session.']);
            break;
          }
          const lines = [
            `${sessionEvictedEntries.length} entries evicted — out of the prompt window, still in the transcript:`,
            ...sessionEvictedEntries.map((e) => {
              const attribution = [e.actor, e.reason].filter(Boolean).join(' · ');
              return `✕ [${e.role}${e.source ? `/${e.source}` : ''}] ${e.content.slice(0, 100)}${attribution ? ` (${attribution})` : ''}`;
            }),
          ];
          showInPanel(lines);
          break;
        }
        case 'context': {
          if (inkRepl) {
            inkRepl.showContextView(buildContextViewLines());
          } else {
            const entries = ledger.listEntries().slice(-12);
            if (entries.length === 0) {
              showInPanel(['Context is empty.']);
              break;
            }
            showInPanel(
              entries.map((entry) => {
                const prefix = `${entry.role}${entry.source ? `/${entry.source}` : ''}`;
                return `${prefix}: ${entry.content.slice(0, 180)}`;
              })
            );
          }
          break;
        }
        case 'usage': {
          if (pendingTurns > 0) {
            await turnQueue;
          }
          const usage = formatUsageLines(
            ledger,
            runtime.maxContextTokens,
            lastUsageTotal,
            lastBackendUsage,
            runtime.backendTokenWindow
          );
          lastUsageTotal = usage.total;
          showInPanel(usage.lines);
          break;
        }
        default:
          showInPanel([`Unknown command: /${slash.name}`]);
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
  stopEventStream?.();

  if (pendingTurns > 0) {
    console.log(chalk.dim(`Waiting for ${pendingTurns} pending turn(s) to finish...`));
    await turnQueue;
  }

  // Cancel any pending remote approval requests
  approvalManager.cancelAll();
  runtime.approvalChannel?.dispose();

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
    console.log(chalk.dim(`Reattach: ink chat -a ${agentId} --attach ${runtime.sessionId}`));
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
        'Tool routing mode: local (ink-tool blocks handled by ink) or backend (native backend tools)',
        'local'
      )
      .option('--ui <mode>', 'UI mode: live (default) or scroll status rendering', 'live')
      .option('--thread-key <key>', 'Thread key for Inkwell session routing')
      .option(
        '--sender <platform:id>',
        'Simulate sender identity for per-contact isolation (e.g., telegram:99887766)'
      )
      .option('--contact-id <uuid>', 'Use existing contact ID for per-contact session isolation')
      .option('--new', 'Always start a new session (disable auto-attach to latest)')
      .option('--attach [query]', 'Attach to an active session for this SB (optional query filter)')
      .option(
        '--attach-latest [query]',
        'Attach to newest active session for this SB (optional query filter)'
      )
      .option('--session-id <id>', 'Attach chat to an existing Inkwell session id')
      .option(
        '--max-context-tokens <n>',
        'Approximate context budget for transcript (default: backend window policy, currently 1,000,000)'
      )
      .option('--poll-seconds <n>', 'Inbox polling interval seconds', '20')
      .option('--tools <mode>', 'Tool mode: backend|off|privileged', 'backend')
      .option('--profile <name>', 'Apply security profile: minimal|safe|collaborative|full')
      .option('--away', 'Start with away mode on (route tool approvals to inbox for 2FA)')
      .option('--auto-run', 'Automatically execute backend turns for new inbox task messages')
      .option('--message <text>', 'Single-turn message for non-interactive mode')
      .option(
        '--attach-file <path>',
        'Attach a local file to the first turn (repeatable). The path is shared with the backend for native viewing.',
        (value: string, previous: string[]) => [...previous, value],
        [] as string[]
      )
      .option(
        '--message-label <label>',
        'Render the --message as a system message with this label (e.g., heartbeat, telegram). Used by server spawns.'
      )
      .option('--non-interactive', 'Run one turn and exit (requires --message)')
      .option('--max-turns <n>', 'Run up to N conversational turns then exit (requires --message)')
      .option(
        '--backend-timeout-seconds <n>',
        'Backend turn timeout in seconds (default: 120 for --non-interactive, otherwise 1200)'
      )
      .option('--sb-debug', 'Enable ink debug logging for chat runtime')
      .option(
        '--sb-strict-tools',
        'Harden backend-native tooling (Codex: disable MCP servers + force read-only sandbox in local routing)'
      )
      .option(
        '--tail-transcript <pathOrSession>',
        'Tail transcript output by file path or session id'
      )
      .option(
        '--approval-mode <mode>',
        'Approval mode: interactive (TUI prompt), jsonl (structured I/O on stderr/stdin)',
        'interactive'
      )
      .option('-v, --verbose', 'Verbose backend passthrough output')
      .option('--fullscreen', 'Fullscreen alternate buffer mode (app-controlled scrolling)')
      .option('--dynamic', 'Render messages dynamically (re-renderable, no terminal scrollback)')
      .action((options: ChatOptions) => runChat(options));

  register('chat', 'Start first-class Ink REPL (experimental)');
  register('alpha', 'Alias for `ink chat` (experimental)');
}
