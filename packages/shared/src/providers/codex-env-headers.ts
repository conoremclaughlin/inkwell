/**
 * Inkwell headers the Codex adapter injects as env_http_headers on the
 * "inkwell" MCP server. Each entry maps a header name to the env var that
 * holds its value. Codex resolves env var → value at runtime, so multiple
 * sessions in the same studio each get their own scoped headers.
 *
 * x-ink-context is the consolidated token (preferred). Individual headers
 * are kept for backward compat during migration.
 *
 * Authorization is intentionally NOT here — it goes through codex's
 * `bearer_token_env_var` mechanism instead (see CodexAdapter.prepare), which
 * also stops codex from running its own managed OAuth for the server.
 *
 * Its own module so the adapter (codex.ts) and its effective-config check
 * (codex-mcp-list.ts, which admits an env-drawn Inkwell header only when it
 * is exactly one of these) read one list without importing each other.
 */
export const INK_ENV_HEADERS: ReadonlyArray<{ header: string; envVar: string }> = [
  { header: 'x-ink-context', envVar: 'INK_CONTEXT' },
  { header: 'x-ink-agent-id', envVar: 'AGENT_ID' },
  { header: 'x-ink-session-id', envVar: 'INK_SESSION_ID' },
  { header: 'x-ink-studio-id', envVar: 'INK_STUDIO_ID' },
];
