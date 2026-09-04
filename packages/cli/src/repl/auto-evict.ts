/**
 * Automatic clearing of consumed tool results.
 *
 * A tool result is read once — in the continuation that follows the call —
 * and then sits in the window as a 500-character bookkeeping line for the
 * rest of the session. Over a long-lived session those lines are most of the
 * window (Myra, 2026-09-02: per-source costs of 24–255 tokens per entry over
 * thousands of entries; #571). The Claude API's context editing clears old
 * tool results server-side for the same reason; ink owns its own window, so
 * it does the same on the ledger — and the transcript keeps every payload.
 *
 * Policy only. The host applies the selection with the same persistent
 * eviction every other actor uses (a context_evict event), so replay
 * reproduces it, and it leaves one tombstone naming what went.
 */
import type { LedgerEntry } from './context-ledger.js';

/** Ledger source under which the REPL records local tool outcomes. */
export const LOCAL_TOOL_RESULT_SOURCE = 'local-tool';
/** Source of the tombstone an automatic sweep leaves behind. */
export const AUTO_EVICT_TOMBSTONE_SOURCE = 'auto-evict';
/** Results from the last N completed turns are never touched. */
export const AUTO_EVICT_KEEP_RECENT_TURNS = 2;
/** A sweep must free at least this many tokens to be worth rolling the provider session. */
export const AUTO_EVICT_MIN_TOKENS = 8_000;
/** …or this share of the effective budget, whichever is larger. */
export const AUTO_EVICT_MIN_SHARE = 0.05;

export interface AutoEvictSelection {
  ids: number[];
  tokens: number;
  /** Distinct tool names, in first-seen order. */
  tools: string[];
  /** Write-side calls whose result says they RAN: the effect stands. */
  receipts: string[];
  /** Write-side calls the runtime refused (blocked/denied): they did NOT happen. */
  refused: string[];
  /** Write-side calls that errored: whether the effect committed is unknown. */
  failed: string[];
  /** Read-side calls, by the audited set below: safe to re-run. */
  reads: string[];
}

/**
 * The tools whose results are pure reads — re-running one changes nothing.
 * An EXACT, audited set, not a name grammar: `get_thread_messages` advances
 * the recipient's durable read pointer and `download_*` write files under
 * ~/.ink/files, and both looked like reads by prefix (Lumen, PR #584 round
 * 3). Anything not listed here — a new tool, a `*_status` — is treated as a
 * write, the only safe default. The classification decides WORDING only; it
 * never decides what is cleared.
 */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  // ink-local
  'list_context',
  'describe_tool',
  // memory & context
  'bootstrap',
  'recall',
  'get_context',
  'get_memory_history',
  'get_user_history',
  'get_chat_context',
  'get_conversation_history',
  // mail & calendar & drive (reads only — download_* write files)
  'list_emails',
  'get_email',
  'list_email_labels',
  'list_calendars',
  'list_calendar_events',
  'get_calendar_event',
  'list_drive_files',
  'get_drive_file',
  'get_document',
  'get_spreadsheet',
  'get_sheet_values',
  // links, tasks, projects, reminders
  'search_links',
  'list_tasks',
  'list_task_groups',
  'get_task_stats',
  'get_task_graph',
  'list_graph_templates',
  'list_projects',
  'get_project',
  'list_reminders',
  'get_reminder_history',
  // artifacts & skills
  'list_artifacts',
  'get_artifact',
  'get_artifact_history',
  'search_artifacts',
  'list_artifact_comments',
  'list_skills',
  'get_skill',
  // sessions, studios, identity, workspace
  'list_sessions',
  'get_session',
  'get_session_context',
  'list_studios',
  'get_studio',
  'get_identity',
  'get_identity_history',
  'get_team_constitution',
  'get_user_identity',
  'get_user_identity_history',
  'get_timezone',
  'list_identities',
  'list_registered_agents',
  'get_agent_status',
  'get_agent_summaries',
  'get_activity',
  'get_activity_summary',
  'list_workspaces',
  'get_workspace',
  'list_threads',
  'list_thread_key_types',
  'get_integration_health',
  'get_cache_stats',
  'get_strategy_status',
  'list_permissions',
  'get_user_permissions',
  'query_audit_log',
  // mini-app reads
  'query_mini_app_records',
  'get_mini_app_record',
  'get_mini_app_balance',
  'list_mini_app_balances',
  'get_mini_app_debts',
]);

/** `mcp__inkwell__list_emails` → `list_emails`; a bare name is unchanged. */
function bareToolName(tool: string): string {
  const name = tool.trim().toLowerCase();
  const idx = name.lastIndexOf('__');
  return idx >= 0 ? name.slice(idx + 2) : name;
}

