import { sanitizeArgsForApproval } from '@inklabs/shared/runtime';
import { createSessionClones } from '@inklabs/shared/node-host';
import { createSessionToolHost } from '@inklabs/shared/node-host';
import { homedir, tmpdir } from 'os';
import {
  runSessionAgentTurn,
  SessionStream,
  applyModelSelection,
  applyDetectedModel,
  createSessionCompaction,
  DEFAULT_TRIM_TARGET_PCT,
  type SessionProviderPorts,
} from '@inklabs/shared/providers';
export { isResumeFailedNoSession } from '@inklabs/shared/runtime';
import { occupancyTokens, promptTokensOf, relayBudgetBytes } from '@inklabs/shared/runtime';
export {
  occupancyTokens,
  promptTokensOf,
  ledgerEntryPromptBytes,
  relayBudgetBytes,
  RELAY_HEADROOM_SHARE,
  RELAY_BYTES_PER_TOKEN,
  MIN_RELAY_BUDGET_BYTES,
  LEDGER_ENTRY_FRAME_BYTES,
} from '@inklabs/shared/runtime';
import {
  envelopeShapeKey,
  turnContextOccupancy,
  buildSessionPrompt,
  formatBootstrapContext,
  renderActiveSkills,
} from '@inklabs/shared/runtime';
export {
  buildDeltaPrompt,
  buildContinuationPrompt,
  buildMidTurnReseedBody,
  continuationSpawnArgs,
  decideContinuationSession,
  envelopeShapeKey,
  spawnDialogueText,
  turnContextOccupancy,
  MID_TURN_RESEED_MAX_CHARS,
  type ContinuationSpawnArgs,
  type ReseedDialogueEntry,
} from '@inklabs/shared/runtime';
import {
  compactForLedger,
  SerialInputDrain,
  SessionUsage,
  SessionContextState,
  CONTEXT_MUTATING_TOOL_NAMES,
  SessionTurnCoordinator,
  bootstrapSessionIdentity,
  type PreparedSessionTurn,
  type SessionTurnExecution,
  InputDrainRefusal,
  extractSessionContextMessages,
  findLastBackendSessionInEvents,
  findLastDetectedModelInEvents,
  hydrateLedgerFromEvents,
  hydrateLedgerFromSessionContext,
  type EvictedEntryRecord,
  type HistoryHydrationResult,
  type RecoveredBackendSession,
} from '@inklabs/shared/runtime';
export {
  keptEntriesForCompaction,
  readProviderSampleEvent,
  type PersistedProviderSample,
  type RecoveredBackendSession,
} from '@inklabs/shared/runtime';
import { Command } from 'commander';
import chalk from 'chalk';
import { createInterface } from 'readline/promises';
import { stdin as input, stdout as output } from 'process';
import {
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
  resolveSlug,
  saveRuntimePreferences,
  type RuntimePreferences,
} from '../backends/identity.js';
import { acceptsContextImagesFor, promptTransportFor } from '../backends/index.js';
import { createCliBackendHost } from '../backends/cli-host.js';
import { InkClient, type InkToolCallResult } from '../lib/ink-client.js';
import { deriveClonePolicy, isForbiddenInClone } from '../repl/clone-policy.js';
import { localDeliveredSend, turnReplyEvent } from '../repl/turn-reply.js';
import {
  CloneRegistry,
  formatCloneLine,
  isSettled,
  type CloneRecord,
  type CloneStatus,
} from '../repl/clone-registry.js';
import {
  COLLECT_AGENTS_TOOL,
  MAX_CLONES_PER_SPAWN,
  admitSpawn,
  MAX_CLONE_SUMMARY_CHARS,
  SPAWN_AGENT_TOOL,
  boundSummary,
  buildClonePrompt,
  classifyCloneOutcome,
  describeCloneToolResult,
  formatFanOutForLedger,
  isCloneHandoffTool,
  parseSpawnAgentArgs,
  screenIteration,
  selectOutcomesToLedger,
  type CloneOutcomeSummary,
  type SpawnAgentTask,
} from '../repl/spawn-agent.js';
import { initSbDebug, sbDebugLog } from '../lib/sb-debug.js';
import { divertConsoleLogToStderr, restoreConsoleLog } from '../lib/stdout-purity.js';
import { completeStudioAtLaunch, type LaunchStudioDeps } from '../lib/launch-studio.js';
import { detectWorktree } from './init.js';
import { SessionLog } from '../session/session-log.js';
import { toolIntentCommitter } from '../session/tool-intent.js';
import {
  ensureBackendAuthReady,
  isBackendAuthBackend,
  getBackendAuthStatus,
  runBackendInteractiveLogin,
  type BackendAuthBackend,
} from '../lib/backend-auth.js';
import {
  startBackendTurn,
  runBackendTurn,
  withholdProviderToolsForThisProcess,
  type BackendRunResult,
  type BackendRunRequest,
} from '../repl/backend-runner.js';
import type { BackendTurnEvent } from '../backends/stream.js';
import type { TurnMedia } from '../backends/types.js';
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
import { createTurnSignal, turnGateDecision } from '../repl/turn-signal.js';
import { createPollGate } from '../repl/poll-gate.js';
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
import { ensureInkToolAllowed } from '../repl/tool-gate.js';
import { executeToolCalls, type ToolCallResult } from '../repl/tool-call-executor.js';
import { resolveCredentialRefs, loadKeychainCredentials } from '../repl/credential-resolver.js';
import {
  createSignalSink,
  isClientLocalTool,
  handleClientLocalTool,
  formatContextStamp,
  type ContextOccupancy,
  type ProviderContextMeasurement,
  type SignalSink,
} from '../repl/context-tools.js';
import { SbHookRegistry } from '../repl/hook-registry.js';
import { registerBuiltinHooks } from '../repl/builtin-hooks.js';
import {
  applyLaunchProfile,
  applyProfile,
  formatProfileList,
  isValidProfileId,
} from '../repl/tool-profiles.js';
import { isPiTool, createPiTools, tryReadDocument } from '../repl/pi-tools.js';
import {
  bareToolName,
  createLocalToolDispatcher,
  impossibleCallRefusal,
} from '@inklabs/shared/runtime';
import { createToolParametersLookup } from '../repl/tool-parameter-help.js';
import { imagesToDeliver, type ContextImage, type ImageDelivery } from '../repl/tool-images.js';
import {
  buildLocalToolInstruction,
  buildBackendToolPassthrough,
  createSessionTools,
} from '@inklabs/shared/runtime';
import { ApprovalRequestManager } from '../repl/approval-request.js';
import { requestToolApproval } from '../repl/approval-api.js';
import {
  type ApprovalChannel,
  type ApprovalOriginInfo,
  type ApprovalResponseDecision,
  JsonlApprovalChannel,
  AutoApprovalChannel,
} from '../repl/approval-channel.js';
import {
  ApprovalCoordinator,
  concurrencyForAdapter,
  type ApprovalTicket,
} from '../repl/approval-coordinator.js';
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
  MAX_TOOL_CALLS_PER_ITERATION,
  runAgentLoop,
  runHeadlessSession,
  type SessionTurnInput,
  type AgentLoopResult,
  type BackendTurnOutcome,
  type LocalToolCall,
  type ToolResultRecord,
  MAX_RELAY_BYTES,
} from '@inklabs/shared/runtime';
// Re-exported for callers (and tests) that have always imported these from
// chat.js. The implementations live in @inklabs/shared/runtime so the turn
// primitive can be reused outside the REPL — see
// ink://specs/ink-runtime-shadow-clones.
export {
  extractLocalToolCalls,
  isTerminalSignalToolResult,
  stripLocalToolBlocks,
} from '@inklabs/shared/runtime';
import {
  classifyError,
  createThreadDrainState,
  decodeDelegationToken,
  drainThreads,
  encodeContextToken,
  mintDelegationToken,
  RUN_TURN_EPOCH_ENV,
  TURN_REPLY_TOKEN_ENV,
  verifyDelegationToken,
  type DelegationTokenPayload,
} from '@inklabs/shared';

type ChatOptions = {
  agent?: string;
  backend?: string;
  model?: string;
  effort?: string;
  systemPromptFile?: string;
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
  /** A profile the chat must run under; a CLI without this option refuses it as unknown. */
  requireProfile?: string;
  /**
   * False under `--no-provider-tools`: the provider gets no tools of its own
   * on any spawn (backend-runner.ts). A CLI without the option refuses it as
   * unknown.
   */
  providerTools?: boolean;
  message?: string;
  messageLabel?: string;
  attachFile?: string[];
  nonInteractive?: boolean;
  requireBootstrap?: boolean;
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
  sessionCandidates?: boolean;
  sessionCandidatesJson?: boolean;
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

/**
 * Read --system-prompt-file, or exit with a clear reason.
 *
 * Fails loudly rather than falling back to the default identity prompt: the
 * caller asked for a specific system prompt, and silently substituting a
 * different one is how a nascent SB ends up being told it is someone it isn't.
 */
function readSystemPromptFile(path?: string): string | undefined {
  if (!path) return undefined;

  let content: string;
  try {
    content = readFileSync(path, 'utf-8');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(chalk.red(`--system-prompt-file: cannot read ${path}`));
    console.error(chalk.dim(`  ${reason}`));
    process.exit(1);
  }

  if (!content.trim()) {
    console.error(chalk.red(`--system-prompt-file: ${path} is empty`));
    process.exit(1);
  }

  return content;
}

interface ChatRuntime {
  backend: string;
  model?: string;
  /** Reasoning effort for every backend spawn (claude: low | medium | high | xhigh | max). */
  effort?: string;
  /**
   * Replaces the generated identity prompt for every backend turn in this
   * session. Set by --system-prompt-file; see BackendConfig.
   */
  systemPromptOverride?: string;
  /**
   * Model id the provider REPORTED for the live session (claude's
   * `system`/`init` stream event). Used to resolve the real context window
   * when no explicit --model / /model override is set; reset on /backend.
   */
  detectedModel?: string;
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
  /** This session's event log; its path is the ledger location in session_meta. */
  log: SessionLog;
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
  sbSlug?: string;
  studioId?: string;
  studioName?: string;
  status?: string;
  lifecycle?: string;
  currentPhase?: string;
  threadKey?: string;
  startedAt?: string;
  endedAt?: string;
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
  sbSlug?: string;
  sessionId?: string;
  createdAt?: string;
  /** Originating platform for message activities (telegram, discord, …) */
  platform?: string;
  /** Sender from the inkmail lifecycle payload — tells own sends from inbound mechanics. */
  fromSlug?: string;
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

const CTRL_C_EXIT_WINDOW_MS = 3000;
// Working context budget + per-model window resolution live in ../repl/
// context-limits.js (imported above as defaultContextBudget /
// resolveBackendTokenWindow). ink derives its budget from the model's REAL
// window so it always compacts before the provider would — that module owns the
// conservative per-model table and the provider-headroom math.

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

/** CLI storage adapter. The server can load events asynchronously and use the same replay. */
export function hydrateLedgerFromTranscript(
  ledger: ContextLedger,
  transcriptPath: string,
  sbSlug?: string
): ReturnType<typeof hydrateLedgerFromEvents> {
  return hydrateLedgerFromEvents(ledger, readTranscriptEvents(transcriptPath), sbSlug);
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
        from: msg.senderSlug ? String(msg.senderSlug) : msg.from ? String(msg.from) : undefined,
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
        sbSlug: typeof row.sbSlug === 'string' ? row.sbSlug : undefined,
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
        lifecycle: typeof row.lifecycle === 'string' ? row.lifecycle : undefined,
        endedAt:
          typeof row.endedAt === 'string'
            ? row.endedAt
            : typeof row.ended_at === 'string'
              ? row.ended_at
              : undefined,
      };
    })
    .filter((session): session is SessionSummary => Boolean(session));
}

/**
 * Whether a session is worth offering in an attach/picker flow.
 *
 * A crashed backend (lifecycle 'failed') is prime attach material — that
 * session is exactly the one its agent keeps resuming after an outage — so
 * callers ask the server for `status: 'attachable'` rather than 'active'
 * ('active' groups 'failed' with the terminal lifecycles, which is right for
 * trigger routing and wrong here). The server filter runs before the row
 * limit; this predicate is the client-side backstop for the agent-declared
 * terminal markers the DB filter does not read, and mirrors
 * isSessionResumable in claude.ts so the two pickers agree.
 */
export function isAttachableSessionSummary(session: SessionSummary): boolean {
  if (session.endedAt) return false;
  if (session.lifecycle === 'completed') return false;

  // The agent-set work phase is deliberately not read. `complete` there
  // means a piece of work finished on a live conversation, and reading it as
  // the conversation's end hid the row, made its transcript look untracked,
  // and had the launcher start a second Inkwell session for the same
  // conversation on every relaunch (2026-10-01). Mirrors isSessionResumable
  // in claude.ts and the server's `active`/`attachable` filters.
  const status = (session.status || '').trim().toLowerCase();
  if (status === 'completed' || status.startsWith('completed:')) return false;

  return true;
}

/**
 * Does picking this row require an explicit server-side reopen?
 *
 * Exactly the rows the picker shows as history — the ones
 * {@link isAttachableSessionSummary} rejects. Defined as the negation rather
 * than as its own list of terminal markers, because two lists of "what counts
 * as finished" would drift, and the drift would be silent: a row shown as
 * history but not reopened resumes into a session the server still considers
 * over, which is the exact defect this repairs.
 */
export function sessionNeedsReopen(session: SessionSummary): boolean {
  return !isAttachableSessionSummary(session);
}

export interface ReopenOutcome {
  ok: boolean;
  reason?: string;
}

/**
 * Decide whether a reopen actually took, from the row the server sent back.
 *
 * Pure so the decision can be tested without a server, and separate from the
 * call so the thing being judged is the POST-STATE rather than the response
 * envelope. `success: true` proves only that the request was accepted — a
 * server that has never heard of `reopen` strips the unknown field, updates
 * nothing, and answers exactly that way. The only evidence that counts is a
 * row which now reads attachable.
 */
export function reopenSucceeded(session: SessionSummary | null | undefined): ReopenOutcome {
  if (!session) return { ok: false, reason: 'the server returned no session' };

  // Absence is not evidence (Lumen, r2). isAttachableSessionSummary answers
  // "does this row carry a terminal marker", which is the right question for a
  // LISTING, where every field is present. Here the question is "did the reopen
  // actually happen", and a server too old to know the field answers by
  // omitting it: an undefined endedAt reads as cleared and an absent status
  // reads as non-terminal, so the predicate returns attachable for a row
  // nothing touched. The response has to STATE the post-state before it can be
  // believed — a current server always sends both, null when cleared.
  const unreported = (['endedAt', 'status'] as const).filter((field) => !(field in session));
  if (unreported.length > 0) {
    return {
      ok: false,
      reason: `the server did not report ${unreported.join(' or ')} (an older server may not support reopen)`,
    };
  }

  if (!isAttachableSessionSummary(session)) {
    // Name the marker still set — "it did not work" sends the reader hunting,
    // and the usual cause is a server predating the reopen field.
    const stuck = session.endedAt
      ? 'ended_at is still set'
      : session.lifecycle === 'completed'
        ? "lifecycle is still 'completed'"
        : `status still reads ${session.status}`;
    return { ok: false, reason: `${stuck} (an older server may not support reopen)` };
  }
  return { ok: true };
}

