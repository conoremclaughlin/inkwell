/**
 * Skill MCP Config Extraction
 *
 * Reads skills that provide MCP servers (via `mcp` field in YAML frontmatter)
 * and merges them into a temporary .mcp.json for the backend to consume.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
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
  const mcpMatch = frontmatter.match(/^mcp:\s*\n((?:  .+\n)*)/m);
  if (!mcpMatch) return null;

  const mcpBlock = mcpMatch[1];

  const name = mcpBlock.match(/^\s*name:\s*(.+)/m)?.[1]?.trim();
  const command = mcpBlock.match(/^\s*command:\s*(.+)/m)?.[1]?.trim();
  const argsMatch = mcpBlock.match(/^\s*args:\s*\[([^\]]*)\]/m);

  if (!name || !command) return null;

  const args = argsMatch
    ? argsMatch[1]
        .split(',')
        .map((a) => a.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean)
    : [];

  // Parse env if present
  const envMatch = mcpBlock.match(/^\s*env:\s*\{([^}]*)\}/m);
  const env: Record<string, string> = {};
  if (envMatch && envMatch[1].trim()) {
    envMatch[1].split(',').forEach((pair) => {
      const [k, v] = pair.split(':').map((s) => s.trim().replace(/^["']|["']$/g, ''));
      if (k && v) env[k] = v;
    });
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
 * Build a merged MCP config that includes both the project's .mcp.json
 * and any skill-provided MCP servers. Returns the path to a temp file
 * and a cleanup function.
 *
 * If no skill MCP servers are found, returns the original .mcp.json path
 * (no temp file needed).
 */
export function buildMergedMcpConfig(cwd: string): {
  mcpConfigPath: string | null;
  cleanup: () => void;
} {
  const projectMcpPath = join(cwd, '.mcp.json');
  const skillServers = discoverSkillMcpServers(cwd);

  // No skill MCP servers — just use the project config as-is
  if (skillServers.length === 0) {
    return {
      mcpConfigPath: existsSync(projectMcpPath) ? projectMcpPath : null,
      cleanup: () => {},
    };
  }

  // Load existing project config
  let config: McpJsonConfig = { mcpServers: {} };
  if (existsSync(projectMcpPath)) {
    try {
      config = JSON.parse(readFileSync(projectMcpPath, 'utf-8'));
    } catch {
      config = { mcpServers: {} };
    }
  }

  // Merge skill-provided servers (don't override existing ones)
  for (const server of skillServers) {
    if (!config.mcpServers[server.name]) {
      config.mcpServers[server.name] = {
        type: 'stdio',
        command: server.command,
        args: server.args,
        ...(server.env ? { env: server.env } : {}),
      };
    }
  }

  // Write merged config to temp file
  const tmpDir = join(tmpdir(), 'sb-mcp');
  mkdirSync(tmpDir, { recursive: true });
  const tmpPath = join(tmpDir, `mcp-${process.pid}.json`);
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
