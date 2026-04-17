/**
 * Identity Constants
 *
 * Canonical values for backend names, identity contexts, and
 * agent configuration. Used by CLI, API, and runner code.
 */

// ── Backends ──────────────────────────────────────────────────────

/** CLI backend names — the canonical short names used in identity.json, CLI flags, etc. */
export const BACKENDS = ['claude', 'codex', 'gemini'] as const;
export type Backend = (typeof BACKENDS)[number];

/**
 * Legacy backend aliases that resolve to a canonical Backend.
 * Used during identity resolution to normalize config values.
 */
export const BACKEND_ALIASES: Record<string, Backend> = {
  'claude-code': 'claude',
  'claude-cli': 'claude',
  'codex-cli': 'codex',
  'gemini-cli': 'gemini',
};

/** Resolve a backend string to its canonical name, or undefined if unknown. */
export function resolveBackendName(name: string): Backend | undefined {
  const lower = name.toLowerCase().trim();
  if ((BACKENDS as readonly string[]).includes(lower)) return lower as Backend;
  return BACKEND_ALIASES[lower];
}

// ── Identity Context ──────────────────────────────────────────────

/** Well-known identity contexts for .ink/identity.json */
export const IDENTITY_CONTEXTS = {
  /** Main repo root (not a studio worktree) */
  MAIN: 'main',
  /** Studio worktree — format: workspace-{agentId} */
  workspace: (agentId: string) => `workspace-${agentId}` as const,
} as const;

// ── MCP Server Key ────────────────────────────────────────────────

/**
 * The MCP server key used in .mcp.json, .codex/config.toml, and .gemini/settings.json.
 * This is the key agents use to find the Inkwell server in their MCP config.
 */
export const MCP_SERVER_KEY = 'inkwell';

// ── Environment Variables ─────────────────────────────────────────

/** Environment variable names used across CLI, hooks, and runners. */
export const ENV = {
  /** Agent ID override */
  AGENT_ID: 'AGENT_ID',
  /** Inkwell server URL */
  SERVER_URL: 'INK_SERVER_URL',
  /** Access token for MCP auth */
  ACCESS_TOKEN: 'INK_ACCESS_TOKEN',
  /** PCP session ID (propagated through spawn chain) */
  SESSION_ID: 'INK_SESSION_ID',
  /** Studio ID */
  STUDIO_ID: 'INK_STUDIO_ID',
  /** Consolidated context token (base64url JSON) */
  CONTEXT_TOKEN: 'INK_CONTEXT',
  /** Runtime link ID for session hint matching */
  RUNTIME_LINK_ID: 'INK_RUNTIME_LINK_ID',
  /** Debug mode toggle */
  DEBUG: 'INK_DEBUG',
  /** Debug log file path */
  DEBUG_FILE: 'INK_DEBUG_FILE',
} as const;
