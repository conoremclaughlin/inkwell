/**
 * Skills Commands
 *
 * Manage PCP skills: discover, list, and sync across studios/worktrees.
 * Writes to ALL backend skill directories so skills show up natively in
 * Claude Code (/skills), Codex, and Gemini — not just PCP's discovery.
 *
 * Commands:
 *   skills list    Show discovered skills (local + server)
 *   skills sync    Sync skills from PCP server to all backend configs
 */

import { Command } from 'commander';
import chalk from 'chalk';
import * as yaml from 'yaml';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { execFileSync } from 'child_process';
import { discoverSkills } from '../repl/skills.js';
import { parseSkillMcpConfig } from '../lib/skill-mcp.js';
import { callPcpTool } from '../lib/pcp-mcp.js';
import { syncMcpConfig } from './mcp.js';

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

// ============================================================================
// Constants
// ============================================================================

/** Canonical skill directory — single source of truth */
const PCP_SKILLS_DIR = join(homedir(), '.ink', 'skills');

/**
 * Backend skill directories that get symlinks pointing to PCP_SKILLS_DIR.
 * This makes skills show up in each backend's native discovery:
 *   Claude Code: /skills   Codex: native   Gemini: native
 */
const BACKEND_SKILL_DIRS = [
  join(homedir(), '.claude', 'skills'),
  join(homedir(), '.codex', 'skills'),
  join(homedir(), '.gemini', 'skills'),
];

// ============================================================================
// Helpers
// ============================================================================

