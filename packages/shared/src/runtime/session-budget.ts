import { MAX_RELAY_BYTES } from './agent-loop.js';
import type { BackendTokenUsage } from './token-usage.js';

/** Share of the remaining window one relay may spend; the rest is the model's reply and the next turn. */
export const RELAY_HEADROOM_SHARE = 0.5;
/**
 * Bytes per token to assume when converting headroom into a relay budget —
 * and the reason budgets are in UTF-8 BYTES at all. No text tokenizes to
 * more tokens than its UTF-8 bytes (byte-level BPE bottoms out at one token
 * per byte), so 1 byte/token is a bound for any script; a chars-per-token
 * heuristic is not — the incident's JSON measured ~1.9 chars/token, and the
 * half-headroom promise failed below 0.75 UTF-16 chars/token (Lumen, PR #576
 * rounds 3–4). For ASCII JSON this is about twice as conservative as needed;
 * the payloads are in the transcript, and safety is the point.
 */
export const RELAY_BYTES_PER_TOKEN = 1;
/**
 * The floor a relay gets when the window has no headroom left: enough for a
 * stub per result that still names the tool and status, so the model is never
 * blind to what ran — at most 4K tokens, at the byte bound.
 */
export const MIN_RELAY_BUDGET_BYTES = 4_000;

const utf8Bytes = (text: string): number => new TextEncoder().encode(text).byteLength;

/**
 * What the provider's session holds after a reply, by its own accounting:
 * the prompt it was handed (input + cache parts for Anthropic, whose cache
 * fields are disjoint from input; input alone for OpenAI/Gemini, whose input
 * already includes the cache) plus the reply it produced — including hidden
 * thinking, which no byte count of the visible text could see (Lumen, PR
 * #576 round 5). Undefined when the backend reported nothing usable.
 */
export function occupancyTokens(
  backend: string,
  usage:
    | Pick<
        BackendTokenUsage,
        | 'inputTokens'
        | 'cacheReadTokens'
        | 'cacheWriteTokens'
        | 'outputTokens'
        | 'totalTokens'
        | 'reasoningTokens'
      >
    | undefined
): number | undefined {
  if (!usage) return undefined;
  const name = backend.toLowerCase();
  if (name === 'claude' || name === 'anthropic') {
    // Anthropic's cache fields are disjoint from input; its total is input +
    // output only, so the parts are summed here.
    const prompt = [usage.inputTokens, usage.cacheReadTokens, usage.cacheWriteTokens].filter(
      (n): n is number => n !== undefined
    );
    if (prompt.length === 0) return undefined;
    return prompt.reduce((a, b) => a + b, 0) + (usage.outputTokens ?? 0);
  }
  // OpenAI and Gemini: the reported total already includes the cached prompt
  // and hidden reasoning (Gemini's thoughtsTokenCount is part of
  // totalTokenCount); without a total, prompt + output + reasoning (Lumen,
  // PR #576 round 6).
  if (usage.totalTokens !== undefined) return usage.totalTokens;
  if (usage.inputTokens === undefined) return undefined;
  return usage.inputTokens + (usage.outputTokens ?? 0) + (usage.reasoningTokens ?? 0);
}

/**
 * The PROMPT part of a report — what the provider counted as handed to the
 * model, discovered instruction files, tool schemas and media included — per
 * backend accounting: input + cache parts for Anthropic, input alone for
 * OpenAI/Gemini (whose input already includes the cache). A stateless
 * parent's next envelope is this plus what the ledger grew since; the reply
 * is not re-sent and is not counted (Lumen, PR #576 rounds 5–10).
 */
export function promptTokensOf(
  backend: string,
  usage: Pick<BackendTokenUsage, 'inputTokens' | 'cacheReadTokens' | 'cacheWriteTokens'> | undefined
): number | undefined {
  if (!usage) return undefined;
  const name = backend.toLowerCase();
  if (name === 'claude' || name === 'anthropic') {
    const parts = [usage.inputTokens, usage.cacheReadTokens, usage.cacheWriteTokens].filter(
      (n): n is number => n !== undefined
    );
    return parts.length ? parts.reduce((a, b) => a + b, 0) : undefined;
  }
  return usage.inputTokens;
}