/**
 * Ask the server to reopen a finished session, and verify it did.
 */
export async function reopenSelectedSession(
  inkClient: { callTool: (tool: string, args: Record<string, unknown>) => Promise<unknown> },
  sbSlug: string,
  sessionId: string
): Promise<ReopenOutcome> {
  let raw: unknown;
  try {
    raw = await inkClient.callTool('update_session_state', {
      sbSlug,
      sessionId,
      reopen: true,
      // Idle, not running: they are back at the prompt, and the on-prompt hook
      // marks running when they actually type.
      lifecycle: 'idle',
    });
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }

  const payload = raw as { success?: boolean; error?: string; session?: SessionSummary } | null;
  if (payload?.success === false) {
    return { ok: false, reason: payload.error || 'the server rejected the reopen' };
  }
  return reopenSucceeded(payload?.session);
}

/**
 * Union of the attachable list and full history for the interactive picker.
 *
 * Sessions are chat history — always resumable unless deleted — so the
 * picker shows finished ones too. The two lists stay separate fetches so a
 * flood of completed rows can never push a live session past the history
 * call's row limit (the limit-before-filter defect from PR #532 r2):
 * attachable rows are guaranteed a seat first, history fills in around them.
 * Auto-attach paths keep using the attachable list alone — a non-interactive
 * launch should never silently resume a finished session.
 */
export function mergeSessionsWithHistory(
  attachable: SessionSummary[],
  history: SessionSummary[]
): SessionSummary[] {
  const seen = new Set(attachable.map((session) => session.id));
  return [...attachable, ...history.filter((session) => !seen.has(session.id))];
}

/**
 * List the sessions this agent could attach to.
 *
 * Asks for `status: 'attachable'` so the server excludes finished sessions
 * *before* applying the row limit. A server that predates that enum value
 * rejects the call outright, which would empty the picker — the very bug
 * this filter exists to fix — so an unrecognised-status failure retries
 * unfiltered and leans on {@link isAttachableSessionSummary}. That fallback
 * restores the pre-server-filter behaviour rather than the pre-fix one: the
 * rows are still correct, only the limit-before-filter edge returns.
 *
 * Any other failure (auth, network) is a real failure and returns null, so
 * callers can tell "no sessions" from "could not ask".
 */
export async function listAttachableSessions(
  inkClient: Pick<InkClient, 'callTool'>,
  params: Record<string, unknown>
): Promise<Record<string, unknown> | null> {
  try {
    return (await inkClient.callTool('list_sessions', {
      ...params,
      status: 'attachable',
    })) as Record<string, unknown>;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Zod rejects an out-of-enum value by name; match loosely so a wording
    // change degrades to the fallback rather than to an empty picker.
    const looksLikeUnknownStatus =
      message.includes('attachable') ||
      message.toLowerCase().includes('invalid enum') ||
      message.toLowerCase().includes('invalid_enum_value');
    if (!looksLikeUnknownStatus) return null;
    sbDebugLog('chat', 'list_sessions_attachable_unsupported', { message });
    try {
      return (await inkClient.callTool('list_sessions', params)) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
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
        sbSlug:
          typeof row.sbSlug === 'string'
            ? row.sbSlug
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
        fromSlug: (() => {
          const payload = row.payload as Record<string, unknown> | undefined;
          return payload && typeof payload.fromSlug === 'string' ? payload.fromSlug : undefined;
        })(),
      };
    })
    .filter((activity): activity is ActivitySummary => Boolean(activity));
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
  /** Model serving the session (pinned or stream-detected), when known. */
  model?: string;
  bootstrapTokens?: number;
}): string {
  const transcriptTokens = params.ledger.totalTokens();
  const bootstrapTokens = params.bootstrapTokens || 0;
  const total = transcriptTokens + bootstrapTokens;
  const pct = params.maxContextTokens > 0 ? (total / params.maxContextTokens) * 100 : 0;
  const queue = params.pendingTurns > 0 ? `queue:${params.pendingTurns}` : 'idle';
  // Compact — this shares the bottom bar with cwd/branch. transcript+identity
  // breakdown stays visible in k-notation; full numbers live in Ctrl+O.
  const breakdown =
    bootstrapTokens > 0
      ? `${compactTokens(transcriptTokens)}+${compactTokens(bootstrapTokens)}`
      : compactTokens(total);
  // The model serving the session (pinned or stream-detected), shortened by
  // dropping the redundant backend prefix: claude:fable-5, not
  // claude:claude-fable-5. Backend alone until the first init event reports.
  const model = (params.model ?? '').trim();
  const provider = model
    ? `${params.backend}:${model.startsWith(`${params.backend}-`) ? model.slice(params.backend.length + 1) : model}`
    : params.backend;
  return `${breakdown}/${compactTokens(params.maxContextTokens)} (${pct.toFixed(1)}%)  ·  ${queue}  ·  ${provider}`;
}

