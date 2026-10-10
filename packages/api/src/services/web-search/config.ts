import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { WebSearchError } from './errors.js';
import type { WebSearchInput, WebSearchBatchInput } from './types.js';

export const LIMITS = Object.freeze({
  concurrent: 1,
  queryChars: 500,
  results: 10,
  searches: 4,
  timeoutMs: 60_000,
  probeTimeoutMs: 5_000,
  stdoutBytes: 512 * 1024,
  stderrBytes: 32 * 1024,
  lineBytes: 128 * 1024,
  events: 256,
  stopGraceMs: 500,
  stopGiveUpMs: 2_000,
});

// This exact release was inspected with --help and its embedded WebSearch output
// schema, without inference. New versions must be reviewed, not silently admitted.
// The logged-in adapter uses this version's separate secure-storage selector.
// It deliberately keeps settings isolated while selecting the default macOS
// keychain login. No token is read/copied by Inkwell; live acceptance is gated.
export const CLAUDE_VERSION = '2.1.294';

export interface SearchConfig {
  executable: string;
  model: string;
}

export function isWebSearchEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.INK_WEB_SEARCH_ENABLED === 'true';
}

export function readConfig(env: NodeJS.ProcessEnv): SearchConfig {
  if (!isWebSearchEnabled(env)) throw new WebSearchError('disabled');
  if (env.INK_WEB_SEARCH_PROVIDER === 'codex') {
    // shell_tool=false does NOT remove apply_patch, apps, or MCP. A complete
    // native search-only allowlist has not been demonstrated for Codex.
    throw new WebSearchError('unsupported_provider');
  }
  if (env.INK_WEB_SEARCH_PROVIDER && env.INK_WEB_SEARCH_PROVIDER !== 'claude') {
    throw new WebSearchError('unsupported_provider');
  }
  // Reject obsolete dedicated credentials instead of silently changing their
  // billing identity. Login is managed by the pinned CLI, not copied into env.
  if (env.INK_WEB_SEARCH_CLAUDE_OAUTH_TOKEN || env.INK_WEB_SEARCH_CLAUDE_API_KEY) {
    throw new WebSearchError('unsupported_credential');
  }
  const executable = env.INK_WEB_SEARCH_CLAUDE_PATH;
  const model = env.INK_WEB_SEARCH_MODEL;
  if (
    env.INK_WEB_SEARCH_PROVIDER !== 'claude' ||
    !executable ||
    !isAbsolute(executable) ||
    executable.length > 4096 ||
    /[\x00-\x1f]/.test(executable) ||
    !model ||
    !/^claude-[a-z0-9][a-z0-9.-]{0,100}$/.test(model)
  ) {
    throw new WebSearchError('missing_configuration');
  }
  return { executable, model };
}

// Shared by the public tool and service so validation cannot drift at dispatch.
export const webSearchQuerySchema = z
  .string()
  .trim()
  .min(1)
  .max(LIMITS.queryChars)
  .refine((query) => !/[\x00-\x1f\x7f]/.test(query));

const inputSchema = z
  .object({
    query: webSearchQuerySchema,
    maxResults: z.number().int().min(1).max(LIMITS.results),
    signal: z.custom<AbortSignal>((value) => value instanceof AbortSignal).optional(),
  })
  .strict();

export function validateInput(input: unknown): WebSearchInput {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) throw new WebSearchError('invalid_input');
  if (parsed.data.signal?.aborted) throw new WebSearchError('cancelled');
  return parsed.data;
}

const batchInputSchema = inputSchema.omit({ query: true }).extend({
  queries: z.array(webSearchQuerySchema).min(1).max(LIMITS.searches),
});

export function validateBatchInput(input: unknown): WebSearchBatchInput {
  const parsed = batchInputSchema.safeParse(input);
  if (!parsed.success) throw new WebSearchError('invalid_input');
  if (parsed.data.signal?.aborted) throw new WebSearchError('cancelled');
  return { ...parsed.data, queries: [...new Set(parsed.data.queries)] };
}
