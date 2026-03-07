/**
 * Skills Commands
 *
 * Manage PCP skills: discover, list, and sync across studios/worktrees.
 *
 * Commands:
 *   skills list    Show discovered skills (local + server)
 *   skills sync    Sync MCP-providing skills to local directories
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { execSync } from 'child_process';
import { discoverSkills, loadSkillInstruction } from '../repl/skills.js';
import { parseSkillMcpConfig } from '../lib/skill-mcp.js';
import { callPcpTool } from '../lib/pcp-mcp.js';

// ============================================================================
// Types
// ============================================================================

interface ServerSkill {
  name: string;
  displayName?: string;
  type: string;
  description: string;
  version?: string;
  mcp?: {
    name: string;
    command: string;
    args: string[];
    env?: Record<string, string>;
  };
}

interface GetSkillResponse {
  success: boolean;
  skillName: string;
  type: string;
  version: string;
  description: string;
  content: string;
  mcp?: ServerSkill['mcp'];
  triggers?: { keywords?: string[] };
}

// ============================================================================
// Helpers
// ============================================================================

function getWorktrees(): string[] {
  try {
    const output = execSync('git worktree list --porcelain', {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return output
      .split('\n')
      .filter((line) => line.startsWith('worktree '))
      .map((line) => line.slice('worktree '.length));
  } catch {
    return [process.cwd()];
  }
}

/**
 * Reconstruct a SKILL.md file from get_skill response data.
 */
function buildSkillMd(skill: GetSkillResponse): string {
  const frontmatter: Record<string, unknown> = {
    name: skill.skillName,
    description: skill.description,
    type: skill.type,
  };

  if (skill.version) frontmatter.version = skill.version;

  if (skill.triggers?.keywords) {
    frontmatter.triggers = { keywords: skill.triggers.keywords };
  }

  if (skill.mcp) {
    frontmatter.mcp = skill.mcp;
  }

  // Simple YAML serialization for the frontmatter
  const yamlLines = serializeYaml(frontmatter, 0);
  return `---\n${yamlLines}---\n\n${skill.content}\n`;
}

function serializeYaml(obj: unknown, indent: number): string {
  const prefix = '  '.repeat(indent);
  if (obj === null || obj === undefined) return '';

  if (Array.isArray(obj)) {
    if (obj.length === 0) return '[]\n';
    // Use inline format for simple string arrays
    if (obj.every((v) => typeof v === 'string')) {
      const items = obj.map((v) => JSON.stringify(v)).join(', ');
      return `[${items}]\n`;
    }
    return obj.map((v) => `${prefix}- ${String(v)}`).join('\n') + '\n';
  }

  if (typeof obj === 'object') {
    const entries = Object.entries(obj as Record<string, unknown>);
    if (entries.length === 0) return '{}\n';
    return entries
      .map(([key, val]) => {
        if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
          const nested = serializeYaml(val, indent + 1);
          return `${prefix}${key}:\n${nested}`;
        }
        const serialized = serializeYaml(val, indent).trimEnd();
        return `${prefix}${key}: ${serialized}\n`;
      })
      .join('');
  }

  if (typeof obj === 'string') return obj;
  return String(obj);
}

// ============================================================================
// List Command
// ============================================================================

async function listCommand(): Promise<void> {
  const cwd = process.cwd();
  const localSkills = discoverSkills(cwd);

  // Check which local skills provide MCP servers
  const withMcp = localSkills.map((skill) => {
    const mcp = parseSkillMcpConfig(skill.path);
    return { ...skill, mcp };
  });

  console.log(chalk.bold(`\nLocal Skills (${localSkills.length} discovered)\n`));

  if (localSkills.length === 0) {
    console.log(chalk.dim('  No local skills found.'));
    console.log(
      chalk.dim(
        '  Skills are discovered from .pcp/skills/, .claude/skills/, .codex/skills/, .gemini/skills/'
      )
    );
    console.log(chalk.dim('  Run `sb skills sync` to install skills from PCP server.\n'));
    return;
  }

  for (const skill of withMcp) {
    const mcpBadge = skill.mcp ? chalk.cyan(' [MCP]') : '';
    const sourceBadge = chalk.dim(` (${skill.source})`);
    console.log(`  ${skill.name}${mcpBadge}${sourceBadge}`);
  }

  // Try to show server skills too
  try {
    const result = await callPcpTool<{ success: boolean; skills: ServerSkill[] }>(
      'list_skills',
      {}
    );
    if (result.success && result.skills) {
      const serverMcp = result.skills.filter((s) => s.mcp);
      const localNames = new Set(localSkills.map((s) => s.name));
      const serverOnly = serverMcp.filter((s) => !localNames.has(s.name));

      if (serverOnly.length > 0) {
        console.log(chalk.bold(`\nServer Skills with MCP (not installed locally)`));
        for (const skill of serverOnly) {
          console.log(
            `  ${skill.name} ${chalk.cyan('[MCP]')} ${chalk.dim(`— ${skill.description}`)}`
          );
        }
        console.log(chalk.dim('\n  Run `sb skills sync` to install these locally.\n'));
      }
    }
  } catch {
    console.log(chalk.dim('\n  (PCP server not reachable — showing local skills only)\n'));
  }
}

