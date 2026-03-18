/**
 * MCP Config Injection
 *
 * Shared utilities for injecting PCP session headers into .mcp.json configs.
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
  /** PCP session ID to inject */
  pcpSessionId: string;
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
 * Inject PCP session headers into an MCP config file.
 *
 * Reads the given .mcp.json, adds x-pcp-session-id (and optionally
 * x-pcp-studio-id) headers to the "pcp" server entry, and writes
 * a temp file if modifications were needed.
 *
 * The header values use ${VAR} interpolation so Claude Code resolves
 * them from the spawned process's env vars at runtime.
 *
 * If the config already has the headers, or the file doesn't exist,
 * or there's no "pcp" server entry, returns the original path unchanged.
 */
export function injectSessionHeaders(
  options: InjectSessionHeadersOptions
): InjectSessionHeadersResult {
  const { mcpConfigPath, studioId, accessToken } = options;

  // No config path or session — nothing to inject
  if (!mcpConfigPath || !existsSync(mcpConfigPath) || !options.pcpSessionId) {
    return { mcpConfigPath, cleanup: () => {}, modified: false };
  }

  let config: McpJsonConfig;
  try {
    const parsed = JSON.parse(readFileSync(mcpConfigPath, 'utf-8'));
    config = { mcpServers: {}, ...parsed };
  } catch {
    return { mcpConfigPath, cleanup: () => {}, modified: false };
  }

  // No PCP server entry — nothing to inject into
  if (!config.mcpServers.pcp) {
    return { mcpConfigPath, cleanup: () => {}, modified: false };
  }

  let modified = false;

  // Inject session ID header (uses ${VAR} interpolation — Claude Code resolves at runtime)
  if (!config.mcpServers.pcp.headers?.['x-pcp-session-id']) {
    config.mcpServers.pcp.headers = {
      ...config.mcpServers.pcp.headers,
      'x-pcp-session-id': '${PCP_SESSION_ID}',
    };
    modified = true;
  }

  // Inject studio ID header
  if (studioId && !config.mcpServers.pcp.headers?.['x-pcp-studio-id']) {
    config.mcpServers.pcp.headers = {
      ...config.mcpServers.pcp.headers,
      'x-pcp-studio-id': '${PCP_STUDIO_ID}',
    };
    modified = true;
  }

  // Inject Authorization header for triggered sessions.
  // Uses ${VAR} interpolation so the token is resolved from PCP_ACCESS_TOKEN
  // env var at runtime, not hardcoded in the config file.
  if (accessToken && !config.mcpServers.pcp.headers?.['Authorization']) {
    config.mcpServers.pcp.headers = {
      ...config.mcpServers.pcp.headers,
      Authorization: 'Bearer ${PCP_ACCESS_TOKEN}',
    };
    modified = true;
  }

  // Inject consolidated context token (Phase 1 — alongside individual headers)
  if (!config.mcpServers.pcp.headers?.['x-pcp-context']) {
    config.mcpServers.pcp.headers = {
      ...config.mcpServers.pcp.headers,
      'x-pcp-context': '${PCP_CONTEXT_TOKEN}',
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
 * PCP context token payload — consolidated session/routing metadata.
 * Carried in the `x-pcp-context` header as base64url-encoded JSON.
 * See spec: pcp://specs/mcp-context-token
 */
export interface PcpContextToken {
  sessionId: string;
  studioId: string;
  agentId: string;
  cliAttached: boolean;
  runtime: string; // 'claude' | 'codex' | 'gemini'
}

/**
 * Encode a context token for the `x-pcp-context` header.
 */
export function encodeContextToken(token: PcpContextToken): string {
  return Buffer.from(JSON.stringify(token)).toString('base64url');
}

/**
 * Decode a context token from the `x-pcp-context` header.
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
 * - PCP_CONTEXT_TOKEN: consolidated context token for x-pcp-context header
 * - Legacy individual env vars (PCP_SESSION_ID, PCP_STUDIO_ID, etc.)
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
}): Record<string, string> {
  const env: Record<string, string> = {};

  // Legacy individual env vars (Phase 1 backward compat)
  if (options.pcpSessionId) {
    env.PCP_SESSION_ID = options.pcpSessionId;
  }
  if (options.runtimeLinkId) {
    env.PCP_RUNTIME_LINK_ID = options.runtimeLinkId;
  }
  if (options.studioId) {
    env.PCP_STUDIO_ID = options.studioId;
  }
  if (options.accessToken) {
    env.PCP_ACCESS_TOKEN = options.accessToken;
    // Codex env_http_headers maps env var name → full header value
    env.PCP_AUTH_BEARER = `Bearer ${options.accessToken}`;
  }

  // Consolidated context token (new — Phase 1)
  if (options.pcpSessionId && options.agentId) {
    env.PCP_CONTEXT_TOKEN = encodeContextToken({
      sessionId: options.pcpSessionId,
      studioId: options.studioId || '',
      agentId: options.agentId,
      cliAttached: options.cliAttached || false,
      runtime: options.runtime || 'claude',
    });
  }

  return env;
}
