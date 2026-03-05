/**
 * sb permissions — manage backend permission configs
 *
 * Currently supports Claude Code only (the only backend with granular
 * allow/deny rules). Codex and Gemini lack per-command deny support.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import chalk from 'chalk';
import type { Command } from 'commander';

const CLAUDE_SETTINGS_PATH = '.claude/settings.local.json';

/**
 * Default deny rules — destructive commands that should require confirmation
 * even when everything else is auto-approved.
 */
const DEFAULT_DENY_RULES: string[] = [
  'Bash(rm -rf *)',
  'Bash(git push --force *)',
  'Bash(git push -f *)',
  'Bash(git reset --hard *)',
  'Bash(git clean -fd *)',
  'Bash(git clean -f *)',
  'Bash(git checkout -- .)',
];

/**
 * Default allow rules — broad permissions for normal development work.
 */
const DEFAULT_ALLOW_RULES: string[] = [
  'Bash(*)',
  'Edit(*)',
  'Write(*)',
  'Read(*)',
  'WebFetch(*)',
  'WebSearch',
  'mcp__pcp__*',
  'mcp__github__*',
  'mcp__supabase__*',
];

interface ClaudeSettings {
  permissions?: {
    allow?: string[];
    deny?: string[];
  };
  [key: string]: unknown;
}

function readClaudeSettings(cwd: string): ClaudeSettings {
  const configPath = join(cwd, CLAUDE_SETTINGS_PATH);
  if (!existsSync(configPath)) return {};
  try {
    return JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch {
    return {};
  }
}

function writeClaudeSettings(cwd: string, settings: ClaudeSettings): void {
  const configPath = join(cwd, CLAUDE_SETTINGS_PATH);
  mkdirSync(join(cwd, '.claude'), { recursive: true });
  writeFileSync(configPath, JSON.stringify(settings, null, 2) + '\n');
}

export function registerPermissionsCommands(parent: Command): void {
  const perms = parent.command('permissions').description('Manage backend permission configs');

  perms
    .command('auto')
    .description('Set up auto-approve with deny rules for dangerous commands (Claude only)')
    .option('--dry-run', 'Show what would be written without making changes')
    .action((options: { dryRun?: boolean }) => {
      const cwd = process.cwd();
      const existing = readClaudeSettings(cwd);

      const updated: ClaudeSettings = {
        ...existing,
        permissions: {
          ...existing.permissions,
          allow: DEFAULT_ALLOW_RULES,
          deny: DEFAULT_DENY_RULES,
        },
      };

      if (options.dryRun) {
        console.log(chalk.dim('Would write to ' + CLAUDE_SETTINGS_PATH + ':'));
        console.log();
        console.log(chalk.green('Allow (auto-approve):'));
        for (const rule of DEFAULT_ALLOW_RULES) {
          console.log(chalk.green(`  + ${rule}`));
        }
        console.log();
        console.log(chalk.red('Deny (always block):'));
        for (const rule of DEFAULT_DENY_RULES) {
          console.log(chalk.red(`  - ${rule}`));
        }
        return;
      }

      writeClaudeSettings(cwd, updated);

      console.log(chalk.green('Permissions configured in ' + CLAUDE_SETTINGS_PATH));
      console.log();
      console.log(chalk.dim('Allow (auto-approve):'));
      for (const rule of DEFAULT_ALLOW_RULES) {
        console.log(chalk.dim(`  + ${rule}`));
      }
      console.log();
      console.log(chalk.dim('Deny (always block):'));
      for (const rule of DEFAULT_DENY_RULES) {
        console.log(chalk.dim(`  - ${rule}`));
      }
      console.log();
      console.log(
        chalk.yellow('Note: deny rules are Claude Code only. Use --dangerous for Codex/Gemini.')
      );
    });

  perms
    .command('show')
    .description('Show current permission rules')
    .action(() => {
      const cwd = process.cwd();
      const settings = readClaudeSettings(cwd);
      const perms = settings.permissions;

      if (!perms?.allow?.length && !perms?.deny?.length) {
        console.log(chalk.dim('No permission rules configured.'));
        console.log(
          chalk.dim('Run `sb permissions auto` to set up auto-approve with safety deny rules.')
        );
        return;
      }

      if (perms.allow?.length) {
        console.log(chalk.green('Allow:'));
        for (const rule of perms.allow) {
          console.log(chalk.green(`  + ${rule}`));
        }
      }

      if (perms.deny?.length) {
        console.log();
        console.log(chalk.red('Deny:'));
        for (const rule of perms.deny) {
          console.log(chalk.red(`  - ${rule}`));
        }
      }
    });

  perms
    .command('reset')
    .description('Remove all auto-approve and deny rules')
    .action(() => {
      const cwd = process.cwd();
      const existing = readClaudeSettings(cwd);

      if (!existing.permissions?.allow?.length && !existing.permissions?.deny?.length) {
        console.log(chalk.dim('No permission rules to reset.'));
        return;
      }

      const updated: ClaudeSettings = { ...existing };
      delete updated.permissions;
      writeClaudeSettings(cwd, updated);

      console.log(chalk.green('Permission rules removed. Claude will prompt for all actions.'));
    });
}
