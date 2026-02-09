/**
 * Backend Registry
 *
 * Resolves backend name to adapter instance.
 */

export type { BackendAdapter, BackendConfig, PreparedBackend } from './types.js';
export { resolveAgentId } from './identity.js';

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

export function getBackend(name: string): BackendAdapter {
  const factory = BACKENDS[name];
  if (!factory) {
    throw new Error(`Unknown backend: ${name}. Available: ${BACKEND_NAMES.join(', ')}`);
  }
  return factory();
}
