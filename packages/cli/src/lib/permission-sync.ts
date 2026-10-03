/**
 * `ink permissions sync` (task cd2fe361): bring an existing studio's Claude
 * settings up to its permission profile, additively.
 *
 * Why it exists. A studio's settings file is generated once, and every
 * permissions object found there afterwards is treated as authored and kept
 * as written (#730: `ink init` never replaces one, and a builder's launch
 * delivers the profile only when the file holds exactly it). So a studio
 * created before a rule joined its profile never gains that rule. Most
 * studios made before the profiles existed carry a copy of the main
 * worktree's lane rules instead: allows named one by one, no denies, and
 * none of the Playwright or simulator tools.
 *
 * What it does. It adds each rule the profile has and the file lacks,
 * appended after the file's own rules in profile order. It never removes
 * or reorders a rule and keeps every other setting. Two exceptions keep an
 * author's explicit choice:
 *   - a profile deny is not added when it would refuse something the file
 *     allows by name (`Bash(yarn install*)` against an authored
 *     `Bash(yarn install)`, `mcp__github__create_pull_request` against the
 *     same rule allowed). A broad allow such as `Bash(*)` or
 *     `mcp__github__*` names nothing in particular, so the profile's
 *     backstops are added beside it.
 *   - a profile allow is not added when the file denies or asks about
 *     exactly that rule.
 * Both are reported. The match is a glob over the rule's own text, with
 * Bash rules read in each spelling Claude Code accepts (the legacy `X:*`
 * is `X *`, and a sole trailing ` *` also matches the bare command). It is
 * not Claude Code's decision engine: a conservative reading of what the
 * author named, not a proof of what a call would do.
 *
 * What it leaves. A file holding exactly the profile (generated); a
 * permissions object with no rules at all, which is what `ink permissions
 * reset` writes on purpose; a file with no permissions object, or none at
 * all, which `ink init` fills; and a file it cannot read, or one reached
 * through a symlink, which it refuses. A dry run writes nothing.
 */

import { existsSync, lstatSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  studioPermissionRules,
  type ClaudePermissionRules,
  type StudioPermissionProfile,
} from '@inklabs/shared';

export interface KeptRule {
  rule: string;
  /** The profile list the rule was not added to. */
  list: 'allow' | 'deny';
  reason: string;
}

export interface ProfileSyncPlan {
  /** `generated`: exactly the profile. `no-rules`: no allow, deny or ask rule at all. */
  state: 'generated' | 'authored' | 'no-rules';
  addAllow: string[];
  addDeny: string[];
  kept: KeptRule[];
  /** The permissions object with the additions, keys in their original order. */
  permissions: Record<string, unknown>;
}

export class PermissionSyncError extends Error {
  override name = 'PermissionSyncError';
}

const RULE_LISTS = ['allow', 'deny', 'ask'] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** A rule list as written, or a refusal when it is not a list of strings. */
function ruleList(permissions: Record<string, unknown>, key: string): string[] {
  const value = permissions[key];
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((rule) => typeof rule !== 'string')) {
    throw new PermissionSyncError(`permissions.${key} is not a list of rules`);
  }
  return value as string[];
}

/** `Tool(pattern)` or a bare tool name (`WebSearch`, `mcp__github__get_me`). */
function parseRule(rule: string): { tool: string; pattern?: string } {
  const match = rule.match(/^([A-Za-z0-9_]+)\((.*)\)$/s);
  return match ? { tool: match[1], pattern: match[2] } : { tool: rule };
}

function globMatches(glob: string, text: string): boolean {
  const escaped = glob.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`^${escaped.join('.*')}$`, 's').test(text);
}

/**
 * A Bash pattern in its current spelling: the legacy `X:*` suffix is the
 * same rule as `X *`.
 */
function normalizeBashPattern(pattern: string): string {
  return pattern.endsWith(':*') ? `${pattern.slice(0, -2)} *` : pattern;
}

/** Whether a Bash pattern's only wildcard is a trailing ` *`: a prefix grant or deny. */
function isBashPrefixPattern(pattern: string): boolean {
  return pattern.endsWith(' *') && pattern.indexOf('*') === pattern.length - 1;
}

/**
 * Whether a Bash pattern matches a command: `*` spans anything, and a sole
 * trailing ` *` also matches the bare command (`git push *` matches
 * `git push`).
 */
function bashPatternMatches(pattern: string, command: string): boolean {
  const p = normalizeBashPattern(pattern);
  if (globMatches(p, command)) return true;
  return isBashPrefixPattern(p) && p.slice(0, -2) === command;
}

/**
 * The commands a Bash allow names: its text as written, and for a prefix
 * grant (`git push *`, `git push:*`) the bare command as well.
 */
function bashNamedCommands(pattern: string): string[] {
  const p = normalizeBashPattern(pattern);
  return isBashPrefixPattern(p) ? [p, p.slice(0, -2)] : [p];
}

/**
 * Whether a deny rule refuses what an allow rule names: the same tool, and
 * the deny's pattern matches the allow's text (for Bash, the allow's text
 * or the bare command a prefix allow names, in either spelling). A deny
 * never matches a broader allow (`Bash(rm -rf *)` does not match
 * `Bash(*)`, `Bash(git push *)` does not match `Bash(git *)`), which is
 * what lets a backstop sit beside a broad grant.
 */
export function denyRefusesNamedAllow(deny: string, allow: string): boolean {
  const d = parseRule(deny);
  const a = parseRule(allow);
  if (d.pattern === undefined && a.pattern === undefined) return globMatches(d.tool, a.tool);
  if (d.pattern === undefined || a.pattern === undefined || d.tool !== a.tool) return false;
  if (d.tool === 'Bash') {
    const denyPattern = d.pattern;
    return bashNamedCommands(a.pattern).some((command) => bashPatternMatches(denyPattern, command));
  }
  return globMatches(d.pattern, a.pattern);
}

