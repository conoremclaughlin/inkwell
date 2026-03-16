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
  const { mcpConfigPath, studioId } = options;

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

/**
 * Build the session-related env vars for a spawned backend process.
 *
 * Consolidates the env var naming:
 * - PCP_SESSION_ID: The PCP session ID (used by ${VAR} interpolation in .mcp.json headers)
 * - PCP_RUNTIME_LINK_ID: Unique runtime link for session hint file matching
 * - PCP_STUDIO_ID: The studio/workspace ID (if available)
 */
export function buildSessionEnv(options: {
  pcpSessionId?: string;
  runtimeLinkId?: string;
  studioId?: string;
}): Record<string, string> {
  const env: Record<string, string> = {};

  if (options.pcpSessionId) {
    env.PCP_SESSION_ID = options.pcpSessionId;
  }
  if (options.runtimeLinkId) {
    env.PCP_RUNTIME_LINK_ID = options.runtimeLinkId;
  }
  if (options.studioId) {
    env.PCP_STUDIO_ID = options.studioId;
  }

  return env;
}
