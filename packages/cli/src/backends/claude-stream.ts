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

import type { BackendTokenUsage, BackendModelUsage } from '../repl/token-usage.js';
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
  message?: { content?: ClaudeContentBlock[] };
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
      costUSD: fields.costUSD ?? 0,
      ...(typeof entry.canonicalModel === 'string' ? { canonicalModel: entry.canonicalModel } : {}),
    };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Map Claude's `result.usage` object to BackendTokenUsage with the REAL field names. */
function toUsage(u: Record<string, unknown>): BackendTokenUsage {
  const inputTokens = num(u.input_tokens);
  const outputTokens = num(u.output_tokens);
  const cacheReadTokens = num(u.cache_read_input_tokens);
  const cacheWriteTokens = num(u.cache_creation_input_tokens);
  return {
    backend: 'claude',
    source: 'json',
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens:
      inputTokens !== undefined && outputTokens !== undefined
        ? inputTokens + outputTokens
        : undefined,
    raw: u,
  };
}

export class ClaudeStreamParser implements BackendStreamParser {
  private buffer = '';
  /** Last non-empty assistant text — the real final response when `result` is empty. */
  private lastAssistantText = '';

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
        const content = ev.message?.content;
        if (!Array.isArray(content)) break;
        // ONE message-level text event per assistant message: all text blocks
        // concatenated, matching exactly what final-response extraction uses
        // (lastAssistantText) — so consumers can dedupe streamed output
        // against the final text by simple equality. Emitted before the
        // message's tool-use events (text blocks precede tool_use in
        // practice, so display order is preserved).
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
          out.push({ kind: 'text', text });
          this.lastAssistantText = text;
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
        // last assistant text. Prefer a non-empty `result`, else fall back.
        const resultText = typeof ev.result === 'string' && ev.result ? ev.result : undefined;
        const modelUsage = toModelUsage((ev as Record<string, unknown>).modelUsage);
        const text = resultText ?? (this.lastAssistantText || undefined);
        out.push({
          kind: 'result',
          text,
          usage: ev.usage
            ? { ...toUsage(ev.usage), ...(modelUsage ? { modelUsage } : {}) }
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
