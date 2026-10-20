/**
 * Provider-agnostic backend streaming seam.
 *
 * A backend adapter MAY implement `createStreamParser()` to declare that it
 * emits a parseable event stream (claude: `--output-format stream-json` today;
 * codex: `exec --json`; gemini can follow). The parser turns stdout chunks
 * into NORMALIZED turn events, which the runner uses for three things at once:
 *   1. per-event liveness (resets the idle/token-flow timeout),
 *   2. live emission (CLI + website streaming), and
 *   3. final-response + usage extraction.
 *
 * Kept intentionally small. We do NOT over-generalize
 * across providers yet; other parsers can map their own stdout into the
 * same union without touching this contract.
 */

import type { BackendTokenUsage } from '../runtime/token-usage.js';

/** Provider-local correlation inside ONE host-owned attempt, never authority. */
export interface BackendMessageSource {
  messageId: string;
  /** Absence of child metadata is not proof of parent origin. */
  origin: 'parent' | 'child' | 'unknown';
  parentToolUseId?: string;
}

export interface BackendTextSource extends BackendMessageSource {
  /** Native block index or stable completed-item/event ID, scoped to messageId. */
  blockId: string;
  /**
   * UTF-16 position within this block. Completed block snapshots start at zero.
   * Repeated snapshots retain their identity and text: an effect consumer must
   * reject conflicting text at the same position, not silently accept a rewrite.
   */
  offset: number;
}

export type BackendTurnEvent =
  /**
   * Completed assistant text: the text blocks of one `assistant` stream
   * event, concatenated. Final-response extraction uses the concatenation of
   * every text event of the same assistant MESSAGE — Claude Code streams one
   * event per content block, so a text → thinking → text response is two text
   * events. `continuesMessage` marks the second and later ones: a consumer
   * deduping streamed output against the final text must append, not replace.
   */
  | { kind: 'text'; text: string; continuesMessage?: boolean; source?: BackendTextSource }
  /**
   * Partial-message text fragment (claude: `--include-partial-messages`).
   * Contract: the completed message's `text` event ALWAYS follows its deltas
   * and carries the full concatenated text — consumers that render deltas
   * live must dedupe against it. Deltas never feed final-response extraction.
   */
  | { kind: 'text-delta'; text: string; source?: BackendTextSource }
  /**
   * Correlation boundaries only. Block end is not message end; message end is
   * not child exit. A cut stream can emit message-end too; complete requires
   * the backend's normal-completion evidence. Consumers may reconcile display
   * with these boundaries; none independently grants tool execution authority.
   */
  | {
      kind: 'text-boundary';
      boundary: 'message-start' | 'block-start' | 'block-end' | 'message-end';
      source: BackendMessageSource & { blockId?: string };
      /** Initial text on block-start, when supplied by the provider. */
      text?: string;
      complete?: boolean;
    }
  | { kind: 'tool-use'; id?: string; name: string; input?: unknown }
  | { kind: 'tool-result'; id?: string; isError?: boolean }
  /**
   * The provider announced which model is actually serving the session
   * (claude: the `system`/`init` event). Emitted once per turn, before any
   * text. Consumers use it to resolve the REAL context window instead of
   * guessing from backend defaults (context-limits.ts).
   */
  | { kind: 'model'; model: string }
  | {
      kind: 'result';
      text?: string;
      /** Identifies only the message this final text confirms, not all output. */
      source?: BackendMessageSource;
      usage?: BackendTokenUsage;
      /** A terminal provider/protocol failure, even if the child exits zero. */
      error?: string;
      /** The resumed provider session no longer exists (roll to a fresh seed). */
      resumeFailedNoSession?: boolean;
    };

/**
 * Stateful, single-request parser. One fresh instance per actual provider
 * attempt, even when a persistent child serves multiple requests — it owns a
 * cross-chunk line buffer, so a JSON line split across two stdout chunks is
 * reassembled rather than dropped.
 */
export interface BackendStreamParser {
  /** Feed a raw stdout chunk; returns any complete events it produced. */
  push(chunk: string): BackendTurnEvent[];
  /** Flush a trailing (newline-less) buffered line at end of stream. */
  end(): BackendTurnEvent[];
}