/**
 * What syncing a permissions object to a profile adds, and what it keeps
 * out. Pure; throws PermissionSyncError on a rule list it cannot read.
 */
export function planProfileSync(
  permissions: Record<string, unknown>,
  rules: ClaudePermissionRules
): ProfileSyncPlan {
  const allow = ruleList(permissions, 'allow');
  const deny = ruleList(permissions, 'deny');
  const ask = ruleList(permissions, 'ask');
  const none = { addAllow: [], addDeny: [], kept: [], permissions };
  if (JSON.stringify(permissions) === JSON.stringify(rules)) {
    return { state: 'generated', ...none };
  }
  if (allow.length + deny.length + ask.length === 0) {
    return { state: 'no-rules', ...none };
  }

  const kept: KeptRule[] = [];
  const addAllow: string[] = [];
  for (const rule of rules.allow) {
    if (allow.includes(rule)) continue;
    if (deny.includes(rule) || ask.includes(rule)) {
      kept.push({
        rule,
        list: 'allow',
        reason: `this file ${deny.includes(rule) ? 'denies' : 'asks about'} ${rule} by name`,
      });
      continue;
    }
    addAllow.push(rule);
  }
  const addDeny: string[] = [];
  for (const rule of rules.deny) {
    if (deny.includes(rule)) continue;
    const named = allow.find((authored) => denyRefusesNamedAllow(rule, authored));
    if (named !== undefined) {
      kept.push({ rule, list: 'deny', reason: `this file allows ${named} by name` });
      continue;
    }
    addDeny.push(rule);
  }

  const next: Record<string, unknown> = { ...permissions };
  if (addAllow.length > 0) next.allow = [...allow, ...addAllow];
  if (addDeny.length > 0) next.deny = [...deny, ...addDeny];
  return { state: 'authored', addAllow, addDeny, kept, permissions: next };
}

export interface StudioPermissionSync {
  settingsPath: string;
  profile: StudioPermissionProfile;
  owner: string;
  /**
   * `would-add`: a dry run found rules to add. `nothing-to-add`: the file
   * already has every rule it can take. `skipped`: a file this command does
   * not fill. `refused`: a file it cannot read or must not write through.
   */
  outcome: 'added' | 'would-add' | 'nothing-to-add' | 'skipped' | 'refused';
  detail: string;
  plan?: ProfileSyncPlan;
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function describeRules(permissions: Record<string, unknown>): string {
  const parts = RULE_LISTS.map((key) =>
    Array.isArray(permissions[key]) ? `${(permissions[key] as unknown[]).length} ${key}` : null
  ).filter(Boolean);
  return parts.join(', ');
}

/**
 * Sync a worktree's `.claude/settings.local.json` to a profile. The
 * profile and its owner are the caller's to establish (the studio row, or
 * flags a person passed); nothing here reads them from the checkout.
 */
export function syncStudioPermissions(
  worktreePath: string,
  options: { profile: StudioPermissionProfile; owner: string; apply: boolean }
): StudioPermissionSync {
  const claudeDir = join(worktreePath, '.claude');
  const settingsPath = join(claudeDir, 'settings.local.json');
  const base = { settingsPath, profile: options.profile, owner: options.owner };
  const result = (
    outcome: StudioPermissionSync['outcome'],
    detail: string,
    plan?: ProfileSyncPlan
  ) => ({
    ...base,
    outcome,
    detail,
    ...(plan ? { plan } : {}),
  });

  let rules: ClaudePermissionRules;
  try {
    rules = studioPermissionRules(options.profile, options.owner);
  } catch (error) {
    return result('refused', (error as Error).message);
  }
  if (isSymlink(claudeDir) || isSymlink(settingsPath)) {
    return result('refused', 'is a symlink; refusing to write through it');
  }
  if (!existsSync(settingsPath)) {
    return result('skipped', 'no settings file; `ink init` writes the profile into one');
  }
  let settings: unknown;
  try {
    settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
  } catch {
    return result('refused', 'not JSON; left as it is (fix or remove it)');
  }
  if (!isPlainObject(settings)) {
    return result('refused', 'not a JSON object; left as it is (fix or remove it)');
  }
  if (settings.permissions === undefined) {
    return result('skipped', 'no permissions object; `ink init` writes the profile into it');
  }
  if (!isPlainObject(settings.permissions)) {
    return result('refused', 'permissions is not an object; left as it is (fix or remove it)');
  }

  let plan: ProfileSyncPlan;
  try {
    plan = planProfileSync(settings.permissions, rules);
  } catch (error) {
    return result('refused', `${(error as Error).message}; left as it is (fix or remove it)`);
  }
  if (plan.state === 'generated') {
    return result('nothing-to-add', `already the ${options.profile} profile as generated`, plan);
  }
  if (plan.state === 'no-rules') {
    return result(
      'skipped',
      'a permissions object with no rules, which `ink permissions reset` writes on purpose; kept as it is',
      plan
    );
  }
  const authored = `authored policy (${describeRules(settings.permissions)})`;
  const count = plan.addAllow.length + plan.addDeny.length;
  if (count === 0) {
    return result('nothing-to-add', `${authored}: has every rule it can take`, plan);
  }
  if (!options.apply) {
    return result('would-add', `${authored}: ${count} rules to add`, plan);
  }
  const next = { ...settings, permissions: plan.permissions };
  writeFileSync(settingsPath, JSON.stringify(next, null, 2) + '\n');
  return result('added', `${authored}: added ${count} rules`, plan);
}
