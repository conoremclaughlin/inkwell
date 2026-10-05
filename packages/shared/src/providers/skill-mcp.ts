/**
 * The MCP config a spawn is handed: the project's .mcp.json with Inkwell's
 * session headers applied (the same applySessionHeaders the server runners
 * use) and the skill servers the caller's host discovered merged in. All IO
 * here is asynchronous; the synchronous skill helpers the CLI uses live in
 * skill-servers.ts.
 */

import { mkdir, readFile, rm, stat, writeFile } from 'fs/promises';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { applySessionHeaders } from '../runner/mcp-config.js';
import { pinIsolatedPlaywright } from '../runner/playwright-mcp.js';

export interface SkillMcpServer {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

interface McpJsonConfig {
  mcpServers: Record<
    string,
    {
      type?: string;
      command?: string;
      args?: string[];
      url?: string;
      env?: Record<string, string>;
      headers?: Record<string, string>;
    }
  >;
}

/**
 * Where the InkMail channel plugin may live, in the order they are tried.
 * Shared with the synchronous resolver `ink init` uses (skill-servers.ts), so
 * the generator and the withholding boundary agree on what the plugin IS.
 */
export function channelPluginCandidates(cwd: string): string[] {
  return [
    join(cwd, 'packages', 'channel-plugin', 'index.ts'),
    join(cwd, '..', 'personal-context-protocol', 'packages', 'channel-plugin', 'index.ts'),
  ];
}

/** The channel plugin's entrypoint on disk, found without blocking, or null. */
async function findChannelPluginPath(cwd: string): Promise<string | null> {
  for (const p of channelPluginCandidates(cwd)) {
    const found = await stat(p).then(
      () => true,
      () => false
    );
    if (found) return p;
  }
  return null;
}

/** Headers that say which session and studio a request serves. */
const ROUTING_HEADERS: ReadonlySet<string> = new Set([
  'x-ink-session-id',
  'x-ink-studio-id',
  'x-ink-context',
]);

/**
 * Remove every routing header from every server, matching names
 * case-insensitively, as HTTP does. Returns whether any was removed.
 */
function stripRoutingHeaders(config: McpJsonConfig): boolean {
  let stripped = false;
  for (const server of Object.values(config.mcpServers)) {
    const headers = server.headers;
    if (!headers) continue;
    for (const name of Object.keys(headers)) {
      if (ROUTING_HEADERS.has(name.toLowerCase())) {
        delete headers[name];
        stripped = true;
      }
    }
  }
  return stripped;
}

/**
 * Write a config under `<tempDir>/sb-mcp`, one file per spawn: a parent and
 * its shadow clones spawn from one process, and a shared name would let the
 * first cleanup delete a config another backend has not read yet. A failed
 * write removes any partial file before the error propagates.
 */
async function writeSpawnConfig(
  tempDir: string,
  prefix: string,
  config: McpJsonConfig
): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const dir = join(tempDir, 'sb-mcp');
  const path = join(dir, `${prefix}-${process.pid}-${randomUUID()}.json`);
  const cleanup = async (): Promise<void> => {
    await rm(path, { force: true }).catch(() => undefined);
  };
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(path, JSON.stringify(config, null, 2));
  } catch (error) {
    await cleanup();
    throw error;
  }
  return { path, cleanup };
}

/**
 * Build the MCP config a spawn is handed: the project's .mcp.json with
 * Inkwell's session headers injected (the same applySessionHeaders the server
 * runners use) and the skill servers the caller's host discovered merged in.
 *
 * It is built in memory and written once, under `tempDir`, only when it
 * differs from the project file; otherwise the project path is returned as
 * is, and null when there is no project file. All IO is asynchronous.
 *
 * With `omitToolServers` (wholly-in-ink, ink-owned tool routing) the config
 * is CHANNEL-ONLY: every tool-bearing server (inkwell, supabase, github,
 * skill-provided, …) is dropped and only the verified canonical channel
 * bridge survives. The result is always a temp file, even when empty — the
 * adapter pairs it with `--strict-mcp-config` so an empty config means "no
 * MCP servers at all".
 */
