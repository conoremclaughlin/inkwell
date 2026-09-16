/**
 * Provider-agnostic backend streaming seam.
 *
 * A backend adapter MAY implement `createStreamParser()` to declare that it
 * emits a parseable event stream (claude: `--output-format stream-json` today;
 * codex/gemini can follow). The parser turns raw stdout chunks into NORMALIZED
 * turn events, which the runner uses for three things at once:
 *   1. per-event liveness (resets the idle/token-flow timeout),
 *   2. live emission (CLI + website streaming), and
 *   3. final-response + usage extraction.
 *
 * Kept intentionally minimal — four event kinds. We do NOT over-generalize
 * across providers yet; codex/gemini parsers will map their own stdout into the
 * same union without touching this contract.
 */

import type { BackendTokenUsage } from '../repl/token-usage.js';

export type BackendTurnEvent =
  /**
   * Completed assistant text: the text blocks of one `assistant` stream
   * event, concatenated. Final-response extraction uses the concatenation of
   * every text event of the same assistant MESSAGE — Claude Code streams one
   * event per content block, so a text → thinking → text response is two text
   * events. `continuesMessage` marks the second and later ones: a consumer
   * deduping streamed output against the final text must append, not replace.
   */
  | { kind: 'text'; text: string; continuesMessage?: boolean }
  /**
   * Partial-message text fragment (claude: `--include-partial-messages`).
   * Contract: the completed message's `text` event ALWAYS follows its deltas
   * and carries the full concatenated text — consumers that render deltas
   * live must dedupe against it. Deltas never feed final-response extraction.
   */
  | { kind: 'text-delta'; text: string }
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
      usage?: BackendTokenUsage;
      /** The resumed provider session no longer exists (roll to a fresh seed). */
      resumeFailedNoSession?: boolean;
    };

/**
 * Stateful, single-turn parser. One fresh instance per turn — it owns a
 * cross-chunk line buffer, so a JSON line split across two stdout chunks is
 * reassembled rather than dropped.
 */
export interface BackendStreamParser {
  /** Feed a raw stdout chunk; returns any complete events it produced. */
  push(chunk: string): BackendTurnEvent[];
  /** Flush a trailing (newline-less) buffered line at end of stream. */
  end(): BackendTurnEvent[];
}
