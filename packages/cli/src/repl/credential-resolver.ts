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
 * Resolution cascade:
 * 1. Keychain cache (loaded at session start via `loadKeychainCredentials()`)
 * 2. process.env (fallback)
 *
 * Resolution rules:
 * - Only string values are scanned (numbers, booleans, objects pass through)
 * - Pattern: `$VAR_NAME` or `${VAR_NAME}` anywhere in a string value
 * - A string that IS a bare reference (`$FOO`) resolves to just the value
 * - A string with embedded references (`user: $FOO`) does interpolation
 * - Unresolvable references (env var not set) are left as-is
 * - Nested objects/arrays are walked recursively
 */

import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface CredentialResolution {
  /** Env var name that was resolved */
  name: string;
  /** Tool parameter path where it was found (e.g., "value", "options.password") */
  path: string;
}

export interface ResolveResult {
  /** The args with credential references resolved */
  args: Record<string, unknown>;
  /** Which credentials were resolved (for audit logging — never includes values) */
  resolutions: CredentialResolution[];
}

const REF_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;

/**
 * Resolve credential references in tool call arguments.
 *
 * Walks all string values in `args`, replacing `$VAR` / `${VAR}` patterns
 * with their `process.env` values. Returns the resolved args and an audit
 * trail of which references were resolved (without the actual values).
 */
export function resolveCredentialRefs(
  args: Record<string, unknown>,
  env: Record<string, string | undefined> = process.env
): ResolveResult {
  const resolutions: CredentialResolution[] = [];

  function resolveValue(value: unknown, path: string): unknown {
    if (typeof value === 'string') {
      return resolveString(value, path);
    }
    if (Array.isArray(value)) {
      return value.map((item, i) => resolveValue(item, `${path}[${i}]`));
    }
    if (value !== null && typeof value === 'object') {
      return resolveObject(value as Record<string, unknown>, path);
    }
    return value;
  }

  function resolveString(value: string, path: string): string {
    return value.replace(
      REF_PATTERN,
      (match, braced: string | undefined, bare: string | undefined) => {
        const varName = braced || bare;
        if (!varName) return match;
        const envValue = env[varName];
        if (envValue === undefined) return match;
        resolutions.push({ name: varName, path });
        return envValue;
      }
    );
  }

  function resolveObject(
    obj: Record<string, unknown>,
    parentPath: string
  ): Record<string, unknown> {
    const resolved: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      const path = parentPath ? `${parentPath}.${key}` : key;
      resolved[key] = resolveValue(value, path);
    }
    return resolved;
  }

  const resolvedArgs = resolveObject(args, '');
  return { args: resolvedArgs, resolutions };
}

// ─── Keychain Integration ──────────────────────────────────────

const SERVICE_PREFIX = 'ink:';
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
  const cache: Record<string, string> = {};
  if (process.platform !== 'darwin') {
    keychainCache = cache;
    return cache;
  }

  try {
    const { stdout } = await execFileAsync('security', ['dump-keychain']);
    const entries = stdout.split(/^keychain:/gm);

    for (const entry of entries) {
      if (!entry.includes('class: "genp"')) continue;
      const svcMatch = entry.match(/"svce"<blob>="([^"]+)"/);
      if (!svcMatch || !svcMatch[1].startsWith(SERVICE_PREFIX)) continue;
      const name = svcMatch[1].slice(SERVICE_PREFIX.length);

      try {
        const { stdout: pw } = await execFileAsync('security', [
          'find-generic-password',
          '-s',
          svcMatch[1],
          '-w',
        ]);
        cache[name] = pw.trimEnd();
      } catch {
        // Individual credential retrieval failed — skip it
      }
    }
  } catch {
    // Keychain inaccessible — proceed with empty cache
  }

  keychainCache = cache;
  return cache;
}

/**
 * Build the merged env map for credential resolution.
 * Keychain values take precedence over process.env.
 */
export function buildResolverEnv(): Record<string, string | undefined> {
  if (!keychainCache) return process.env;
  return { ...process.env, ...keychainCache };
}
