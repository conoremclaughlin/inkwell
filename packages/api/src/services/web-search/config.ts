import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { WebSearchError } from './errors.js';
import type { WebSearchInput } from './types.js';

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
// Its --bare help explicitly says OAuth/keychain are never read and Anthropic
// auth is ANTHROPIC_API_KEY or an explicit apiKeyHelper. We never set a helper.
// A fresh HOME alone does NOT isolate the macOS login keychain. No supported
// no-keychain OAuth mode was demonstrated, so OAuth is not enabled here.
export const CLAUDE_VERSION = '2.1.294';

export interface SearchConfig {
  executable: string;
  model: string;
  apiKey: string;
}

export function readConfig(env: NodeJS.ProcessEnv): SearchConfig {
  if (env.INK_WEB_SEARCH_ENABLED !== 'true') throw new WebSearchError('disabled');
  if (env.INK_WEB_SEARCH_PROVIDER === 'codex') {
    // shell_tool=false does NOT remove apply_patch, apps, or MCP. A complete
    // native search-only allowlist has not been demonstrated for Codex.
    throw new WebSearchError('unsupported_provider');
  }
  if (env.INK_WEB_SEARCH_PROVIDER && env.INK_WEB_SEARCH_PROVIDER !== 'claude') {
    throw new WebSearchError('unsupported_provider');
  }
  // --bare explicitly never reads OAuth or the keychain. Do not fall back to a
  // less isolated launch when only a subscription token was configured.
  if (env.INK_WEB_SEARCH_CLAUDE_OAUTH_TOKEN) {
    throw new WebSearchError('unsupported_credential');
  }
  const executable = env.INK_WEB_SEARCH_CLAUDE_PATH;
  const model = env.INK_WEB_SEARCH_MODEL;
  const apiKey = env.INK_WEB_SEARCH_CLAUDE_API_KEY;
  if (
    env.INK_WEB_SEARCH_PROVIDER !== 'claude' ||
    !executable ||
    !isAbsolute(executable) ||
    executable.length > 4096 ||
    /[\x00-\x1f]/.test(executable) ||
    !model ||
    !/^claude-[a-z0-9][a-z0-9.-]{0,100}$/.test(model) ||
    !apiKey ||
    apiKey.length > 4096 ||
    /\s|[\x00-\x1f\x7f]/.test(apiKey)
  ) {
    throw new WebSearchError('missing_configuration');
  }
  return { executable, model, apiKey };
}

const inputSchema = z
  .object({
    query: z
      .string()
      .trim()
      .min(1)
      .max(LIMITS.queryChars)
      .refine((query) => !/[\x00-\x1f\x7f]/.test(query)),
    maxResults: z.number().int().min(1).max(LIMITS.results),
    signal: z.custom<AbortSignal>((value) => value instanceof AbortSignal).optional(),
  })
  .strict();

export function validateInput(input: WebSearchInput): WebSearchInput {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) throw new WebSearchError('invalid_input');
  if (parsed.data.signal?.aborted) throw new WebSearchError('cancelled');
  return parsed.data;
}