export async function buildMergedMcpConfig(
  cwd: string,
  options: {
    /**
     * The session and studio the headers route to, already resolved: a
     * launcher's adapter has applied its host's ambient session, and a spawn
     * that named its own passes exactly that. Nothing is read from the env.
     */
    inkSessionId?: string;
    studioId?: string;
    omitToolServers?: boolean;
    /**
     * The caller named the session and studio, possibly as none: drop any
     * session, studio or context header the project config carries, so the
     * named ids are the only routing (see BackendConfig).
     */
    explicitSession?: boolean;
    /** Skill-provided servers to merge, as the host discovered them. */
    skillServers: SkillMcpServer[];
    /** Where a written config goes (BackendHost.paths.tempDir). */
    tempDir: string;
  }
): Promise<{
  mcpConfigPath: string | null;
  cleanup: () => Promise<void>;
  /**
   * Whether the FINAL config actually retains the inkmail channel bridge.
   * The channel flag (`--dangerously-load-development-channels
   * server:inkmail`) must key off this, never off the raw project file — a
   * rejected non-canonical entry would otherwise still be requested by name
   * against a strict config that no longer defines it.
   */
  hasChannelBridge: boolean;
}> {
  const projectMcpPath = join(cwd, '.mcp.json');
  const explicit = options.explicitSession === true;
  // Only a missing file is "no project config". For a spawn that named its
  // session, a file that cannot be read or parsed is refused: its routing
  // headers could not be stripped, and passing it through, or dropping it,
  // would both be a guess. The reason is fixed; no file content is quoted.
  const projectText = await readFile(projectMcpPath, 'utf-8').catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT' || !explicit) return undefined;
    throw new Error(
      `the project .mcp.json could not be read (${(error as NodeJS.ErrnoException)?.code ?? 'unknown error'})`
    );
  });
  let parsed: Partial<McpJsonConfig> | null = null;
  if (projectText !== undefined) {
    try {
      parsed = JSON.parse(projectText) as Partial<McpJsonConfig> | null;
    } catch {
      if (explicit) throw new Error('the project .mcp.json is not valid JSON');
      parsed = null;
    }
  }

  if (options.omitToolServers) {
    // Channel-only, deliberately: skill-provided MCP servers are NOT merged
    // here. Skill discovery spans repo/home roots independent of active
    // skills or tool policy, so re-adding them would restore provider-native
    // tools inside the very mode meant to withhold them (Lumen's review
    // probe surfaced an inactive playwright skill doing exactly that).
    // MCP-bearing skills require backend routing until ink has an
    // active+policy-approved mediation path.
    //
    // Header injection is intentionally skipped too: it only decorates the
    // tool servers being dropped. Channel bridges get their context from the
    // spawn env (INK_CONTEXT), not from config headers.
    const config: McpJsonConfig = { mcpServers: {} };
    // The project entry is only an OPT-IN signal — its launcher, args, and
    // path are NEVER copied. The retained entry is CONSTRUCTED from the
    // init-generator's own resolver, so a squatting or lookalike entry
    // (`node /tmp/evil.js packages/channel-plugin/index.ts`, an attacker path
    // merely ending in the canonical suffix, `bash -c …` with a decoy argv)
    // structurally cannot reach the provider — validation of
    // attacker-controlled strings is replaced by not consuming them at all
    // (Lumen, PR #462 review 4894572540). No resolvable plugin on disk → no
    // bridge; fail closed costs inbox push, never the boundary.
    if (parsed?.mcpServers?.['inkmail']) {
      const pluginPath = await findChannelPluginPath(cwd);
      if (pluginPath) {
        config.mcpServers['inkmail'] = { type: 'stdio', command: 'npx', args: ['tsx', pluginPath] };
      }
    }
    const written = await writeSpawnConfig(options.tempDir, 'mcp-local', config);
    return {
      mcpConfigPath: written.path,
      hasChannelBridge: 'inkmail' in config.mcpServers,
      cleanup: written.cleanup,
    };
  }

  // Non-withholding path: the channel flag keys off the project config's own
  // inkmail entry (any shape — the full config passes through unchanged, so
  // whatever is defined there is what claude will see).
  const hasChannelBridge = Boolean(parsed?.mcpServers?.['inkmail']);

  const config: McpJsonConfig = { mcpServers: {}, ...(parsed ?? {}) } as McpJsonConfig;
  let modified = false;
  if (parsed) {
    // injectSessionHeaders keeps a header the project config already sets.
    // For a caller that named its session a configured one is stale routing:
    // drop it, so the named ids are injected fresh, or stay absent when the
    // caller named none.
    if (explicit && stripRoutingHeaders(config)) modified = true;
    // The x-ink-context header carries identity (sbSlug/studioId/runtime)
    // even without a session; the session and studio headers only when named.
    if (
      applySessionHeaders(config, {
        inkSessionId: options.inkSessionId,
        studioId: options.studioId,
      })
    ) {
      modified = true;
    }
  }
  for (const server of options.skillServers) {
    if (!config.mcpServers[server.name]) {
      config.mcpServers[server.name] = {
        type: 'stdio',
        command: server.command,
        args: server.args,
        ...(server.env ? { env: server.env } : {}),
      };
      modified = true;
    }
  }

  const playwright = pinIsolatedPlaywright(config.mcpServers);
  config.mcpServers = playwright.servers;
  modified ||= playwright.pinned.length > 0;

  if (!modified) {
    return {
      mcpConfigPath: projectText !== undefined ? projectMcpPath : null,
      hasChannelBridge,
      cleanup: async () => undefined,
    };
  }
  const written = await writeSpawnConfig(options.tempDir, 'mcp', config);
  return { mcpConfigPath: written.path, hasChannelBridge, cleanup: written.cleanup };
}
