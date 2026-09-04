/**
 * Claude Code `--output-format stream-json` parser.
 *
 * Parses the JSONL Claude Code emits in print + stream-json mode into
 * provider-agnostic `BackendTurnEvent`s. Shape reference: Claude nests content
 * blocks under `assistant.message.content[]` (text, tool_use) and
 * `user.message.content[]` (tool_result), and emits a final `result` event
 * carrying `usage` and (usually empty) `result` text.
 *
 * Deliberately mirrors the CORRECT parse from
 * `packages/api/src/agent/backends/claude-code.backend.ts` (nested content,
 * cross-chunk line buffering, real usage field names) — NOT the older
 * `claude-runner.ts`, which reads top-level `tool_use`/`text` (a bug vs. the
 * real stream) and mislabels usage fields.
 */

import {
  providerContextTokens,
  type BackendTokenUsage,
  type BackendModelUsage,
  type ContextParts,
} from '../repl/token-usage.js';
import type { BackendStreamParser, BackendTurnEvent } from './stream.js';

interface ClaudeContentBlock {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  is_error?: boolean;
}

interface ClaudeStreamMessage {
  type?: string;
  subtype?: string;
  errors?: unknown[];
  result?: unknown;
  usage?: Record<string, unknown>;
  message?: { id?: string; content?: ClaudeContentBlock[]; usage?: Record<string, unknown> };
  /** Set on events that belong to a subagent's context, not this session's. */
  parent_tool_use_id?: string | null;
  session_id?: string;
  /** Model id serving the session (`system`/`init` event). */
  model?: string;
  /** Raw SSE event nested under `stream_event` (--include-partial-messages). */
  event?: {
    type?: string;
    delta?: { type?: string; text?: string };
  };
}

const NO_SESSION_MARKER = 'No conversation found with session ID';

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/**
 * Map Claude's `result.modelUsage` — the authoritative record of which models
 * actually served the query (subagents, aliases and fallbacks included), with
 * its own costUSD per model. Entries keep the keys Claude reports.
 */
