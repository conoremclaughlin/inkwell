/** Advisory only: never writes policy or decides whether a tool may run. */
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { LaunchSettings } from './launch-settings.js';
import { analyzeClaudePermissionCoverage } from './claude-permission-audit.js';
import { logger } from '../../utils/logger.js';

// Common to both studio profiles. Do not demand a reviewer's edit grants or
// the broad GitHub/Supabase defaults: their absence is intentional policy.
export const SPAWN_STANDARD_ALLOW_RULES = [
  'Bash(*)',
  'WebFetch(*)',
  'WebSearch',
  'mcp__inkwell__*',
  'mcp__playwright__*',
] as const;

export interface PermissionRules {
  allow: string[];
  ask: string[];
  deny: string[];
}

export interface PermissionSource {
  path: string;
  state: 'read' | 'absent' | 'unverified';
}

export interface SpawnPermissionWarning {
  workingDirectory: string;
  missingRules: string[];
  restrictedRules: string[];
  sources: PermissionSource[];
  limitations: string[];
  fix: string;
}

const MAX_BYTES = 256 * 1024;
const MAX_RULES = 2048;
const MAX_RULE_LENGTH = 512;
const emptyRules = (): PermissionRules => ({ allow: [], ask: [], deny: [] });

/** No raw file contents or parse errors can enter the warning. Nonblocking
 * open + fstat refuses FIFOs/devices; the read is bounded even if a file grows. */
export async function readPermissionSource(file: string): Promise<{
  source: PermissionSource;
  rules: PermissionRules;
}> {
  const result = (state: PermissionSource['state'], rules = emptyRules()) => ({
    source: { path: file, state },
    rules,
  });
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_BYTES) return result('unverified');
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > MAX_BYTES) return result('unverified');
    const parsed: unknown = JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return result('unverified');
    // This managed-only switch changes which sources count. Do not simulate
    // it as an ordinary merged grant list (or claim verified coverage).
    if ((parsed as Record<string, unknown>).allowManagedPermissionRulesOnly === true) {
      return result('unverified');
    }
    const permissions = (parsed as Record<string, unknown>).permissions;
    if (permissions === undefined) return result('read');
    if (!permissions || typeof permissions !== 'object' || Array.isArray(permissions)) {
      return result('unverified');
    }
    if ((permissions as Record<string, unknown>).allowManagedPermissionRulesOnly === true) {
      return result('unverified');
    }
    const rules = emptyRules();
    for (const key of ['allow', 'ask', 'deny'] as const) {
      const value = (permissions as Record<string, unknown>)[key];
      if (value === undefined) continue;
      if (
        !Array.isArray(value) ||
        value.length > MAX_RULES ||
        value.some((r) => typeof r !== 'string' || r.length > MAX_RULE_LENGTH)
      )
        return result('unverified');
      rules[key] = value;
    }
    return result('read', rules);
  } catch (error) {
    return result((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'unverified');
  } finally {
    await handle?.close();
  }
}

export interface PermissionInspection {
  workingDirectory: string;
  mainRoot?: string;
  launchSettings?: LaunchSettings | null;
  container?: boolean;
  /** Explicit in tests; production follows the same HOME as the runner. */
  home?: string;
  configDir?: string;
  managedSettingsPath?: string;
}

/** Inspect only sources known to the launcher, not global credentials or CLI
 * history. A container's host files say nothing about its effective settings. */
export async function collectSpawnPermissions(input: PermissionInspection): Promise<{
  rules: PermissionRules;
  sources: PermissionSource[];
  limitations: string[];
}> {
  const rules = emptyRules();
  if (input.container)
    return {
      rules,
      sources: [],
      limitations: ['Container settings were not inspected; host policy is not container policy.'],
    };
  const home = input.home ?? homedir();
  const files = new Set([
    join(input.configDir ?? join(home, '.claude'), 'settings.json'),
    join(input.workingDirectory, '.claude', 'settings.json'),
    join(input.mainRoot ?? input.workingDirectory, '.claude', 'settings.local.json'),
    join(input.workingDirectory, '.claude', 'settings.local.json'),
    input.managedSettingsPath ??
      (process.platform === 'darwin'
        ? '/Library/Application Support/ClaudeCode/managed-settings.json'
        : '/etc/claude-code/managed-settings.json'),
  ]);
  const sources: PermissionSource[] = [];
  for (const file of files) {
    const read = await readPermissionSource(file);
    sources.push(read.source);
    for (const key of ['allow', 'ask', 'deny'] as const) rules[key].push(...read.rules[key]);
  }
  const delivered = input.launchSettings?.settings.permissions;
  if (delivered) {
    rules.allow.push(...delivered.allow);
    rules.deny.push(...delivered.deny);
    rules.ask.push(...((delivered as { ask?: string[] }).ask ?? []));
    sources.push({ path: input.launchSettings!.hostPath, state: 'read' });
  }
  return {
    rules,
    sources,
    limitations: [
      'Static inspection only; managed fragments, remote/MDM policy, trust and runtime permission decisions are not verified.',
    ],
  };
}

export async function inspectSpawnPermissions(
  input: PermissionInspection
): Promise<SpawnPermissionWarning | undefined> {
  const { rules, sources, limitations } = await collectSpawnPermissions(input);
  const coverage = analyzeClaudePermissionCoverage(SPAWN_STANDARD_ALLOW_RULES, rules);
  // Surface only names from our standard list, never arbitrary command text
  // from a settings file (which can contain secrets or private arguments).
  const restrictedRules = [
    ...new Set([
      ...coverage.shadowingAsk.map((x) => `ask: ${x.expectedRule} (${x.overlap})`),
      ...coverage.shadowingDeny.map((x) => `deny: ${x.expectedRule} (${x.overlap})`),
    ]),
  ];
  if (
    !input.container &&
    coverage.missingAllow.length === 0 &&
    restrictedRules.length === 0 &&
    !sources.some((s) => s.state === 'unverified')
  )
    return undefined;
  return {
    workingDirectory: input.workingDirectory,
    missingRules: input.container ? [] : coverage.missingAllow,
    restrictedRules,
    sources,
    limitations,
    fix: input.container
      ? "Inspect the container's /permissions settings before changing policy; host files cannot repair it."
      : 'Operator: review .claude/settings.local.json in this checkout; add only approved missing rules to permissions.allow, preserving all ask/deny rules. Review restrictions separately; do not remove them automatically.',
  };
}

export type SpawnPermissionWarningHandler = (
  warning: SpawnPermissionWarning,
  signal: AbortSignal
) => Promise<void>;

/** A broken warning pipeline must not hang a turn or bypass final admission.
 * A send already in flight may settle later; timeout is never called delivery. */
export async function warnBeforeClaudeSpawn(
  input: PermissionInspection,
  notify: SpawnPermissionWarningHandler,
  budgetMs = 2000
): Promise<void> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      (async () => {
        const warning = await inspectSpawnPermissions(input);
        if (controller.signal.aborted || !warning) return;
        await notify(warning, controller.signal);
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error('deadline'));
        }, budgetMs);
      }),
    ]);
  } catch {
    logger.warn('Spawn permission warning could not be confirmed (non-fatal)', {
      workingDirectory: input.workingDirectory,
    });
  } finally {
    if (timer) clearTimeout(timer);
    controller.abort();
  }
}
