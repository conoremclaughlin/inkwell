/**
 * Which runtime and provider an inkling's turn runs on. Every inkling runs
 * on the ink runtime, existing ones included, whatever runtime its identity
 * or session stored (Conor, Oct 4 2026, 5:08 PM). The provider is chosen
 * separately, and is Claude Code when none is set (5:32 PM).
 * SessionService.processMessage asks this once an inkling's turn has passed
 * the owner gate, before anything is spawned.
 *
 * Nothing here is translated quietly (Lumen 638d1a75). A provider ink cannot
 * run for an inkling yet, a runtime that is not one of the inkling's own, and
 * a conversation that began natively on another runtime are each refused
 * with a reason that names what was found:
 * - Codex under ink is not wired yet, so a Codex provider is refused rather
 *   than run as Claude, or handed a Codex model id.
 * - A session that stored another runtime and that runtime's own native
 *   session id holds a conversation ink cannot carry: nothing imports its
 *   history yet (Lumen aec2aae7). One with no native id holds nothing to
 *   carry, and moves to ink.
 */

/** The providers an inkling's turn may run under ink, as `ink chat --backend` names them. */
export type InklingProvider = 'claude';

export type InklingRuntimeDecision =
  | { ok: true; provider: InklingProvider }
  | { ok: false; reason: string };

export interface InklingRuntimeInput {
  /** The runtime the session row stored (sessions.backend). */
  sessionBackend: string | null | undefined;
  /** The native session id the row stored (sessions.backend_session_id). */
  backendSessionId: string | null | undefined;
  /** The runtime the identity stored (agent_identities.backend). */
  identityBackend: string | null | undefined;
  /** The provider the identity stored (agent_identities.provider). */
  identityProvider: string | null | undefined;
}

/** Spellings of the ink runtime, as normalizeBackend reads them. */
const INK_RUNTIMES = new Set(['ink', 'direct-api', 'direct', 'api']);
/** Spellings of the direct Claude runtime: not an exception to "all inklings run on ink". */
const CLAUDE_RUNTIMES = new Set(['claude', 'claude-code']);
const CLAUDE_PROVIDERS = new Set(['claude', 'claude-code']);
const CODEX_PROVIDERS = new Set(['codex', 'codex-cli']);

const spelled = (raw: string | null | undefined): string => (raw ?? '').trim().toLowerCase();

export function inklingRuntime(input: InklingRuntimeInput): InklingRuntimeDecision {
  const identityBackend = spelled(input.identityBackend);
  if (
    identityBackend !== '' &&
    !INK_RUNTIMES.has(identityBackend) &&
    !CLAUDE_RUNTIMES.has(identityBackend)
  ) {
    return {
      ok: false,
      reason: `this inkling's identity names the "${identityBackend}" runtime; inklings run only on ink`,
    };
  }

  const provider = spelled(input.identityProvider);
  if (CODEX_PROVIDERS.has(provider)) {
    return {
      ok: false,
      reason: "this inkling's provider is Codex, which ink does not run for inklings yet",
    };
  }
  if (provider !== '' && !CLAUDE_PROVIDERS.has(provider)) {
    return {
      ok: false,
      reason: `this inkling's provider "${provider}" is not one ink runs for inklings`,
    };
  }

  // The schema's default runtime for a session row is claude-code, so a row
  // that names none began there too.
  const sessionBackend = spelled(input.sessionBackend) || 'claude-code';
  if (!INK_RUNTIMES.has(sessionBackend) && input.backendSessionId) {
    return {
      ok: false,
      reason: `this conversation began on the "${sessionBackend}" runtime, and moving it to ink would not carry its history`,
    };
  }

  return { ok: true, provider: 'claude' };
}
