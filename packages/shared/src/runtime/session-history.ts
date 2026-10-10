/**
 * Existing Ink session restoration, shared by hosts. Hosts load transcript
 * events or session-context records; this module only rebuilds the ledger and
 * its replay projection. It never starts a turn or replays an external effect.
 */
import { ContextLedger, type LedgerRole, type LedgerReplayMeta } from './context-ledger.js';
import type { ProviderSampleScope } from './provider-sample.js';
import { classifyActivity } from './activity-render.js';
import { formatFanOutForLedger, MAX_CLONE_SUMMARY_CHARS } from './clone-outcomes.js';
import { AUTO_EVICT_TOMBSTONE_SOURCE } from './auto-evict.js';
import { readRecordedContextImages } from './context-media.js';
import { isClientLocalTool } from './context-tools.js';
import { isCloneHandoffTool } from './spawn-agent.js';
import { readSessionSteeringInput } from './session-steering.js';

export interface HistoryHydrationResult {
  loaded: number;
  messageCount: number;
  source: 'repl-transcript' | 'ink-session-context' | 'none';
  transcriptPath?: string;
  tailPreview: Array<{
    /** 'event' rows are dim progress lines (tool calls) — not messages */
    role: 'user' | 'assistant' | 'inbox' | 'system' | 'event';
    content: string;
    ts?: string;
    /**
     * Display label override: system entries ("heartbeat", "continuation")
     * and replayed platform messages ("📤 myra → telegram").
     */
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
export interface EvictedEntryRecord {
  role: LedgerRole;
  content: string;
  source?: string;
  eid?: number;
  actor?: string;
  reason?: string;
}

export const EVICTED_DISPLAY_MAX = 100;

export interface SessionContextMessage {
  role: 'user' | 'assistant' | 'inbox' | 'system';
  content: string;
  ts?: string;
  source: string;
}

const LEDGER_COMPACT_CHARS = 420;
const HISTORY_PREVIEW_MAX = 200;

/** A `provider_sample` transcript event, as the next process replays it. */
export interface PersistedProviderSample {
  at: string;
  scope: ProviderSampleScope;
  contextTokens: number;
  inputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export function readProviderSampleEvent(
  event: Record<string, unknown>
): PersistedProviderSample | undefined {
  const str = (k: string): string | undefined =>
    typeof event[k] === 'string' ? (event[k] as string) : undefined;
  const n = (k: string): number | undefined =>
    typeof event[k] === 'number' && Number.isFinite(event[k] as number)
      ? (event[k] as number)
      : undefined;
  const contextTokens = n('contextTokens');
  const backend = str('backend');
  const at = str('at');
  if (contextTokens === undefined || contextTokens <= 0 || !backend || !at) return undefined;
  return {
    at,
    scope: {
      backend,
      model: str('model'),
      backendSessionId: str('backendSessionId'),
      envelopeShape: str('envelopeShape'),
    },
    contextTokens,
    inputTokens: n('inputTokens'),
    cacheReadTokens: n('cacheReadTokens'),
    cacheWriteTokens: n('cacheWriteTokens'),
  };
}

/** The same reducer is driven by either a CLI array or an async host stream. */
export type LedgerHydration = {
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
  toolCalls: Array<{ tool: string; status: string; at: string; args?: string; result?: string }>;
  /** Highest event id seen — seeds the append counter so new eids continue */
  maxEid: number;
  /**
   * The provider's last measurement, when no context-boundary mutation
   * followed it — so a new process budgets against it from its first
   * pre-turn check (Lumen, PR #583 round 2).
   */
  providerSample?: PersistedProviderSample;
};

/** Replay a host-loaded snapshot without changing the CLI's synchronous API. */
export function hydrateLedgerFromEvents(
  ledger: ContextLedger,
  events: readonly Record<string, unknown>[],
  sbSlug?: string
): LedgerHydration {
  const replay = ledgerHydration(ledger, sbSlug);
  replay.next();
  for (const event of events) replay.next(event);
  return replay.next(undefined).value!;
}

/** Hosts supply cancellation/yielding through the iterator; no file-sized array. */
export async function hydrateLedgerFromEventStream(
  ledger: ContextLedger,
  events: AsyncIterable<Record<string, unknown>> | Iterable<Record<string, unknown>>,
  sbSlug?: string,
  observe?: (event: Record<string, unknown>) => void
): Promise<LedgerHydration> {
  const replay = ledgerHydration(ledger, sbSlug);
  replay.next();
  for await (const event of events) {
    observe?.(event);
    replay.next(event);
  }
  return replay.next(undefined).value!;
}

function* ledgerHydration(
  ledger: ContextLedger,
  sbSlug?: string
): Generator<undefined, LedgerHydration, Record<string, unknown> | undefined> {
  let loaded = 0;
  let messageCount = 0;
  let compactionCollapsed = false;
  let maxEid = 0;
  let providerSample: PersistedProviderSample | undefined;
  const preview: HistoryHydrationResult['tailPreview'] = [];
  const seenInboxIds = new Set<string>();
  const seenActivityIds = new Set<string>();
  const recoveredMemoryIds: string[] = [];
  const evictedEntries: EvictedEntryRecord[] = [];
  const toolCalls: Array<{
    tool: string;
    status: string;
    at: string;
    args?: string;
    result?: string;
  }> = [];
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

  for (let event = yield; event !== undefined; event = yield) {
    const type = typeof event.type === 'string' ? event.type : '';
    const eid = typeof event.eid === 'number' ? event.eid : undefined;
    if (eid !== undefined && eid > maxEid) maxEid = eid;
    if (type === 'provider_sample') {
      providerSample = readProviderSampleEvent(event);
      continue;
    }
    if (
      type === 'context_evict' ||
      type === 'context_trim' ||
      type === 'compaction' ||
      type === 'context_budget_changed' ||
      type === 'steering_input' ||
      type === 'backend_session_invalidated'
    ) {
      // The window it measured is gone — live, the same mutations clear it.
      providerSample = undefined;
    }
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
      loaded = 0;
      messageCount = 0;
      // Reset the visible replay too — pre-compaction turns are out of
      // context and must not appear below the cutoff divider. The kept
      // tail is re-added below from the event's keptEntries.
      preview.length = 0;
      compactionCollapsed = true;
      const keptEntries = Array.isArray(event.keptEntries) ? event.keptEntries : [];
      // The summary goes where the live ledger put it, not always at the front.
      // An oldest-N compaction removes a prefix, so its summary IS the first
      // entry and every event written before `summaryIndex` existed means that
      // — hence the 0 default, which replays legacy events unchanged. A
      // ref-selected consolidation removes a named set that can start
      // mid-ledger, and there the summary takes the first removed entry's
      // place; replaying it at the front would hand the reattached session the
      // same entries in a different order than it held live.
      const summaryIndex =
        typeof event.summaryIndex === 'number' && Number.isFinite(event.summaryIndex)
          ? Math.max(0, Math.min(Math.floor(event.summaryIndex), keptEntries.length))
          : 0;
      const addSummary = (): void => {
        const summaryEntry = ledger.addEntry(
          'system',
          event.summary as string,
          'compaction-history'
        );
        hydratedEntryIds.push(summaryEntry.id);
        loaded += 1;
      };
      // Positioned against the SERIALIZED array, not against how many entries
      // were successfully added: `summaryIndex` indexes the kept list as it was
      // written, and a malformed record skipped below would otherwise slide the
      // summary one place left of where it sat.
      for (let ki = 0; ki < keptEntries.length; ki++) {
        if (ki === summaryIndex) addSummary();
        const kept = keptEntries[ki];
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
        const keptReplay = parseReplayMeta(keptRecord.replay);
        const entry = ledger.addEntry(
          role,
          keptRecord.content,
          source,
          keptEid,
          keptReplay,
          undefined,
          readRecordedContextImages(keptRecord.media)
        );
        hydratedEntryIds.push(entry.id);
        loaded += 1;
        if (keptReplay) {
          // A platform message in the protected tail: replay the SAME
          // directional block the live session showed — the compact ⚡
          // ledger line is context bookkeeping, not the visible message.
          messageCount += 1;
          pushPreview(keptReplay.role, keptReplay.body, keptReplay.at, keptReplay.label, keptEid);
        } else if (role === 'user' || role === 'assistant' || role === 'inbox') {
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
      // Consolidating the newest entries leaves no survivor after them, so the
      // summary is last. The clamp above caps the index at keptEntries.length,
      // which is exactly this case — and it also covers an empty kept list,
      // where the summary is the whole ledger.
      if (summaryIndex >= keptEntries.length) addSummary();
      continue;
    }
    if (type === 'steering_input') {
      const input = readSessionSteeringInput(event);
      if (!input) continue;
      const entry = ledger.addEntry('user', input.text, 'steering', eid);
      hydratedEntryIds.push(entry.id);
      loaded += 1;
      messageCount += 1;
      pushPreview(
        'user',
        input.text,
        typeof event.ts === 'string' ? event.ts : undefined,
        'steering',
        eid
      );
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
    if (type === 'context_note' && typeof event.content === 'string') {
      // A runtime notice that belongs in the window — today the auto-evict
      // tombstone. Replayed as the system entry it was live, so a reattached
      // process knows why earlier tool results are missing (PR #584).
      const source = typeof event.source === 'string' ? event.source : 'context-note';
      const entry = ledger.addEntry('system', event.content, source, eid);
      hydratedEntryIds.push(entry.id);
      loaded += 1;
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
    if (type === 'clone_fanout' && Array.isArray(event.outcomes)) {
      // The clones' summaries are the parent's ONLY record of that work — their
      // own transcripts are separate files the parent never replays. Without
      // this branch a reattached parent loses every clone result it paid for.
      const outcomes = event.outcomes as Array<Record<string, unknown>>;
      const rendered = formatFanOutForLedger(
        outcomes.map((o) => ({
          id: String(o.id ?? '?'),
          label: String(o.label ?? ''),
          status: String(o.status ?? 'unknown'),
          summary: typeof o.summary === 'string' ? o.summary : undefined,
          error: typeof o.error === 'string' ? o.error : undefined,
        }))
      );
      const entry = ledger.addEntry(
        'system',
        rendered.length > MAX_CLONE_SUMMARY_CHARS
          ? `${rendered.slice(0, MAX_CLONE_SUMMARY_CHARS)}…`
          : rendered,
        'shadow-clone',
        eid
      );
      // Tracked like every other replayed entry: a later compaction event in
      // the same transcript evicts everything hydrated before it. Dropping the
      // id here leaves the superseded fan-out sitting alongside the compacted
      // summary that replaced it.
      hydratedEntryIds.push(entry.id);
      loaded += 1;
      continue;
    }

    if (type === 'local_tool_call' && typeof event.tool === 'string') {
      // Only the new path-free media envelope restores a tool ledger entry.
      // Legacy tool results stay display-only; context/clone tools never reinsert
      // the entries they removed or handed off. Preserve exact content and eid
      // so unavailable-image notes cannot make durable eviction refs drift.
      const media = event.imageContext as Record<string, unknown> | undefined;
      if (
        media &&
        media.version === 1 &&
        typeof media.content === 'string' &&
        media.content.length <= 8192 &&
        (event.status === 'executed' || event.status === 'approved') &&
        !isClientLocalTool(event.tool) &&
        !isCloneHandoffTool(event.tool)
      ) {
        const images = readRecordedContextImages(media.images);
        if (images.length) {
          const entry = ledger.addEntry(
            'system',
            media.content,
            'local-tool',
            eid,
            undefined,
            undefined,
            images
          );
          hydratedEntryIds.push(entry.id);
          loaded += 1;
        }
      }
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
        `🛠 ${sbSlug ? `${sbSlug} · ` : ''}${event.tool} (${status})${argsPreview ? ` — ${argsPreview}` : ''}`,
        typeof event.ts === 'string' ? event.ts : undefined,
        undefined,
        eid
      );
      // Blocked/denied rows persist `reason` and thrown errors persist
      // `error` instead of `result` — fall back so Ctrl+T keeps those
      // details across reattach, matching the live recentToolCalls entries.
      const resultSource = event.result ?? event.reason ?? event.error;
      const resultJson =
        resultSource !== undefined
          ? (typeof resultSource === 'string'
              ? resultSource
              : JSON.stringify(resultSource)
            ).replace(/\s+/g, ' ')
          : '';
      toolCalls.push({
        tool: event.tool,
        status,
        at: typeof event.ts === 'string' ? event.ts : '',
        args: argsJson
          ? argsJson.length > 400
            ? `${argsJson.slice(0, 400)}…`
            : argsJson
          : undefined,
        result: resultJson
          ? resultJson.length > 2000
            ? `${resultJson.slice(0, 2000)}…`
            : resultJson
          : undefined,
      });
      if (toolCalls.length > 100) {
        toolCalls.splice(0, toolCalls.length - 100);
      }
      continue;
    }
    if (type === 'activity' && typeof event.content === 'string') {
      const actor = typeof event.sbSlug === 'string' ? event.sbSlug : 'system';
      const activityType = typeof event.activityType === 'string' ? event.activityType : 'activity';
      // Platform messages are real conversation: replay them as the same
      // directional message blocks the live activity poll renders, so a
      // reattached session shows what the agent actually SENT/received —
      // not only the collapsed send_response receipt. Same classification
      // as live; the recovered seenActivityIds keep the live poll from
      // rendering these again after reattach.
      const plan = classifyActivity(
        {
          type: activityType,
          subtype: typeof event.activitySubtype === 'string' ? event.activitySubtype : undefined,
          sbSlug: typeof event.sbSlug === 'string' ? event.sbSlug : undefined,
          platform: typeof event.platform === 'string' ? event.platform : undefined,
          fromSlug: typeof event.fromSlug === 'string' ? event.fromSlug : undefined,
        },
        sbSlug ?? actor
      );
      const activityTs =
        typeof event.createdAt === 'string'
          ? event.createdAt
          : typeof event.ts === 'string'
            ? event.ts
            : undefined;
      const replayMeta =
        (plan.mode === 'message-in' || plan.mode === 'message-out') &&
        plan.role &&
        plan.label &&
        event.content.trim()
          ? {
              role: plan.role,
              label: plan.label,
              body: event.content,
              ...(activityTs ? { at: activityTs } : {}),
            }
          : undefined;
      // The replay metadata rides on the LEDGER entry too, so a compaction
      // in THIS process serializes it into keptEntries and the block
      // survives the next detach/reattach cycle as well.
      const entry = ledger.addEntry(
        'system',
        compactForLedger(`⚡ ${actor} ${activityType} — ${event.content}`, 320),
        'ink-activity-history',
        eid,
        replayMeta
      );
      hydratedEntryIds.push(entry.id);
      loaded += 1;
      if (typeof event.activityId === 'string') {
        seenActivityIds.add(event.activityId);
      }
      if (replayMeta) {
        pushPreview(replayMeta.role, replayMeta.body, replayMeta.at, replayMeta.label, eid);
        messageCount += 1;
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
    ...(providerSample ? { providerSample } : {}),
  };
}

export function compactForLedger(content: string, maxChars = LEDGER_COMPACT_CHARS): string {
  const normalized = content.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(1, maxChars - 1))}…`;
}

// System-entry sources that are runtime bookkeeping, not conversation —
// excluded from the visible history replay (they stay in the ledger).
/** Validate replay metadata recovered from a transcript record. */
function parseReplayMeta(raw: unknown): LedgerReplayMeta | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (r.role !== 'user' && r.role !== 'assistant') return undefined;
  if (typeof r.label !== 'string' || !r.label) return undefined;
  if (typeof r.body !== 'string' || !r.body) return undefined;
  return {
    role: r.role,
    label: r.label,
    body: r.body,
    ...(typeof r.at === 'string' ? { at: r.at } : {}),
  };
}

/**
 * Serialize the post-compaction ledger tail for the compaction transcript
 * event. The event is the COMPLETE new start state — hydration rebuilds the
 * ledger AND the visible replay from it — so each kept entry carries its
 * replay metadata (platform message blocks) alongside role/content/source.
 * Without it, a platform send in the protected tail degrades to its compact
 * ⚡ bookkeeping line after compact → detach → reattach (Lumen, PR #478).
 */
export function keptEntriesForCompaction(ledger: ContextLedger): Array<Record<string, unknown>> {
  return ledger
    .listEntries()
    .slice(1) // entry 0 is the summary itself
    .map((e) => ({
      role: e.role,
      content: e.content,
      source: e.source,
      ...(e.eid !== undefined ? { eid: e.eid } : {}),
      ...(e.replay !== undefined ? { replay: e.replay } : {}),
      ...(e.media !== undefined ? { media: e.media } : {}),
    }));
}

const INTERNAL_SYSTEM_SOURCES: ReadonlySet<string> = new Set([
  'continuation',
  'compaction-tail',
  'compaction-history',
  'ink-activity',
  'ink-activity-history',
  // Written before #659. Ledger entries persist and are replayed, so the old
  // source values still arrive and must stay internal — otherwise every
  // pre-rename activity line reappears as a visible system turn.
  'pcp-activity',
  'pcp-activity-history',
  'passive-recall',
  'budget-monitor',
  'auto-run',
  'hook-history',
  'bootstrap',
  // The auto-evict tombstone (and a context note's fallback source): a
  // runtime notice for the model, never a visible system message — through
  // a compaction's kept tail as well as by direct replay (Lumen, PR #584
  // round 3).
  AUTO_EVICT_TOMBSTONE_SOURCE,
  'context-note',
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

export function extractSessionContextMessages(
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

export function hydrateLedgerFromSessionContext(
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
      ledger.addEntry('user', message.content, `ink-history:${message.source}`);
      loaded += 1;
      messageCount += 1;
      pushPreview('user', message.content, message.ts);
      continue;
    }
    if (message.role === 'assistant') {
      ledger.addEntry('assistant', message.content, `ink-history:${message.source}`);
      loaded += 1;
      messageCount += 1;
      pushPreview('assistant', message.content, message.ts);
      continue;
    }
    if (message.role === 'inbox') {
      ledger.addEntry('inbox', compactForLedger(message.content), `ink-history:${message.source}`);
      loaded += 1;
      messageCount += 1;
      pushPreview('inbox', message.content, message.ts);
      continue;
    }

    ledger.addEntry(
      'system',
      compactForLedger(message.content, 320),
      `ink-history:${message.source}`
    );
    loaded += 1;
  }

  return {
    loaded,
    messageCount,
    source: 'ink-session-context',
    tailPreview: preview,
  };
}