function toModelUsage(raw: unknown): Record<string, BackendModelUsage> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const out: Record<string, BackendModelUsage> = {};
  for (const [model, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const entry = value as Record<string, unknown>;
    const fields = {
      inputTokens: num(entry.inputTokens),
      outputTokens: num(entry.outputTokens),
      cacheReadTokens: num(entry.cacheReadInputTokens),
      cacheWriteTokens: num(entry.cacheCreationInputTokens),
      costUSD: num(entry.costUSD),
    };
    // An entry with nothing numeric in it is unreadable, not a free turn.
    // Coercing it to zeros would publish "this model cost nothing" as though
    // it were measured — the same false certainty this whole accounting arc
    // exists to remove (Lumen, PR #500 round 1).
    if (Object.values(fields).every((v) => v === undefined)) continue;
    out[model] = {
      inputTokens: fields.inputTokens ?? 0,
      outputTokens: fields.outputTokens ?? 0,
      cacheReadTokens: fields.cacheReadTokens ?? 0,
      cacheWriteTokens: fields.cacheWriteTokens ?? 0,
      ...(fields.costUSD !== undefined ? { costUSD: fields.costUSD } : {}),
      ...(typeof entry.canonicalModel === 'string' ? { canonicalModel: entry.canonicalModel } : {}),
    };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** One request's prompt parts, from a usage object with Claude's field names. */
function requestParts(u: Record<string, unknown>): ContextParts | undefined {
  const parts = {
    inputTokens: num(u.input_tokens),
    cacheReadTokens: num(u.cache_read_input_tokens),
    cacheWriteTokens: num(u.cache_creation_input_tokens),
  };
  if (Object.values(parts).every((v) => v === undefined)) return undefined;
  return {
    ...(parts.inputTokens !== undefined ? { inputTokens: parts.inputTokens } : {}),
    ...(parts.cacheReadTokens !== undefined ? { cacheReadTokens: parts.cacheReadTokens } : {}),
    ...(parts.cacheWriteTokens !== undefined ? { cacheWriteTokens: parts.cacheWriteTokens } : {}),
  };
}

/**
 * The last EXECUTOR request in `result.usage.iterations`: searched backward
 * for a readable `type: "message"` entry. The array can end with a foreign
 * window — an `advisor_message` — and a failed run can leave it empty, so
 * the raw last entry is not it and there is no fallback (Lumen, PR #583
 * round 3; anthropics/claude-code#53065).
 */
function lastMessageIteration(raw: unknown): ContextParts | undefined {
  if (!Array.isArray(raw)) return undefined;
  for (let i = raw.length - 1; i >= 0; i -= 1) {
    const entry = raw[i];
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (e.type !== 'message') continue;
    const parts = requestParts(e);
    if (parts) return parts;
  }
  return undefined;
}

/**
 * Map Claude's `result.usage` object to BackendTokenUsage with the REAL field
 * names. The top-level fields are the agent run's AGGREGATE — one CLI spawn
 * may make several native tool/model iterations and they sum — and stay for
 * cost. The window the FINAL request was handed comes only from a
 * per-request sample: the newest top-level assistant message's usage
 * (`lastRequest`), else the last executor iteration; with neither, it is
 * UNKNOWN — the aggregate is never a stand-in for enforcement (Lumen, PR
 * #583 rounds 2–3).
 */
function toUsage(u: Record<string, unknown>, lastRequest?: ContextParts): BackendTokenUsage {
  const inputTokens = num(u.input_tokens);
  const outputTokens = num(u.output_tokens);
  const cacheReadTokens = num(u.cache_read_input_tokens);
  const cacheWriteTokens = num(u.cache_creation_input_tokens);
  const request = lastRequest ?? lastMessageIteration(u.iterations);
  const contextTokens = request ? providerContextTokens('claude', request) : undefined;
  return {
    backend: 'claude',
    source: 'json',
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    ...(contextTokens !== undefined && request ? { contextTokens, contextParts: request } : {}),
    totalTokens:
      inputTokens !== undefined && outputTokens !== undefined
        ? inputTokens + outputTokens
        : undefined,
    raw: u,
  };
}

export class ClaudeStreamParser implements BackendStreamParser {
  private buffer = '';
  /**
   * Text of the assistant message currently being assembled — the real final
   * response when `result` is empty or partial.
   *
   * Claude Code streams ONE `assistant` event per content block, all sharing
   * the API message's `message.id`. A response shaped text → thinking → text
   * therefore arrives as three events, and treating each as "the" assistant
   * message kept only the last block: an ink-tool fence in the first block was
   * never extracted, so the call silently never ran (Myra, 2026-09-02 9 PM —
   * the list_emails that "vanished"; #569). Blocks of the same message
   * accumulate here; a new message id starts over.
   */
  private lastAssistantText = '';
  private lastAssistantMessageId: string | undefined;
  /**
   * The newest top-level assistant message's own usage — one API request,
   * so its input + cache parts are the context that request was handed.
   * Subagent events (`parent_tool_use_id`) describe a different context and
   * are skipped, as claude-runner does (Lumen, PR #583 round 3).
   */
  private lastRequestUsage: ContextParts | undefined;

  push(chunk: string): BackendTurnEvent[] {
    this.buffer += chunk;
    const out: BackendTurnEvent[] = [];
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      this.consume(line, out);
    }
    return out;
  }

  end(): BackendTurnEvent[] {
    const out: BackendTurnEvent[] = [];
    if (this.buffer.trim()) this.consume(this.buffer, out);
    this.buffer = '';
    return out;
  }

  private consume(line: string, out: BackendTurnEvent[]): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let ev: ClaudeStreamMessage;
    try {
      ev = JSON.parse(trimmed) as ClaudeStreamMessage;
    } catch {
      return; // non-JSON chrome / partial — ignore
    }

    switch (ev.type) {
      case 'assistant': {
        if (!ev.parent_tool_use_id && ev.message?.usage && typeof ev.message.usage === 'object') {
          const parts = requestParts(ev.message.usage);
          if (parts) this.lastRequestUsage = parts;
        }
        const content = ev.message?.content;
        if (!Array.isArray(content)) break;
        // ONE text event per assistant stream event: its text blocks
        // concatenated, emitted before the event's tool-use events (text
        // blocks precede tool_use in practice, so display order is preserved).
        // A later text block of the SAME message (after a thinking block) is
        // flagged `continuesMessage` so consumers deduping against the final
        // text append rather than replace.
        let text = '';
        const toolUses: BackendTurnEvent[] = [];
        for (const block of content) {
          if (block.type === 'text' && typeof block.text === 'string' && block.text) {
            text += block.text;
          } else if (block.type === 'tool_use' && typeof block.name === 'string') {
            toolUses.push({ kind: 'tool-use', id: block.id, name: block.name, input: block.input });
          }
        }
        if (text) {
          const messageId = typeof ev.message?.id === 'string' ? ev.message.id : undefined;
          const continuesMessage =
            messageId !== undefined &&
            messageId === this.lastAssistantMessageId &&
            this.lastAssistantText.length > 0;
          out.push({ kind: 'text', text, ...(continuesMessage ? { continuesMessage } : {}) });
          this.lastAssistantText = continuesMessage ? this.lastAssistantText + text : text;
          this.lastAssistantMessageId = messageId;
        }
        out.push(...toolUses);
        break;
      }
      case 'user': {
        const content = ev.message?.content;
        if (!Array.isArray(content)) break;
        for (const block of content) {
          if (block.type === 'tool_result') {
            out.push({
              kind: 'tool-result',
              id: block.tool_use_id,
              isError: block.is_error === true,
            });
          }
        }
        break;
      }
      case 'result': {
        const resumeFailedNoSession =
          ev.subtype === 'error_during_execution' &&
          Array.isArray(ev.errors) &&
          ev.errors.some((e) => typeof e === 'string' && e.includes(NO_SESSION_MARKER));
        // `result` text is usually empty in stream-json; the real answer is the
        // last assistant text. Prefer a non-empty `result`, else fall back —
        // EXCEPT when a SUCCESSFUL `result` is only the final text block of
        // the assembled multi-block message (Claude Code reports per block):
        // the blocks before it must not be discarded, which is where the tool
        // fence lives.
        const resultText = typeof ev.result === 'string' && ev.result ? ev.result : undefined;
        const modelUsage = toModelUsage((ev as Record<string, unknown>).modelUsage);
        const assembled = this.lastAssistantText || undefined;
        // Any error subtype's result wins unconditionally: that text is the
        // diagnosis. And only a SUFFIX qualifies as the partial shape — an
        // `includes` test let assistant prose that merely mentioned the
        // result's words replace it (Lumen, PR #575 round 1).
        const resultIsError = typeof ev.subtype === 'string' && ev.subtype !== 'success';
        const text =
          resultText === undefined
            ? assembled
            : !resultIsError &&
                assembled !== undefined &&
                assembled.length > resultText.length &&
                assembled.endsWith(resultText)
              ? assembled
              : resultText;
        out.push({
          kind: 'result',
          text,
          usage: ev.usage
            ? { ...toUsage(ev.usage, this.lastRequestUsage), ...(modelUsage ? { modelUsage } : {}) }
            : undefined,
          resumeFailedNoSession: resumeFailedNoSession || undefined,
        });
        break;
      }
      case 'system': {
        // The init event names the model actually serving the session —
        // the ground truth for per-model context-window resolution.
        if (ev.subtype === 'init' && typeof ev.model === 'string' && ev.model) {
          out.push({ kind: 'model', model: ev.model });
        }
        break;
      }
      case 'stream_event': {
        // Partial-message text fragments (--include-partial-messages). Only
        // text deltas matter here — thinking/input_json deltas are noise for
        // display, and the completed `assistant` block event remains the
        // authoritative text (deltas never feed final-response extraction).
        const delta = ev.event?.type === 'content_block_delta' ? ev.event.delta : undefined;
        if (delta?.type === 'text_delta' && typeof delta.text === 'string' && delta.text) {
          out.push({ kind: 'text-delta', text: delta.text });
        }
        break;
      }
      default:
        break; // error / other chrome — not needed for the turn result
    }
  }
}
