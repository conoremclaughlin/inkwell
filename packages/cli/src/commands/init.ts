/**
 * Init Command
 *
 * Set up a repo for PCP: install hooks, create default .mcp.json,
 * ensure .pcp/ directory. Idempotent — skips steps already done.
 *
 * Commands:
 *   init    Initialize PCP in the current repo
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { installHooks } from './hooks.js';
import { syncMcpConfig } from './mcp.js';
import { loadAuth, decodeJwtPayload, isTokenExpired } from '../auth/tokens.js';

// ============================================================================
// Helpers
// ============================================================================

interface PcpConfig {
  userId?: string;
  email?: string;
}

function getPcpConfig(): PcpConfig | null {
  const configPath = join(homedir(), '.pcp', 'config.json');
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
  return process.env.PCP_SERVER_URL || 'http://localhost:3001';
}

function buildDefaultMcpJson(serverUrl: string): Record<string, unknown> {
  return {
    mcpServers: {
      pcp: {
        type: 'http',
        url: `${serverUrl}/mcp`,
        headers: {
          Authorization: 'Bearer ${PCP_ACCESS_TOKEN}',
        },
      },
    },
  };
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
  const pcpDir = join(cwd, '.pcp');
  if (existsSync(pcpDir)) {
    return { label: '.pcp/', status: 'exists' };
  }
  mkdirSync(pcpDir, { recursive: true });
  return { label: '.pcp/', status: 'created' };
}

function ensureMcpJson(cwd: string): InitStepResult {
  const mcpPath = join(cwd, '.mcp.json');
  if (existsSync(mcpPath)) {
    // Check if pcp server entry exists
    try {
      const existing = JSON.parse(readFileSync(mcpPath, 'utf-8')) as Record<string, unknown>;
      const servers = existing.mcpServers as Record<string, unknown> | undefined;
      if (servers?.pcp) {
        // Migrate existing pcp entry to include auth header if missing
        const pcpEntry = servers.pcp as Record<string, unknown>;
        const headers = pcpEntry.headers as Record<string, string> | undefined;
        if (!headers?.Authorization) {
          const updatedPcp = {
            ...pcpEntry,
            headers: { ...headers, Authorization: 'Bearer ${PCP_ACCESS_TOKEN}' },
          };
          const updated = {
            ...existing,
            mcpServers: { ...servers, pcp: updatedPcp },
          };
          writeFileSync(mcpPath, JSON.stringify(updated, null, 2) + '\n');
          return {
            label: '.mcp.json',
            status: 'updated',
            detail: 'added auth header to pcp entry',
          };
        }
        return { label: '.mcp.json', status: 'exists', detail: 'pcp server configured' };
      }
      // Add pcp server to existing config
      const serverUrl = getPcpServerUrl();
      const updated = {
        ...existing,
        mcpServers: {
          ...(servers || {}),
          pcp: {
            type: 'http',
            url: `${serverUrl}/mcp`,
            headers: { Authorization: 'Bearer ${PCP_ACCESS_TOKEN}' },
          },
        },
      };
      writeFileSync(mcpPath, JSON.stringify(updated, null, 2) + '\n');
      return { label: '.mcp.json', status: 'updated', detail: 'added pcp server' };
    } catch {
      return { label: '.mcp.json', status: 'exists', detail: 'unparseable, skipping' };
    }
  }

  const serverUrl = getPcpServerUrl();
  writeFileSync(mcpPath, JSON.stringify(buildDefaultMcpJson(serverUrl), null, 2) + '\n');
  return { label: '.mcp.json', status: 'created', detail: `pcp → ${serverUrl}/mcp` };
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
          detail: 'existing non-PCP hooks (use sb hooks install --force)',
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

  console.log(chalk.bold('\nInitializing PCP...\n'));

  const auth = loadAuth();
  if (auth && !isTokenExpired(auth)) {
    const payload = decodeJwtPayload(auth.access_token);
    console.log(chalk.dim(`  User: ${payload?.email || 'authenticated'}`));
  } else if (config?.email) {
    console.log(chalk.dim(`  User: ${config.email} (not authenticated)`));
    console.log(chalk.yellow('  Run `sb auth login` to authenticate.'));
  } else {
    console.log(chalk.yellow('  Not authenticated. Run: sb auth login'));
  }
  console.log('');

  const steps: InitStepResult[] = [
    ensurePcpDir(cwd),
    ensureMcpJson(cwd),
    ...runInstallHooks(cwd, options.force),
    syncBackendConfigs(cwd),
  ];

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
    .description('Initialize PCP in the current repo (hooks, .mcp.json, backend configs)')
    .option('-f, --force', 'Overwrite existing hooks even if non-PCP hooks are present')
    .action(initCommand);
}
