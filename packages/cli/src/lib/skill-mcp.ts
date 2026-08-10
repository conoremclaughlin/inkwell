/**
 * Skill MCP Config Extraction
 *
 * Reads skills that provide MCP servers (via `mcp` field in YAML frontmatter)
 * and merges them into a temporary .mcp.json for the backend to consume.
 *
 * Session header injection is delegated to the shared `injectSessionHeaders`
 * utility (packages/shared) so the same logic runs in both CLI and server paths.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { injectSessionHeaders } from '@inklabs/shared';
import { discoverSkills } from '../repl/skills.js';

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

/**
 * MCP servers that survive tool withholding (`omitToolServers`). These are
 * channel bridges, not tool providers: `inkmail` is resolved by name via
 * `--dangerously-load-development-channels server:inkmail` and registers zero
 * model-callable tools — dropping it kills inbox push notifications without
 * withholding anything.
 */
const CHANNEL_SERVER_NAMES = new Set(['inkmail']);

/**
 * A channel bridge must LOOK like the channel plugin, not merely be named
 * after it — a tool-bearing server that happens to claim the `inkmail` key
 * (an HTTP server, or a stdio command pointing anywhere else) would otherwise
 * ride the name allowlist straight through the withholding boundary. Verified
 * shape: stdio command whose invocation references the channel-plugin package.
 * Fail closed — a non-canonical entry costs inbox push, never the boundary.
 */
function isCanonicalChannelBridge(server: {
  command?: string;
  url?: string;
  args?: string[];
}): boolean {
  if (!server?.command || server.url) return false;
  return [server.command, ...(server.args ?? [])].some((part) =>
    String(part).includes('channel-plugin')
  );
}

/**
 * Build a merged MCP config that includes both the project's .mcp.json
 * and any skill-provided MCP servers. Also injects PCP session/studio
 * headers via the shared injectSessionHeaders utility.
 *
 * Two layers:
 * 1. Session header injection (shared with server runners via @inklabs/shared)
 * 2. Skill MCP server merging (CLI-only — server runners don't load skills)
 *
 * Returns the path to a temp file and a cleanup function.
 * When no modifications are needed, returns the original .mcp.json path.
 *
 * With `omitToolServers` (wholly-in-ink, ink-owned tool routing) the project
 * config's tool-bearing servers (inkwell, supabase, github, …) are dropped:
 * only channel bridges and skill-provided servers reach the provider. The
 * result is always a temp file, even when empty — the adapter pairs it with
 * `--strict-mcp-config` so an empty config means "no MCP servers at all".
 */
export function buildMergedMcpConfig(
  cwd: string,
  options?: { pcpSessionId?: string; studioId?: string; omitToolServers?: boolean }
): {
  mcpConfigPath: string | null;
  cleanup: () => void;
} {
  const projectMcpPath = join(cwd, '.mcp.json');
  const hasProjectConfig = existsSync(projectMcpPath);

  if (options?.omitToolServers) {
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
    if (hasProjectConfig) {
      try {
        const parsed = JSON.parse(readFileSync(projectMcpPath, 'utf-8')) as Partial<McpJsonConfig>;
        for (const [name, server] of Object.entries(parsed.mcpServers ?? {})) {
          if (CHANNEL_SERVER_NAMES.has(name) && isCanonicalChannelBridge(server)) {
            config.mcpServers[name] = server;
          }
        }
      } catch {
        // Unreadable project config — start from an empty server set.
      }
    }
    const tmpDir = join(tmpdir(), 'sb-mcp');
    mkdirSync(tmpDir, { recursive: true });
    const tmpPath = join(tmpDir, `mcp-local-${process.pid}.json`);
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
    };
  }

  // ── Layer 1: Session header injection (shared logic) ──
  // Delegates to the same injectSessionHeaders used by server runners.
  // Prefer explicit options over process.env — the CLI knows the session ID
  // before it's set in the spawn env.
  const cleanups: Array<() => void> = [];
  let effectivePath = hasProjectConfig ? projectMcpPath : null;

  const sessionId = options?.pcpSessionId || process.env.INK_SESSION_ID;
  const studioId = options?.studioId || process.env.INK_STUDIO_ID;

  // Always run injection when we have a config path. The x-ink-context header
  // still carries useful identity (agentId/studioId/runtime) even when the
  // session ID isn't known yet — sessionId-specific headers are gated inside
  // injectSessionHeaders.
  if (effectivePath) {
    const injection = injectSessionHeaders({
      mcpConfigPath: effectivePath,
      pcpSessionId: sessionId,
      studioId,
    });
    if (injection.modified) {
      effectivePath = injection.mcpConfigPath;
      cleanups.push(injection.cleanup);
    }
  }

  // ── Layer 2: Skill MCP server merging (CLI-only) ──
  const skillServers = discoverSkillMcpServers(cwd);
  if (skillServers.length === 0) {
    return {
      mcpConfigPath: effectivePath,
      cleanup: () => cleanups.forEach((fn) => fn()),
    };
  }

  // Load config (from injection temp file or original)
  let config: McpJsonConfig = { mcpServers: {} };
  if (effectivePath) {
    try {
      const parsed = JSON.parse(readFileSync(effectivePath, 'utf-8'));
      config = { mcpServers: {}, ...parsed };
    } catch {
      config = { mcpServers: {} };
    }
  }

  let skillsModified = false;
  for (const server of skillServers) {
    if (!config.mcpServers[server.name]) {
      config.mcpServers[server.name] = {
        type: 'stdio',
        command: server.command,
        args: server.args,
        ...(server.env ? { env: server.env } : {}),
      };
      skillsModified = true;
    }
  }

  if (!skillsModified) {
    return {
      mcpConfigPath: effectivePath,
      cleanup: () => cleanups.forEach((fn) => fn()),
    };
  }

  // Write final merged config (skills + headers) to temp file
  const tmpDir = join(tmpdir(), 'sb-mcp');
  mkdirSync(tmpDir, { recursive: true });
  const tmpPath = join(tmpDir, `mcp-${process.pid}.json`);
  writeFileSync(tmpPath, JSON.stringify(config, null, 2));

  // Clean up the injection temp file (if any) since we wrote a new one
  cleanups.forEach((fn) => fn());

  return {
    mcpConfigPath: tmpPath,
    cleanup: () => {
      try {
        unlinkSync(tmpPath);
      } catch {
        // Best-effort cleanup
      }
    },
  };
}
