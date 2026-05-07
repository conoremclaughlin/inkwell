/**
 * MCP Config Injection
 *
 * Shared utilities for injecting Ink session headers into .mcp.json configs.
 * Used by both CLI (buildMergedMcpConfig) and server runners to ensure
 * spawned agents' MCP calls carry session identity.
 *
 * The key insight: Claude Code resolves ${VAR} in header values at runtime
 * from its own env. So we inject the header template AND set the env var
 * in the spawn env.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ─── Types ──────────────────────────────────────────────────────

interface McpServerConfig {
  type?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

interface McpJsonConfig {
  mcpServers: Record<string, McpServerConfig>;
}

export interface InjectSessionHeadersOptions {
  /** Path to the .mcp.json file to read as base config */
  mcpConfigPath: string;
  /** PCP session ID to inject. Optional — other headers still get injected without it. */
  pcpSessionId?: string;
  /** Optional studio ID to inject */
  studioId?: string;
  /** Optional access token — injected as Authorization header for triggered sessions */
  accessToken?: string;
}

export interface InjectSessionHeadersResult {
  /** Path to the (possibly temp) MCP config file with headers injected */
  mcpConfigPath: string;
  /** Call this to clean up any temp files */
  cleanup: () => void;
  /** Whether a temp file was created (vs returning original path) */
  modified: boolean;
}

// ─── Core ───────────────────────────────────────────────────────

/**
 * Inject Ink session headers into an MCP config file.
 *
 * Reads the given .mcp.json, adds x-ink-session-id (and optionally
 * x-ink-studio-id) headers to the "inkwell" server entry, and writes
 * a temp file if modifications were needed.
 *
 * The header values use ${VAR} interpolation so Claude Code resolves
 * them from the spawned process's env vars at runtime.
 *
 * If the config already has the headers, or the file doesn't exist,
 * or there's no "inkwell" server entry, returns the original path unchanged.
 */
export function injectSessionHeaders(
  options: InjectSessionHeadersOptions
): InjectSessionHeadersResult {
  const { mcpConfigPath, pcpSessionId, studioId, accessToken } = options;

  // Missing config file — nothing to inject into. Note: we still inject the
  // other headers (studio, context, authorization) when pcpSessionId is
  // absent — x-ink-context carries agentId/studioId/runtime which are useful
  // independently of session identity.
  if (!mcpConfigPath || !existsSync(mcpConfigPath)) {
    return { mcpConfigPath, cleanup: () => {}, modified: false };
  }

  let config: McpJsonConfig;
  try {
    const parsed = JSON.parse(readFileSync(mcpConfigPath, 'utf-8'));
    config = { mcpServers: {}, ...parsed };
  } catch {
    return { mcpConfigPath, cleanup: () => {}, modified: false };
  }

  // Find the server entry — prefer 'inkwell', fall back to 'pcp' for backward compat
  const serverKey = config.mcpServers.inkwell ? 'inkwell' : config.mcpServers.pcp ? 'pcp' : null;
  if (!serverKey) {
    return { mcpConfigPath, cleanup: () => {}, modified: false };
  }

  let modified = false;

  // Inject session ID header (uses ${VAR} interpolation — Claude Code resolves at runtime).
  // Only when we actually have a session — otherwise the rendered header
  // would be an empty string which muddies server-side logs.
  if (pcpSessionId && !config.mcpServers[serverKey].headers?.['x-ink-session-id']) {
    config.mcpServers[serverKey].headers = {
      ...config.mcpServers[serverKey].headers,
      'x-ink-session-id': '${INK_SESSION_ID}',
    };
    modified = true;
  }

  // Inject studio ID header
  if (studioId && !config.mcpServers[serverKey].headers?.['x-ink-studio-id']) {
    config.mcpServers[serverKey].headers = {
      ...config.mcpServers[serverKey].headers,
      'x-ink-studio-id': '${INK_STUDIO_ID}',
    };
    modified = true;
  }

  // Inject Authorization header for triggered sessions.
  // Uses ${VAR} interpolation so the token is resolved from INK_ACCESS_TOKEN
  // env var at runtime, not hardcoded in the config file.
  if (accessToken && !config.mcpServers[serverKey].headers?.['Authorization']) {
    config.mcpServers[serverKey].headers = {
      ...config.mcpServers[serverKey].headers,
      Authorization: 'Bearer ${INK_ACCESS_TOKEN}',
    };
    modified = true;
  }

  // Inject consolidated context token (Phase 1 — alongside individual headers)
  if (!config.mcpServers[serverKey].headers?.['x-ink-context']) {
    config.mcpServers[serverKey].headers = {
      ...config.mcpServers[serverKey].headers,
      'x-ink-context': '${INK_CONTEXT}',
    };
    modified = true;
  }

  if (!modified) {
    return { mcpConfigPath, cleanup: () => {}, modified: false };
  }

  // Write modified config to temp file
  const tmpDir = join(tmpdir(), 'sb-mcp');
  mkdirSync(tmpDir, { recursive: true });
  const tmpPath = join(tmpDir, `mcp-server-${process.pid}-${Date.now()}.json`);
  writeFileSync(tmpPath, JSON.stringify(config, null, 2));

  return {
    mcpConfigPath: tmpPath,
    cleanup: () => {
      try {
        unlinkSync(tmpPath);
      } catch {
        // Best-effort cleanup
      }
    },
    modified: true,
  };
}

