/**
 * Which provider `ink chat` runs for an ordinary SB's ink turn, read from the
 * provider its identity names (agent_identities.provider). InkRunner used to
 * name none, so `ink chat` ran its own default, Claude, whatever the identity
 * said: an SB set to Codex ran the Claude CLI, handed a Codex model id when
 * one was configured (task f5acf0f5).
 *
 * - None named: nothing is passed, and the chat's default runs, as before.
 * - Claude or Codex: passed explicitly, so the model the server picks for
 *   that provider meets the provider that runs it.
 * - Anything else: refused by name, never left to run as Claude.
 *
 * Funding and configuration are untouched: the spawn's environment is what
 * it was. An inkling's provider is decided by inklings/inkling-runtime.ts,
 * which still refuses Codex until its tools can be withheld structurally.
 */

/** The providers InkRunner names to `ink chat --backend`. */
export type InkProvider = 'claude' | 'codex';

export type InkProviderDecision =
  | { ok: true; provider?: InkProvider }
  | { ok: false; reason: string };

const CLAUDE = new Set(['claude', 'claude-code']);
const CODEX = new Set(['codex', 'codex-cli']);

export function inkProviderFor(identityProvider: string | null | undefined): InkProviderDecision {
  const provider = (identityProvider ?? '').trim().toLowerCase();
  if (provider === '') return { ok: true };
  if (CLAUDE.has(provider)) return { ok: true, provider: 'claude' };
  if (CODEX.has(provider)) return { ok: true, provider: 'codex' };
  return {
    ok: false,
    reason: `this SB's provider "${provider}" is not one ink runs (Claude or Codex)`,
  };
}
