/**
 * DEPRECATED FOR NOW — see DEPRECATED_BACKENDS in ./index.ts. The Gemini CLI
 * requires an enterprise plan; the adapter is kept so existing transcripts and
 * configs still resolve, and selecting it warns once per process.
 */
/**
 * Gemini CLI Backend Adapter
 *
 * Identity injection via GEMINI_SYSTEM_MD=<tmpfile> env var
 * MCP config via GEMINI_CLI_SYSTEM_SETTINGS_PATH → temp settings.json
 *   with auth + session headers merged into Inkwell server config.
 *
 * Docs: https://geminicli.com/docs/
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { createIdentityPromptFile } from './identity-prompt.js';
import { encodeContextToken } from '../runner/mcp-config.js';
import type { BackendAdapter, BackendConfig, BackendHost, PreparedBackend } from './types.js';

/**
 * Build a temp Gemini settings.json that merges Inkwell auth + session headers
 * into the MCP server config. Gemini reads MCP headers from settings.json
 * (not env vars like Codex), so we need a generated override file.
 *
 * Uses ${ENV_VAR} syntax — Gemini resolves env vars at runtime.
 * Authorization uses ${INK_ACCESS_TOKEN} which is set at the spawn site.
 * If unset, Gemini sends "Bearer " which the server handles as unauthenticated.
 *
 * NOTE: Gemini env var interpolation in MCP headers may be unreliable
 * (upstream issues #5282, #5828). Aster's existing settings use ${GITHUB_TOKEN}
 * for GitHub auth which works, but Inkwell headers haven't been verified end-to-end.
 * Live validation needed once Aster's quota resets.
 */
export function buildGeminiSettings(
  cwd: string,
  contextToken: string,
  sessionId?: string,
  studioId?: string,
  explicitSession = false
): { path: string; cleanup: () => void } | null {
  // Start from .mcp.json to preserve other MCP servers (supabase, github, etc.)
  const mcpJsonPath = join(cwd, '.mcp.json');
  let mcpServers: Record<string, unknown> = {};
  if (existsSync(mcpJsonPath)) {
    try {
      const parsed = JSON.parse(readFileSync(mcpJsonPath, 'utf-8'));
      mcpServers = parsed.mcpServers || {};
    } catch {
      // ignore parse errors
    }
  }

  // Merge Inkwell auth + session headers into the canonical 'inkwell' server.
  // The legacy 'pcp' server name is retired — never target or create it.
  const serverKey = 'inkwell';
  const serverConfig = (mcpServers[serverKey] || {}) as Record<string, unknown>;
  const existingHeaders = { ...((serverConfig.headers || {}) as Record<string, string>) };
  // A caller that named the session owns the routing: a session or studio
  // header the project config carries would otherwise survive whenever the
  // caller named none (BackendConfig.explicitSession).
  if (explicitSession) {
    for (const name of Object.keys(existingHeaders)) {
      if (['x-ink-session-id', 'x-ink-studio-id', 'x-ink-context'].includes(name.toLowerCase())) {
        delete existingHeaders[name];
      }
    }
  }
  mcpServers[serverKey] = {
    ...serverConfig,
    type: serverConfig.type || 'http',
    url: serverConfig.url || 'http://localhost:3001/mcp',
    headers: {
      ...existingHeaders,
      Authorization: 'Bearer ${INK_ACCESS_TOKEN}',
      'x-ink-context': contextToken,
      ...(sessionId ? { 'x-ink-session-id': sessionId } : {}),
      ...(studioId ? { 'x-ink-studio-id': studioId } : {}),
    },
  };

  const settingsDir = join(tmpdir(), 'ink-gemini');
  mkdirSync(settingsDir, { recursive: true });
  const settingsFile = join(settingsDir, `settings-${process.pid}-${randomUUID()}.json`);
  try {
    writeFileSync(settingsFile, JSON.stringify({ mcpServers }, null, 2));
    return {
      path: settingsFile,
      cleanup: () => {
        try {
          rmSync(settingsFile, { force: true });
        } catch {
          // best-effort
        }
      },
    };
  } catch {
    return null;
  }
}

export class GeminiAdapter implements BackendAdapter {
  readonly name = 'gemini';
  readonly binary = 'gemini';
  // Prompt rides argv (`-p <prompt>`) — bounded by OS ARG_MAX.
  readonly promptTransport = 'argv' as const;

  async prepare(config: BackendConfig, host: BackendHost): Promise<PreparedBackend> {
    const { promptFile, cleanup: identityCleanup } = createIdentityPromptFile(
      config.sbSlug,
      undefined,
      config.systemPromptOverride
    );

    const args: string[] = [];

    // Model (only if explicitly specified)
    if (config.model) {
      args.push('-m', config.model);
    }

    // Prompt mode: gemini uses -p for one-shot
    // Interactive is the default (no flag needed)
    if (config.prompt) {
      args.push('-p');
      // Keep prompt adjacent to -p for strict CLI parsers.
      args.push(config.prompt);
    }

    // Resume a specific backend-native Gemini session when available.
    if (config.backendSessionId) {
      args.push('--resume', config.backendSessionId);
    }

    // Auto-approve: skip all permission prompts
    if (config.dangerous) {
      args.push('--yolo');
    }

    // Ephemeral-studio root (spec:studio-materialization v8): Gemini's
    // workspace-grant equivalent of --add-dir, so studios minted mid-session
    // stay editable. Created if missing.
    const inkStudiosDir = host.paths.studiosRoot;
    try {
      mkdirSync(inkStudiosDir, { recursive: true });
    } catch {
      // Non-fatal — worst case the grant is a no-op until the dir exists.
    }
    args.push('--include-directories', inkStudiosDir);

    // Passthrough flags
    args.push(...config.passthroughArgs);

    // Build consolidated context token
    const contextToken = encodeContextToken({
      sessionId: config.inkSessionId || '',
      studioId: config.studioId || '',
      sbSlug: config.sbSlug,
      cliAttached: config.cliAttached,
      runtime: 'gemini',
    });

    // Build temp settings.json with Inkwell auth + session headers.
    // INK_ACCESS_TOKEN is set at the spawn site (after prepare) — the
    // ${INK_ACCESS_TOKEN} syntax in settings.json resolves at Gemini runtime.
    const settings = buildGeminiSettings(
      config.cwd,
      contextToken,
      config.inkSessionId,
      config.studioId,
      config.explicitSession === true
    );
    const cleanup = () => {
      identityCleanup();
      settings?.cleanup();
    };

    return {
      binary: this.binary,
      args,
      env: {
        SB_SLUG: config.sbSlug,
        AGENT_ID: config.sbSlug,
        GEMINI_SYSTEM_MD: promptFile,
        INK_CONTEXT: contextToken,
        ...(config.inkSessionId ? { INK_SESSION_ID: config.inkSessionId } : {}),
        ...(config.studioId ? { INK_STUDIO_ID: config.studioId } : {}),
        ...(settings ? { GEMINI_CLI_SYSTEM_SETTINGS_PATH: settings.path } : {}),
      },
      cleanup,
    };
  }
}
