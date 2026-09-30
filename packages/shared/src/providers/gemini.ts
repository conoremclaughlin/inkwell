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

import { mkdir, readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { createIdentityPromptFile } from './identity-prompt.js';
import { encodeContextToken } from '../runner/mcp-config.js';
import {
  BakedRoutingHeaderError,
  findGeminiExtensionManifests,
  findGeminiSettingsRouting,
} from './gemini-settings-routing.js';
import type {
  BackendAdapter,
  BackendConfig,
  BackendHost,
  EffectiveConfigCheck,
  PreparedBackend,
} from './types.js';

/** The refusal when the spawn's env names no home for Gemini's user settings. */
export const GEMINI_NO_HOME_REFUSAL =
  "the Gemini spawn's env names no home (GEMINI_CLI_HOME or HOME), so its user settings cannot be checked";

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
export async function buildGeminiSettings(
  tempDir: string,
  cwd: string,
  contextToken: string,
  sessionId?: string,
  studioId?: string,
  explicitSession = false
): Promise<{ path: string; cleanup: () => Promise<void> } | null> {
  // Start from .mcp.json to preserve other MCP servers (supabase, github, etc.)
  const mcpJsonPath = join(cwd, '.mcp.json');
  let mcpServers: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(await readFile(mcpJsonPath, 'utf-8'));
    mcpServers = parsed.mcpServers || {};
  } catch {
    // missing or unparseable: start from no servers
  }

  // Merge Inkwell auth + session headers into the canonical 'inkwell' server.
  // Only the canonical Inkwell server is a header-injection target.
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

  const settingsDir = join(tempDir, 'ink-gemini');
  const settingsFile = join(settingsDir, `settings-${process.pid}-${randomUUID()}.json`);
  const cleanup = async (): Promise<void> => {
    await rm(settingsFile, { force: true }).catch(() => undefined);
  };
  try {
    await mkdir(settingsDir, { recursive: true });
    await writeFile(settingsFile, JSON.stringify({ mcpServers }, null, 2));
    return { path: settingsFile, cleanup };
  } catch {
    // A partial file is removed; the spawn goes ahead without the override.
    await cleanup();
    return null;
  }
}

export class GeminiAdapter implements BackendAdapter {
  readonly name = 'gemini';
  readonly binary = 'gemini';
  // Prompt rides argv (`-p <prompt>`) — bounded by OS ARG_MAX.
  readonly promptTransport = 'argv' as const;

  /**
   * The settings the spawn's Gemini will read its MCP servers from, judged
   * before the spawn (gemini-settings-routing.ts). Measured on 0.54.0 (Myra,
   * #701 9c94e5b3), four sources feed `mcpServers`:
   *
   * - user: `($GEMINI_CLI_HOME || $HOME)/.gemini/settings.json`, from the
   *   env the spawn will get. With neither, the spawn is refused;
   * - workspace: `<cwd>/.gemini/settings.json`, read whatever folder trust
   *   decides, which errs toward refusing;
   * - system: the file this adapter wrote for the spawn
   *   (GEMINI_CLI_SYSTEM_SETTINGS_PATH, in the adapter's env). Its routing
   *   headers are this spawn's own, so only the rule on servers other than
   *   Inkwell applies to it. It carries the servers copied from `.mcp.json`;
   * - extensions: `<dir>/<ext>/gemini-extension.json` under
   *   `<home>/.gemini/extensions`, whose servers load and expand like the
   *   settings' (Myra, #701 42b6a265), and under `<cwd>/.gemini/extensions`,
   *   whose loading is unmeasured. Every extension is read, enabled or not.
   *
   * Not read: the system-defaults file, whose path variable the spawn never
   * gets and whose default location is unmeasured; and the platform's default
   * system file (on macOS `/Library/Application Support/GeminiCli/settings.json`),
   * which Gemini reads only when the adapter wrote no system file. Both are
   * machine-wide admin files, and this check cannot ask which platform it is
   * on without reading the host process.
   */
  async checkEffectiveConfig(check: EffectiveConfigCheck): Promise<string | undefined> {
    // What the spawn's env holds for a name: the adapter's own over the base.
    const spawnValue = (name: string): string | undefined =>
      check.adapterEnv[name] ?? check.probeEnv[name];
    const home = spawnValue('GEMINI_CLI_HOME') || spawnValue('HOME');
    if (!home) return GEMINI_NO_HOME_REFUSAL;
    const scope = { inkwellMcpUrl: check.inkwellMcpUrl, sessionEnvNames: check.sessionEnvNames };
    const findings = await findGeminiSettingsRouting(
      [join(check.cwd, '.gemini', 'settings.json'), join(home, '.gemini', 'settings.json')],
      scope
    );
    const systemPath = spawnValue('GEMINI_CLI_SYSTEM_SETTINGS_PATH');
    if (systemPath) {
      const system = await findGeminiSettingsRouting([systemPath], scope);
      findings.push(...system.filter((finding) => finding.kind !== 'routing'));
    }
    const extensions = await findGeminiExtensionManifests([
      join(home, '.gemini', 'extensions'),
      join(check.cwd, '.gemini', 'extensions'),
    ]);
    findings.push(
      ...extensions.unreadable.map((path) => ({ path, kind: 'unreadable' as const })),
      ...(await findGeminiSettingsRouting(extensions.manifests, scope))
    );
    return findings.length > 0
      ? new BakedRoutingHeaderError('gemini', findings).message
      : undefined;
  }

  async prepare(config: BackendConfig, host: BackendHost): Promise<PreparedBackend> {
    const identity = await createIdentityPromptFile(
      host.paths.tempDir,
      config.sbSlug,
      undefined,
      config.systemPromptOverride
    );
    // A prepare that rejects leaves nothing behind (PreparedBackend.cleanup).
    try {
      return await this.prepareWith(config, host, identity);
    } catch (error) {
      await identity.cleanup();
      throw error;
    }
  }

  private async prepareWith(
    config: BackendConfig,
    host: BackendHost,
    { promptFile, cleanup: identityCleanup }: { promptFile: string; cleanup: () => Promise<void> }
  ): Promise<PreparedBackend> {
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
    // Non-fatal — worst case the grant is a no-op until the dir exists.
    await mkdir(inkStudiosDir, { recursive: true }).catch(() => undefined);
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
    const settings = await buildGeminiSettings(
      host.paths.tempDir,
      config.cwd,
      contextToken,
      config.inkSessionId,
      config.studioId,
      config.explicitSession === true
    );
    const cleanup = async (): Promise<void> => {
      await Promise.all([identityCleanup(), settings?.cleanup()]);
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
