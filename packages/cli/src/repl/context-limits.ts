/**
 * Per-model context-window limits + ink's working-budget derivation.
 *
 * The keystone principle (task 17d212ff): **ink owns compaction, not the
 * provider.** For that to hold, ink must know each model's REAL context window
 * and keep its own working budget comfortably below where the provider (Claude
 * Code, codex, gemini) would run its OWN auto-compaction. If we over-estimate a
 * window, ink compacts too late and the provider compacts first — the exact
 * failure this table exists to prevent.
 *
 * So every value here is deliberately CONSERVATIVE. The two directions are not
 * symmetric:
 *   - under-estimating a window → ink compacts a little early (harmless).
 *   - over-estimating a window  → the provider compacts first (the bug).
 * When unsure, round DOWN.
 */

/**
 * The provider auto-compacts as its native session approaches full. We don't
 * know each provider's exact trigger and it can move between releases, so we
 * assume the provider may compact once its session is this fraction of the
 * model's window full, and keep ink's ENTIRE working budget at or below it.
 *
 * Claude Code has historically compacted around ~90–92% full; 0.85 leaves a
 * safety margin under even an aggressive provider. Combined with the 0.8
 * in-budget compaction threshold (AUTO_COMPACT_THRESHOLD_PCT in chat.ts), ink
 * compacts by ~0.68 × window in the worst case (a small-window model whose
 * budget equals the headroom slice) — well ahead of any provider auto-compact.
 */
export const PROVIDER_HEADROOM_PCT = 0.85;

/**
 * ink's working budget is also hard-capped here regardless of window: a
 * deliberately smaller slice than a huge (1M/2M) window so turns stay tight and
 * argv size / latency don't degrade before we ever approach the provider's
 * trigger. This is the historical DEFAULT_MAX_CONTEXT_TOKENS.
 */
export const INK_WORKING_BUDGET_CAP = 200_000;

/**
 * Fallback window for a model we don't recognize. A SAFE default: small enough
 * that an unknown model with a modest window still gets ink-first compaction.
 * Any model with a genuinely smaller window MUST be added to the table below —
 * do NOT rely on this fallback for sub-200K models.
 */
export const DEFAULT_MODEL_CONTEXT_WINDOW = 200_000;

/**
 * Real total context windows (tokens) keyed by lowercased model-id prefix.
 * Longest matching prefix wins, so `gpt-5` beats `gpt-`. Conservative on
 * purpose (see file header). Add new / smaller-window models here.
 */
export const MODEL_CONTEXT_WINDOWS: ReadonlyArray<readonly [string, number]> = [
  // Anthropic / Claude Code. Standard API window is 200K across Opus / Sonnet /
  // Haiku / Fable. Sonnet's 1M beta is intentionally NOT assumed — Claude Code
  // does not enable it by default, and assuming 200K keeps ink safely ahead.
  // Kept as family entries (not one `claude-` line) so bumping a single family
  // to a larger window later is a one-line change.
  ['claude-opus', 200_000],
  ['claude-sonnet', 200_000],
  ['claude-haiku', 200_000],
  ['claude-fable', 200_000],
  ['claude-', 200_000],

  // OpenAI / codex. GPT-5 / GPT-5-Codex carry large windows; 256K is a
  // conservative floor for those SPECIFIC prefixes. Older gpt-4-class is 128K.
  // The broad `codex` prefix (and the codex backend default below) must stay at
  // 200K: `codex-mini-latest` is a 200K-window model, and extending 256K to all
  // `codex-*` would overestimate it — the unsafe direction. Larger codex windows
  // belong on specific gpt-5-codex prefixes above, never on the broad entry.
  ['gpt-5', 256_000],
  ['gpt-4', 128_000],
  ['gpt-', 128_000],
  ['o3', 200_000],
  ['o4', 200_000],
  ['codex', 200_000],

  // Google / gemini. 1M+ windows; assume 1M conservatively (2M variants exist).
  ['gemini-2', 1_000_000],
  ['gemini-1.5', 1_000_000],
  ['gemini-', 1_000_000],
];

/**
 * Conservative window for a backend's *default* model (when no model id is
 * given). Never larger than the smallest window that backend routinely uses.
 */
function backendDefaultWindow(backend: string): number {
  switch (backend) {
    case 'gemini':
      return 1_000_000;
    case 'codex':
      // codex-mini-latest is a 200K-window model; the codex default must not
      // exceed it. (Specific gpt-5-codex prefixes get their larger window via
      // the table.)
      return 200_000;
    case 'claude':
      return 200_000;
    default:
      return DEFAULT_MODEL_CONTEXT_WINDOW;
  }
}

/**
 * Resolve a model's real context window (tokens). Prefers an explicit model id
 * (longest prefix match, case-insensitive); falls back to a conservative
 * per-backend default; then the global safe default.
 */
export function resolveModelContextWindow(backend: string, model?: string): number {
  const id = (model ?? '').trim().toLowerCase();
  if (id) {
    let best: number | undefined;
    let bestLen = -1;
    for (const [prefix, window] of MODEL_CONTEXT_WINDOWS) {
      if (id.startsWith(prefix) && prefix.length > bestLen) {
        best = window;
        bestLen = prefix.length;
      }
    }
    if (best !== undefined) return best;
  }
  return backendDefaultWindow(backend);
}

/**
 * ink's working budget for a given real window: the smaller of the global cap
 * and the provider-headroom slice of the window. This is what guarantees ink's
 * budget — and therefore its 80%-of-budget compaction point — sits below the
 * provider's own auto-compaction trigger.
 */
export function contextBudgetForWindow(window: number): number {
  const headroom = Math.floor(window * PROVIDER_HEADROOM_PCT);
  return Math.max(1, Math.min(INK_WORKING_BUDGET_CAP, headroom));
}
