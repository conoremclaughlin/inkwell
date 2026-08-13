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
 * Absolute ceiling on ink's working budget for STDIN-transport backends.
 * Historically 200K (DEFAULT_MAX_CONTEXT_TOKENS) for every backend; raised to
 * 1M on Conor's direction (2026-08-12) so 1M-window models get 1M-class
 * budgets — stdin delivery has no argv ceiling, and the reseed-latency trade
 * is accepted. The PROVIDER_HEADROOM_PCT slice still binds first for every
 * real window ≤ 1M (a 1M window yields an 850K working budget); this cap only
 * clips hypothetical 2M-window models.
 */
export const INK_WORKING_BUDGET_CAP = 1_000_000;

/**
 * Ceiling for ARGV-transport backends (codex `exec <prompt>`, gemini
 * `-p <prompt>`): the full reseed prompt rides a single positional argument,
 * bounded by the OS ARG_MAX (~1MB total on macOS). An 850K-token budget would
 * produce multi-MB argv and fail the spawn outright (Lumen, PR #477 review —
 * finding 1), so argv backends keep the historical 200K ceiling — at the 80%
 * compaction threshold that is a ~680KB reseed, safely under ARG_MAX.
 * Migrating an adapter to stdin delivery (BackendAdapter.promptTransport)
 * is what unlocks the large cap for its backend.
 */
export const ARGV_TRANSPORT_BUDGET_CAP = 200_000;

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
  // Anthropic / Claude Code. Fable 5 and Opus 5 carry 1M windows (confirmed by
  // Conor, 2026-08-12 — task 6725439e); older Opus / Sonnet / Haiku stay at the
  // standard 200K. Sonnet's 1M beta is intentionally NOT assumed — Claude Code
  // does not enable it by default, and assuming 200K keeps ink safely ahead.
  // Sessions normally resolve through the stream-reported model id (the
  // `system`/`init` event), so these prefixes match REAL model ids, not
  // guesses from backend defaults.
  ['claude-fable-5', 1_000_000],
  ['claude-opus-5', 1_000_000],
  ['claude-opus', 200_000],
  ['claude-sonnet', 200_000],
  ['claude-haiku', 200_000],
  // Only Fable 5 is CONFIRMED at 1M; unknown future fable versions fall back
  // to the conservative family entry until verified (round DOWN — file header).
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
 * ink's working budget for a given real window: the smaller of the
 * transport-specific cap and the provider-headroom slice of the window. The
 * headroom slice is what guarantees ink's budget — and therefore its
 * 80%-of-budget compaction point — sits below the provider's own
 * auto-compaction trigger; the transport cap is what keeps argv-delivered
 * reseed prompts under the OS ARG_MAX. Pass the ADAPTER's declared transport
 * (backends: promptTransportFor), never a guess.
 */
export function contextBudgetForWindow(window: number, transport: 'stdin' | 'argv'): number {
  const cap = transport === 'stdin' ? INK_WORKING_BUDGET_CAP : ARGV_TRANSPORT_BUDGET_CAP;
  const headroom = Math.floor(window * PROVIDER_HEADROOM_PCT);
  return Math.max(1, Math.min(cap, headroom));
}