/**
 * The bytes a ledger entry costs once rendered into a stateless envelope —
 * its content, role and source in UTF-8, plus a per-entry allowance for the
 * framing the envelope adds around them. An over-approximation on purpose:
 * a tokens × 4 estimate charged 500 for a 1,483-byte Han entry and omitted
 * the framing entirely (Lumen, PR #576 round 11).
 */
export const LEDGER_ENTRY_FRAME_BYTES = 64;
export function ledgerEntryPromptBytes(entry: {
  role: string;
  content: string;
  source?: string;
  images?: ReadonlyArray<{ approxTokens: number }>;
}): number {
  return (
    utf8Bytes(entry.content) +
    utf8Bytes(entry.role) +
    utf8Bytes(entry.source ?? '') +
    LEDGER_ENTRY_FRAME_BYTES +
    // An image rides the spawn as a block, not as text, but it fills the
    // window all the same. Its token estimate stands in for bytes here, which
    // keeps the bound this function promises: never less than it costs.
    (entry.images ?? []).reduce((sum, image) => sum + image.approxTokens, 0)
  );
}

/**
 * How many UTF-8 bytes the next relay message may be, from the window's live
 * headroom: the window minus what it holds, times RELAY_HEADROOM_SHARE, at
 * RELAY_BYTES_PER_TOKEN — clamped between MIN_RELAY_BUDGET_BYTES and
 * MAX_RELAY_BYTES.
 *
 * What it holds is `occupancyTokens`, which the host supplies: for a native
 * session the provider's own count after the last reply — and NOTHING once a
 * later spawn reported no usage, because hidden thinking that was never
 * reported cannot be recovered from visible text (Lumen, PR #576 round 7);
 * for a stateless parent the previous request's PROMPT tokens as the provider
 * counted them (system prompt, discovered instruction files, tool schemas and
 * media included — nothing ink could measure from outside bounds those; Lumen,
 * PR #576 rounds 7–10) plus the exact rendered bytes of every ledger entry
 * added after that report and still present (by entry id — an eviction of
 * older entries can never net an addition away); the previous body is inside
 * the count and is not re-sent, which is slack in the safe direction. With no
 * occupancy the relay gets the floor.
 *
 * The one named assumption for a stateless parent: what the provider
 * discovers on its own (instruction files, tool schemas) is the same on the
 * next spawn as on the reported one. Ink drops the count to unknown whenever
 * the session-wide context generation moved since the report — any parent or
 * clone call of CONTEXT_MUTATING_TOOLS bumps it before running and again when
 * it settles, and no count is trusted while one is in flight, so an error after
 * a side effect and a spawn overlapping the mutation both count; drift caused
 * OUTSIDE this process — another
 * process editing AGENTS.md between spawns — is not detected and is accepted
 * as the limit of what the runtime can know (Lumen, PR #576 rounds 12–13).
 *
 * The bound is exact for the relay string. The floor is the one deliberate
 * exception: at exhausted headroom the model still receives a
 * MIN_RELAY_BUDGET_BYTES receipt of what ran, because a silent loop is worse
 * than a small overrun; the pre-turn compaction threshold is what keeps
 * headroom from reaching zero (Lumen, PR #576 rounds 2–7).
 */
export function relayBudgetBytes(
  runtime: { maxContextTokens: number },
  occupancyTokens?: number
): number {
  const occupied =
    occupancyTokens !== undefined ? Math.max(0, occupancyTokens) : runtime.maxContextTokens;
  const remainingTokens = Math.max(0, runtime.maxContextTokens - occupied);
  const bytes = Math.floor(remainingTokens * RELAY_BYTES_PER_TOKEN * RELAY_HEADROOM_SHARE);
  return Math.min(MAX_RELAY_BYTES, Math.max(MIN_RELAY_BUDGET_BYTES, bytes));
}
