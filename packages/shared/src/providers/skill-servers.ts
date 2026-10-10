import { parseSkillMcpContent } from './skill-mcp-parser.js';
/**
 * The synchronous skill helpers, for the CLI host and `ink init`: parsing
 * a skill's `mcp` frontmatter, discovering the skill-provided MCP servers
 * for a directory, and resolving the channel plugin on disk.
 *
 * They read files synchronously, so no preparation file imports them: a
 * spawn's preparation asks its host for skill servers (BackendHost
 * .skillMcpServers) and finds the channel plugin asynchronously
 * (skill-mcp.ts). providers-prep-guard.test.ts holds that line.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { discoverSkills } from './skill-discovery.js';
import { channelPluginCandidates, type SkillMcpServer } from './skill-mcp.js';

/**
 * Parse the `mcp` field from a skill's YAML frontmatter.
 * Returns null if the skill doesn't provide an MCP server.
 */
export function parseSkillMcpConfig(skillPath: string): SkillMcpServer | null {
  const skillFile = join(skillPath, 'SKILL.md');
  if (!existsSync(skillFile)) return null;

  const content = readFileSync(skillFile, 'utf-8');

  return parseSkillMcpContent(content);
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

/**
 * Resolve the InkMail channel plugin's entrypoint on disk. Shared with
 * `ink init` (which generates the project entry from the same candidates) so
 * the generator and the withholding boundary can never disagree about what
 * the plugin IS. Returns null when no candidate exists.
 */
export function resolveChannelPluginPath(
  cwd: string,
  channelPluginCheckout?: string
): string | null {
  for (const p of channelPluginCandidates(cwd, channelPluginCheckout)) {
    if (existsSync(p)) return p;
  }
  return null;
}
