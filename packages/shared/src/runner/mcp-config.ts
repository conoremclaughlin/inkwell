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
import { pinIsolatedPlaywright } from '../studio/playwright-mcp.js';

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
  /** Inkwell session ID to inject. Optional — other headers still get injected without it. */
  inkSessionId?: string;
  /** Optional studio ID to inject */
  studioId?: string;
  /** Optional access token — injected as Authorization header for triggered sessions */
  accessToken?: string;
  /** Directory to write the modified config to (default: system tmpdir/sb-mcp). Use this for container execution where temp files must be in a mounted directory. */
  outputDir?: string;
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
 * The same pass pins a Playwright MCP server to the default launch
 * (headless, isolated; studio/playwright-mcp.ts), with or without an
 * "inkwell" entry to decorate.
 *
 * If nothing needed adding, or the file doesn't exist or can't be parsed,
 * returns the original path unchanged.
 */
export function injectSessionHeaders(
  options: InjectSessionHeadersOptions
): InjectSessionHeadersResult {
  const { mcpConfigPath, inkSessionId, studioId, accessToken } = options;

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

  // Every session launches Playwright headless and on a throwaway profile,
  // whatever the studio's own file says, unless the entry names a browser
  // of its own (studio/playwright-mcp.ts).
  const playwright = pinIsolatedPlaywright(config.mcpServers);
  config.mcpServers = playwright.servers;
  let modified = playwright.pinned.length > 0;

  // Session headers are injected only into the canonical 'inkwell' server. The
  // legacy 'pcp' server name is retired — no code should create or feed it.
  const serverKey = 'inkwell';
  if (config.mcpServers[serverKey]) {
    // Inject session ID header (uses ${VAR} interpolation — Claude Code resolves at runtime).
    // Only when we actually have a session — otherwise the rendered header
    // would be an empty string which muddies server-side logs.
    if (inkSessionId && !config.mcpServers[serverKey].headers?.['x-ink-session-id']) {
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
  }

  if (!modified) {
    return { mcpConfigPath, cleanup: () => {}, modified: false };
  }

  // Write modified config to temp file (or outputDir for container execution)
  const tmpDir = options.outputDir || join(tmpdir(), 'sb-mcp');
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
export interface InkContextToken {
  sessionId: string;
  studioId: string;
  sbSlug: string;
  cliAttached: boolean;
  runtime: string; // 'claude' | 'codex' | 'gemini'
  repoRoot?: string; // root repo path for cross-project 'main' resolution
}

/**
 * Encode a context token for the `x-ink-context` header.
 */
export function encodeContextToken(token: InkContextToken): string {
  // token.runtime values in the wild: 'claude' | 'codex' | 'gemini' for
  // provider-backed spawns, plus 'ink' for the ink chat loop's own InkClient
  // (PR #468). The server treats it as an opaque string.
  return Buffer.from(JSON.stringify(token)).toString('base64url');
}

/**
 * Decode a context token from the `x-ink-context` header.
 * Returns null if the header is missing or malformed.
 */
export function decodeContextToken(header: string | undefined | null): InkContextToken | null {
  if (!header) return null;
  try {
    const parsed = JSON.parse(Buffer.from(header, 'base64url').toString());
    // Tokens minted before the agentId -> sbSlug rename carry `agentId`, and they
    // live in running processes and already-generated MCP configs that nothing
    // rewrites. Such a token is otherwise valid: refusing it would discard its
    // session, studio, runtime and cliAttached together, and take the server's
    // context-session auth fallback with them (Lumen, PR #635).
    const sbSlug =
      typeof parsed.sbSlug === 'string'
        ? parsed.sbSlug
        : typeof parsed.agentId === 'string'
          ? parsed.agentId
          : undefined;
    if (typeof parsed.sessionId !== 'string' || sbSlug === undefined) {
      return null;
    }
    return { ...parsed, sbSlug } as InkContextToken;
  } catch {
    return null;
  }
}

// ─── Channel Host Mode ──────────────────────────────────────

/**
 * Env a print-mode Claude process (`claude -p` / `--print`) hands its MCP
 * servers, telling the InkMail channel plugin that its host cannot render a
 * channel notification.
 *
 * A print-mode host accepts the notification and never shows it to the
 * model. A plugin polling there would still ack each message it pushed — the
 * ack is the only consumption — and stamp `cli_poll_at`, which steers the
 * trigger handler to inline delivery instead of queueing a turn. Messages
 * sent while such a turn ran were read by nobody and reported as delivered
 * (task 2f892701). Under this env the plugin stays inert.
 *
 * Every spawner that runs Claude in print mode must pass it. The plugin reads
 * the same literal; channel-plugin/host-mode.test.ts launches the real plugin
 * with this constant, so a rename on either side fails there.
 */
export const PRINT_MODE_CHANNEL_ENV = { INK_CHANNEL_HOST: 'print' } as const;

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
  inkSessionId?: string;
  runtimeLinkId?: string;
  studioId?: string;
  accessToken?: string;
  /**
   * The secret the ink chat child verifies and mints delegation tokens with.
   * Derived by the server from its signing key; the key itself never crosses
   * (spec:sender-token-binding v3 §4 Phase 0).
   */
  delegationSecret?: string;
  sbSlug?: string;
  cliAttached?: boolean;
  runtime?: string;
  repoRoot?: string;
}): Record<string, string> {
  const env: Record<string, string> = {};

  // Legacy individual env vars (Phase 1 backward compat)
  if (options.inkSessionId) {
    env.INK_SESSION_ID = options.inkSessionId;
  }
  if (options.runtimeLinkId) {
    env.INK_RUNTIME_LINK_ID = options.runtimeLinkId;
  }
  if (options.studioId) {
    env.INK_STUDIO_ID = options.studioId;
  }
  if (options.accessToken) {
    env.INK_ACCESS_TOKEN = options.accessToken;
  }
  if (options.delegationSecret) {
    env.INK_DELEGATION_SECRET = options.delegationSecret;
  }

  // Consolidated context token (new — Phase 1)
  if (options.inkSessionId && options.sbSlug) {
    env.INK_CONTEXT = encodeContextToken({
      sessionId: options.inkSessionId,
      studioId: options.studioId || '',
      sbSlug: options.sbSlug,
      cliAttached: options.cliAttached || false,
      runtime: options.runtime || 'claude',
      ...(options.repoRoot ? { repoRoot: options.repoRoot } : {}),
    });
  }

  return env;
}
