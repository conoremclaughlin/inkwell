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

const BARE_REF_PATTERN = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$|^\$([A-Za-z_][A-Za-z0-9_]*)$/;

/**
 * Resolve credential references in tool call arguments.
 *
 * Only resolves bare references where the entire string value is a single
 * `$VAR` or `${VAR}`. Embedded references in longer strings are left as-is
 * to prevent credential leakage into text fields.
 */
export function resolveCredentialRefs(
  args: Record<string, unknown>,
  env: Readonly<Record<string, string | undefined>>
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
    const m = value.trim().match(BARE_REF_PATTERN);
    if (!m) return value;
    const varName = m[1] || m[2];
    if (!varName) return value;
    const resolved = env[varName];
    if (resolved === undefined) return value;
    resolutions.push({ name: varName, path });
    return resolved;
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