function getWorktrees(): string[] {
  try {
    const output = execFileSync('git', ['worktree', 'list', '--porcelain'], {
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

export function buildSkillMd(skill: GetSkillResponse): string {
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

  const yamlLines = yaml.stringify(frontmatter).trimEnd();
  return `---\n${yamlLines}\n---\n\n${skill.content}\n`;
}

function injectMcpServers(
  mcpJsonPath: string,
  skills: ServerSkill[]
): { added: string[]; existed: string[] } {
  let config: McpJsonConfig = { mcpServers: {} };
  if (existsSync(mcpJsonPath)) {
    try {
      config = JSON.parse(readFileSync(mcpJsonPath, 'utf-8'));
      if (!config.mcpServers) config.mcpServers = {};
    } catch {
      config = { mcpServers: {} };
    }
  }

  const added: string[] = [];
  const existed: string[] = [];

  for (const skill of skills) {
    if (!skill.mcp) continue;
    const serverName = skill.mcp.name;

    if (config.mcpServers[serverName]) {
      existed.push(serverName);
      continue;
    }

    config.mcpServers[serverName] = {
      type: 'stdio',
      command: skill.mcp.command,
      args: skill.mcp.args,
      ...(skill.mcp.env && Object.keys(skill.mcp.env).length > 0 ? { env: skill.mcp.env } : {}),
    };
    added.push(serverName);
  }

  if (added.length > 0) {
    writeFileSync(mcpJsonPath, JSON.stringify(config, null, 2) + '\n');
  }

  return { added, existed };
}

/** Validate server-provided names before they reach any filesystem operation. */
export function assertSkillName(skillName: string): void {
  if (
    typeof skillName !== 'string' ||
    !/^[a-zA-Z0-9]/.test(skillName) ||
    /[^a-zA-Z0-9._-]/.test(skillName)
  ) {
    throw new Error('Skill name must be a single alphanumeric-led path component');
  }
}

function entryAt(filePath: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Write canonical SKILL.md; return false when its content is unchanged. */
export function writeCanonicalSkill(skillName: string, content: string): boolean {
  assertSkillName(skillName);
  const skillDir = join(PCP_SKILLS_DIR, skillName);
  const skillFile = join(skillDir, 'SKILL.md');

  for (const candidate of [skillDir, skillFile]) {
    if (entryAt(candidate)?.isSymbolicLink()) {
      throw new Error('Refusing to write a canonical skill through a symlink');
    }
  }

  if (existsSync(skillFile)) {
    const existing = readFileSync(skillFile, 'utf-8');
    if (existing === content) return false;
  }

  mkdirSync(skillDir, { recursive: true });
  writeFileSync(skillFile, content);
  return true;
}

/**
 * Create a symlink from a backend skill dir to the canonical PCP skill dir.
 * Returns 'created' | 'exists' | 'updated' (if symlink target changed).
 */
export function ensureSkillSymlink(
  backendDir: string,
  skillName: string
): 'created' | 'exists' | 'updated' {
  assertSkillName(skillName);
  const linkPath = join(backendDir, skillName);
  const targetPath = join(PCP_SKILLS_DIR, skillName);

  mkdirSync(backendDir, { recursive: true });

  const entry = entryAt(linkPath);
  if (entry?.isSymbolicLink()) {
    if (readlinkSync(linkPath) === targetPath) return 'exists';
    // lstat also sees dangling links. Remove the link, never its target.
    unlinkSync(linkPath);
  } else if (entry) {
    // The name is validated before any IO, so a server response cannot
    // escape the backend directory. No shell interprets the path.
    rmSync(linkPath, { recursive: true, force: true });
  }

  symlinkSync(targetPath, linkPath);
  return entry ? 'updated' : 'created';
}

// ============================================================================
// List Command
// ============================================================================

async function listCommand(): Promise<void> {
  const cwd = process.cwd();
  const localSkills = discoverSkills(cwd);

  const withMcp = localSkills.map((skill) => {
    const mcp = parseSkillMcpConfig(skill.path);
    return { ...skill, mcp };
  });

  console.log(chalk.bold(`\nLocal Skills (${localSkills.length} discovered)\n`));

  if (localSkills.length === 0) {
    console.log(chalk.dim('  No local skills found.'));
    console.log(
      chalk.dim(
        '  Skills are discovered from .ink/skills/, .claude/skills/, .codex/skills/, .gemini/skills/'
      )
    );
    console.log(chalk.dim('  Run `ink skills sync` to install skills from PCP server.\n'));
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
        console.log(chalk.dim('\n  Run `ink skills sync` to install these locally.\n'));
      }
    }
  } catch {
    console.log(chalk.dim('\n  (PCP server not reachable — showing local skills only)\n'));
  }
}

// ============================================================================
// Sync Core (reusable by init)
// ============================================================================

export interface SyncSkillsResult {
  written: number;
  linked: number;
  skipped: number;
  mcpAdded: string[];
  serverUnreachable: boolean;
}

/**
 * Sync skills from PCP server to local dirs + backend configs.
 * Pure logic — no console output. Used by both `ink skills sync` and `ink init`.
 */
export async function syncSkills(
  cwd: string,
  options: { all?: boolean } = {}
): Promise<SyncSkillsResult> {
  const result: SyncSkillsResult = {
    written: 0,
    linked: 0,
    skipped: 0,
    mcpAdded: [],
    serverUnreachable: false,
  };

  // Fetch all skills from server
  let serverSkills: ServerSkill[];
  try {
    const listResult = await callPcpTool<{ success: boolean; skills: ServerSkill[] }>(
      'list_skills',
      {}
    );
    if (!listResult.success || !listResult.skills) return result;
    serverSkills = listResult.skills;
  } catch {
    result.serverUnreachable = true;
    return result;
  }

  const mcpSkills = serverSkills.filter((s) => s.mcp);
  if (mcpSkills.length === 0) return result;

  // Step 1: Write canonical SKILL.md + symlink to backend dirs
  for (const skill of mcpSkills) {
    assertSkillName(skill.name);
    let detail: GetSkillResponse;
    try {
      detail = await callPcpTool<GetSkillResponse>('get_skill', { skillName: skill.name });
      if (!detail.success) continue;
    } catch {
      continue;
    }

    if (!detail.mcp && skill.mcp) detail.mcp = skill.mcp;
    const skillMd = buildSkillMd(detail);

    if (writeCanonicalSkill(skill.name, skillMd)) {
      result.written++;
    } else {
      result.skipped++;
    }

    for (const backendDir of BACKEND_SKILL_DIRS) {
      const linkResult = ensureSkillSymlink(backendDir, skill.name);
      if (linkResult === 'created' || linkResult === 'updated') {
        result.linked++;
      }
    }
  }

  // Step 2: Inject MCP servers into .mcp.json
  const mcpTargets: string[] = [cwd];
  if (options.all) {
    for (const wt of getWorktrees()) {
      if (wt !== cwd && existsSync(join(wt, '.mcp.json'))) {
        mcpTargets.push(wt);
      }
    }
  }

  const mcpAddedSet = new Set<string>();
  for (const targetDir of mcpTargets) {
    const mcpPath = join(targetDir, '.mcp.json');
    if (!existsSync(mcpPath)) continue;
    const { added } = injectMcpServers(mcpPath, mcpSkills);
    for (const name of added) mcpAddedSet.add(name);
  }
  result.mcpAdded = [...mcpAddedSet];

  // Step 3: Sync to Codex/Gemini backend configs
  const syncTargets = options.all ? getWorktrees() : [cwd];
  for (const targetDir of syncTargets) {
    if (!existsSync(join(targetDir, '.mcp.json'))) continue;
    syncMcpConfig(targetDir);
  }

  return result;
}

// ============================================================================
// Sync Command
// ============================================================================

interface SyncOptions {
  all?: boolean;
}

async function syncCommand(options: SyncOptions): Promise<void> {
  const cwd = process.cwd();
  console.log(chalk.bold('\nSyncing skills from PCP server...\n'));

  const result = await syncSkills(cwd, options);

  if (result.serverUnreachable) {
    console.error(chalk.red('Cannot reach PCP server.'));
    console.error(chalk.dim('Ensure the server is running (yarn dev) and try again.'));
    process.exit(1);
  }

  if (result.written === 0 && result.linked === 0 && result.skipped === 0) {
    console.log(chalk.dim('  No MCP-providing skills found on server.'));
    return;
  }

  if (result.written > 0) {
    console.log(chalk.green(`  ${result.written} skill(s) written to ~/.ink/skills/`));
  }
  if (result.linked > 0) {
    console.log(chalk.green(`  ${result.linked} symlink(s) created across backend dirs`));
  }
  if (result.mcpAdded.length > 0) {
    console.log(
      chalk.green(`  ${result.mcpAdded.length} MCP server(s) added to .mcp.json:`),
      chalk.dim(result.mcpAdded.join(', '))
    );
  }
  if (result.written === 0 && result.linked === 0 && result.skipped > 0) {
    console.log(chalk.dim('  All skill(s) already up to date.'));
  }

  console.log(
    chalk.dim('\nDone. Skills available to all backends (claude /skills, codex, gemini).\n')
  );
}

// ============================================================================
// Register
// ============================================================================

export function registerSkillsCommands(program: Command): void {
  const skills = program.command('skills').description('Manage PCP skills');

  skills.command('list').description('List discovered skills (local + server)').action(listCommand);

  skills
    .command('sync')
    .description('Sync MCP-providing skills from PCP server to all backend configs')
    .option('--all', 'Also sync .mcp.json + backend configs across all git worktrees')
    .action(syncCommand);
}