/** 12_735 → '12.7k', 850_000 → '850k', 1_000_000 → '1M' — bar-sized numbers. */
function compactTokens(value: number): string {
  if (value >= 1_000_000) {
    const m = value / 1_000_000;
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
  }
  if (value >= 1_000) {
    const k = value / 1_000;
    return `${k >= 100 || Number.isInteger(k) ? Math.round(k) : k.toFixed(1)}k`;
  }
  return String(value);
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
  session: Pick<SessionSummary, 'sbSlug'>,
  meta: SessionTranscriptMetadata | null
): string | null {
  if (!meta?.lastMessagePreview) return null;
  const speaker =
    meta.lastMessageRole === 'assistant'
      ? session.sbSlug || 'assistant'
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
    const agent = (session.sbSlug || '-').slice(0, 6).padEnd(6);
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
  sbSlug: string,
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
          sbSlug,
        },
        target: {
          sessionId: session.id,
          threadKey: session.threadKey,
          studioId: session.studioId,
          sbSlug: session.sbSlug,
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
  const haystack = `${session.id} ${session.sbSlug || ''} ${session.threadKey || ''} ${
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

async function promptForToolApproval(
  rl: ReturnType<typeof createInterface> | null,
  toolPolicy: ToolPolicyState,
  sessionId: string | undefined,
  tool: string,
  reason: string,
  inkRepl?: InkRepl | null,
  approvalChannel?: ApprovalChannel,
  args?: Record<string, unknown>,
  ctx?: {
    origin?: ApprovalOriginInfo;
    signal?: AbortSignal;
    /** How many other approvals are waiting behind this one. */
    queuedNow?: () => number;
  }
): Promise<boolean> {
  let choice: import('../repl/tool-approval.js').ToolApprovalChoice;

  const argsDisplay = args ? sanitizeArgsForApproval(tool, args) : '';
  // A clone's request must say whose it is — otherwise the user is approving
  // `read` with no idea which of three concurrent clones asked.
  const originTag =
    ctx?.origin?.origin === 'clone'
      ? ` · 🌀 ${ctx.origin.cloneLabel || ctx.origin.cloneId || 'clone'}`
      : '';
  const waiting = ctx?.queuedNow?.() ?? 0;
  const waitingTag = waiting > 0 ? ` · ${waiting} more waiting` : '';

  if (approvalChannel) {
    // JSONL or auto channel — structured approval protocol
    const response = await approvalChannel.requestApproval({
      tool,
      args: args ?? {},
      reason,
      sessionId,
      signal: ctx?.signal,
      origin: ctx?.origin,
    });
    // Map channel response decision to tool approval choice
    choice = response.decision as import('../repl/tool-approval.js').ToolApprovalChoice;
  } else if (inkRepl) {
    // Render a visually distinct permission prompt in Ink
    const lines = [`🔐 ${tool}${originTag}${waitingTag}`];
    if (argsDisplay) lines.push(argsDisplay);
    lines.push(reason, '', '[y] once · [s] session · [a] always · [d] deny · [n] cancel');
    inkRepl.addMessage('system', lines.join('\n'), { label: '🔐 permission' });
    // priority: the REPL loop is already waiting for the next command by now,
    // so this has to take the line rather than queue behind it.
    const answer = (await inkRepl.waitForInput({ signal: ctx?.signal, priority: true })).trim();
    choice = parseToolApprovalInput(answer);
  } else if (rl) {
    const detail = argsDisplay ? ` (${argsDisplay})` : '';
    console.log(chalk.yellow(`🔐 ${tool}${detail}${originTag}${waitingTag} — ${reason}`));
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
  // A clone's policy is ephemeral, so "session"/"always" answered for a clone
  // binds that clone and dies with it. Saying so beats letting the user believe
  // they have made a durable choice they have not.
  const cloneScopeNote =
    ctx?.origin?.origin === 'clone' && (choice === 'session' || choice === 'always')
      ? ' (this clone only — clones cannot change your saved policy)'
      : '';
  if (result.message) {
    result.message += cloneScopeNote;
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

/**
 * How to call tools in local routing mode.
 *
 * Two audiences, because a shadow clone's tool surface is genuinely smaller and
 * telling it otherwise would produce calls that only get refused. The clone
 * variant omits the write tools and `spawn_agent` — not as enforcement (the
 * executor refuses them regardless; a text-protocol model can name any tool)
 * but so the clone spends its turns on work it can actually do.
 *
 * The three local blocks are RENDERED from `LOCAL_TOOL_CATALOG` rather than
 * written here, because this text and `describe_tool` are two answers to the
 * same question and they had already diverged: this said `bash` and
 * `signal_status` exist, discovery said they did not, and the agent believed
 * discovery. One source means the next tool added shows up in both or neither.
 */
export { buildLocalToolInstruction } from '@inklabs/shared/runtime';

/**
 * Format bootstrap result into a compact identity context string for prompt injection.
 * This is the primary mechanism for the backend to know who it is, who it's talking to,
 * and what it cares about.
 */
/**
 * Marker the server-side InkRunner matches on. Kept as a literal string on both
 * sides of the process boundary — there is no shared module between the CLI and
 * the runner, so this is the contract.
 */
export const BOOTSTRAP_REQUIRED_EXIT_MARKER = 'INK_BOOTSTRAP_REQUIRED_FAILURE';

/**
 * Under `--require-bootstrap`, refuse to answer rather than answer as a
 * stranger.
 *
 * A server-spawned run gets no constitution in its prompt — the runner omits it
 * precisely because this process loads its own. If that load fails and we
 * continue anyway, the agent replies to a real person with no soul, no values,
 * no user document and no memory, and the runner sees a successful turn it
 * cannot correct. For a messaging bridge a visible failed turn is far better
 * than a confident reply from someone who is not Myra.
 *
 * Interactive runs never pass the flag and keep the old warn-and-continue
 * behaviour, which is right for a human who can see the warning.
 */
export function failIfBootstrapRequired(
  options: Pick<ChatOptions, 'requireBootstrap'>,
  reason: string
): never | void {
  if (!options.requireBootstrap) return;
  console.error(chalk.red(`${BOOTSTRAP_REQUIRED_EXIT_MARKER}: ${reason}`));
  process.exit(78); // EX_CONFIG — the environment is wrong, not the request
}

/** Recovered provider-native session marker (see findLastBackendSession). */
/** CLI storage adapters for the host-independent provider-continuity policy. */
export function findLastBackendSession(
  transcriptPath: string
): RecoveredBackendSession | undefined {
  return findLastBackendSessionInEvents(readTranscriptEvents(transcriptPath));
}

export function findLastDetectedModel(transcriptPath: string, backend: string): string | undefined {
  return findLastDetectedModelInEvents(readTranscriptEvents(transcriptPath), backend);
}

/**
 * Apply a /model selection change (set OR clear). The previous model's
 * detection is void the moment the selection changes — what actually serves
 * the next turn is unknown until its init event reports it — so detection is
 * invalidated BOTH in memory and in the transcript (a `model_detection_reset`
 * entry, so a process reattaching before the next init cannot recover stale
 * authority). The window/budget recompute from the explicit model alone puts
 * the session back in the conservative state, where the pre-detection
 * compaction deferral protects large histories until the truth arrives
 * (Lumen, PR #477 round 2 — finding 2).
 */
export { applyModelSelection, applyDetectedModel } from '@inklabs/shared/providers';

const utf8Bytes = (text: string): number => Buffer.byteLength(text, 'utf8');

/** What a stateless clone joins its history with; two ride along every new turn. */
export { CLONE_HISTORY_SEPARATOR } from '@inklabs/shared/node-host';

/**
 * Local tools after which a stateless provider's next fresh spawn may see a
 * DIFFERENT discovered context: a write or edit can change AGENTS.md, a shell
 * can change anything. The previous report's prompt count then no longer
 * describes the next envelope, so the stateless count is dropped to unknown
 * (the floor) until the next report (Lumen, PR #576 round 12).
 */
export const CONTEXT_MUTATING_TOOLS: ReadonlySet<string> = new Set(CONTEXT_MUTATING_TOOL_NAMES);

/** CLI compatibility: instruction discovery stays at the host boundary. */
export function buildPromptEnvelope(
  sbSlug: string,
  runtime: ChatRuntime,
  ledger: ContextLedger,
  userMessage: string,
  contextStamp?: string
): string {
  return buildSessionPrompt(
    sbSlug,
    runtime,
    ledger,
    userMessage,
    buildLocalToolInstruction({ audience: 'parent' }),
    contextStamp
  );
}

/**
 * The studio checklist before the chat runtime reads its scope (task
 * 2841c7a9, Lumen's PR #699 rounds 1 and 2). `-b ink`, `ink chat` and
 * `ink alpha` all come through runChat, and none of them pass the backend
 * wrappers that run the launch completion, so a partial linked worktree
 * launched here started with no identity file and a session scoped to
 * "main". The identity is read only AFTER the completion has had its
 * chance to write it, and it is read where the completion writes it: the
 * worktree ROOT. A launch from `<studio>/packages/api` completes the root
 * and would otherwise read a `.ink/identity.json` that never exists beside
 * the package (round 2). Outside a repository the cwd is the root. Exported
 * so the ordering is testable without a live chat.
 */
export async function prepareChatStudio(
  cwd: string,
  sbSlug: string,
  deps: LaunchStudioDeps = {}
): Promise<{ identity: ReturnType<typeof readIdentityJson> }> {
  const placement = (deps.placement ?? detectWorktree)(cwd);
  await completeStudioAtLaunch(cwd, sbSlug, { ...deps, placement: () => placement });
  return { identity: readIdentityJson(placement.toplevel ?? cwd) };
}

export async function runChat(options: ChatOptions): Promise<void> {
  let disposeTools: (() => Promise<void>) | undefined;
  try {
    await runChatSession(options, (dispose) => {
      disposeTools = dispose;
    });
  } finally {
    // Session-owned files must also retire on a setup/input failure, not only
    // the ordinary /quit and headless-return paths.
    await disposeTools?.();
  }
}

async function runChatSession(
  options: ChatOptions,
  setToolDisposer: (dispose: () => Promise<void>) => void
): Promise<void> {
  // Read once and removed before anything is spawned: the token is how the
  // server tells this process's turn_reply lines from anything else on its
  // stdout, so no tool or provider child may inherit it (turn-reply.ts).
  const turnReplyToken = process.env[TURN_REPLY_TOKEN_ENV] || undefined;
  delete process.env[TURN_REPLY_TOKEN_ENV];
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

  const listingSessionCandidates = Boolean(
    options.sessionCandidates || options.sessionCandidatesJson
  );
  // --session-candidates-json must put nothing but JSON on stdout, and the
  // path to the payload prints diagnostics that are not ours to silence
  // (sender-resolution failures, profile notices, anything a callee logs).
  if (options.sessionCandidatesJson) {
    divertConsoleLogToStderr();
  }

  const resolvedSlug = resolveSlug(options.agent);
  if (!resolvedSlug) {
    throw new Error('Could not resolve agent identity. Run `ink init` or pass `--agent <id>`.');
  }
  const sbSlug: string = resolvedSlug;
  const { identity } = await prepareChatStudio(process.cwd(), sbSlug);
  // x-ink-context on every ink-routed tool call: the server validates the
  // named session against the authenticated user and enriches request
  // identity from the session row (workspace scope for writes, session
  // attribution, trigger context). sessionId/studioId are read through live
  // refs — both can change after client construction (session start,
  // cross-studio attach) and a stale header would suppress server-side
  // correction. cliAttached is false for ANY one-shot mode: --message runs
  // headless even without --non-interactive, and persisting cliAttached=true
  // from such a run would wrongly suppress concurrent trigger spawns. Every
  // backend spawn carries the same value: its hooks write it onto this
  // session through the INK_SESSION_ID the child inherits.
  const cliAttached = !options.nonInteractive && !options.message;
  let currentInkSessionId: () => string | undefined = () => undefined;
  let currentInkStudioId: () => string | undefined = () => identity?.studioId;
  const inkClient = new InkClient(undefined, undefined, {
    getContextToken: () =>
      encodeContextToken({
        sessionId: currentInkSessionId() || '',
        studioId: currentInkStudioId() || 'main',
        sbSlug,
        cliAttached,
        runtime: 'ink',
      }),
  });
  // One lookup of each Inkwell tool's parameters per process, shared by every
  // dispatcher this run builds (tool-parameter-help.ts): a validation error
  // then names the real parameters, and a success notes an ignored key.
  const inkToolParameters = createToolParametersLookup((tool) =>
    inkClient.callTool('describe_tool', { name: tool })
  );
  let autoAttachedLatest = false;
  let contextBudgetAuto = !options.maxContextTokens;
  const initialBackend = options.backend || 'claude';
  const initialBackendTokenWindow = resolveBackendTokenWindow(initialBackend, options.model);
  const configuredMaxContextTokens = Number.parseInt(
    options.maxContextTokens ||
      String(defaultContextBudget(initialBackendTokenWindow, promptTransportFor(initialBackend))),
    10
  );
  const parsedBackendTimeoutSeconds =
    options.backendTimeoutSeconds !== undefined
      ? Number.parseInt(options.backendTimeoutSeconds, 10)
      : Number.NaN;
  // Hard ceiling: an explicit --backend-timeout-seconds override, else undefined
  // (→ no ceiling at all; the 4-hour backstop went on 2026-10-04). The old blunt 120s
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
    effort: options.effort,
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
      ? defaultContextBudget(initialBackendTokenWindow, promptTransportFor(initialBackend))
      : configuredMaxContextTokens,
    pollSeconds: Number.parseInt(options.pollSeconds || '20', 10),
    showSessionsWatch: false,
    eventPolling: true,
    autoRunInbox: options.autoRun ?? false,
    awayMode: options.away ?? false,
    // Replaced once the session is known (below); nothing appends before then.
    log: new SessionLog({ path: ensureRuntimeTranscriptPath() }),
    systemPromptOverride: readSystemPromptFile(options.systemPromptFile),
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
  // From here, ink-routed tool calls carry the live session and studio ids
  // in their x-ink-context header (see InkClient construction above).
  currentInkSessionId = () => runtime.sessionId;
  currentInkStudioId = () => runtime.studioId || identity?.studioId;
  // What every provider spawn of this chat serves: this chat's directory, its
  // session, and this process as its host, which hands over its own session
  // credentials (backend-runner.ts, backends/cli-host.ts). Read at spawn
  // time, because the session and studio can change after startup. The root
  // checkout's 'main' is a sentinel, not a studio id, so it names no studio
  // here, as in hooks.ts and turn-signal.ts.
  const providerHost = createCliBackendHost();
  const providerSpawnContext = (): Pick<
    BackendRunRequest,
    'workingDirectory' | 'inkSessionId' | 'studioId' | 'host'
  > => ({
    workingDirectory: process.cwd(),
    inkSessionId: runtime.sessionId,
    studioId: runtime.studioId && runtime.studioId !== 'main' ? runtime.studioId : undefined,
    host: providerHost,
  });
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
      const { getInkServerUrl } = await import('../lib/ink-mcp.js');
      const { getValidAccessToken } = await import('../auth/tokens.js');
      const serverUrl = getInkServerUrl().replace(/\/+$/, '');
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

  // Listing session candidates never reaches the model provider — it only
  // asks the Inkwell server what is attachable. Running provider-auth
  // diagnostics first would print warnings (or prompt) for a backend the
  // command is not going to use.
  if (!listingSessionCandidates) {
    await ensureBackendAuthReady(runtime.backend, {
      nonInteractive: Boolean(options.nonInteractive),
      hasMessage: Boolean(options.message?.trim()),
      verbose: runtime.verbose,
    });
  }
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
    sbSlug,
    studioId: runtime.studioId,
  });
  if (runtime.studioId) {
    toolPolicy.setMutationScope('studio');
  } else {
    toolPolicy.setMutationScope('agent');
  }
  runtime.toolMode = toolPolicy.getMode();

  // Apply --profile flag if provided. A profile that can't be applied stops
  // the chat: carrying on would run with whatever the policy file holds, and
  // a server spawn names a profile precisely to bound its turn (task
  // 0321ccf1). A typo at the terminal costs a rerun.
  //
  // --require-profile is the same, for a launcher that must not run without
  // it: a CLI built before the option existed refuses it as unknown (exit 1)
  // before anything runs, where it would have taken --profile <new name> with
  // a warning and carried on unbounded (Lumen, #773).
  if (options.requireProfile && options.profile && options.requireProfile !== options.profile) {
    console.error(
      chalk.red(
        `Conflicting profiles: --require-profile ${options.requireProfile} and --profile ${options.profile}`
      )
    );
    process.exit(78); // EX_CONFIG
  }
  const launchProfileName = options.requireProfile ?? options.profile;
  let profileWithholdsProviderTools = false;
  if (launchProfileName) {
    const launchProfile = applyLaunchProfile(toolPolicy, launchProfileName);
    if (!launchProfile.ok) {
      console.error(chalk.red(launchProfile.message));
      process.exit(78); // EX_CONFIG
    }
    runtime.toolMode = toolPolicy.getMode();
    profileWithholdsProviderTools = launchProfile.withholdProviderTools;
    console.log(chalk.green(launchProfile.message));
  }

  // No provider tools (task 0321ccf1): --no-provider-tools, or a profile that
  // implies it. Latched before any turn can spawn, for the life of this
  // process; startBackendTurn applies it to every spawn. It needs ink-owned
  // routing on Claude, the one backend that can withhold every native tool,
  // and the chat refuses to start without both rather than run unbounded.
  if (options.providerTools === false || profileWithholdsProviderTools) {
    if (runtime.toolRouting !== 'local' || runtime.backend !== 'claude') {
      console.error(
        chalk.red(
          `No provider tools needs --tool-routing local on the claude backend (got ${runtime.toolRouting} on ${runtime.backend})`
        )
      );
      process.exit(78); // EX_CONFIG
    }
    withholdProviderToolsForThisProcess();
  }

  // --session-candidates / --session-candidates-json: list what the session
  // picker would offer and exit. Handled before any identity/bootstrap output
  // so the JSON stays machine-parseable, and before the TUI so a TTY-less
  // invocation exits instead of blocking on stdin forever.
  if (options.sessionCandidates || options.sessionCandidatesJson) {
    const [sessionsResult, historyResult] = await Promise.all([
      listAttachableSessions(inkClient, {
        sbSlug,
        backend: 'ink',
        limit: 50,
      }),
      inkClient
        .callTool('list_sessions', { sbSlug, backend: 'ink', limit: 50 })
        .catch(() => null) as Promise<Record<string, unknown> | null>,
    ]);
    const attachable = extractSessionSummaries(sessionsResult).filter(isAttachableSessionSummary);
    const sessions = filterSessionsByPolicy(
      mergeSessionsWithHistory(attachable, extractSessionSummaries(historyResult)),
      runtime,
      sbSlug,
      toolPolicy,
      'attach'
    );
    const candidates = sessions.map((session) => ({
      type: 'ink' as const,
      id: session.id,
      sbSlug: session.sbSlug || null,
      backend: session.backend || 'ink',
      phase: session.currentPhase || session.status || null,
      lifecycle: session.lifecycle || null,
      threadKey: session.threadKey || null,
      studioName: session.studioName || null,
      startedAt: session.startedAt || null,
      attachable: isAttachableSessionSummary(session),
    }));
    if (options.sessionCandidatesJson) {
      restoreConsoleLog();
      console.log(
        JSON.stringify(
          {
            backend: 'ink',
            sbSlug,
            inkAvailable: sessionsResult !== null,
            counts: { ink: candidates.length },
            candidates: [{ type: 'new' as const }, ...candidates],
          },
          null,
          2
        )
      );
    } else {
      console.log(chalk.bold(`\nInk session candidates for ${sbSlug}:`));
      console.log(chalk.dim('  new — start a new session'));
      for (const candidate of candidates) {
        const bits = [
          candidate.id.slice(0, 8),
          candidate.sbSlug || '-',
          candidate.phase || '-',
          candidate.threadKey || '-',
          candidate.studioName || '-',
        ];
        console.log(`  ${bits.join('  ·  ')}`);
      }
      if (candidates.length === 0) {
        console.log(chalk.dim('  (no ink sessions)'));
      }
    }
    return;
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

  /**
   * Away-mode approval: create a request on the Inkwell server, which notifies the
   * user's connected platforms (Telegram, etc.) and intercepts their reply. The
   * server owns routing; we create and poll.
   */
  const askFor2faApproval = async (
    ticket: ApprovalTicket<ToolPolicyState>,
    target: ToolPolicyState
  ): Promise<boolean> => {
    const { tool, reason, args } = ticket;
    const who =
      ticket.origin.origin === 'clone' ? ` (🌀 ${ticket.origin.cloneLabel || 'clone'})` : '';
    printLine(chalk.yellow(`⏳ Requesting 2FA approval for ${tool}${who}…`));
    // Sanitize args for the notification — show command/path but redact large content
    const sanitizedArgs = args ? sanitizeArgsForApproval(tool, args) : undefined;
    try {
      const result = await requestToolApproval({
        tool,
        args: sanitizedArgs,
        reason,
        sessionId: runtime.sessionId,
        studioId: runtime.studioId,
        signal: ticket.signal,
        origin: ticket.origin,
        onCreated: (id) => {
          printLine(chalk.yellow(`   Request ${id.slice(0, 8)}… sent to connected platforms`));
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
            grantScope === 'studio' ? target.getContext()?.studioId : target.getContext()?.sbSlug;
          if (scopeId) {
            target.persistentGrant(tool, { scope: grantScope, id: scopeId });
            printLine(
              chalk.green(`✅ 2FA: ${tool} permanently approved (${grantScope}: ${scopeId})`)
            );
          } else {
            // Can't resolve scope — fall back to session grant instead of leaking to global
            if (runtime.sessionId) {
              target.grantToolForSession(runtime.sessionId, tool);
            }
            printLine(
              chalk.yellow(
                `⚠️ 2FA: ${tool} approved for session only (could not resolve ${grantScope} scope)`
              )
            );
          }
        } else if (result.action === 'grant-session') {
          if (runtime.sessionId) {
            target.grantToolForSession(runtime.sessionId, tool);
          }
          printLine(chalk.green(`✅ 2FA: ${tool} approved for this session`));
        } else {
          printLine(chalk.green(`✅ 2FA approval granted for ${tool}`));
        }
        return true;
      } else if (result.status === 'aborted') {
        printLine(chalk.dim(`↩ 2FA approval for ${tool} cancelled`));
        return false;
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
  };

  /**
   * Ask the user about one tool call. Two very different waits hide behind this:
   * the local prompt (Ink / readline / JSONL) and the away-mode 2FA round-trip
   * through the Inkwell server. The coordinator below decides *when* this runs; this
   * function only decides *how* to ask.
   */
  const askForToolApproval = async (
    ticket: ApprovalTicket<ToolPolicyState>,
    promptCtx: { queuedNow: () => number }
  ): Promise<boolean> => {
    // Apply the user's answer to the policy the request was made against. A
    // clone's grant belongs to the clone: landing it on the parent widens the
    // parent while leaving the requester still blocked at its own re-check.
    const target = ticket.policy ?? toolPolicy;
    if (!runtime.awayMode) {
      return promptForToolApproval(
        rl,
        target,
        runtime.sessionId,
        ticket.tool,
        ticket.reason,
        inkRepl,
        runtime.approvalChannel,
        ticket.args,
        { origin: ticket.origin, signal: ticket.signal, queuedNow: promptCtx.queuedNow }
      );
    }
    return askFor2faApproval(ticket, target);
  };

  /**
   * Approvals from the parent turn and from concurrent clones, gated to whatever
   * the active adapter can sustain.
   *
   * Interactive adapters own a single input slot — two overlapping prompts
   * orphan the first promise forever — so they serialize. JSONL and 2FA
   * correlate by request id and would only gain head-of-line blocking from a
   * queue, so they run free. Away mode can be toggled mid-session, hence the
   * function rather than a frozen number.
   */
  const approvalCoordinator = new ApprovalCoordinator<ToolPolicyState>({
    concurrency: () =>
      concurrencyForAdapter(
        runtime.awayMode || runtime.approvalChannel ? 'correlated' : 'interactive'
      ),
    prompt: askForToolApproval,
    // Re-check at the FRONT of the queue, not at enqueue time: while this ticket
    // waited, a sibling's "session"/"always" answer may already have settled the
    // same tool, and asking again is asking a question already answered. Must be
    // the non-consuming inspect — a query that spends a one-use grant would
    // charge the parent for a clone's call that has not happened yet.
    recheck: (ticket) => {
      const decision = (ticket.policy ?? toolPolicy).inspectInkTool(
        ticket.tool.replace(/^mcp__inkwell__/, ''),
        runtime.sessionId
      );
      if (decision.allowed) {
        // An allow resting on a one-use grant is NOT a free pass: leaving it to
        // the executor's own canCallInkTool keeps the grant accounting in one
        // place instead of spending it here.
        return decision.wouldConsumeGrant ? 'prompt' : 'allow';
      }
      return decision.promptable ? 'prompt' : 'deny';
    },
  });

  /**
   * Shadow clones spawned by this process, running or finished.
   *
   * Lives at runChat scope rather than turn scope because a backgrounded clone
   * outlives the turn that spawned it — the parent can answer the user, start
   * another turn, or switch sessions while its clones keep working.
   */
  const cloneRegistry = new CloneRegistry();

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

  // One session-owned stream composition for CLI and hosted execution. The
  // host only renders guarded lines, mirrors progress and applies model windows.
  const sessionStream = new SessionStream({
    toolRouting: () => runtime.toolRouting,
    append: (entry) => runtime.log.append(entry),
    render: (lines) => {
      if (!inkRepl) return; // readline retains the buffered final render
      for (const line of lines) {
        inkRepl.addMessage(
          'assistant',
          line.text,
          line.continuation ? { continuation: true } : { label: sbSlug }
        );
      }
    },
    toolStarted: (name) => printEvent(chalk.dim(`🛠 ${sbSlug} · ${name} …`)),
    progress: emitStreamEvent,
    modelReported: (model) => {
      if (model !== runtime.detectedModel && model !== runtime.model) {
        const { windowChanged } = applyDetectedModel(runtime, model, contextBudgetAuto);
        if (windowChanged) {
          printEvent(
            chalk.dim(
              `⚙ ${model} · window ${formatTokenCount(runtime.backendTokenWindow)} · budget ${formatTokenCount(runtime.maxContextTokens)} tok`
            )
          );
          emitStatusLaneIfChanged(true);
        }
      }
    },
  });
  const streamRenderer = sessionStream.renderer;
  const handleBackendEvent = (event: BackendTurnEvent): void => sessionStream.handle(event);
  const beginSpawn = (): void => sessionStream.beginSpawn();
  const endSpawn = (): void => sessionStream.endSpawn();
  const runUsage = new SessionUsage();
  const recordRunUsage = (usage: BackendTokenUsage | undefined): void => runUsage.record(usage);
  // Only a committed successful ordinary turn may become a reply.
  let lastTurnAssistantText: string | null = null;

  const ledger = new ContextLedger();
  const sessionSignal = createSignalSink();
  const hookRegistry = new SbHookRegistry();

  // Session-level tool call log — surfaced in the Ctrl+O context inspector
  const recentToolCalls: Array<{
    tool: string;
    status: string;
    at: string;
    args?: string;
    result?: string;
  }> = [];

  // Entries evicted from the window (hydration replay + live evictions) —
  // out of context but never out of sight; surfaced in the inspector
  const sessionEvictedEntries: EvictedEntryRecord[] = [];

  // Register built-in hooks (passive recall + budget monitor).
  // callRecall wraps inkClient.callTool('recall', ...) into the shape hooks expect.
  const { passiveRecall: passiveRecallHandle } = registerBuiltinHooks(hookRegistry, {
    callRecall: async (query, limit) => {
      try {
        const result = await inkClient.callTool('recall', {
          query,
          sbSlug,
          limit,
          recallMode: 'hybrid',
        });
        // InkClient.callTool() parses the JSON-RPC response and returns
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
  /**
   * The provider's own measurement of the last request, scoped to the native
   * session / model / envelope it measured (Lumen, PR #583 finding 4) and
   * taken where each spawn's result lands — before the loop runs that turn's
   * tools, so a list_context in the same turn already sees it (finding 1).
   */
  const sessionContext = new SessionContextState({
    runtime: () => runtime,
    append: (entry) => runtime.log.append(entry),
    rolled: (note) => printEvent(chalk.yellow(`  ⛁ provider session rolled — ${note}`)),
  });
  const providerContextMeasurement = (): ProviderContextMeasurement | undefined =>
    sessionContext.measurement();
  const sampleProviderContext = (usage: BackendTokenUsage | undefined): void =>
    sessionContext.sampleUsage(usage);

  let lastDelegation: DelegationState | undefined;
  let forceQuitAfterTurn = false;
  let readyForAutoRun = false;
  let enqueueAutoRunFromInbox: ((message: InboxMessage) => Promise<void>) | null = null;

  let sessionCredentials: Record<string, string> = {};

  // Shared bootstrap sequence: identity override, context/timezone, host
  // preparation, recall dedup and ledger marker. Only presentation and I/O
  // stay here; a server host supplies these same ports without a CLI process.
  await bootstrapSessionIdentity(
    { sbSlug, systemPromptOverride: runtime.systemPromptOverride },
    {
      load: async (slug) =>
        (await inkClient.callTool('bootstrap', { sbSlug: slug })) as Record<string, unknown>,
      ledger,
      setTimezone: (timezone) => {
        runtime.userTimezone = timezone;
        statusLane.setTimezone(timezone);
      },
      setContext: (context) => {
        runtime.bootstrapContext = context;
        console.log(
          chalk.dim(
            `Identity context loaded: ~${estimateTokens(context).toLocaleString()} tokens injected into prompt`
          )
        );
      },
      prepareHost: async () => {
        const keychainCreds = await loadKeychainCredentials();
        sessionCredentials = { ...keychainCreds };
        if (Object.keys(keychainCreds).length > 0) {
          console.log(
            chalk.dim(`Keychain: ${Object.keys(keychainCreds).length} credential(s) loaded`)
          );
        }
      },
      seedMemoryIds: (ids) => passiveRecallHandle.seedBootstrapIds(ids),
      unavailable: (reason) => {
        failIfBootstrapRequired(options, reason);
        if (reason.startsWith('bootstrap unavailable:')) console.log(chalk.yellow(reason));
      },
    }
  );

  let attachedSessionSummary: SessionSummary | undefined;

  if ((options.attach || options.attachLatest) && !runtime.sessionId) {
    const attachQuery = typeof options.attach === 'string' ? options.attach.trim() : undefined;
    const attachLatestQuery =
      typeof options.attachLatest === 'string' ? options.attachLatest.trim() : undefined;
    const query = attachLatestQuery || attachQuery;
    const listed = await listAttachableSessions(inkClient, { sbSlug, limit: 50 });
    const sessionsResult: Record<string, unknown> = listed ?? {
      error: 'could not fetch attachable sessions',
    };

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
        extractSessionSummaries(sessionsResult).filter(isAttachableSessionSummary),
        runtime,
        sbSlug,
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
        sbSlug,
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
    const [sessionsResult, historyResult] = await Promise.all([
      listAttachableSessions(inkClient, {
        sbSlug,
        backend: 'ink',
        limit: 50,
      }),
      inkClient
        .callTool('list_sessions', { sbSlug, backend: 'ink', limit: 50 })
        .catch(() => null) as Promise<Record<string, unknown> | null>,
    ]);
    const attachableSessions = extractSessionSummaries(sessionsResult).filter(
      isAttachableSessionSummary
    );
    const sessions = filterSessionsByPolicy(
      mergeSessionsWithHistory(attachableSessions, extractSessionSummaries(historyResult)),
      runtime,
      sbSlug,
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
          // A human just chose a FINISHED session out of their history, so it
          // is not finished any more. Sent here, at the selection, because the
          // selection is what caused it — the previous behaviour leaned on the
          // next incidental `update_session_state`, and that call sends
          // `status: 'active'`, which is and always was a server-side no-op.
          // The row stayed terminal with `ended_at` set while the chat
          // generated, invisible to attachable listing, active lookup and
          // findByThreadKey — so a trigger could open a SECOND session on the
          // thread the human was already typing into (Lumen, PR #541).
          //
          // Only the interactive picker reaches this. Auto-attach filters to
          // attachable rows before choosing, so it can never revive anything,
          // and the terminal fence automatic routing relies on stays intact.
          if (sessionNeedsReopen(selected)) {
            // FAIL CLOSED. The previous version swallowed everything with
            // `.catch(() => undefined)` and carried on, which is the failure
            // this PR exists to remove wearing a different coat: a reopen that
            // errors, or that lands on a server too old to know the flag and
            // returns a cheerful success without doing anything, would leave
            // the human typing into a session the server still considers over
            // — the exact silent resume-into-a-terminal-row we started from.
            //
            // So the RESULT is checked, not the absence of an exception, and
            // the post-state is checked rather than the acknowledgement: an old
            // server ignoring an unknown field still answers `success: true`.
            // Only a row that actually comes back attachable counts.
            const reopened = await reopenSelectedSession(inkClient, sbSlug, selected.id);
            if (!reopened.ok) {
              console.log(
                chalk.yellow(
                  `Could not reopen session ${selected.id.slice(0, 8)} — ${reopened.reason}`
                )
              );
              console.log(
                chalk.dim(
                  '  Not attaching: the server still lists it as finished, so a trigger could open a second session on this thread.'
                )
              );
              return;
            }
          }
          if (selected.studioId) {
            runtime.studioId = selected.studioId;
          }
          if (!runtime.threadKey && selected.threadKey) {
            runtime.threadKey = selected.threadKey;
          }
          toolPolicy.setContext({ sbSlug, studioId: runtime.studioId });
          const currentScope = toolPolicy.getMutationScope();
          if (currentScope.scope !== 'global') {
            toolPolicy.setMutationScope(currentScope.scope);
          }
          runtime.toolMode = toolPolicy.getMode();
        }
      }
      // picked === null means "New session" — fall through to create one
    } else {
      // Non-interactive or no sessions — auto-attach to latest. Filters back
      // to attachable: history rows are for the human picker; a headless
      // launch must not silently resume a finished session.
      const selected = pickLatestSession(sessions.filter(isAttachableSessionSummary), undefined, {
        studioId: runtime.studioId,
      });
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
        toolPolicy.setContext({ sbSlug, studioId: runtime.studioId });
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
      sbSlug,
      backend: 'ink',
      metadata: { provider: runtime.backend },
    };
    if (runtime.threadKey) startArgs.threadKey = runtime.threadKey;
    if (identity?.studioId) {
      startArgs.studioId = identity.studioId;
    }
    if (runtime.contactId) startArgs.contactId = runtime.contactId;

    const sessionStartResult = (await inkClient
      .callTool('start_session', startArgs)
      .catch((error) => ({ error: String(error) }))) as Record<string, unknown>;
    runtime.sessionId = extractSessionId(sessionStartResult);
  }

  if (attachedToExistingSession && runtime.sessionId && !attachedSessionSummary) {
    const sessionsResult = (await inkClient
      .callTool('list_sessions', { sbSlug, status: 'active', limit: 80 })
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
  // The live obs mirror: EVERY projection-type ledger append (user, system
  // turns, inkClient/local tools, assistant results, backend events, session
  // markers) is emitted as an `obs` line from inside SessionLog.append — one
  // place, all paths, so the live view can never diverge from replay
  // (spec:observer-attach §4.2; the e2e caught exactly this gap when only
  // backend events were mirrored). It belongs to this session's log alone:
  // a clone's log has no observer.
  runtime.log = new SessionLog({
    path: existingTranscript || ensureRuntimeTranscriptPath(runtime.sessionId),
    onProjection: (entry) => emitStreamEvent({ type: 'obs', entry }),
  });

  // Announce the ledger's absolute location to the server (session_meta) so
  // observer replay has a server-owned locator (spec:observer-attach §4.3).
  // The runtime is the authority on where it writes — the server validates
  // shape but never derives paths from its own cwd or caller input.
  emitStreamEvent({ type: 'session_meta', transcriptPath: runtime.log.path });

  // The same context-generation fence is shared by parent and clone calls.
  const beginContextMutationFor = (calls: ReadonlyArray<{ tool: string }>): (() => void) =>
    sessionContext.beginMutation(calls);
  const rollProviderSession = (reason: string, note: string): void =>
    sessionContext.roll(reason, note);

  // ── Images a tool put in context (view_image, `read` on an image) ──
  // The bytes never ride the text relay (tool-images.ts). They live on the
  // ledger entry that recorded the call, and each spawn carries the ones its
  // provider session has not been given: a resume only what is new, a seed
  // (fresh, rolled, or re-seeded after a lost session) everything the ledger
  // still holds, a stateless backend all of them every time. Evicting or
  // compacting the entry rolls the session, so the next seed simply omits it.
  const sessionToolHost = createSessionToolHost({
    cwd: process.cwd(),
    home: homedir(),
    imageRoots: [process.cwd(), join(homedir(), '.ink', 'files')],
    tempDir: tmpdir(),
    credentials: sessionCredentials,
    coding: { load: createPiTools, readDocument: tryReadDocument },
  });
  setToolDisposer(() => sessionToolHost.close());
  const toolImageCacheDir = sessionToolHost.cacheDir;
  const { withImageCapture, takeCapturedImages } = sessionToolHost.images;
  const parentImageDelivery = (): ImageDelivery =>
    acceptsContextImagesFor(runtime.backend)
      ? { deliverable: true }
      : {
          deliverable: false,
          reason: `this session's backend (${runtime.backend}) cannot receive images`,
        };
  let deliveredImages: { sessionId: string | undefined; refs: Set<string> } = {
    sessionId: undefined,
    refs: new Set(),
  };
  /** The images a spawn into `targetSessionId` must carry (undefined: stateless). */
  const contextImagesFor = (targetSessionId: string | undefined): ContextImage[] | undefined => {
    if (!acceptsContextImagesFor(runtime.backend)) return undefined;
    const images = imagesToDeliver(ledger.listImages(), deliveredImages, targetSessionId);
    return images.length > 0 ? images : undefined;
  };
  /**
   * Record what a spawn delivered: the images the ADAPTER reports its input
   * carried, never the list the host offered. An adapter can refuse part of
   * that list (the request's media budget, a file gone from disk), and
   * counting a refused image as seen suppressed it for the rest of the
   * session, however often it was viewed again (Lumen, PR #708). Only on
   * success, and only for a provider session that keeps it: a failed spawn may
   * never have reached the model, so its images go again with the next one.
   */
  const noteImagesDelivered = (
    targetSessionId: string | undefined,
    result: Pick<BackendRunResult, 'success' | 'contextImagesDelivered'>
  ): void => {
    const carried = result.contextImagesDelivered ?? [];
    if (!result.success || targetSessionId === undefined || carried.length === 0) return;
    if (deliveredImages.sessionId !== targetSessionId) {
      deliveredImages = { sessionId: targetSessionId, refs: new Set() };
    }
    for (const image of carried) {
      const ref = (image as Partial<ContextImage>).ref;
      if (typeof ref === 'string') deliveredImages.refs.add(ref);
    }
  };

  let historyHydration: HistoryHydrationResult | null = null;
  if (attachedToExistingSession && existingTranscript) {
    const hydrated = hydrateLedgerFromTranscript(ledger, existingTranscript, sbSlug);
    if (hydrated.providerSample) {
      // Replayed under the scope it was taken in; measurement() decides
      // whether that is still the live window.
      const s = hydrated.providerSample;
      sessionContext.sample.record(
        {
          backend: s.scope.backend,
          source: 'json',
          contextTokens: s.contextTokens,
          contextParts: {
            ...(s.inputTokens !== undefined ? { inputTokens: s.inputTokens } : {}),
            ...(s.cacheReadTokens !== undefined ? { cacheReadTokens: s.cacheReadTokens } : {}),
            ...(s.cacheWriteTokens !== undefined ? { cacheWriteTokens: s.cacheWriteTokens } : {}),
          },
        },
        s.scope,
        s.at
      );
    }
    // Recover the provider-reported model persisted by the prior process
    // BEFORE any budget enforcement runs: a reattached large transcript must
    // be judged against the session's REAL window, not the conservative
    // default that stands in until this process's own init event arrives.
    // An explicit --model override still wins.
    const persistedModel = findLastDetectedModel(existingTranscript, runtime.backend);
    if (persistedModel && !runtime.model) {
      runtime.detectedModel = persistedModel;
      const recoveredWindow = resolveBackendTokenWindow(runtime.backend, persistedModel);
      if (recoveredWindow !== runtime.backendTokenWindow) {
        runtime.backendTokenWindow = recoveredWindow;
        if (contextBudgetAuto) {
          runtime.maxContextTokens = defaultContextBudget(
            recoveredWindow,
            promptTransportFor(runtime.backend)
          );
        }
      }
    }
    // Resume the provider session the prior process left live (delta only),
    // unless a compaction/eviction rolled it — then the next turn seeds fresh.
    if (runtime.backend === 'claude') {
      // Recover the id only when the marker's persisted tool routing matches
      // this process's routing — a session seeded under the other routing (or
      // a legacy marker with no routing) holds the wrong instruction envelope
      // and must reseed fresh, not resume with a delta. The volatile shape
      // baseline (bootstrap context, skills) is still adopted on the first
      // turn below, AFTER all startup mutations, so a matching session
      // resumes rather than spuriously reseeding on startup-timing drift.
      const recovered = findLastBackendSession(existingTranscript);
      if (recovered && recovered.routing === runtime.toolRouting) {
        sessionContext.provider.id = recovered.id;
      }
    }
    // Continue the event-id sequence from where the file left off
    runtime.log.seed(hydrated.maxEid);
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
    const sessionContextResult = (await inkClient
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

  runtime.log.append({
    type: attachedToExistingSession ? 'session_attach' : 'session_start',
    sbSlug,
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
    await inkClient
      .callTool('update_session_state', {
        sbSlug,
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
    chip('inkling', sbSlug, chalk.cyan),
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
    const result = (await inkClient
      .callTool('list_sessions', { limit: 20, status: 'active' })
      .catch(() => null)) as Record<string, unknown> | null;
    sessionsCache = filterSessionsByPolicy(
      extractSessionSummaries(result),
      runtime,
      sbSlug,
      toolPolicy,
      'list'
    );
    sessionsCacheAt = Date.now();
    return sessionsCache;
  };

  const sessionCompaction = createSessionCompaction({
    runtime,
    ledger,
    sessionContext,
    sessionEvictedEntries,
    sbSlug,
    cliAttached,
    contextBudgetAuto: () => contextBudgetAuto,
    append: (entry) => runtime.log.append(entry),
    flush: () => runtime.log.flush(),
    spawnContext: providerSpawnContext,
    startTurn: startBackendTurn,
    recordUsage: recordRunUsage,
    formatTokens: formatTokenCount,
    trimmed: (note) => console.log(chalk.yellow(note)),
    progress: (line) => printEvent(chalk.yellow(`  ⛁ ${line}`)),
    deferred: () =>
      printEvent(chalk.dim('⛁ Compaction deferred — waiting for the provider to report its model')),
    compacted: (outcome, selected) => {
      // Live pre-mutation total, as the result reports it — the wrapper's own
      // pre-await snapshot showed "10K → 11K (freed 1K)" when entries arrived
      // during summarization (Lumen, PR #578 round 4).
      const sizes = `${formatTokenCount(outcome.before)} → ${formatTokenCount(outcome.totalAfter)} tok (freed ${formatTokenCount(outcome.freedTokens)})`;
      if (selected) {
        // NOT a cutoff divider. That line means "everything above is out of
        // the window", which is true of an oldest-N compaction and false of a
        // consolidation: the replaced set can start mid-ledger, and entries
        // above it are still in context. Drawing the divider here would
        // report a larger loss than happened.
        printEvent(chalk.yellow(`  ⛁ consolidated ${outcome.removed} selected entries · ${sizes}`));
      } else {
        // Cutoff divider: everything above this line in the scrollback is
        // now out of the context window (replaced by the summary).
        printEvent(renderContextCutoff(`compacted ${outcome.removed} entries · ${sizes}`));
      }
    },
  });
  const { recordEviction, trimContextToPercent, maybeCompactContext, runSbCompaction } =
    sessionCompaction;

  // Poll gates (PR #385): interval ticks skip while a poll is in flight;
  // forced polls (/inbox, /events) queue behind it instead of overlapping.
  // Prevents ticks from stacking concurrent requests behind a slow server.
  const inboxPollGate = createPollGate();
  const activityPollGate = createPollGate();

  // The session-visibility policy, applied to legacy and thread rows alike.
  const inboxTargetAllowedByPolicy = (target: {
    sessionId?: string;
    threadKey?: string;
    studioId?: string;
  }): boolean =>
    toolPolicy.canAccessSession({
      action: 'inbox',
      requester: {
        sessionId: runtime.sessionId,
        threadKey: runtime.threadKey,
        studioId: runtime.studioId,
        sbSlug,
      },
      target: { ...target, sbSlug },
    }).allowed;
  const inboxMessageAllowedByPolicy = (msg: InboxMessage): boolean =>
    inboxTargetAllowedByPolicy({
      sessionId: msg.relatedSessionId,
      threadKey: msg.threadKey,
      studioId: msg.recipientStudioId,
    });
  // A thread row carries no relatedSessionId or recipientStudioId. The server
  // found it through a poll scoped to this session, so the session and studio
  // it is addressed to are this REPL's own. Judging it on the absent fields
  // refused every thread row under /session-visibility self or studio, and a
  // refused row is acked unread (Lumen, PR #686).
  const threadRowAllowedByPolicy = (msg: InboxMessage): boolean =>
    inboxTargetAllowedByPolicy({
      sessionId: runtime.sessionId,
      threadKey: msg.threadKey,
      studioId: runtime.studioId,
    });

  // A permission grant modifies local policy; it is not chat. Legacy and
  // thread rows both come through here, so a grant sent on a thread is
  // applied, not rendered as a message.
  const intakePermissionGrant = (msg: InboxMessage): void => {
    seenInboxIds.add(msg.id);
    const grant = parsePermissionGrant(msg.metadata);
    if (!grant) {
      printLine(
        chalk.yellow(
          `Received malformed permission grant from ${msg.from || 'unknown'} — ignoring.`
        )
      );
      return;
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
    runtime.log.append({
      type: 'permission_grant',
      messageId: msg.id,
      action,
      tools: grant.tools,
      summary: result.summary,
      from,
      createdAt: msg.createdAt || null,
      ...(msg.threadKey ? { threadKey: msg.threadKey } : {}),
    });
  };

  // One intake for every message the REPL delivers — legacy inbox rows and
  // thread rows alike — so each reaches the ledger, the transcript and the
  // screen the same way, under the same auto-run policy. Throws if any step
  // does: the thread drain acks a message only after intake returned. An
  // eligible message is accepted into the turn queue here, so the ack follows
  // acceptance; the turn's completion goes into `autoRunTurns` for the caller
  // to await outside the poll gate. The seen-set entry is the last step, so
  // it never records a message whose intake stopped part-way.
  const intakeInboxMessage = (msg: InboxMessage, autoRunTurns: Array<Promise<void>>): void => {
    if (!runtime.threadKey && msg.threadKey) {
      runtime.threadKey = msg.threadKey;
    }
    const from = msg.from || 'unknown';
    // Each message names its own thread. The REPL binds to the first thread it
    // sees, and a session can be stamped with several, so the envelope's
    // thread is not this message's (Lumen, PR #686). At the front, because
    // compactForLedger cuts the tail.
    const sender = msg.threadKey ? `${from} (thread ${msg.threadKey})` : from;
    const heading = msg.subject ? `${sender} — ${msg.subject}` : sender;
    let delegationLabel = '';
    if (msg.delegationToken) {
      const secret = getDelegationSecret();
      if (!secret) {
        delegationLabel = ' [delegation:unverified:no-secret]';
      } else {
        // Verified against the thread the message was sent on. Checking the
        // REPL's bound thread instead would pass a token minted for that
        // thread on a message from another one.
        const verified = verifyDelegationToken(msg.delegationToken, secret, {
          expectedDelegateeSlug: sbSlug,
          expectedThreadKey: msg.threadKey ?? runtime.threadKey ?? undefined,
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
    runtime.log.append({
      type: 'inbox',
      messageId: msg.id,
      rendered,
      createdAt: msg.createdAt || null,
      delegationToken: msg.delegationToken || null,
      messageType: msg.messageType || null,
      relatedSessionId: msg.relatedSessionId || null,
      ...(msg.threadKey ? { threadKey: msg.threadKey } : {}),
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

    const enqueueAutoRun = enqueueAutoRunFromInbox;
    const eligibleForAutoRun =
      runtime.autoRunInbox &&
      readyForAutoRun &&
      (msg.from || '').toLowerCase() !== sbSlug.toLowerCase() &&
      msg.messageType !== 'notification' &&
      msg.content.trim().length > 0;

    if (eligibleForAutoRun && enqueueAutoRun) {
      try {
        autoRunTurns.push(enqueueAutoRun(msg));
      } catch (error) {
        // Delivery and execution are separate: this message is on screen and
        // in the journal, but it can never fit in this queue. Report that
        // failure before acknowledging delivery; do not retry it every poll.
        // Busy capacity and other intake failures still propagate for retry.
        if (!(error instanceof InputDrainRefusal) || error.reason !== 'too-large') throw error;
        const notice = `Inbox auto-run refused for ${msg.id}: input exceeds the queue's byte limit. Message delivered, but no turn queued. Send a smaller message to run it.`;
        if (inkRepl) inkRepl.addMessage('system', notice);
        else printLine(chalk.yellow(notice));
        runtime.log.append({
          type: 'inbox_auto_run_refused',
          messageId: msg.id,
          reason: error.reason,
          ...(msg.threadKey ? { threadKey: msg.threadKey } : {}),
        });
      }
    }
    seenInboxIds.add(msg.id);
  };

  // Thread delivery for an attached REPL. Once the REPL's session is
  // attached, the trigger handler delivers inline and spawns nothing, so the
  // REPL is the only reader of threads stamped to its session. It drains
  // them under the channel plugin's contract (shared/src/inkmail/drain.ts):
  // fetch with markRead:false, intake, then ack the exact last id, only
  // after intake returned. A headless run gets its message through
  // --message and does not drain, or it would take that message twice.
  const threadDrainState = createThreadDrainState();
  const drainsThreads = !options.nonInteractive && !options.message;
  const drainSessionThreads = async (autoRunTurns: Array<Promise<void>>): Promise<number> => {
    // channelPoll scopes to the session named in x-ink-context and fails
    // closed without one.
    if (!drainsThreads || !runtime.sessionId) return 0;
    const poll = (await inkClient
      .callTool('get_inbox', {
        sbSlug,
        status: 'unread',
        markRead: false,
        limit: 20,
        channelPoll: true,
      })
      .catch(() => null)) as Record<string, unknown> | null;
    if (!poll || poll.success === false) return 0;
    const threads = Array.isArray(poll.threadsWithUnread)
      ? (poll.threadsWithUnread as Array<Record<string, unknown>>)
      : [];
    // An empty page still goes to the drain, as the plugin's does: a
    // cold-start summary deferred by an earlier full batch is reported on the
    // first quiet poll (Lumen, PR #686).
    const drained = await drainThreads(
      {
        callInk: async (tool, args) =>
          (await inkClient.callTool(tool, args).catch(() => null)) as Record<
            string,
            unknown
          > | null,
        notify: async (content, _meta, row) => {
          if (row) {
            const msg = extractInboxMessages({ messages: [row] })[0];
            // Without an id there is nothing to take in or to ack past.
            if (!msg) return;
            // The drain has already skipped own-studio self messages. The
            // legacy thread-binding filter (inboxMessageMatchesSessionScope)
            // is not applied: the server stamped this thread to this
            // session, and a row refused here would be acked unread. The
            // visibility policy still applies. A refused row is acked
            // without rendering, as the legacy path consumes at fetch.
            if (!threadRowAllowedByPolicy(msg)) {
              sbDebugLog('chat', 'thread_drain_policy_refused', {
                messageId: msg.id,
                threadKey: msg.threadKey,
              });
              return;
            }
            // Only a row typed permission_grant is a grant. The type is the
            // server's gate (send_to_inbox refuses it from an SB); a grant
            // shape in the metadata of any other row is chat.
            if (msg.messageType === 'permission_grant') intakePermissionGrant(msg);
            else intakeInboxMessage(msg, autoRunTurns);
            return;
          }
          // The drain's own notice (the cold-start summary) carries no row.
          ledger.addEntry('inbox', compactForLedger(content), 'inkmail');
          if (inkRepl) inkRepl.addMessage('system', content);
          else printLine(chalk.dim(content));
        },
        log: (level, message, data) =>
          sbDebugLog('chat', 'thread_drain', { level, message, ...(data ?? {}) }),
        sbSlug,
        studioId: currentInkStudioId(),
      },
      threadDrainState,
      threads,
      {
        moreThreadsPending: poll.unreadThreadsTruncated === true,
        pollIncomplete: poll.channelPollIncomplete === true,
      }
    );
    return drained.injected;
  };

  // Phase 1 (gated): fetch + render + accept auto-run turns into the queue.
  // Must not await backend turns — pollInbox phase 2 awaits them, after the
  // gate releases, so grant delivery keeps flowing during a turn.
  const collectInbox = async (
    force: boolean
  ): Promise<{ freshCount: number; autoRunTurns: Array<Promise<void>> }> => {
    const inboxResult = (await inkClient
      .callTool('get_inbox', { sbSlug, status: 'unread', limit: 10 })
      .catch(() => null)) as Record<string, unknown> | null;
    const messages = extractInboxMessages(inboxResult);
    const fresh = messages
      .filter((msg) => !seenInboxIds.has(msg.id))
      .filter((msg) => inboxMessageMatchesSessionScope(runtime, msg))
      .filter(inboxMessageAllowedByPolicy)
      .sort((a, b) => safeDateMs(a.createdAt) - safeDateMs(b.createdAt));
    const autoRunTurns: Array<Promise<void>> = [];

    // Process permission grants separately — they modify local policy, not chat flow.
    const permissionGrants = fresh.filter((msg) => msg.messageType === 'permission_grant');
    const nonGrantMessages = fresh.filter((msg) => msg.messageType !== 'permission_grant');
    for (const msg of permissionGrants) {
      intakePermissionGrant(msg);
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
        runtime.log.append({
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
      intakeInboxMessage(msg, autoRunTurns);
    }

    const threadMessages = await drainSessionThreads(autoRunTurns);
    const freshCount = fresh.length + threadMessages;

    if (force && freshCount === 0) {
      if (inkRepl) {
        inkRepl.setCommandOutput(['No new inbox messages.']);
      } else {
        printLine(chalk.dim('No new inbox messages.'));
      }
    }
    emitStatusLaneIfChanged();
    return { freshCount, autoRunTurns };
  };

  const pollInbox = async (force = false): Promise<number> => {
    const collected = await inboxPollGate.run(() => collectInbox(force), { force });
    if (!collected) return 0; // another poll in flight — tick skipped
    // Phase 2 (gate released): auto-run backend turns run BEHIND the gate so
    // interval polling — and the permission-grant delivery a remote approval
    // depends on — continues while a turn is in flight.
    let autoRuns = 0;
    for (const turn of collected.autoRunTurns) {
      await turn;
      autoRuns += 1;
    }
    if (autoRuns > 0) {
      printLine(
        chalk.green(`Auto-run processed ${autoRuns} inbox message${autoRuns === 1 ? '' : 's'}.`)
      );
      emitStatusLaneIfChanged();
    }
    return collected.freshCount;
  };

  // Activity polls have no backend-turn phase — the whole body is gated.
  const collectActivity = async (force: boolean): Promise<number> => {
    const activityResult = (await inkClient
      .callTool('get_activity', {
        sbSlug,
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
              sbSlug,
            },
            target: {
              sessionId: activity.sessionId,
              threadKey: runtime.threadKey,
              studioId: runtime.studioId,
              sbSlug: activity.sbSlug,
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
      const actor = activity.sbSlug || 'system';
      const preview = (activity.content || '').replace(/\\s+/g, ' ').trim().slice(0, 200);
      const rendered = `⚡ ${actor} ${type}${preview ? ` — ${preview}` : ''}`;

      // Tiered rendering: platform messages are real conversation and get
      // proper message blocks; the agent's own mechanics (tools, state,
      // backend turn lifecycle) are dim event lines; everything else stays
      // a ⚡ activity block.
      const plan = classifyActivity(activity, sbSlug);
      const activityEid = runtime.log.append({
        type: 'activity',
        activityId: activity.id,
        activityType: activity.type || null,
        activitySubtype: activity.subtype || null,
        sbSlug: activity.sbSlug || null,
        sessionId: activity.sessionId || null,
        createdAt: activity.createdAt || null,
        content: activity.content || null,
        // Needed at replay: hydration re-classifies the entry to rebuild the
        // directional message label (📤 myra → telegram) and to tell own
        // inkmail sends from inbound delivery mechanics.
        platform: activity.platform || null,
        fromSlug: activity.fromSlug || null,
      });
      // Platform messages carry replay metadata so their message-block
      // rendering survives compaction (the kept tail serializes ledger
      // entries — the compact ⚡ line alone cannot rebuild the block).
      const replayMeta =
        (plan.mode === 'message-in' || plan.mode === 'message-out') &&
        plan.role &&
        plan.label &&
        (activity.content || '').trim()
          ? {
              role: plan.role,
              label: plan.label,
              body: activity.content || '',
              ...(activity.createdAt ? { at: activity.createdAt } : {}),
            }
          : undefined;
      ledger.addEntry(
        'system',
        compactForLedger(rendered, 320),
        'ink-activity',
        activityEid,
        replayMeta
      );
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

  const pollActivity = async (force = false): Promise<number> => {
    const count = await activityPollGate.run(() => collectActivity(force), { force });
    return count ?? 0;
  };

  // ── Turn attachments (--attach-file) ──
  // Resolved once at startup; the block attaches to the FIRST turn (the
  // message the attachments belong to) and the directories stay granted
  // to the backend for the whole session so later turns can re-read the
  // files. Server spawns (InkRunner) pass --attach-file per media item.
  let pendingAttachmentBlock = '';
  let sessionAttachmentDirs: string[] = [];
  // Media for the DELIVERY turn only (spec:provider-media-injection):
  // injecting adapters embed these as prompt content on the turn that
  // carries the attachment block. Later turns re-view via the gated
  // native-read fallback (dirs stay granted for the session).
  let pendingTurnMedia: TurnMedia[] = [];
  if (options.attachFile && options.attachFile.length > 0) {
    const resolvedAttachments = await resolveAttachments(options.attachFile);
    pendingAttachmentBlock = buildAttachmentBlock(resolvedAttachments);
    sessionAttachmentDirs = collectAttachmentDirs(resolvedAttachments);
    pendingTurnMedia = resolvedAttachments
      .filter((a) => !a.missing)
      .map((a) => ({ path: a.path, ...(a.mime ? { mimeType: a.mime } : {}) }));
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

  const clones = createSessionClones({
    runtime,
    sbSlug,
    cliAttached,
    policy: toolPolicy,
    ledger,
    registry: cloneRegistry,
    sessionContext,
    cwd: process.cwd(),
    toolHost: sessionToolHost,
    bindInk: (context) => {
      const client = new InkClient(undefined, undefined, {
        getContextToken: () =>
          encodeContextToken({
            sessionId: context.inkSessionId || '',
            studioId: context.studioId || 'main',
            sbSlug,
            cliAttached,
            runtime: 'ink',
          }),
      });
      return (name, args) => client.callTool(name, args);
    },
    derivePolicy: (parent, sessionId) => deriveClonePolicy(parent, { sessionId }).policy,
    createLog: (path) => new SessionLog({ path }),
    mintId: randomUUID,
    spawnContext: providerSpawnContext,
    startTurn: startBackendTurn,
    approve: (ticket) => approvalCoordinator.request(ticket).then((outcome) => outcome.approved),
    recordUsage: recordRunUsage,
    printEvent: (text) => printEvent(chalk.dim(text)),
  });
  const runSpawnAgent = clones.spawn;
  const runCollectAgents = clones.collect;
  const cancelRunningClones = clones.cancel;

  /** `/clones` — every clone this session spawned, running or finished. */
  const cloneOverviewLines = (): string[] => {
    const records = cloneRegistry.list();
    if (records.length === 0) {
      return ['No shadow clones spawned in this session.'];
    }
    const running = cloneRegistry.runningCount;
    return [
      `Shadow clones (${records.length} total${running > 0 ? `, ${running} running` : ''}):`,
      ...records.map(formatCloneLine),
      '',
      'Use /clones <id> to open one.',
    ];
  };

  /** `/clones <id>` — navigate into one clone's work. */
  const cloneDetailLines = (record: CloneRecord): string[] => {
    const lines = [
      formatCloneLine(record),
      '',
      `Task: ${record.prompt.split('\n')[0].slice(0, 200)}`,
      `Transcript: ${record.transcriptPath}`,
    ];
    if (record.parentSessionId) lines.push(`Parent session: ${record.parentSessionId}`);
    if (record.error) lines.push('', `Error: ${record.error}`);
    if (record.summary) {
      lines.push('', 'Summary:', ...record.summary.split('\n').slice(0, 40));
    } else if (record.status === 'running') {
      lines.push('', 'Still working — no summary yet.');
    }
    return lines;
  };

  /**
   * Execute one iteration's tool calls through ink's policy pipeline and return
   * what happened.
   *
   * This is the `tools.execute` port of the agent loop (see
   * ink://specs/ink-runtime-shadow-clones): the LOOP sequences, the HOST
   * authorizes. Policy, approvals, and credential resolution all live here, so a
   * shadow clone can supply its own executor over a narrowed policy snapshot
   * without the loop knowing anything about ToolPolicyState.
   */
  const sessionTools = createSessionTools({
    sessionId: () => runtime.sessionId,
    ledger,
    log: { append: (entry) => runtime.log.append(entry), flush: () => runtime.log.flush() },
    policy: toolPolicy,
    signalState: sessionSignal,
    mintInvocationId: randomUUID,
    beginContextMutation: beginContextMutationFor,
    takeImages: takeCapturedImages,
    capture: (dispatch) =>
      withImageCapture(dispatch, { cacheDir: toolImageCacheDir, delivery: parentImageDelivery }),
    dispatch: {
      cwd: process.cwd(),
      ...sessionToolHost.dispatch,
      callInk: (bare, resolved) => inkClient.callTool(bare, resolved),
      toolParameters: inkToolParameters,
      resolveCredentials: (args) => {
        const { args: resolvedArgs, resolutions } = resolveCredentialRefs(args, sessionCredentials);
        if (resolutions.length > 0 && runtime.verbose) {
          const refs = resolutions.map((r) => `${r.name} at ${r.path}`).join(', ');
          printLine(
            chalk.dim(`credential-resolver: resolved ${resolutions.length} ref(s): ${refs}`)
          );
        }
        return resolvedArgs;
      },
    },
    spawnAgent: runSpawnAgent,
    collectAgents: runCollectAgents,
    compact: runSbCompaction,
    measurement: providerContextMeasurement,
    recordEviction,
  });
  const runIterationTools = async (
    calls: LocalToolCall[],
    ctx?: { signal?: AbortSignal; origin?: ApprovalOriginInfo }
  ): Promise<ToolResultRecord[]> => {
    const approvalOrigin: ApprovalOriginInfo = ctx?.origin ?? { origin: 'parent' };
    const abortSignal = ctx?.signal;
    return sessionTools(calls, {
      signal: abortSignal,
      promptForApproval: (tool, reason, args) =>
        approvalCoordinator
          .request({
            tool,
            args: args ?? {},
            reason,
            sessionId: runtime.sessionId,
            origin: approvalOrigin,
            signal: abortSignal,
          })
          .then((outcome) => outcome.approved),
      onResult: (result: ToolCallResult) => {
        const delivered = localDeliveredSend(result);
        if (delivered) sessionStream.sends.push(delivered);
        if (result.status === 'blocked' || result.status === 'denied') {
          printEvent(
            chalk.yellow(`🛠 ${sbSlug} · ${result.tool} (${result.status}) — ${result.reason}`)
          );
        } else if (result.status === 'executed' || result.status === 'approved') {
          const resultJson = JSON.stringify(result.result);

          // Format context-management and signal tools with friendly output
          if (result.tool === 'evict_context') {
            const r = result.result as Record<string, unknown> | undefined;
            const content = (r?.content as Array<{ text: string }> | undefined)?.[0]?.text;
            if (content) {
              const parsed = JSON.parse(content);
              // The eviction itself was persisted from the onEvict hook at
              // execution time (recordEviction); this is display only.
              printEvent(
                chalk.dim(
                  `  🗑 evicted ${parsed.evicted} entries (${parsed.tokensFreed} tok freed, ${parsed.totalAfter} tok remaining)`
                )
              );
            }
          } else if (result.tool === 'list_context') {
            const r = result.result as Record<string, unknown> | undefined;
            const content = (r?.content as Array<{ text: string }> | undefined)?.[0]?.text;
            if (content) {
              const parsed = JSON.parse(content);
              const sources = parsed.bySource
                ? Object.entries(
                    parsed.bySource as Record<string, { count: number; tokens: number }>
                  )
                    .map(([src, { count, tokens }]) => `${src}(${count}/${tokens}t)`)
                    .join(' ')
                : '';
              printEvent(
                chalk.dim(
                  `📋 ${sbSlug} · list_context — ${parsed.totalEntries} entries, ~${parsed.totalTokens} tok${
                    sources ? ` · ${sources}` : ''
                  }`
                )
              );
            }
          } else if (result.tool === 'signal_status') {
            const r = result.result as Record<string, unknown> | undefined;
            const content = (r?.content as Array<{ text: string }> | undefined)?.[0]?.text;
            if (content) {
              const parsed = JSON.parse(content);
              const signal = parsed.signal as { status: string; reason?: string } | undefined;
              if (signal) {
                const icon =
                  signal.status === 'completed' ? '✅' : signal.status === 'blocked' ? '🚫' : '➡️';
                printEvent(
                  chalk.dim(
                    `  ${icon} signal: ${signal.status}${signal.reason ? ` — ${signal.reason}` : ''}`
                  )
                );
              }
            }
          } else {
            // One dim line, attributed to the agent, result truncated —
            // the Ctrl+T inspector holds a 2KB result slice per call and
            // the transcript keeps the complete payload.
            const resultPreview = compactForLedger(resultJson, 160);
            printEvent(
              chalk.dim(
                `🛠 ${sbSlug} · ${result.tool} (${result.status})${
                  resultPreview ? ` — ${resultPreview}` : ''
                }`
              )
            );
          }
        } else if (result.status === 'error') {
          printEvent(
            chalk.red(
              `🛠 ${sbSlug} · ${result.tool} (error) — ${compactForLedger(String(result.error), 160)}`
            )
          );
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
  };

  const executeUserTurn = async (
    raw: string,
    turnMedia: TurnMedia[],
    prepared: PreparedSessionTurn
  ) => {
    const { occupancy: turnOccupancy, promptHooks: promptHookResult } = prepared;
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
        // Same occupancy the hook gated on and the stamp reported. This line
        // used to recompute it from the ledger estimate, so the human at the
        // terminal could read a different percentage than the agent was given.
        const util = Math.round(turnOccupancy.utilization * 100);
        // Same three buckets the stamp names, same words. The human reading this
        // line and the agent reading the stamp must not be given different
        // accounts of the same turn — and "evictable" here once covered the
        // identity envelope, which nothing evicts (Lumen, PR #639).
        const split = turnOccupancy.splitKnown
          ? `${turnOccupancy.ledgerTokens.toLocaleString()} ledger + ` +
            `${turnOccupancy.fixedTokens.toLocaleString()} envelope + ` +
            `${turnOccupancy.unaccountedTokens.toLocaleString()} unaccounted`
          : 'ledger estimate only — provider has not reported';
        printEvent(
          chalk.yellow(
            `  ⚠ Context at ${util}% — ${turnOccupancy.effectiveTokens.toLocaleString()} / ${turnOccupancy.limit.toLocaleString()} tok (${split})`
          )
        );
      }
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
        systemPromptOverride: runtime.systemPromptOverride,
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

    /**
     * Cancellation for everything in this turn that is NOT the backend child
     * process. Killing the child (`currentTurnAbort`) has always ended the
     * backend's work, but anything waiting *around* it — an approval prompt, a
     * 2FA poll — had no way to hear about it and would sit for its full timeout.
     * Fresh per turn, so a cancelled turn does not disarm the next one.
     */
    const turnAbort = new AbortController();

    const abortCurrentTurn = () => {
      // Always fire the turn signal, even between backend turns: that is the
      // only thing that reaches an approval prompt or a 2FA poll, and those are
      // exactly when no child process is running to kill.
      if (!turnAbort.signal.aborted) turnAbort.abort();
      if (currentTurnAbort) {
        currentTurnAbort();
        currentTurnAbort = null;
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

    /**
     * Cancellation handlers stay armed for the WHOLE turn, not per backend
     * child.
     *
     * They used to be installed and torn down around each `startBackendTurn`,
     * which left Ctrl+C unhandled during exactly the phase where a turn is most
     * likely to be waiting on a human: tool execution and approval prompts. The
     * AbortSignal reached the approval channels, but nothing was left alive to
     * fire it. `currentTurnAbort` still moves per child, so a Ctrl+C during a
     * backend turn kills the right process.
     */
    const disarmTurnCancellation = () => {
      process.off('SIGINT', onSigintDuringTurn);
      inkRepl?.setAbortHandler(null);
    };

    const providerPorts: SessionProviderPorts = {
      runtime,
      state: sessionContext.provider,
      ledger,
      sbSlug,
      cliAttached,
      passthroughArgs,
      dialogue: sessionStream.dialogue,
      mintId: randomUUID,
      append: (entry) => runtime.log.append(entry),
      flush: () => runtime.log.flush(),
      buildEnvelope: (body, stamp) => buildPromptEnvelope(sbSlug, runtime, ledger, body, stamp),
      measurement: providerContextMeasurement,
      spawnContext: providerSpawnContext,
      contextImagesFor,
      noteImagesDelivered,
      attachmentDirs: () => (sessionAttachmentDirs.length > 0 ? sessionAttachmentDirs : undefined),
      startTurn: startBackendTurn,
      onEvent: handleBackendEvent,
      beginSpawn,
      endSpawn,
      onAbortHandle: (abort) => {
        currentTurnAbort = abort;
      },
      onInitialSettled: () => {
        turnDurationSeconds = Math.max(0, Math.round((Date.now() - turnStartedAt) / 1000));
        stopWaiting();
      },
      onInitialResult: (runResult) => {
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

        // Log backend CLI turn completion to activity stream. Use 'ink' as the
        // runner label (not the LLM backend like 'claude') so the mission feed
        // shows the correct execution layer. Continuations are the same logical
        // turn and deliberately do NOT log again.
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
          inkClient
            .callTool('log_activity', {
              sbSlug,
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
      },
      recordUsage: recordRunUsage,
      sampleContext: sampleProviderContext,
      contextGeneration: () => sessionContext.generation,
      mutationsInFlight: () => sessionContext.mutationsInFlight,
      notice: (reason) =>
        printEvent(
          reason === 'resume-missing'
            ? chalk.yellow(
                '  ⛁ provider session not found on resume — re-seeding a fresh native session'
              )
            : chalk.dim('  ⛁ provider session rolled mid-turn — re-seeding a fresh native session')
        ),
    };

    process.on('SIGINT', onSigintDuringTurn);
    inkRepl?.setAbortHandler(abortCurrentTurn);

    let execution: Awaited<ReturnType<typeof runSessionAgentTurn>>;
    try {
      execution = await runSessionAgentTurn(
        {
          raw,
          turnMedia,
          prepared,
          signal: turnAbort.signal,
          // Nobody watches a non-interactive turn, so a call that failed (an
          // invalid argument, say) gets a retry instead of ending the turn on
          // the FINAL relay. A deliberate refusal still ends it.
          continueOnFailure: Boolean(options.nonInteractive),
        },
        {
          ui: {
            printLine: (text) => printLine(chalk.dim(text)),
            printEvent: (text) => printEvent(chalk.dim(text)),
            startWaiting: () =>
              inkRepl
                ? ((repl) => {
                    repl.setWaiting(true, runtime.backend);
                    return () => repl.setWaiting(false);
                  })(inkRepl)
                : startWaitingIndicator(runtime.backend, {
                    statusLane,
                    logger: printLine,
                    renderAbovePrompt: true,
                  }),
          },
          tools: {
            execute: (calls, ctx) => runIterationTools(calls, { signal: ctx.signal }),
            // Runs over the full extracted list, before the per-iteration cap —
            // otherwise a spawn_agent in sixth position would be truncated away
            // instead of caught.
            screen: (allCalls) => {
              const verdict = screenIteration(allCalls, MAX_TOOL_CALLS_PER_ITERATION);
              return verdict.ok ? { calls: verdict.calls } : { rejected: verdict.reason };
            },
          },
          provider: providerPorts,
          rollProviderSession,
          observe: {
            recordToolCall: (r) => {
              const liveArgsJson = r.args ? JSON.stringify(r.args).replace(/\s+/g, ' ') : '';
              // The scrollback line shows a 160-char teaser; the inspector (Ctrl+T)
              // is the drill-down, so it keeps a much larger slice of the result.
              // The complete payload always lives in the transcript.
              const liveResultJson =
                r.result !== undefined
                  ? (typeof r.result === 'string' ? r.result : JSON.stringify(r.result)).replace(
                      /\s+/g,
                      ' '
                    )
                  : '';
              recentToolCalls.push({
                tool: r.tool,
                status: r.status,
                at: new Date().toISOString(),
                args: liveArgsJson
                  ? liveArgsJson.length > 400
                    ? `${liveArgsJson.slice(0, 400)}…`
                    : liveArgsJson
                  : undefined,
                result: liveResultJson
                  ? liveResultJson.length > 2000
                    ? `${liveResultJson.slice(0, 2000)}…`
                    : liveResultJson
                  : undefined,
              });
              if (recentToolCalls.length > 100) {
                recentToolCalls.splice(0, recentToolCalls.length - 100);
              }
            },
            // The discarded text is persisted WHOLE. A backend_text preview
            // (200 chars) was enough to detect the 2026-09-02 fabrication after
            // the fact, and not enough to reconstruct what the agent had acted
            // on without the provider's transcript (#569).
            recordProtocolViolation: (violation) => {
              runtime.log.append({
                type: 'protocol_violation',
                kind: violation.kind,
                phase: violation.phase,
                iteration: violation.iteration,
                header: violation.header,
                discardedChars: violation.discarded.length,
                discarded: violation.discarded,
              });
            },
          },
        }
      );
    } finally {
      // Only here — after tools and approvals, not after the last child exits.
      disarmTurnCancellation();
    }

    return {
      ...execution,
      value: { turnDurationSeconds },
    };
  };

  const presentUserTurn = (
    execution: SessionTurnExecution<{ turnDurationSeconds: number }>,
    onReplyReady?: () => void
  ) => {
    const { loop: loopResult, backend: runResult } = execution;
    const { turnDurationSeconds } = execution.value;
    const isAbortedTurn = loopResult.stopReason === 'aborted';
    const assistantDisplayText = loopResult.assistantDisplayText;
    if (!isAbortedTurn) {
      // A failed backend's partial output is not a reply.
      lastTurnAssistantText = loopResult.success ? assistantDisplayText : null;
    }
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
        // When the final text already streamed live (it equals the last
        // completed assistant MESSAGE, modulo local-tool stripping), don't
        // print the body twice — close the turn with a compact meta line.
        if (streamRenderer.shouldSkipFinal(assistantDisplayText)) {
          inkRepl.printEvent(`✔ ${sbSlug} · ${trailingParts}`);
        } else {
          inkRepl.addMessage('assistant', assistantDisplayText, {
            label: sbSlug,
            trailingMeta: trailingParts,
          });
        }
      }
    } else if (!isAbortedTurn) {
      printLine('');
      printLine(
        renderMessageLine('assistant', assistantDisplayText, {
          label: sbSlug,
          timezone: runtime.userTimezone,
          trailingMeta: `${turnDurationSeconds}s`,
        })
      );
      if (runResult.usage) {
        printLine(chalk.dim(`    ↳ ${formatBackendTokenUsage(runResult.usage)}`));
      }
      printLine('');
    }
    onReplyReady?.();
  };

  const turnCoordinator = new SessionTurnCoordinator({
    ledger,
    hooks: hookRegistry,
    // Read the live log/state: /session and other live controls can replace them.
    log: {
      append: (entry) => runtime.log.append(entry),
      flush: () => runtime.log.flush(),
    },
    state: () => ({
      sessionId: runtime.sessionId,
      sbSlug,
      backend: runtime.backend,
      model: runtime.model,
      bootstrapContext: runtime.bootstrapContext,
      maxContextTokens: runtime.maxContextTokens,
      compactionInFlight: sessionCompaction.isInFlight(),
    }),
    occupancy: () => turnContextOccupancy(ledger, runtime, providerContextMeasurement()),
    inputRecorded: async () => {
      if (runtime.sessionId && !options.nonInteractive) {
        await inkClient
          .callTool('update_session_state', {
            sbSlug,
            sessionId: runtime.sessionId,
            phase: 'implementing',
            status: 'active',
          })
          .catch(() => undefined);
      }
    },
    compact: maybeCompactContext,
    recordEviction,
  });

  const runUserTurn = async (
    raw: string,
    source: 'user' | 'inbox-auto' | 'system' = 'user',
    displayLabel?: string,
    onReplyReady?: () => void
  ) => {
    if (!raw.trim()) return;
    sessionStream.resetTurn();
    // Attach pending files to this turn — append the block so the backend
    // sees the paths inline with the message that delivered them. The media
    // list rides the same turn (injected as prompt content by adapters that
    // support it) and is consumed here so continuations don't re-inject.
    if (pendingAttachmentBlock) {
      raw = `${raw}\n\n${pendingAttachmentBlock}`;
      pendingAttachmentBlock = '';
    }
    const turnMedia = pendingTurnMedia;
    pendingTurnMedia = [];
    // Display echo stays at submit time. The shared coordinator sequences
    // context/log writes, compaction and recall with the actual execution.
    const coordinated = await turnCoordinator.run(
      { raw, source, displayLabel },
      (prepared) => executeUserTurn(raw, turnMedia, prepared),
      (execution) => presentUserTurn(execution, onReplyReady)
    );
    if (!coordinated) return;
    const { endHooks: hookResult, autoEviction } = coordinated;
    if (autoEviction) {
      printEvent(
        chalk.dim(
          `  🗑 auto-cleared ${autoEviction.entries} consumed tool results (${formatTokenCount(autoEviction.removedTokens)} tok) — ${autoEviction.tools.join(', ')}`
        )
      );
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
  };

  let rl: ReturnType<typeof createInterface> | null = null;

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
      model: runtime.model ?? runtime.detectedModel,
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
  // The REPL's half of the hook-owned turn marker (PR #506 P1, Lumen):
  // `cli_turn_at` is the lease machinery's only turn signal for CLI
  // processes outside the API run registry, and an interactive Ink turn set
  // neither signal — the whole turn ran invisible to liveness, deferral, and
  // boundary logic. The route stays the single writer; the REPL only posts
  // the same prompt/stop events the backend lifecycle hooks send.
  const turnSignal = createTurnSignal({
    getSessionId: () => runtime.sessionId,
    getStudioId: () => currentInkStudioId(),
    sbSlug,
    cliAttached,
    // Set by the server on a chat it spawned for one run (InkRunner). Only a
    // one-shot run can be that chat; an interactive REPL owns its own turns.
    runTurnEpoch: cliAttached ? undefined : process.env[RUN_TURN_EPOCH_ENV],
    getServerUrl: async () => (await import('../lib/ink-mcp.js')).getInkServerUrl(),
    getToken: async (serverUrl) =>
      (await import('../auth/tokens.js')).getValidAccessToken(serverUrl),
    workingDir: process.cwd(),
    onDebug: (event, detail) => sbDebugLog('chat', event, detail),
  });
  // One shared ordinary-input drain. The CLI still owns admission, context,
  // policy and rendering; hosted callers must supply durable command IDs and
  // the canonical owner fence rather than treating this queue as a lease.
  const inputDrain = new SerialInputDrain<{
    raw: string;
    source: 'user' | 'inbox-auto' | 'system';
    displayLabel?: string;
    onReplyReady?: () => void;
  }>({
    maxPendingInputs: 128,
    maxPendingBytes: 8 * 1024 * 1024,
    sizeOf: ({ raw, source, displayLabel }) =>
      Buffer.byteLength(raw, 'utf8') +
      Buffer.byteLength(source, 'utf8') +
      Buffer.byteLength(displayLabel ?? '', 'utf8'),
    run: async ({ raw, source, displayLabel, onReplyReady }) => {
      if (inkRepl) {
        inkRepl.setWaiting(true, runtime.backend);
      } else {
        statusLane.setTurnActive(true);
      }
      // Turn open before any backend work; turn close on EVERY exit path via
      // finally. The directions differ (round-two P1): a missed STOP decays
      // toward holding and is backstopped by the exit detach, but a missed
      // PROMPT runs this turn INVISIBLE to the lease machinery — liveness,
      // deferral, and boundary logic all read the marker. So an
      // unacknowledged open on studio-backed work refuses the turn instead
      // of running unprotected.
      try {
        const turnProtected = await turnSignal.open();
        const gate = turnGateDecision(runtime.sessionId, turnProtected, currentInkStudioId());
        if (!gate.allow) {
          printLine(chalk.red(`Turn not started: ${gate.reason}`));
          return;
        }
        await runUserTurn(raw, source, displayLabel, onReplyReady);
      } catch (error) {
        printLine(chalk.red(`Turn failed: ${String(error)}`));
      } finally {
        await turnSignal.close();
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
    },
  });
  setToolDisposer(async () => {
    readyForAutoRun = false;
    if (pollTimer) clearInterval(pollTimer);
    stopEventStream?.();
    // Stop producers first, drain ordinary input, then retire any clone that
    // input started while draining. Never delete images a child still reads.
    cancelRunningClones();
    await inputDrain.close();
    cancelRunningClones();
    await clones.drain();
    await sessionToolHost.close();
  });
  const enqueueTurn = (
    raw: string,
    source: 'user' | 'inbox-auto' | 'system' = 'user',
    displayLabel?: string,
    onReplyReady?: () => void
  ): Promise<void> =>
    inputDrain.enqueue({ raw, source, displayLabel, onReplyReady }, () => {
      // Echo at SUBMIT time, not when the queue reaches the turn — a message
      // typed while another turn is in flight must not vanish until its turn
      // starts. Ledger/transcript appends remain turn-sequenced in runUserTurn.
      if (raw.trim()) {
        // The echo interleaves with any in-flight streamed paragraphs — the next
        // one must re-render its agent header so it can't read as continuation
        // of this message.
        streamRenderer.noteInterleave();
        if (source === 'user') {
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
        } else if (source === 'system') {
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
        }
      }
      pendingTurns += 1;
      try {
        emitStatusLaneIfChanged();
      } catch (error) {
        pendingTurns -= 1;
        throw error;
      }
    });

  // Not async: the turn is in the queue when this returns, and a failure to
  // put it there throws into the caller's intake instead of rejecting later,
  // after the message was acked. The promise is the turn's completion.
  enqueueAutoRunFromInbox = (message: InboxMessage) =>
    enqueueTurn(buildAutoRunPromptFromInbox(runtime, message), 'inbox-auto');
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
      const { getInkServerUrl } = await import('../lib/ink-mcp.js');
      const { getValidAccessToken } = await import('../auth/tokens.js');
      const streamServerUrl = getInkServerUrl().replace(/\/+$/, '');
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
            // The agent's own tool call — a dim event line in the message
            // flow, not a labeled activity block.
            const line = `🛠 ${sbSlug} · ${toolName}`;
            if (inkRepl)
              inkRepl.addMessage('event', line, {
                time: formatHumanTime(at, runtime.userTimezone),
              });
            else printEvent(chalk.dim(`  ${line}`));
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
    // maxTurns counts OUTER conversational turns (runUserTurn cycles: the
    // delivered message plus continuation prompts) — not provider subprocess
    // calls, of which a single turn's tool loop may spawn several. Validate
    // strictly: this arrives from server spawn args, and a malformed value
    // silently coerced to NaN/1 would defeat the configured cap.
    const maxTurnsRaw = String(options.maxTurns ?? '1').trim();
    const maxTurns = Number.parseInt(maxTurnsRaw, 10);
    if (!/^\d+$/.test(maxTurnsRaw) || maxTurns < 1 || maxTurns > 25) {
      throw new Error(`--max-turns must be an integer between 1 and 25 (got "${maxTurnsRaw}")`);
    }

    // Turn 1: the delivered message. When --message-label is set (server
    // spawns pass the originating channel, e.g. "heartbeat"), render as a
    // system message — it's harness-delivered, not typed by the human.
    const messageLabel = options.messageLabel?.trim();
    // Each outer turn's reply goes out as one line the moment the turn ends;
    // the server forwards it to the channel then, not after the last turn.
    // Only the last turn's text used to survive the run (turn-reply.ts). The
    // server mints the token only when it forwards these lines, so without one
    // nothing is printed.
    const runTurnAndReport = async (
      turn: number,
      raw: string,
      source: SessionTurnInput['source'],
      label: string | undefined
    ): Promise<void> => {
      lastTurnAssistantText = null;
      sessionStream.resetSends();
      let reported = false;
      const report = () => {
        if (reported || !turnReplyToken) return;
        reported = true;
        console.log(
          JSON.stringify(
            turnReplyEvent({
              turn,
              label: label || 'user',
              assistantText: lastTurnAssistantText,
              sends: sessionStream.sends,
              token: turnReplyToken,
            })
          )
        );
      };
      await enqueueTurn(raw, source, label, report);
      // Preserve the existing empty/error receipt when no assistant outcome
      // reached the committed callback. Never duplicate a successfully sent one.
      report();
    };
    const { turnsCompleted, exitReason, finalSignal, phase } = await runHeadlessSession(
      { message, messageLabel, maxTurns, repliesForwarded: Boolean(turnReplyToken) },
      {
        sessionSignal,
        consecutiveBackendFailures: () => consecutiveBackendFailures,
        runTurn: (turn, input) =>
          runTurnAndReport(turn, input.raw, input.source, input.displayLabel),
      }
    );

    if (pollTimer) clearInterval(pollTimer);
    stopEventStream?.();
    const summary = summarizeForSessionEnd(ledger);

    const isBackendFailure = exitReason === 'backend_failure';

    if (runtime.sessionId) {
      await inkClient
        .callTool('update_session_state', {
          sbSlug,
          sessionId: runtime.sessionId,
          phase,
        })
        .catch(() => undefined);
    }
    runtime.log.append({
      type: 'session_pause',
      sessionId: runtime.sessionId || null,
      summary,
      turnsCompleted,
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
        turnsCompleted,
        reason: finalSignal?.reason || (isBackendFailure ? 'backend_failure' : null),
        usage: {
          contextTokens: reportedContextTokens,
          // Summed over every backend invocation this run made, not just the
          // last. The parser's inputTokens is the FRESH remainder only — the
          // cached portion lives in separate fields, and dropping it here is
          // what made ink sessions report a few hundred input tokens across
          // hundreds of messages. Context stays the ledger's own figure, which
          // was already the right measure and is not the billed sum.
          inputTokens: runUsage.totals.inputTokens,
          outputTokens: runUsage.totals.outputTokens,
          cacheReadTokens: runUsage.totals.cacheReadTokens,
          cacheWriteTokens: runUsage.totals.cacheWriteTokens,
        },
        // Only what the provider reported during THIS process. Requested and
        // transcript-hydrated models are excluded — reporting either would
        // attribute usage to a model that may not have served the run.
        ...(sessionStream.currentModel ? { model: sessionStream.currentModel } : {}),
        ...(Object.keys(runUsage.models).length > 0 ? { modelUsage: runUsage.models } : {}),
        ...(isBackendFailure ? { backendFailure: true } : {}),
      })
    );

    if (isBackendFailure) {
      console.log(chalk.red(`\nSession aborted: backend returned consecutive failures.`));
      console.log(chalk.cyan(`  Resume with: ink chat --attach-latest ${sbSlug}\n`));
      process.exitCode = 1;
    } else if (finalSignal?.status === 'blocked') {
      console.log(chalk.yellow(`\nSession blocked: ${finalSignal.reason || 'needs input'}`));
    } else if (finalSignal?.status === 'completed') {
      console.log(chalk.green(`\nSession completed.`));
    } else {
      console.log(chalk.dim(`\nSession paused (${turnsCompleted} turn(s) completed).`));
    }
    if (!isBackendFailure) {
      console.log(chalk.cyan(`  Resume with: ink chat --attach-latest ${sbSlug}\n`));
    }

    // Clean up handles that would keep the process alive. Without this,
    // the non-interactive path skips the REPL cleanup at the end of
    // runChat() and Node hangs on open handles — blocking InkRunner's
    // heartbeat delivery callback indefinitely.
    readyForAutoRun = false;
    approvalManager.cancelAll();
    approvalCoordinator.dispose();
    // A background clone holds a live backend child, which holds the process.
    cancelRunningClones();
    runtime.approvalChannel?.dispose();
    if (pendingTurns > 0) {
      await inputDrain.flush();
    }
    // Process-proof detach (missed-stop backstop, round-two P1): clears any
    // cli_turn_at this process opened but failed to close, and marks the
    // session unattached so trigger spawns resume.
    await turnSignal.detach();
    // The outer finally drains input/clones before disposing tool files.
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
  let activePromptLabel = `${sbSlug}> `;

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
      sbSlug,
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
      model: runtime.model ?? runtime.detectedModel,
      bootstrapTokens: runtime.bootstrapContext ? estimateTokens(runtime.bootstrapContext) : 0,
    });
    inkRepl.setStatus(initialSummary);
    lastStatusSummary = initialSummary;

    // Background clones are invisible otherwise — they run while the user is
    // typing, reading, or on another session, and nothing in the chat stream
    // would say so. The info bar is the standing reminder that work is in
    // flight; `/clones` is the way in.
    cloneRegistry.onChange(() => {
      const running = cloneRegistry.runningCount;
      inkRepl?.setInfoItems(
        running > 0
          ? [...initialInfoItems, `🌀 ${running} clone${running === 1 ? '' : 's'}`]
          : initialInfoItems
      );
    });

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
        // Replayed platform messages carry their own directional label
        // (📤 myra → telegram) — same as the live activity rendering.
        const label =
          entry.role === 'user'
            ? entry.label || 'you'
            : entry.role === 'assistant'
              ? entry.label || sbSlug
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
      await inputDrain.flush();
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
        const promptLabel = pendingTurns > 0 ? `${sbSlug}+${pendingTurns}> ` : `${sbSlug}> `;
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
            const fullResult = (await inkClient
              .callTool('get_inbox', { sbSlug, status: 'unread', limit: 20 })
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
          const refreshResult = (await inkClient
            .callTool('bootstrap', { sbSlug })
            .catch((error) => ({ error: String(error) }))) as Record<string, unknown>;
          if (refreshResult.error) {
            showInPanel([`Refresh failed: ${String(refreshResult.error)}`]);
          } else {
            const ctx = formatBootstrapContext(refreshResult);
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
        case 'clones': {
          const target = slash.args[0];
          if (target === 'cancel') {
            const which = slash.args[1];
            if (!which) {
              const stopped = cloneRegistry.cancelAll();
              showInPanel([
                stopped > 0 ? `Cancelled ${stopped} running clone(s).` : 'No clones are running.',
              ]);
              break;
            }
            showInPanel([
              cloneRegistry.cancel(which)
                ? `Cancelled ${which}.`
                : `${which} is not running (unknown, or already finished).`,
            ]);
            break;
          }
          if (target) {
            // Navigate INTO a clone: show what it did, from its own transcript.
            const record = cloneRegistry.get(target);
            if (!record) {
              showInPanel([`Unknown clone: ${target}`, '', ...cloneOverviewLines()]);
              break;
            }
            showInPanel(cloneDetailLines(record));
            break;
          }
          showInPanel(cloneOverviewLines());
          break;
        }
        case 'backend': {
          const next = slash.args[0];
          if (!next || !['claude', 'codex', 'gemini'].includes(next)) {
            showInPanel(['Usage: /backend <claude|codex|gemini>']);
            break;
          }
          runtime.backend = next;
          // Detection belongs to the previous provider's session.
          runtime.detectedModel = undefined;
          runtime.backendTokenWindow = resolveBackendTokenWindow(runtime.backend, runtime.model);
          if (contextBudgetAuto) {
            runtime.maxContextTokens = defaultContextBudget(
              runtime.backendTokenWindow,
              promptTransportFor(runtime.backend)
            );
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
          applyModelSelection(runtime, next || undefined, contextBudgetAuto);
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
          const grantResult = await inkClient
            .callTool('send_to_inbox', {
              recipientSlug: targetAgent,
              senderSlug: sbSlug,
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
            let inkArgs: Record<string, unknown> = {};
            const rawArgs = raw.split(/\s+/).slice(3).join(' ').trim();
            if (rawArgs) {
              try {
                inkArgs = JSON.parse(rawArgs) as Record<string, unknown>;
              } catch {
                showInPanel(['Invalid JSON args. Example: /mcp call get_inbox {"sbSlug":"lumen"}']);
                break;
              }
            }
            const approved = await ensureInkToolAllowed({
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
            const result = await inkClient
              .callTool(tool, inkArgs)
              .catch((error) => ({ error: String(error) }));
            const rendered = JSON.stringify(result, null, 2);
            ledger.addEntry('system', compactForLedger(`ink ${tool} -> ${rendered}`, 500), 'ink');
            runtime.log.append({
              type: 'pcp_tool',
              tool,
              args: inkArgs,
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
        case 'ink':
        case 'pcp': {
          // 'pcp' kept as a silent alias: it is what actually dispatched
          // before #659, so it is the spelling in people's muscle memory.
          const tool = slash.args[0];
          if (!tool) {
            showInPanel(['Usage: /ink <tool> [jsonArgs]']);
            break;
          }
          let inkArgs: Record<string, unknown> = {};
          const rawArgs = raw.split(/\s+/).slice(2).join(' ').trim();
          if (rawArgs) {
            try {
              inkArgs = JSON.parse(rawArgs) as Record<string, unknown>;
            } catch {
              showInPanel(['Invalid JSON args. Example: /inkClient get_inbox {"sbSlug":"lumen"}']);
              break;
            }
          }
          const approved = await ensureInkToolAllowed({
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
          const result = await inkClient
            .callTool(tool, inkArgs)
            .catch((error) => ({ error: String(error) }));
          const rendered = JSON.stringify(result, null, 2);
          ledger.addEntry('system', compactForLedger(`ink ${tool} -> ${rendered}`, 500), 'ink');
          runtime.log.append({
            type: 'pcp_tool',
            tool,
            args: inkArgs,
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
              issuerSlug: sbSlug,
              delegateeSlug: toAgent,
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
          runtime.log.append({
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
              issuerSlug: sbSlug,
              delegateeSlug: toAgent,
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

          const approved = await ensureInkToolAllowed({
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
            recipientSlug: toAgent,
            senderSlug: sbSlug,
            messageType: 'task_request',
            subject: `Delegated task from ${sbSlug}`,
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
          const result = await inkClient
            .callTool('send_to_inbox', inboxArgs)
            .catch((error) => ({ error: String(error) }));
          runtime.log.append({
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
            await inkClient
              .callTool('remember', {
                sbSlug,
                ...(runtime.sessionId ? { sessionId: runtime.sessionId } : {}),
                content: `Context ejection at ${result.bookmark.id} (${result.bookmark.label}).\n${summary}`,
                topics: 'repl,context-ejection',
                salience: 'medium',
              })
              .catch(() => undefined);
          }
          runtime.log.append({
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
            await inputDrain.flush();
          }
          const usage = formatUsageLines(
            ledger,
            runtime.maxContextTokens,
            lastUsageTotal,
            sessionContext.sample.latest()?.usage,
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
    try {
      void enqueueTurn(raw).catch((error) => {
        printLine(chalk.red(`Turn failed: ${String(error)}`));
      });
    } catch (error) {
      printLine(chalk.red(`Input not queued: ${String(error)}`));
    }
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
    await inputDrain.flush();
  }

  // Process-proof detach (missed-stop backstop, round-two P1): clears any
  // cli_turn_at this process opened but failed to close, and marks the
  // session unattached so trigger spawns resume.
  await turnSignal.detach();

  // Cancel any pending remote approval requests
  approvalManager.cancelAll();
  approvalCoordinator.dispose();
  cancelRunningClones();
  runtime.approvalChannel?.dispose();
  // The outer finally drains input/clones before disposing tool files.

  const summary = summarizeForSessionEnd(ledger);
  if (runtime.sessionId && !attachedToExistingSession) {
    await inkClient
      .callTool('end_session', { sbSlug, sessionId: runtime.sessionId, summary })
      .catch(() => undefined);
  }
  runtime.log.append({
    type: 'session_end',
    sessionId: runtime.sessionId || null,
    summary,
  });

  if (runtime.sessionId) {
    console.log(chalk.dim(`Reattach: ink chat -a ${sbSlug} --attach ${runtime.sessionId}`));
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
        '--effort <level>',
        'Reasoning effort for the backend (claude: low | medium | high | xhigh | max)'
      )
      .option(
        '--system-prompt-file <path>',
        'Replace the generated identity prompt with this file (used by `ink awaken`)'
      )
      .option(
        '--tool-routing <mode>',
        // No Commander default: a default here would make options.toolRouting
        // always-set and mask the persisted .ink/identity.json preference in
        // the runtime resolution below. Server spawns always pass the flag
        // explicitly (ink-runner); interactive sessions fall through to
        // persisted prefs, then 'local'.
        'Tool routing mode: local (ink-tool blocks handled by ink) or backend (native backend tools)'
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
      .option('--profile <name>', 'Apply security profile: minimal|safe|collaborative|full|tools')
      .option(
        '--require-profile <name>',
        'Apply a security profile and refuse to start without it (server spawns)'
      )
      .option(
        '--no-provider-tools',
        "Give the backend no tools or directory access of its own, only ink's (Claude, local routing)"
      )
      .option('--away', 'Start with away mode on (route tool approvals to inbox for 2FA)')
      .option('--auto-run', 'Automatically execute backend turns for new inbox task messages')
      .option('--session-candidates', 'List attachable ink sessions and exit')
      .option('--session-candidates-json', 'Output attachable ink sessions as JSON (testing/debug)')
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
      .option(
        '--require-bootstrap',
        'Exit non-zero if identity context cannot be loaded, instead of answering without it'
      )
      .option('--max-turns <n>', 'Run up to N conversational turns then exit (requires --message)')
      .option(
        '--backend-timeout-seconds <n>',
        'Hard ceiling for one backend turn, in seconds. Default: none — turns are governed by the idle/token-flow timeout (15 min without output in --non-interactive) plus a 4-hour runaway backstop.'
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
