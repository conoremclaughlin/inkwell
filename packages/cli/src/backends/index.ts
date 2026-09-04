/**
 * Backend Registry
 *
 * Resolves backend name to adapter instance.
 */

export type { BackendAdapter, BackendConfig, PreparedBackend } from './types.js';
export { resolveAgentId, resolveBackend } from './identity.js';

import { ClaudeAdapter } from './claude.js';
import { CodexAdapter } from './codex.js';
import { GeminiAdapter } from './gemini.js';
import type { BackendAdapter } from './types.js';

const BACKENDS: Record<string, () => BackendAdapter> = {
  claude: () => new ClaudeAdapter(),
  codex: () => new CodexAdapter(),
  gemini: () => new GeminiAdapter(),
};

export const BACKEND_NAMES = Object.keys(BACKENDS);

/**
 * Backends that still resolve but are DEPRECATED FOR NOW, with the reason.
 * gemini: the Gemini CLI now requires an enterprise plan, so it is not a
 * backend an Inkling can rely on; Antigravity is the Google surface that
 * matters (Conor, 2026-09-03). The adapter stays so old transcripts and
 * configs keep working; selecting it warns once per process.
 */
export const DEPRECATED_BACKENDS: Readonly<Record<string, string>> = {
  gemini:
    'the Gemini CLI backend is deprecated for now — the Gemini CLI requires an enterprise plan; use claude or codex (Antigravity is the Google surface that matters)',
};

export function deprecatedBackendReason(name: string): string | undefined {
  return DEPRECATED_BACKENDS[name];
}

const warnedDeprecated = new Set<string>();

export function getBackend(name: string): BackendAdapter {
  const factory = BACKENDS[name];
  if (!factory) {
    throw new Error(`Unknown backend: ${name}. Available: ${BACKEND_NAMES.join(', ')}`);
  }
  const reason = deprecatedBackendReason(name);
  if (reason && !warnedDeprecated.has(name)) {
    warnedDeprecated.add(name);
    process.stderr.write(`[ink] backend "${name}": ${reason}\n`);
  }
  return factory();
}

/**
 * The prompt transport a backend's adapter declares. Unknown backends fall
 * back to 'argv' — the conservative direction for context budgeting (an argv
 * transport gets the small ARG_MAX-safe budget cap).
 */
export function promptTransportFor(name: string): 'stdin' | 'argv' {
  const factory = BACKENDS[name];
  return factory ? factory().promptTransport : 'argv';
}
