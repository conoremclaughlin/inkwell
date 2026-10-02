/**
 * ink permissions — manage backend permission configs
 *
 * Currently supports Claude Code only (the only backend with granular
 * allow/deny rules). Codex and Gemini lack per-command deny support.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import chalk from 'chalk';
import type { Command } from 'commander';
import { DEFAULT_CLAUDE_ALLOW_RULES, DEFAULT_CLAUDE_DENY_RULES } from '@inklabs/shared';

const CLAUDE_SETTINGS_PATH = '.claude/settings.local.json';

/**
 * The full-auto defaults, from the one list in @inklabs/shared. This file
 * kept its own copy until design v3 (item 6), and the copy had drifted: it
 * never gained `mcp__playwright__*`.
 */
const DEFAULT_DENY_RULES: string[] = [...DEFAULT_CLAUDE_DENY_RULES];
const DEFAULT_ALLOW_RULES: string[] = [...DEFAULT_CLAUDE_ALLOW_RULES];

interface ClaudeSettings {
  permissions?: {
    allow?: string[];
    deny?: string[];
  };
  [key: string]: unknown;
}

/**
 * The settings file, `{}` when absent, or null when it exists but is not a
 * JSON object. A writer must refuse null: treating a malformed file as
 * empty and writing over it replaces whatever rules the person had there
 * (review 4177f7fe, P2 2).
 */
function readClaudeSettings(cwd: string): ClaudeSettings | null {
  const configPath = join(cwd, CLAUDE_SETTINGS_PATH);
  if (!existsSync(configPath)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath, 'utf-8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as ClaudeSettings)
      : null;
  } catch {
    return null;
  }
}

/** Refuse to write over a file that cannot be read; says so and sets exit 1. */
function refuseMalformed(): void {
  console.error(
    chalk.red(
      `${CLAUDE_SETTINGS_PATH} is not a JSON object; left as it is. Fix or remove it, then run this again.`
    )
  );
  process.exitCode = 1;
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
      if (!existing) return refuseMalformed();

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
        chalk.yellow('Note: deny rules are Claude Code only. Use --yolo for Codex/Gemini.')
      );
    });

  perms
    .command('show')
    .description('Show current permission rules')
    .action(() => {
      const cwd = process.cwd();
      const settings = readClaudeSettings(cwd);
      if (!settings) return refuseMalformed();
      const perms = settings.permissions;

      if (!perms?.allow?.length && !perms?.deny?.length) {
        console.log(chalk.dim('No permission rules configured.'));
        console.log(
          chalk.dim('Run `ink permissions auto` to set up auto-approve with safety deny rules.')
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
      if (!existing) return refuseMalformed();

      if (!existing.permissions?.allow?.length && !existing.permissions?.deny?.length) {
        console.log(chalk.dim('No permission rules to reset.'));
        return;
      }

      // An empty object, not a deleted key: a studio's next `ink init` keeps
      // an authored object and fills a missing one with its profile, so
      // deleting the key would turn a deliberate ask-everything into the
      // builder profile (review 4177f7fe, P2 2).
      const updated: ClaudeSettings = { ...existing, permissions: {} };
      writeClaudeSettings(cwd, updated);

      console.log(chalk.green('Permission rules removed. Claude will prompt for all actions.'));
    });
}
