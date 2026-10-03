/**
 * ink permissions — manage backend permission configs
 *
 * Currently supports Claude Code only (the only backend with granular
 * allow/deny rules). Codex and Gemini lack per-command deny support.
 *
 * `sync` brings an existing studio's settings up to its permission
 * profile, additively (lib/permission-sync): the tools a profile gained
 * after the studio was made, for instance. It reports unless `--apply`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import chalk from 'chalk';
import type { Command } from 'commander';
import {
  DEFAULT_CLAUDE_ALLOW_RULES,
  DEFAULT_CLAUDE_DENY_RULES,
  type StudioPermissionProfile,
} from '@inklabs/shared';
import { detectWorktree, type WorktreePlacement } from './init.js';
import { lookupStudioByPath, type StudioLookup } from '../lib/studio-lookup.js';
import { syncStudioPermissions, type StudioPermissionSync } from '../lib/permission-sync.js';

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

// ============================================================================
// sync: an existing studio's settings, brought up to its profile
// ============================================================================

export interface PermissionsSyncOptions {
  /** Write the additions; without it the run only reports them. */
  apply?: boolean;
  /** The profile, from a person; default the studio row's. */
  profile?: string;
  /** Whose scratch paths the profile names; default the studio row's SB. */
  owner?: string;
}

export interface PermissionsSyncDeps {
  placement?: (cwd: string) => WorktreePlacement;
  lookupStudio?: (worktreePath: string) => Promise<StudioLookup>;
}

export type PermissionsSyncReport =
  | (StudioPermissionSync & { worktreePath: string; source: string })
  | { worktreePath: string; outcome: 'refused'; detail: string };

const PROFILES: readonly StudioPermissionProfile[] = ['builder', 'reviewer'];

/**
 * Sync the studio at `target` to its permission profile (lib/permission-sync).
 * The profile and its owner come from the studio's row, or from flags a
 * person passed, never from the checkout: identity.json is not quarantined
 * in a review checkout. The main worktree is refused: its file is the
 * operator's own lane rules, not a profile.
 */
export async function runPermissionsSync(
  target: string,
  options: PermissionsSyncOptions = {},
  deps: PermissionsSyncDeps = {}
): Promise<PermissionsSyncReport> {
  const placement = (deps.placement ?? detectWorktree)(target);
  const worktreePath = placement.toplevel ?? resolve(target);
  const refuse = (detail: string): PermissionsSyncReport => ({
    worktreePath,
    outcome: 'refused',
    detail,
  });
  if (!placement.toplevel) return refuse('not a git checkout');
  if (!placement.linked) {
    return refuse(
      "the main worktree's settings are the operator's own rules, not a studio profile; run this in a studio"
    );
  }
  if (
    options.profile !== undefined &&
    !PROFILES.includes(options.profile as StudioPermissionProfile)
  ) {
    return refuse(`unknown profile ${JSON.stringify(options.profile)}: builder or reviewer`);
  }

  let profile = options.profile as StudioPermissionProfile | undefined;
  let owner = options.owner;
  const sources: string[] = [];
  if (profile) sources.push('--profile');
  if (owner) sources.push('--owner');
  if (!profile || !owner) {
    const lookup = await (deps.lookupStudio ?? lookupStudioByPath)(worktreePath);
    if (lookup.status === 'unknown') {
      return refuse(`could not read the studio's row (${lookup.reason}); nothing was changed`);
    }
    if (lookup.status === 'none') {
      return refuse('no studio row for this checkout; pass --profile and --owner to name them');
    }
    if (!profile && lookup.row.permissionProfile) {
      profile = lookup.row.permissionProfile;
      sources.push('the studio row (profile)');
    }
    if (!owner && lookup.row.sbSlug) {
      owner = lookup.row.sbSlug;
      sources.push('the studio row (owner)');
    }
  }
  if (!profile || !owner) {
    return refuse(
      `the studio's row names no ${!profile ? 'profile' : 'owner'}; pass ${!profile ? '--profile' : '--owner'}`
    );
  }

  const synced = syncStudioPermissions(worktreePath, {
    profile,
    owner,
    apply: options.apply === true,
  });
  return { ...synced, worktreePath, source: sources.join(', ') };
}

function printSyncReport(report: PermissionsSyncReport, apply: boolean): void {
  console.log(chalk.bold(report.worktreePath));
  if (!('profile' in report)) {
    console.log(chalk.red(`  refused: ${report.detail}`));
    return;
  }
  const color =
    report.outcome === 'refused'
      ? chalk.red
      : report.outcome === 'added' || report.outcome === 'would-add'
        ? chalk.green
        : chalk.dim;
  console.log(
    `  ${CLAUDE_SETTINGS_PATH}: ${color(report.outcome)} (${report.detail})` +
      chalk.dim(`, ${report.profile} profile for ${report.owner}, from ${report.source}`)
  );
  const plan = report.plan;
  if (!plan) return;
  for (const rule of plan.addAllow) console.log(chalk.green(`    + allow ${rule}`));
  for (const rule of plan.addDeny) console.log(chalk.red(`    + deny  ${rule}`));
  for (const kept of plan.kept) {
    console.log(chalk.yellow(`    · not added (${kept.list}) ${kept.rule}: ${kept.reason}`));
  }
  if (report.outcome === 'would-add' && !apply) {
    console.log(
      chalk.dim('  Dry run: nothing written. Run again with --apply to add these rules.')
    );
  }
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
    .command('sync [path]')
    .description(
      "Add the rules a studio's permission profile has and its settings lack (Claude only; reports unless --apply)"
    )
    .option('--apply', 'Write the additions (default: report them and write nothing)')
    .option('--profile <name>', "builder or reviewer (default: the studio row's profile)")
    .option('--owner <sb>', "Whose scratch paths the profile names (default: the studio row's SB)")
    .option('--json', 'Print the report as JSON')
    .action(
      async (
        path: string | undefined,
        options: PermissionsSyncOptions & { json?: boolean }
      ): Promise<void> => {
        const report = await runPermissionsSync(path ?? process.cwd(), options);
        if (options.json) {
          console.log(JSON.stringify(report, null, 2));
        } else {
          printSyncReport(report, options.apply === true);
        }
        if (report.outcome === 'refused') process.exitCode = 1;
      }
    );

  perms
    .command('reset')
    .description('Remove all permission rules and modes, leaving an empty permissions object')
    .action(() => {
      const cwd = process.cwd();
      const existing = readClaudeSettings(cwd);
      if (!existing) return refuseMalformed();

      const current = existing.permissions;
      if (
        current &&
        typeof current === 'object' &&
        !Array.isArray(current) &&
        Object.keys(current).length === 0
      ) {
        console.log(chalk.dim('No permission rules to reset.'));
        return;
      }

      // Always a durable empty object, whatever was there: rules, a mode
      // alone (a bypassPermissions mode must not survive a reset), ask rules
      // alone, or no permissions key at all. A studio's next `ink init`
      // keeps an authored object and fills a missing one with its profile,
      // so a missing key would turn a deliberate reset into the builder
      // profile (review 4177f7fe, P2 2; Lumen d74ce85d, P2 4). Every other
      // setting is kept.
      const updated: ClaudeSettings = { ...existing, permissions: {} };
      writeClaudeSettings(cwd, updated);

      console.log(chalk.green('Permission rules removed. Claude will prompt for all actions.'));
    });
}
