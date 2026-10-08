/**
 * Credential Resolver
 *
 * Resolves credential references in tool call parameters before they reach
 * MCP servers. This keeps credentials out of LLM context windows, conversation
 * transcripts, and compaction summaries.
 *
 * The LLM generates `$GFIBER_PASSWORD` — this module resolves it to the
 * actual value at the tool execution layer. The transcript only ever records
 * the reference, not the secret.
 *
 * Resolution scope:
 * ONLY resolves references that match known Keychain credential names
 * (loaded at session start via `loadKeychainCredentials()`). Arbitrary
 * process.env vars like $HOME or $PATH are never resolved.
 *
 * Safety invariant:
 * Only BARE references are resolved — the entire string value must be
 * exactly `$VAR` or `${VAR}` with no surrounding text. This prevents
 * credential leakage into text fields: `send_to_inbox({ content:
 * "use $GFIBER_PASSWORD" })` stays literal, while `{ password:
 * "$GFIBER_PASSWORD" }` resolves correctly.
 *
 * Resolution rules:
 * - Only string values are scanned (numbers, booleans, objects pass through)
 * - Pattern: entire value must be `$VAR_NAME` or `${VAR_NAME}` (bare ref)
 * - Embedded references (`user: $FOO`) are NOT resolved
 * - Unresolvable references are left as-is
 * - Nested objects/arrays are walked recursively
 */

import { readHostKeychainCredentials } from '@inklabs/shared/node-host';

import { resolveCredentialRefs as resolveSharedCredentials } from '@inklabs/shared/runtime';
export type { CredentialResolution, ResolveResult } from '@inklabs/shared/runtime';
/** Historical CLI default; session hosts pass a private credential snapshot. */
export function resolveCredentialRefs(
  args: Record<string, unknown>,
  env: Record<string, string | undefined> = process.env
) {
  return resolveSharedCredentials(args, env);
}

// ─── Keychain Integration ──────────────────────────────────────

let keychainCache: Record<string, string> | null = null;

/**
 * Load all ink-namespaced credentials from macOS Keychain into an
 * in-memory cache. Call once at session start — the cache is used by
 * `buildResolverEnv()` to merge Keychain values with process.env.
 *
 * On non-macOS or if the Keychain is inaccessible, silently returns
 * an empty map (credentials fall back to process.env only).
 */
export async function loadKeychainCredentials(): Promise<Record<string, string>> {
  keychainCache = await readHostKeychainCredentials({
    platform: process.platform,
    env: process.env,
  });
  return keychainCache;
}

/**
 * Return the Keychain-only credential map for resolution.
 * Only explicitly stored secrets are resolvable — process.env is NOT
 * included, preventing accidental injection of $HOME, $PATH, etc.
 * into text fields.
 */
export function buildResolverEnv(): Record<string, string> {
  return keychainCache ?? {};
}
