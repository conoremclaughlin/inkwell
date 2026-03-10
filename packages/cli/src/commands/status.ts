/**
 * Status Command
 *
 * Unified health/status snapshot for SB CLI.
 * Surfaces auth + hooks together so it's easy to diagnose runtime issues.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { decodeJwtPayload, isTokenExpired, loadAuth } from '../auth/tokens.js';
import { resolveAgentId, resolveBackend } from '../backends/index.js';
import { readIdentityJson } from '../backends/identity.js';
import { getPcpServerUrl } from '../lib/pcp-mcp.js';

type StatusBackend = 'claude' | 'codex' | 'gemini';

function normalizeBackend(value: string): StatusBackend {
  if (value === 'codex' || value === 'gemini') return value;
  return 'claude';
}

function getHookConfigPath(backend: StatusBackend): string {
  switch (backend) {
    case 'codex':
      return '.codex/config.toml';
    case 'gemini':
      return '.gemini/settings.json';
    case 'claude':
    default:
      return '.claude/settings.local.json';
  }
}

function hasPcpHookCommand(value: unknown): boolean {
  const signatures = [
    'hooks on-session-start',
    'hooks on-stop',
    'hooks on-prompt',
    'hooks pre-compact',
    'hooks post-compact',
  ];
  if (typeof value === 'string') {
    return (
      value.includes('sb hooks ') ||
      signatures.some((signature) => value.includes(signature)) ||
      value.includes('commands/hooks.js')
    );
  }
  if (Array.isArray(value)) {
    return value.some((entry) => hasPcpHookCommand(entry));
  }
  if (value && typeof value === 'object') {
    return Object.values(value).some((entry) => hasPcpHookCommand(entry));
  }
  return false;
}

function getHooksInstalled(
  cwd: string,
  backend: StatusBackend
): {
  installed: boolean;
  configExists: boolean;
  parseError: boolean;
} {
  const configPath = join(cwd, getHookConfigPath(backend));
  if (!existsSync(configPath)) {
    return { installed: false, configExists: false, parseError: false };
  }

  if (backend === 'codex') {
    const content = readFileSync(configPath, 'utf-8');
    return {
      installed: content.includes('hooks on-session-start') || content.includes('hooks on-stop'),
      configExists: true,
      parseError: false,
    };
  }

  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    return {
      installed: hasPcpHookCommand(parsed.hooks),
      configExists: true,
      parseError: false,
    };
  } catch {
    return { installed: false, configExists: true, parseError: true };
  }
}

interface ClaudePermissionsStatus {
  configExists: boolean;
  parseError: boolean;
  hasPermissions: boolean;
  allowCount: number;
  denyCount: number;
  hasPcpMcpAllowance: boolean;
}

function hasPcpMcpAllowRule(rule: string): boolean {
  const normalized = rule.trim();
  return (
    normalized === 'mcp__pcp__*' ||
    normalized === 'mcp__*' ||
    normalized === '*' ||
    normalized.startsWith('mcp__pcp__')
  );
}

export function getClaudePermissionsStatus(cwd: string): ClaudePermissionsStatus {
  const settingsPath = join(cwd, '.claude', 'settings.local.json');
  if (!existsSync(settingsPath)) {
    return {
      configExists: false,
      parseError: false,
      hasPermissions: false,
      allowCount: 0,
      denyCount: 0,
      hasPcpMcpAllowance: false,
    };
  }

  try {
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf-8')) as {
      permissions?: { allow?: unknown; deny?: unknown };
    };
    const allow = Array.isArray(parsed.permissions?.allow)
      ? parsed.permissions?.allow.filter((rule): rule is string => typeof rule === 'string')
      : [];
    const deny = Array.isArray(parsed.permissions?.deny)
      ? parsed.permissions?.deny.filter((rule): rule is string => typeof rule === 'string')
      : [];
    return {
      configExists: true,
      parseError: false,
      hasPermissions: allow.length > 0 || deny.length > 0,
      allowCount: allow.length,
      denyCount: deny.length,
      hasPcpMcpAllowance: allow.some((rule) => hasPcpMcpAllowRule(rule)),
    };
  } catch {
    return {
      configExists: true,
      parseError: true,
      hasPermissions: false,
      allowCount: 0,
      denyCount: 0,
      hasPcpMcpAllowance: false,
    };
  }
}

interface McpConfigStatus {
  configExists: boolean;
  parseError: boolean;
  hasPcpServer: boolean;
  pcpUrl?: string;
}

export function getMcpConfigStatus(cwd: string): McpConfigStatus {
  const mcpPath = join(cwd, '.mcp.json');
  if (!existsSync(mcpPath)) {
    return { configExists: false, parseError: false, hasPcpServer: false };
  }

  try {
    const parsed = JSON.parse(readFileSync(mcpPath, 'utf-8')) as {
      mcpServers?: Record<string, { url?: unknown }>;
    };
    const pcpServer = parsed.mcpServers?.pcp;
    const pcpUrl = typeof pcpServer?.url === 'string' ? pcpServer.url : undefined;
    return {
      configExists: true,
      parseError: false,
      hasPcpServer: Boolean(pcpServer),
      ...(pcpUrl ? { pcpUrl } : {}),
    };
  } catch {
    return { configExists: true, parseError: true, hasPcpServer: false };
  }
}

async function statusCommand(options: { backend?: string }): Promise<void> {
  const cwd = process.cwd();
  const identity = readIdentityJson(cwd);
  const agentId = resolveAgentId() || 'unresolved';
  const backend = normalizeBackend(resolveBackend(options.backend));
  const hookConfig = getHookConfigPath(backend);

  const auth = loadAuth();
  const payload = auth ? decodeJwtPayload(auth.access_token) : null;
  const expired = auth ? isTokenExpired(auth, 0) : false;

  const hooks = getHooksInstalled(cwd, backend);
  const claudePermissions = backend === 'claude' ? getClaudePermissionsStatus(cwd) : undefined;
  const mcpConfig = getMcpConfigStatus(cwd);
  const pcpServerUrl = getPcpServerUrl();

  console.log(chalk.bold('\nSB Status\n'));
  console.log(`  ${chalk.bold('Agent:')}   ${agentId}`);
  console.log(`  ${chalk.bold('Backend:')} ${backend}`);
  if (identity?.identityId) {
    console.log(`  ${chalk.bold('Identity:')} ${chalk.dim(identity.identityId)}`);
  }
  if (identity?.studio) {
    console.log(`  ${chalk.bold('Studio:')}  ${identity.studio}`);
  }
  console.log('');

  console.log(chalk.bold('Auth'));
  if (!auth) {
    console.log(`  ${chalk.yellow('Not logged in')}`);
    console.log(chalk.dim('  Run: sb auth login'));
  } else if (expired) {
    console.log(`  ${chalk.yellow('Token expired')}`);
    if (payload?.email) {
      console.log(`  ${chalk.dim(payload.email)}`);
    }
  } else {
    console.log(`  ${chalk.green('Authenticated')}${payload?.email ? ` as ${payload.email}` : ''}`);
  }
  console.log('');

  console.log(chalk.bold('Hooks'));
  console.log(`  ${chalk.dim(hookConfig)}`);
  if (!hooks.configExists) {
    console.log(`  ${chalk.yellow('Not installed')}`);
    console.log(chalk.dim(`  Run: sb hooks install -b ${backend}`));
  } else if (hooks.parseError) {
    console.log(`  ${chalk.red('Config parse error')}`);
  } else if (hooks.installed) {
    console.log(`  ${chalk.green('Installed')}`);
  } else {
    console.log(`  ${chalk.yellow('No PCP hooks found')}`);
    console.log(chalk.dim(`  Run: sb hooks install -b ${backend}`));
  }
  console.log('');

  console.log(chalk.bold('Permissions'));
  if (backend !== 'claude') {
    console.log(chalk.dim('  Managed by backend runtime (no local allow/deny file).'));
  } else if (!claudePermissions?.configExists) {
    console.log(chalk.yellow('  .claude/settings.local.json missing'));
    console.log(chalk.dim('  Run: sb permissions auto'));
  } else if (claudePermissions.parseError) {
    console.log(chalk.red('  .claude/settings.local.json parse error'));
  } else if (!claudePermissions.hasPermissions) {
    console.log(chalk.yellow('  No explicit permission rules configured'));
    console.log(chalk.dim('  Run: sb permissions auto'));
  } else {
    console.log(
      `  ${chalk.green('Configured')} (${claudePermissions.allowCount} allow, ${claudePermissions.denyCount} deny)`
    );
    if (!claudePermissions.hasPcpMcpAllowance) {
      console.log(chalk.yellow('  No MCP PCP allow rule detected (mcp__pcp__*)'));
    }
  }
  console.log('');

  console.log(chalk.bold('MCP Config'));
  console.log(`  ${chalk.dim('.mcp.json')}`);
  if (!mcpConfig.configExists) {
    console.log(chalk.yellow('  Missing'));
    console.log(chalk.dim('  Run: sb init'));
  } else if (mcpConfig.parseError) {
    console.log(chalk.red('  Parse error'));
  } else if (!mcpConfig.hasPcpServer) {
    console.log(chalk.yellow('  Missing mcpServers.pcp'));
    console.log(chalk.dim('  Run: sb init'));
  } else {
    console.log(
      `  ${chalk.green('PCP server configured')} (${mcpConfig.pcpUrl || chalk.dim('<url not set>')})`
    );
  }
  console.log(`  ${chalk.dim('PCP_SERVER_URL')} ${pcpServerUrl}`);
  console.log('');

  const permissionsHealthy =
    backend !== 'claude'
      ? true
      : Boolean(
          claudePermissions &&
          claudePermissions.configExists &&
          !claudePermissions.parseError &&
          claudePermissions.hasPermissions &&
          claudePermissions.hasPcpMcpAllowance
        );
  const mcpHealthy =
    mcpConfig.configExists && !mcpConfig.parseError && mcpConfig.hasPcpServer === true;
  if (!auth || expired || !hooks.installed || !permissionsHealthy || !mcpHealthy) {
    console.log(
      chalk.yellow(
        '  Attention: auth + hooks + permissions + mcp config should all be healthy for reliable trigger/session behavior.'
      )
    );
    console.log('');
  }
}

export function registerStatusCommand(program: Command): void {
  program
    .command('status')
    .description('Show unified auth + hooks status')
    .option('-b, --backend <name>', 'Backend to inspect (claude, codex, gemini)')
    .action(statusCommand);
}
