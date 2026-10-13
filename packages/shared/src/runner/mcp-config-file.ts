/**
 * Session header injection into an MCP config file, synchronously.
 *
 * The server runners' path: they read a .mcp.json, inject the headers and
 * write the result to a temp file before a spawn. It lives apart from
 * mcp-config.ts because that file is on every provider's preparation path,
 * which must never block (providers/providers-prep-guard.test.ts); the
 * providers build their config asynchronously through applySessionHeaders.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { pinIsolatedPlaywright } from './playwright-mcp.js';
import { applySessionHeaders, type InjectSessionHeadersOptions } from './mcp-config.js';

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
  const { mcpConfigPath } = options;

  // Missing config file — nothing to inject into. Note: we still inject the
  // other headers (studio, context, authorization) when inkSessionId is
  // absent — x-ink-context carries sbSlug/studioId/runtime which are useful
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

  if (!applySessionHeaders(config, options)) {
    return { mcpConfigPath, cleanup: () => {}, modified: false };
  }

  // Write modified config to temp file (or outputDir for container execution)
  const tmpDir = options.outputDir || join(tmpdir(), 'sb-mcp');
  mkdirSync(tmpDir, { recursive: true });
  // Unique per spawn: server runners spawn concurrently in one process, and a
  // millisecond does not separate them.
  const tmpPath = join(tmpDir, `mcp-server-${process.pid}-${randomUUID()}.json`);
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
 * The MCP servers a backend launch takes from a `.mcp.json`: its server
 * map, with the Playwright server pinned to the default launch (headless,
 * isolated; studio/playwright-mcp.ts). Empty when the file is absent,
 * cannot be parsed, or has no server map. For launchers that build their
 * own settings from the file (Gemini's) instead of passing it through
 * injectSessionHeaders.
 */
export function readLaunchMcpServers(mcpJsonPath: string): Record<string, unknown> {
  if (!existsSync(mcpJsonPath)) return {};
  let servers: unknown;
  try {
    servers = JSON.parse(readFileSync(mcpJsonPath, 'utf-8'))?.mcpServers;
  } catch {
    return {};
  }
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return {};
  return pinIsolatedPlaywright(servers as Record<string, McpServerConfig>).servers;
}
