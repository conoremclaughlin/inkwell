/**
 * Config Commands
 *
 * Manage backend configuration.
 *
 * Commands:
 *   config sync    Convert .mcp.json to Codex and Gemini formats
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import { join, relative, resolve as resolvePath } from 'path';

import { syncMcpConfig, parseEnvFile, findTemplateVars, type McpJson } from '@inklabs/shared';

// Re-exported so existing importers (init, skills, memory, tests) keep working
// while @inklabs/shared stays the single definition. See studio/bootstrap.ts.
export { syncMcpConfig, parseEnvFile };

interface SyncSource {
  mcpPath: string;
  envPath?: string;
  from: 'local' | 'main';
}

// ============================================================================
// Commands
// ============================================================================

function resolveCanonicalRepoRoot(gitRoot: string): string {
  const gitFile = join(gitRoot, '.git');
  if (!existsSync(gitFile)) return gitRoot;

  try {
    const stat = readFileSync(gitFile, 'utf-8');
    const match = stat.match(/^gitdir:\s*(.+)\s*$/m);
    if (!match) return gitRoot;

    const gitDirPath = resolvePath(gitRoot, match[1]);
    const marker = `${join('.git', 'worktrees')}`;
    const idx = gitDirPath.lastIndexOf(marker);
    if (idx === -1) return gitRoot;

    // /path/to/repo/.git/worktrees/name -> /path/to/repo
    return resolvePath(gitDirPath.slice(0, idx));
  } catch {
    return gitRoot;
  }
}

function resolveSyncSource(targetDir: string): SyncSource | null {
  const localMcp = join(targetDir, '.mcp.json');
  if (existsSync(localMcp)) {
    return {
      mcpPath: localMcp,
      ...(existsSync(join(targetDir, '.env.local'))
        ? { envPath: join(targetDir, '.env.local') }
        : {}),
      from: 'local',
    };
  }

  try {
    const gitRoot = execSync('git rev-parse --show-toplevel', {
      cwd: targetDir,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const canonicalRoot = resolveCanonicalRepoRoot(gitRoot);
    if (canonicalRoot !== targetDir) {
      const mainMcp = join(canonicalRoot, '.mcp.json');
      if (existsSync(mainMcp)) {
        return {
          mcpPath: mainMcp,
          ...(existsSync(join(canonicalRoot, '.env.local'))
            ? { envPath: join(canonicalRoot, '.env.local') }
            : {}),
          from: 'main',
        };
      }
    }
  } catch {
    // Not in a git repo or git unavailable — no fallback
  }

  return null;
}
async function syncCommand(): Promise<void> {
  const cwd = process.cwd();
  const source = resolveSyncSource(cwd);

  if (!source) {
    console.error(chalk.red('No .mcp.json found in current directory'));
    console.error(chalk.dim('Tip: new studios copy .mcp.json/.env.local from main by default.'));
    process.exit(1);
  }

  let mcpJson: McpJson;
  try {
    mcpJson = JSON.parse(readFileSync(source.mcpPath, 'utf-8'));
  } catch (err) {
    console.error(chalk.red(`Failed to parse .mcp.json (${source.mcpPath}): ${err}`));
    process.exit(1);
  }

  if (!mcpJson.mcpServers || Object.keys(mcpJson.mcpServers).length === 0) {
    console.log(chalk.yellow('No MCP servers found in .mcp.json'));
    return;
  }

  const serverCount = Object.keys(mcpJson.mcpServers).length;
  const envLocalPath = join(cwd, '.env.local');
  const hasEnvLocal = existsSync(envLocalPath);
  const sourceEnvExists = !!(source.envPath && existsSync(source.envPath));
  const sourcePathRelative = relative(cwd, source.mcpPath);
  const sourcePathDisplay =
    sourcePathRelative === ''
      ? '.mcp.json'
      : sourcePathRelative.startsWith('.')
        ? sourcePathRelative
        : `./${sourcePathRelative}`;

  if (source.from === 'main') {
    console.log(chalk.yellow('Warning: local .mcp.json is missing in this studio.'));
    console.log(chalk.dim(`  Falling back to root main: ${sourcePathDisplay}`));
    if (!hasEnvLocal && sourceEnvExists) {
      console.log(chalk.dim('  Also using root main .env.local for referenced ${VAR} values.'));
    }
    console.log(chalk.dim('  If this is not preferred:'));
    console.log(
      chalk.dim('    1) Add .mcp.json/.env.local to this studio, then rerun `ink config sync`')
    );
    console.log(
      chalk.dim(
        '    2) Or create a new studio from a specific source: `ink studio create <slug> --copy-from <studio-path>`'
      )
    );
    console.log('');
  }

  const sourceLabel =
    source.from === 'local'
      ? '.mcp.json'
      : `${sourcePathDisplay} ${chalk.dim('(fallback from root main worktree)')}`;

  console.log(
    chalk.dim(
      `Found ${serverCount} server(s) in ${sourceLabel}${
        hasEnvLocal ? ' + .env.local' : sourceEnvExists ? ' + main .env.local' : ''
      }\n`
    )
  );

  const result = syncMcpConfig(cwd, {
    sourceMcpPath: source.mcpPath,
    ...(source.envPath ? { sourceEnvPath: source.envPath } : {}),
  });

  if (result.codex) {
    console.log(chalk.green('  wrote'), chalk.cyan('.codex/config.toml'));
  }
  if (result.gemini) {
    console.log(chalk.green('  wrote'), chalk.cyan('.gemini/settings.json'));
  }

  if (hasEnvLocal || sourceEnvExists) {
    const envVars = {
      ...(source.envPath ? parseEnvFile(source.envPath) : {}),
      ...parseEnvFile(envLocalPath),
    };
    const allRefs = new Set<string>();
    for (const config of Object.values(mcpJson.mcpServers)) {
      for (const v of findTemplateVars(config)) allRefs.add(v);
    }
    const resolved = [...allRefs].filter((v) => envVars[v]);
    if (resolved.length > 0) {
      console.log(chalk.green('  injected'), chalk.dim(`.env.local vars: ${resolved.join(', ')}`));
    }
  }

  console.log(chalk.dim(`\nDone. All backends can now discover MCP servers.`));
}

// ============================================================================
// Register Commands
// ============================================================================

export function registerConfigCommands(program: Command): void {
  const config = program.command('config').description('Manage backend configuration');

  config
    .command('sync')
    .description('Sync .mcp.json to Codex (.codex/config.toml) and Gemini (.gemini/settings.json)')
    .action(syncCommand);
}
