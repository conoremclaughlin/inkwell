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

  if (!auth || expired || !hooks.installed) {
    console.log(
      chalk.yellow(
        '  Attention: auth + hooks should both be healthy for reliable trigger/session behavior.'
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
