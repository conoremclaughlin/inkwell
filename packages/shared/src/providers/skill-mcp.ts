/**
 * Skill MCP Config Extraction
 *
 * Reads skills that provide MCP servers (via `mcp` field in YAML frontmatter)
 * and merges them into a temporary .mcp.json for the backend to consume.
 *
 * Session header injection is delegated to the shared `injectSessionHeaders`
 * utility (packages/shared) so the same logic runs in both CLI and server paths.
 */

import { existsSync, readFileSync } from 'fs';
import { mkdir, readFile, rm, stat, writeFile } from 'fs/promises';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { applySessionHeaders } from '../runner/mcp-config.js';
import { discoverSkills } from './skill-discovery.js';

export interface SkillMcpServer {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/**
 * Parse the `mcp` field from a skill's YAML frontmatter.
 * Returns null if the skill doesn't provide an MCP server.
 */
export function parseSkillMcpConfig(skillPath: string): SkillMcpServer | null {
  const skillFile = join(skillPath, 'SKILL.md');
  if (!existsSync(skillFile)) return null;

  const content = readFileSync(skillFile, 'utf-8');

  // Extract YAML frontmatter between --- delimiters
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;

  const frontmatter = match[1];

  // Simple YAML parsing for the mcp block — avoids adding a yaml dependency.
  // Looks for:
  //   mcp:
  //     name: <string>
  //     command: <string>
  //     args: [...]
  //     env: {}
  // `\n?` on the last line: the frontmatter capture strips the newline before
  // the closing ---, so an mcp block that ends the frontmatter would otherwise
  // silently lose its final property.
  const mcpMatch = frontmatter.match(/^mcp:\s*\n((?:  .+\n?)*)/m);
  if (!mcpMatch) return null;

  const mcpBlock = mcpMatch[1];

  const name = mcpBlock.match(/^\s*name:\s*(.+)/m)?.[1]?.trim();
  const command = mcpBlock.match(/^\s*command:\s*(.+)/m)?.[1]?.trim();

  if (!name || !command) return null;

  // Parse args — inline [a, b] or block-style list (- a\n- b)
  let args: string[] = [];
  const argsInlineMatch = mcpBlock.match(/^\s*args:\s*\[([^\]]*)\]/m);
  if (argsInlineMatch) {
    args = argsInlineMatch[1]
      .split(',')
      .map((a) => a.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean);
  } else {
    // Block-style: args:\n    - value1\n    - value2
    const argsBlockMatch = mcpBlock.match(/^\s*args:\s*\n((?:\s+-\s+.+\n?)*)/m);
    if (argsBlockMatch) {
      args = argsBlockMatch[1]
        .split('\n')
        .map((line) =>
          line
            .replace(/^\s*-\s+/, '')
            .trim()
            .replace(/^["']|["']$/g, '')
        )
        .filter(Boolean);
    }
  }

  // Parse env — inline {K: V} or block-style (K: V\n K2: V2)
  const env: Record<string, string> = {};
  const envInlineMatch = mcpBlock.match(/^\s*env:\s*\{([^}]*)\}/m);
  if (envInlineMatch && envInlineMatch[1].trim()) {
    envInlineMatch[1].split(',').forEach((pair) => {
      const [k, v] = pair.split(':').map((s) => s.trim().replace(/^["']|["']$/g, ''));
      if (k && v) env[k] = v;
    });
  } else {
    // Block-style: env:\n    KEY: VALUE
    const envBlockMatch = mcpBlock.match(/^\s*env:\s*\n((?:\s+\w+:.+\n?)*)/m);
    if (envBlockMatch) {
      envBlockMatch[1].split('\n').forEach((line) => {
        const colonIdx = line.indexOf(':');
        if (colonIdx === -1) return;
        const k = line.slice(0, colonIdx).trim();
        const v = line
          .slice(colonIdx + 1)
          .trim()
          .replace(/^["']|["']$/g, '');
        if (k && v) env[k] = v;
      });
    }
  }

  return { name, command, args, env: Object.keys(env).length > 0 ? env : undefined };
}

/**
 * Discover all skills that provide MCP servers.
 */
export function discoverSkillMcpServers(cwd: string): SkillMcpServer[] {
  const skills = discoverSkills(cwd);
  const servers: SkillMcpServer[] = [];

  for (const skill of skills) {
    const mcpConfig = parseSkillMcpConfig(skill.path);
    if (mcpConfig) {
      servers.push(mcpConfig);
    }
  }

  return servers;
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

/** Where the InkMail channel plugin may live, in the order they are tried. */
function channelPluginCandidates(cwd: string): string[] {
  return [
    join(cwd, 'packages', 'channel-plugin', 'index.ts'),
    join(cwd, '..', 'personal-context-protocol', 'packages', 'channel-plugin', 'index.ts'),
  ];
}

/**
 * Resolve the InkMail channel plugin's entrypoint on disk. Shared with
 * `ink init` (which generates the project entry from the same candidates) so
 * the generator and the withholding boundary can never disagree about what
 * the plugin IS. Returns null when no candidate exists.
 */
export function resolveChannelPluginPath(cwd: string): string | null {
  for (const p of channelPluginCandidates(cwd)) {
    if (existsSync(p)) return p;
  }
  return null;
}

/** resolveChannelPluginPath without blocking, for a spawn's preparation. */
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
  const projectText = await readFile(projectMcpPath, 'utf-8').catch(() => undefined);
  let parsed: Partial<McpJsonConfig> | null = null;
  if (projectText !== undefined) {
    try {
      parsed = JSON.parse(projectText) as Partial<McpJsonConfig> | null;
    } catch {
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
    if (options.explicitSession === true && stripRoutingHeaders(config)) modified = true;
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