// ─── Context Token ──────────────────────────────────────────

/**
 * Ink context token payload — consolidated session/routing metadata.
 * Carried in the `x-ink-context` header as base64url-encoded JSON.
 * See spec: ink://specs/mcp-context-token
 */
export interface PcpContextToken {
  sessionId: string;
  studioId: string;
  agentId: string;
  cliAttached: boolean;
  runtime: string; // 'claude' | 'codex' | 'gemini'
  repoRoot?: string; // root repo path for cross-project 'main' resolution
}

/**
 * Encode a context token for the `x-ink-context` header.
 */
export function encodeContextToken(token: PcpContextToken): string {
  return Buffer.from(JSON.stringify(token)).toString('base64url');
}

/**
 * Decode a context token from the `x-ink-context` header.
 * Returns null if the header is missing or malformed.
 */
export function decodeContextToken(header: string | undefined | null): PcpContextToken | null {
  if (!header) return null;
  try {
    const parsed = JSON.parse(Buffer.from(header, 'base64url').toString());
    if (typeof parsed.sessionId !== 'string' || typeof parsed.agentId !== 'string') {
      return null;
    }
    return parsed as PcpContextToken;
  } catch {
    return null;
  }
}

// ─── Session Env ────────────────────────────────────────────

/**
 * Build the session-related env vars for a spawned backend process.
 *
 * Sets both:
 * - INK_CONTEXT: consolidated context token for x-ink-context header
 * - Legacy individual env vars (INK_SESSION_ID, INK_STUDIO_ID, etc.)
 *   for backward compat during Phase 1 migration
 */
export function buildSessionEnv(options: {
  pcpSessionId?: string;
  runtimeLinkId?: string;
  studioId?: string;
  accessToken?: string;
  agentId?: string;
  cliAttached?: boolean;
  runtime?: string;
  repoRoot?: string;
}): Record<string, string> {
  const env: Record<string, string> = {};

  // Legacy individual env vars (Phase 1 backward compat)
  if (options.pcpSessionId) {
    env.INK_SESSION_ID = options.pcpSessionId;
  }
  if (options.runtimeLinkId) {
    env.INK_RUNTIME_LINK_ID = options.runtimeLinkId;
  }
  if (options.studioId) {
    env.INK_STUDIO_ID = options.studioId;
  }
  if (options.accessToken) {
    env.INK_ACCESS_TOKEN = options.accessToken;
    // Codex env_http_headers maps env var name → full header value
    env.INK_AUTH_BEARER = `Bearer ${options.accessToken}`;
  }

  // Consolidated context token (new — Phase 1)
  if (options.pcpSessionId && options.agentId) {
    env.INK_CONTEXT = encodeContextToken({
      sessionId: options.pcpSessionId,
      studioId: options.studioId || '',
      agentId: options.agentId,
      cliAttached: options.cliAttached || false,
      runtime: options.runtime || 'claude',
      ...(options.repoRoot ? { repoRoot: options.repoRoot } : {}),
    });
  }

  return env;
}