export function isWriteSideTool(tool: string): boolean {
  return !READ_ONLY_TOOLS.has(bareToolName(tool));
}

/** `local tool <name> -> …` — an executed result, as the REPL records it. */
const TOOL_NAME_RE = /^local tool ([A-Za-z_][\w.-]*) ->/;
/** `Local tool error|blocked|denied (<name>): …` — a refused or failed one. */
const OUTCOME_RE = /^Local tool (error|blocked|denied) \(([A-Za-z_][\w.-]*)\)/;

/**
 * Pick the consumed tool results to clear: `local-tool` entries that sit
 * BEFORE the last `keepRecentTurns` assistant entries (each completed turn
 * ends with one), when together they exceed `minTokens`. Anything in the
 * current or recent turns is untouched — a continuation still has to carry
 * them whole — and a sweep below the threshold is skipped, because every
 * eviction rolls the provider session and a small one is not worth that.
 */
export function selectConsumedToolResults(
  entries: ReadonlyArray<LedgerEntry>,
  opts: { keepRecentTurns?: number; minTokens?: number } = {}
): AutoEvictSelection | null {
  const keepRecentTurns = opts.keepRecentTurns ?? AUTO_EVICT_KEEP_RECENT_TURNS;
  const minTokens = opts.minTokens ?? AUTO_EVICT_MIN_TOKENS;

  // The boundary: the assistant entry that ENDS the turn before the protected
  // ones — the (keepRecentTurns + 1)-th most recent. A turn's results precede
  // its own assistant entry, so everything at or after this index belongs to
  // the protected recent turns (and the one in progress).
  let seen = 0;
  let boundary = -1;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (entries[i]!.role === 'assistant') {
      seen += 1;
      if (seen === keepRecentTurns + 1) {
        boundary = i;
        break;
      }
    }
  }
  if (boundary === -1) return null; // fewer completed turns than we protect

  const ids: number[] = [];
  const tools: string[] = [];
  const receipts: string[] = [];
  const refused: string[] = [];
  const failed: string[] = [];
  const reads: string[] = [];
  const add = (list: string[], name: string): void => {
    if (!list.includes(name)) list.push(name);
  };
  let tokens = 0;
  for (let i = 0; i < boundary; i += 1) {
    const e = entries[i]!;
    if (e.source !== LOCAL_TOOL_RESULT_SOURCE) continue;
    ids.push(e.id);
    tokens += e.approxTokens;
    // Outcome classes are kept apart: a refused or errored write is not a
    // receipt, and telling the model it "already happened" would make it
    // decline a retry the task still needs (Lumen, PR #584 round 3).
    const outcome = OUTCOME_RE.exec(e.content);
    const name = outcome?.[2] ?? TOOL_NAME_RE.exec(e.content)?.[1];
    if (!name) continue;
    add(tools, name);
    if (!isWriteSideTool(name)) add(reads, name);
    else if (!outcome) add(receipts, name);
    else if (outcome[1] === 'error') add(failed, name);
    else add(refused, name);
  }
  if (ids.length === 0 || tokens < minTokens) return null;
  return { ids, tokens, tools, receipts, refused, failed, reads };
}

/**
 * The one line left where the results were. It never claims success for a
 * call that did not run, and never invites a repeat of one that did: a
 * receipt is gone, its effect is not; a refusal did nothing; an error may
 * have done either.
 */
export function autoEvictTombstone(selection: AutoEvictSelection, keepRecentTurns: number): string {
  const parts: string[] = [];
  if (selection.receipts.length > 0) {
    parts.push(
      `write calls that RAN (${selection.receipts.join(', ')}) — their effects stand; do not repeat them. ` +
        'If you need what one returned (an id, a confirmation), read the current state back with a read tool instead of re-issuing the write'
    );
  }
  if (selection.refused.length > 0) {
    parts.push(
      `write calls the runtime REFUSED (${selection.refused.join(', ')}) — they did not happen; retry only if the task still needs them`
    );
  }
  if (selection.failed.length > 0) {
    parts.push(
      `write calls that ERRORED (${selection.failed.join(', ')}) — whether the effect committed is unknown; read the current state back before retrying`
    );
  }
  if (selection.reads.length > 0) {
    parts.push(
      `read calls (${selection.reads.join(', ')}) — re-run one only if you need its data again`
    );
  }
  return (
    `[${selection.ids.length} earlier tool results, ~${selection.tokens.toLocaleString()} tokens, ` +
    `were cleared from context automatically after they had been consumed (results older than ${keepRecentTurns} turns are cleared once they outgrow the threshold): ` +
    parts.join('; ') +
    '. The session transcript holds every one of them.]'
  );
}
