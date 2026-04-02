/**
 * Init Command
 *
 * Set up a repo for Ink: install hooks, create default .mcp.json,
 * ensure .ink/ directory. Idempotent — skips steps already done.
 *
 * Commands:
 *   init    Initialize Ink in the current repo
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { installHooks } from './hooks.js';
import { syncMcpConfig } from './mcp.js';
import { syncSkills } from './skills.js';
import { loadAuth, decodeJwtPayload, isTokenExpired } from '../auth/tokens.js';

// ============================================================================
// Helpers
// ============================================================================

interface PcpConfig {
  userId?: string;
  email?: string;
}

function getPcpConfig(): PcpConfig | null {
  const configPath = join(homedir(), '.ink', 'config.json');
  if (existsSync(configPath)) {
    try {
      return JSON.parse(readFileSync(configPath, 'utf-8'));
    } catch {
      return null;
    }
  }
  return null;
}

function getPcpServerUrl(): string {
  return process.env.INK_SERVER_URL || 'http://localhost:3001';
}

function resolveChannelPluginPath(cwd: string): string | null {
  // Look for the channel plugin relative to the repo root
  const candidates = [
    join(cwd, 'packages', 'channel-plugin', 'index.ts'),
    join(cwd, '..', 'personal-context-protocol', 'packages', 'channel-plugin', 'index.ts'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

function buildDefaultMcpJson(serverUrl: string, cwd?: string): Record<string, unknown> {
  const servers: Record<string, unknown> = {
    inkstand: {
      type: 'http',
      url: `${serverUrl}/mcp`,
    },
  };

  // Add InkMail channel plugin for real-time inbox push notifications
  const channelPath = cwd ? resolveChannelPluginPath(cwd) : null;
  if (channelPath) {
    servers['inkmail'] = {
      command: 'npx',
      args: ['tsx', channelPath],
    };
  }

  return { mcpServers: servers };
}

// ============================================================================
// Init Steps
// ============================================================================

interface InitStepResult {
  label: string;
  status: 'created' | 'exists' | 'skipped' | 'updated';
  detail?: string;
}

function ensurePcpDir(cwd: string): InitStepResult {
  const pcpDir = join(cwd, '.ink');
  if (existsSync(pcpDir)) {
    return { label: '.ink/', status: 'exists' };
  }
  mkdirSync(pcpDir, { recursive: true });
  return { label: '.ink/', status: 'created' };
}

function ensureMcpJson(cwd: string): InitStepResult {
  const mcpPath = join(cwd, '.mcp.json');
  if (existsSync(mcpPath)) {
    // Check if inkstand server entry exists
    try {
      const existing = JSON.parse(readFileSync(mcpPath, 'utf-8')) as Record<string, unknown>;
      const servers = existing.mcpServers as Record<string, unknown> | undefined;
      if (servers?.inkstand) {
        // Add inkmail if missing and plugin exists locally
        if (!servers['inkmail']) {
          const channelPath = resolveChannelPluginPath(cwd);
          if (channelPath) {
            const updatedServers = { ...servers, 'inkmail': { command: 'npx', args: ['tsx', channelPath] } };
            const updated = { ...existing, mcpServers: updatedServers };
            writeFileSync(mcpPath, JSON.stringify(updated, null, 2) + '\n');
            return {
              label: '.mcp.json',
              status: 'updated',
              detail: 'added inkmail channel plugin',
            };
          }
        }
        return { label: '.mcp.json', status: 'exists', detail: 'inkstand server configured' };
      }
      // Add inkstand server to existing config
      const serverUrl = getPcpServerUrl();
      const updated = {
        ...existing,
        mcpServers: {
          ...(servers || {}),
          inkstand: {
            type: 'http',
            url: `${serverUrl}/mcp`,
          },
        },
      };
      writeFileSync(mcpPath, JSON.stringify(updated, null, 2) + '\n');
      return { label: '.mcp.json', status: 'updated', detail: 'added inkstand server' };
    } catch {
      return { label: '.mcp.json', status: 'exists', detail: 'unparseable, skipping' };
    }
  }

  const serverUrl = getPcpServerUrl();
  writeFileSync(mcpPath, JSON.stringify(buildDefaultMcpJson(serverUrl, cwd), null, 2) + '\n');
  return { label: '.mcp.json', status: 'created', detail: `inkstand → ${serverUrl}/mcp` };
}

function runInstallHooks(cwd: string, force?: boolean): InitStepResult[] {
  const targets = ['claude-code', 'codex', 'gemini'] as const;
  const results: InitStepResult[] = [];

  for (const backend of targets) {
    const { result, backend: resolvedBackend } = installHooks(cwd, { force, backend });
    switch (result) {
      case 'installed':
        results.push({
          label: `hooks (${resolvedBackend.name})`,
          status: 'created',
          detail: resolvedBackend.configPath,
        });
        break;
      case 'already-installed':
        results.push({
          label: `hooks (${resolvedBackend.name})`,
          status: 'exists',
          detail: resolvedBackend.configPath,
        });
        break;
      case 'conflict':
        results.push({
          label: `hooks (${resolvedBackend.name})`,
          status: 'skipped',
          detail: 'existing non-Inkstand hooks (use ink hooks install --force)',
        });
        break;
    }
  }

  return results;
}

function syncBackendConfigs(cwd: string): InitStepResult {
  if (!existsSync(join(cwd, '.mcp.json'))) {
    return { label: 'backend configs', status: 'skipped', detail: 'no .mcp.json' };
  }

  const result = syncMcpConfig(cwd);
  const synced: string[] = [];
  if (result.codex) synced.push('.codex/');
  if (result.gemini) synced.push('.gemini/');

  if (synced.length === 0) {
    return { label: 'backend configs', status: 'skipped', detail: 'no servers to sync' };
  }

  return { label: 'backend configs', status: 'created', detail: synced.join(', ') };
}

// ============================================================================
// Command
// ============================================================================

async function initCommand(options: { force?: boolean }): Promise<void> {
  const cwd = process.cwd();
  const config = getPcpConfig();

  console.log(chalk.bold('\nInitializing Inkstand...\n'));

  const auth = loadAuth();
  if (auth && !isTokenExpired(auth)) {
    const payload = decodeJwtPayload(auth.access_token);
    console.log(chalk.dim(`  User: ${payload?.email || 'authenticated'}`));
  } else if (config?.email) {
    console.log(chalk.dim(`  User: ${config.email} (not authenticated)`));
    console.log(chalk.yellow('  Run `ink auth login` to authenticate.'));
  } else {
    console.log(chalk.yellow('  Not authenticated. Run: ink auth login'));
  }
  console.log('');

  const steps: InitStepResult[] = [
    ensurePcpDir(cwd),
    ensureMcpJson(cwd),
    ...runInstallHooks(cwd, options.force),
    syncBackendConfigs(cwd),
  ];

  // Async step: sync skills from Inkstand server (best-effort)
  try {
    const skillsResult = await syncSkills(cwd);
    if (skillsResult.serverUnreachable) {
      steps.push({ label: 'skills sync', status: 'skipped', detail: 'server not reachable' });
    } else if (skillsResult.written > 0 || skillsResult.linked > 0) {
      steps.push({
        label: 'skills sync',
        status: 'created',
        detail: `${skillsResult.written} written, ${skillsResult.linked} symlinked`,
      });
    } else if (skillsResult.skipped > 0) {
      steps.push({ label: 'skills sync', status: 'exists', detail: 'all up to date' });
    } else {
      steps.push({ label: 'skills sync', status: 'skipped', detail: 'no MCP skills on server' });
    }
  } catch {
    steps.push({ label: 'skills sync', status: 'skipped', detail: 'error during sync' });
  }

  for (const step of steps) {
    const icon =
      step.status === 'created' || step.status === 'updated'
        ? chalk.green('✓')
        : step.status === 'exists'
          ? chalk.dim('·')
          : chalk.yellow('○');
    const statusText =
      step.status === 'created'
        ? chalk.green(step.status)
        : step.status === 'updated'
          ? chalk.cyan(step.status)
          : step.status === 'exists'
            ? chalk.dim(step.status)
            : chalk.yellow(step.status);
    const detail = step.detail ? chalk.dim(` (${step.detail})`) : '';
    console.log(`  ${icon} ${step.label}: ${statusText}${detail}`);
  }

  console.log(chalk.dim('\nDone.'));
}

// ============================================================================
// Register
// ============================================================================

export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description('Initialize Inkstand in the current repo (hooks, .mcp.json, backend configs, skills)')
    .option('-f, --force', 'Overwrite existing hooks even if non-Inkstand hooks are present')
    .action(initCommand);
}