// ============================================================================
// Sync Command
// ============================================================================

interface SyncOptions {
  all?: boolean;
  workspace?: boolean;
}

async function syncCommand(options: SyncOptions): Promise<void> {
  console.log(chalk.bold('\nSyncing skills from PCP server...\n'));

  // Fetch all skills from server
  let serverSkills: ServerSkill[];
  try {
    const result = await callPcpTool<{ success: boolean; skills: ServerSkill[] }>(
      'list_skills',
      {}
    );
    if (!result.success || !result.skills) {
      console.error(chalk.red('Failed to fetch skills from PCP server.'));
      process.exit(1);
    }
    serverSkills = result.skills;
  } catch (error) {
    console.error(chalk.red('Cannot reach PCP server.'));
    console.error(chalk.dim('Ensure the server is running (yarn dev) and try again.'));
    process.exit(1);
  }

  // Filter to skills with MCP configs
  const mcpSkills = serverSkills.filter((s) => s.mcp);
  if (mcpSkills.length === 0) {
    console.log(chalk.dim('  No MCP-providing skills found on server.'));
    return;
  }

  console.log(chalk.dim(`  Found ${mcpSkills.length} MCP-providing skill(s) on server`));

  // Determine target directories
  const targets: Array<{ dir: string; label: string }> = [];

  // Always sync to ~/.pcp/skills/ (managed tier — available to all SBs)
  targets.push({
    dir: join(homedir(), '.pcp', 'skills'),
    label: '~/.pcp/skills',
  });

  if (options.workspace) {
    targets.push({
      dir: join(process.cwd(), '.pcp', 'skills'),
      label: '.pcp/skills (workspace)',
    });
  }

  if (options.all) {
    const worktrees = getWorktrees();
    for (const wt of worktrees) {
      const wtSkillsDir = join(wt, '.pcp', 'skills');
      // Avoid duplicating cwd
      if (!targets.some((t) => t.dir === wtSkillsDir)) {
        targets.push({ dir: wtSkillsDir, label: `.pcp/skills (${wt})` });
      }
    }
  }

  // Fetch full skill content for each MCP skill
  let synced = 0;
  let skipped = 0;

  for (const skill of mcpSkills) {
    let detail: GetSkillResponse;
    try {
      detail = await callPcpTool<GetSkillResponse>('get_skill', { skillName: skill.name });
      if (!detail.success) {
        console.log(chalk.yellow(`  ! ${skill.name}: failed to fetch details`));
        continue;
      }
    } catch {
      console.log(chalk.yellow(`  ! ${skill.name}: failed to fetch details`));
      continue;
    }

    // Ensure mcp field is on the detail
    if (!detail.mcp && skill.mcp) {
      detail.mcp = skill.mcp;
    }

    const skillMd = buildSkillMd(detail);

    for (const target of targets) {
      const skillDir = join(target.dir, skill.name);
      const skillFile = join(skillDir, 'SKILL.md');

      // Skip if already exists and content matches
      if (existsSync(skillFile)) {
        const existing = readFileSync(skillFile, 'utf-8');
        if (existing === skillMd) {
          skipped++;
          continue;
        }
      }

      mkdirSync(skillDir, { recursive: true });
      writeFileSync(skillFile, skillMd);
      synced++;
      console.log(chalk.green(`  + ${skill.name}`), chalk.dim(`→ ${target.label}`));
    }
  }

  if (synced === 0 && skipped > 0) {
    console.log(chalk.dim(`\n  All ${skipped} skill(s) already up to date.`));
  } else if (synced > 0) {
    console.log(chalk.dim(`\n  Synced ${synced} skill(s), ${skipped} already up to date.`));
  }

  console.log(chalk.dim('Done.\n'));
}

// ============================================================================
// Register
// ============================================================================

export function registerSkillsCommands(program: Command): void {
  const skills = program.command('skills').description('Manage PCP skills');

  skills.command('list').description('List discovered skills (local + server)').action(listCommand);

  skills
    .command('sync')
    .description('Sync MCP-providing skills from PCP server to local directories')
    .option('--workspace', 'Also sync to workspace .pcp/skills/ (current directory)')
    .option('--all', 'Sync to all git worktrees')
    .action(syncCommand);
}
