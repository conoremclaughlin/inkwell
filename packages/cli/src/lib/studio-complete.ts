/**
 * Complete a studio worktree (task c3b34be8).
 *
 * The ONE routine that makes a worktree a usable studio, run by every
 * creator — `ink studio create`, the server's `create_studio`, the overflow
 * and strategy services after their `git worktree add` — and by `ink init`
 * in a linked worktree, which is how a partial studio is repaired. Before
 * this, each creator wrote a different subset: the server wrote `.mcp.json`
 * and Claude hooks but never an identity file or Codex/Gemini hooks; the
 * CLI wrote identity and hooks but never permissions or `.env.local`; a
 * bare `git worktree add` wrote nothing, and a session in it found it had
 * no tools while its hooks booked the work to the root studio.
 *
 * What a complete studio carries is the shared checklist
 * (`auditStudio`, @inklabs/shared). This routine writes each item that is
 * missing and leaves each item that is present alone: it never overwrites
 * a customised file, never clobbers a field an identity already has, and
 * never writes through a symlink (a checkout can ship one, Lumen PR #604).
 * A second run reports every step as `exists`.
 *
 * Two switches, both on by default (Conor, 2026-09-24: "included by
 * default and adjustable later"):
 *   - rootSync: copy `.mcp.json` and `.env.local` from the main worktree.
 *     Off, the routine generates the thin default `.mcp.json` instead.
 *   - studioSetup: write `.ink/identity.json` and register the studio row
 *     (or record a known id). Off for a checkout deliberately not tracked
 *     as a studio.
 * In the main worktree (mainRoot null) neither applies: hooks, backend
 * config and skills only, as `ink init` has always done there.
 *
 * Claude permissions are not synced (design v3, Conor 2026-10-02: "people
 * should be able to do their work by default"). The main worktree's
 * `settings.local.json` carries the operator's lane rules: absolute Edit
 * paths into the root checkout, and denies a studio does not want, such
 * as local commits. A new studio gets a profile instead: `builder`, or
 * `reviewer` for a checkout the server recorded as detached, chosen by the
 * caller from the studio's record and never from the checkout. Copying the
 * main worktree's rules is an explicit opt-in (`inheritPermissions: true`).
 * Any `permissions` object already in the file is kept exactly as it is,
 * empty and mode-only included; a file that cannot be parsed is reported
 * failed and left untouched, by this step and by the hook step after it.
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  auditStudio,
  copyBootstrapFiles,
  describePermissions,
  pinIsolatedPlaywright,
  studioPermissionRules,
  syncMcpConfig,
  type PlaywrightServerShape,
  type StudioAudit,
  type StudioPermissionProfile,
} from '@inklabs/shared';
import { installHooks, callInkTool } from '../commands/hooks.js';
import { syncSkills as syncSkillsFromServer } from '../commands/skills.js';
import { resolveChannelPluginPath } from './skill-mcp.js';
import { loadAuth, decodeJwtPayload, isTokenExpired } from '../auth/tokens.js';

export interface StepResult {
  label: string;
  status: 'created' | 'exists' | 'updated' | 'skipped' | 'failed';
  detail?: string;
}

export interface RegisterStudioArgs {
  sbSlug: string;
  repoRoot: string;
  slug: string;
  /** The worktree as it is; the server must record this, not invent a sibling path. */
  worktreePath: string;
  branch?: string;
  purpose?: string;
  roleTemplate?: string;
}

export interface CompleteStudioOptions {
  sbSlug: string;
  /** The main worktree when this is a linked worktree; null when it IS the main worktree. */
  mainRoot: string | null;
  /** Copy `.mcp.json` and `.env.local` from the main worktree (default true). */
  rootSync?: boolean;
  /**
   * Copy the main worktree's Claude permissions instead of writing a
   * profile. Opt-in: only `true` copies them.
   */
  inheritPermissions?: boolean;
  /**
   * The profile written into a settings file that has no permissions yet.
   * The caller takes it from the studio's server-side record
   * (`studioPermissionProfile`) or its own trusted input, never from the
   * checkout. Absent, and with no `lookupPermissions` to supply one, no
   * permissions are written: there is no default.
   */
  permissionProfile?: StudioPermissionProfile;
  /**
   * Whose scratch paths the profile names (default `sbSlug`, the caller's
   * own trusted input). Never read from identity.json.
   */
  permissionOwner?: string;
  /**
   * Looks the studio's row up when no profile was given (a manual
   * `ink init`); consulted only when permissions are about to be written.
   * Undefined, or a lookup that fails, is no profile.
   */
  lookupPermissions?: () => Promise<
    { profile?: StudioPermissionProfile; owner?: string } | undefined
  >;
  /**
   * Write Claude permissions at all (default true). Off when the caller
   * could not read the studio's record, so the profile, and the owner whose
   * scratch paths it names, are unknown: a guess would be kept by every
   * later run, since an existing permissions object is never replaced.
   */
  permissions?: boolean;
  /** Write identity and register the studio row (default true). */
  studioSetup?: boolean;
  /** The studio's name; defaults to the worktree folder's suffix after `--`. */
  studioName?: string;
  purpose?: string;
  branch?: string;
  backend?: string;
  role?: string;
  /** A studio row that already exists (server creators know it): recorded, not registered. */
  studioId?: string;
  /** Overwrite non-ink hooks. */
  force?: boolean;
  /**
   * Registers the studio row and returns its id, or null when it cannot
   * (server unreachable, not signed in). Injectable; the default calls
   * `create_studio` with skipGitOperations.
   */
  register?: (args: RegisterStudioArgs) => Promise<string | null>;
  /** Skills sync, best effort. Injectable; the default calls the server. */
  syncSkills?: (cwd: string) => Promise<StepResult>;
  /** The Inkwell server URL for a generated `.mcp.json`. */
  serverUrl?: string;
}

export interface CompleteStudioReport {
  worktreePath: string;
  linked: boolean;
  steps: StepResult[];
  audit: StudioAudit;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * A settings file as found: absent, malformed (it exists but is not a JSON
 * object), or read. `readJson` folds the first two together, and a writer
 * that treats a malformed file as an empty one replaces whatever the
 * person had in it.
 */
type SettingsFile =
  | { state: 'absent' }
  | { state: 'malformed' }
  | { state: 'read'; settings: Record<string, unknown> };

function readSettingsFile(path: string): SettingsFile {
  if (!existsSync(path)) return { state: 'absent' };
  const settings = readJson(path);
  return settings ? { state: 'read', settings } : { state: 'malformed' };
}

/**
 * Pin the Playwright server in a `.mcp.json` to the default launch
 * (@inklabs/shared `pinIsolatedPlaywright`), rewriting the file only when
 * a flag was added. Returns the servers pinned. A file that cannot be read
 * is left as it is.
 */
function pinPlaywrightInMcpJson(mcpPath: string): string[] {
  if (isSymlink(mcpPath)) return [];
  const config = readJson(mcpPath);
  if (!config || !isPlainObject(config.mcpServers)) return [];
  const { servers, pinned } = pinIsolatedPlaywright(
    config.mcpServers as Record<string, PlaywrightServerShape>
  );
  if (pinned.length > 0) {
    writeFileSync(mcpPath, JSON.stringify({ ...config, mcpServers: servers }, null, 2) + '\n');
  }
  return pinned;
}

export function defaultServerUrl(): string {
  return process.env.INK_SERVER_URL || 'http://localhost:3001';
}

/**
 * The thin default `.mcp.json`: the inkwell server and, when built, the
 * inkmail channel plugin. `pluginBase` is where the plugin is looked for —
 * the MAIN worktree for a studio, never the studio itself: a studio can be
 * a checkout of unreviewed code (a PR under review), and an entry pointing
 * at its copy of the plugin would run that code at the next session start
 * (Lumen, PR #604).
 */
export function buildDefaultMcpJson(
  serverUrl: string,
  pluginBase?: string
): Record<string, unknown> {
  const servers: Record<string, unknown> = {
    inkwell: { type: 'http', url: `${serverUrl}/mcp` },
  };
  const channelPath = pluginBase ? resolveChannelPluginPath(pluginBase) : null;
  if (channelPath) {
    servers['inkmail'] = { command: 'npx', args: ['tsx', channelPath] };
  }
  return { mcpServers: servers };
}

/**
 * Ensure `.mcp.json` names the inkwell server: create the default, add the
 * entry to an existing file that lacks it, or leave a configured one alone.
 */
export function ensureMcpJson(
  cwd: string,
  serverUrl: string,
  pluginBase: string = cwd
): StepResult {
  const mcpPath = join(cwd, '.mcp.json');
  if (isSymlink(mcpPath)) {
    return {
      label: '.mcp.json',
      status: 'failed',
      detail: 'is a symlink; refusing to write through it',
    };
  }
  if (existsSync(mcpPath)) {
    const existing = readJson(mcpPath);
    if (!existing) return { label: '.mcp.json', status: 'exists', detail: 'unparseable, skipping' };
    const servers = (existing.mcpServers as Record<string, unknown> | undefined) || {};
    if (servers.inkwell) {
      if (!servers.inkmail) {
        const channelPath = resolveChannelPluginPath(pluginBase);
        if (channelPath) {
          const updated = {
            ...existing,
            mcpServers: { ...servers, inkmail: { command: 'npx', args: ['tsx', channelPath] } },
          };
          writeFileSync(mcpPath, JSON.stringify(updated, null, 2) + '\n');
          return { label: '.mcp.json', status: 'updated', detail: 'added inkmail channel plugin' };
        }
      }
      return { label: '.mcp.json', status: 'exists', detail: 'inkwell server configured' };
    }
    const updated = {
      ...existing,
      mcpServers: { ...servers, inkwell: { type: 'http', url: `${serverUrl}/mcp` } },
    };
    writeFileSync(mcpPath, JSON.stringify(updated, null, 2) + '\n');
    return { label: '.mcp.json', status: 'updated', detail: 'added inkwell server' };
  }
  writeFileSync(
    mcpPath,
    JSON.stringify(buildDefaultMcpJson(serverUrl, pluginBase), null, 2) + '\n'
  );
  return { label: '.mcp.json', status: 'created', detail: `inkwell → ${serverUrl}/mcp` };
}

/** The SB id the signed-in token carries, when it is bound to one. */
function tokenSbId(): string | undefined {
  const auth = loadAuth();
  if (!auth || isTokenExpired(auth)) return undefined;
  const payload = decodeJwtPayload(auth.access_token) as { identityId?: unknown } | null;
  return typeof payload?.identityId === 'string' ? payload.identityId : undefined;
}

function currentUser(): string | undefined {
  try {
    const config = readJson(join(process.env.HOME || '', '.ink', 'config.json'));
    const value = config?.email ?? config?.userId;
    return typeof value === 'string' ? value : undefined;
  } catch {
    return undefined;
  }
}

const HOOK_TARGETS = {
  'claude-code': ['.claude', join('.claude', 'settings.local.json')],
  codex: ['.codex', join('.codex', 'config.toml')],
  gemini: ['.gemini', join('.gemini', 'settings.json')],
} as const;

function hookStep(
  cwd: string,
  backend: 'claude-code' | 'codex' | 'gemini',
  force: boolean | undefined
): StepResult {
  // The installers write the file the backend reads; a link there would
  // carry the write outside the studio.
  if (HOOK_TARGETS[backend].some((rel) => isSymlink(join(cwd, rel)))) {
    return {
      label: `hooks (${backend})`,
      status: 'failed',
      detail: 'is a symlink; refusing to write through it',
    };
  }
  const { result, backend: resolved } = installHooks(cwd, { backend, force });
  const label = `hooks (${resolved.name})`;
  switch (result) {
    case 'installed':
      return { label, status: 'created', detail: resolved.configPath };
    case 'updated':
      return { label, status: 'updated', detail: resolved.configPath };
    case 'already-installed':
      return { label, status: 'exists', detail: resolved.configPath };
    case 'conflict':
      return {
        label,
        status: 'skipped',
        detail: 'existing non-Inkwell hooks (use ink hooks install --force)',
      };
  }
}

/**
 * The default registration: the same call the on-session-start hook makes
 * for a studio that has a name but no row — create_studio with the git
 * work already done. Null when the server cannot be reached or refuses.
 */
export async function registerStudioRow(args: RegisterStudioArgs): Promise<string | null> {
  try {
    const created = await callInkTool('create_studio', {
      email: currentUser(),
      sbSlug: args.sbSlug,
      repoRoot: args.repoRoot,
      slug: args.slug,
      skipGitOperations: true,
      worktreePath: args.worktreePath,
      ...(args.branch ? { branch: args.branch } : {}),
      ...(args.purpose ? { purpose: args.purpose } : {}),
      ...(args.roleTemplate ? { roleTemplate: args.roleTemplate } : {}),
    });
    const studio = (created.studio || created.workspace) as Record<string, unknown> | undefined;
    return studio && typeof studio.id === 'string' ? studio.id : null;
  } catch {
    return null;
  }
}

/** The default skills step: the server's MCP skills, best effort. */
async function skillsStep(cwd: string): Promise<StepResult> {
  try {
    const result = await syncSkillsFromServer(cwd);
    if (result.serverUnreachable) {
      return { label: 'skills sync', status: 'skipped', detail: 'server not reachable' };
    }
    if (result.written > 0 || result.linked > 0) {
      return {
        label: 'skills sync',
        status: 'created',
        detail: `${result.written} written, ${result.linked} symlinked`,
      };
    }
    if (result.skipped > 0)
      return { label: 'skills sync', status: 'exists', detail: 'all up to date' };
    return { label: 'skills sync', status: 'skipped', detail: 'no MCP skills on server' };
  } catch {
    return { label: 'skills sync', status: 'skipped', detail: 'error during sync' };
  }
}

export async function completeStudio(
  worktreePath: string,
  options: CompleteStudioOptions
): Promise<CompleteStudioReport> {
  const linked = options.mainRoot !== null;
  const register = options.register ?? registerStudioRow;
  const skills = options.syncSkills ?? skillsStep;
  const rootSync = linked && options.rootSync !== false;
  const studioSetup = linked && options.studioSetup !== false;
  const serverUrl = options.serverUrl || defaultServerUrl();
  const studioName = options.studioName || worktreePath.split('--').slice(1).join('--') || 'studio';
  const steps: StepResult[] = [];

  // .ink/ — the studio's own directory.
  const inkDir = join(worktreePath, '.ink');
  if (existsSync(inkDir)) {
    steps.push({ label: '.ink/', status: 'exists' });
  } else {
    mkdirSync(inkDir, { recursive: true });
    steps.push({ label: '.ink/', status: 'created' });
  }

  // Local config: the main worktree's, or the generated default.
  if (rootSync && options.mainRoot) {
    const copied = copyBootstrapFiles(options.mainRoot, worktreePath);
    if (copied.length > 0) {
      // The copy made this run is ours to adjust: its Playwright server
      // launches like every session's (headless, isolated). An existing
      // studio file is not touched.
      const pinned = copied.includes('.mcp.json')
        ? pinPlaywrightInMcpJson(join(worktreePath, '.mcp.json'))
        : [];
      steps.push({
        label: 'root sync',
        status: 'created',
        detail: [
          `copied ${copied.join(', ')}`,
          ...(pinned.length > 0 ? [`${pinned.join(', ')} launched headless and isolated`] : []),
        ].join('; '),
      });
    } else {
      steps.push({ label: 'root sync', status: 'exists', detail: 'nothing to copy' });
    }
  } else if (linked) {
    steps.push({ label: 'root sync', status: 'skipped', detail: '--no-root-sync' });
  }
  // With or without root sync the studio needs an inkwell entry; a main
  // worktree without `.mcp.json` gets the default here too.
  // The channel plugin entry, when generated, points at the main worktree's
  // copy, never at this worktree's (it may be unreviewed code).
  steps.push(ensureMcpJson(worktreePath, serverUrl, options.mainRoot ?? worktreePath));

  // Identity: who works here. Written once; existing fields are kept.
  const identityPath = join(inkDir, 'identity.json');
  let identity = readJson(identityPath);
  // A pre-rename file names its owner as agentId. That owner is kept: the
  // caller's slug fills a MISSING owner, never replaces one (Lumen, PR #692).
  if (identity && identity.sbSlug === undefined && typeof identity.agentId === 'string') {
    identity.sbSlug = identity.agentId;
  }
  if (!studioSetup) {
    steps.push({
      label: 'identity',
      status: 'skipped',
      detail: linked ? '--no-studio-setup' : 'main worktree',
    });
  } else if (isSymlink(identityPath) || isSymlink(inkDir)) {
    steps.push({
      label: 'identity',
      status: 'failed',
      detail: 'is a symlink; refusing to write through it',
    });
    identity = null;
  } else {
    const sbId = tokenSbId();
    const filled: Record<string, unknown> = {
      sbSlug: options.sbSlug,
      ...(sbId ? { sbId } : {}),
      context: `studio-${studioName}`,
      ...(options.backend ? { backend: options.backend } : {}),
      ...(options.role ? { role: options.role } : {}),
      studio: studioName,
      description: options.purpose || `Studio: ${studioName}`,
      ...(options.branch ? { branch: options.branch } : {}),
      createdAt: new Date().toISOString(),
      createdBy: currentUser(),
    };
    if (!identity) {
      identity = filled;
      writeFileSync(identityPath, JSON.stringify(identity, null, 2) + '\n');
      steps.push({ label: 'identity', status: 'created', detail: `sbSlug ${options.sbSlug}` });
    } else {
      let changed = false;
      for (const [key, value] of Object.entries(filled)) {
        if (
          key === 'createdAt' ||
          key === 'createdBy' ||
          key === 'context' ||
          key === 'description'
        )
          continue;
        if (identity[key] === undefined && value !== undefined) {
          identity[key] = value;
          changed = true;
        }
      }
      if (changed) {
        writeFileSync(identityPath, JSON.stringify(identity, null, 2) + '\n');
        steps.push({ label: 'identity', status: 'updated', detail: 'filled missing fields' });
      } else {
        steps.push({ label: 'identity', status: 'exists' });
      }
    }
  }

  // Registration: the studio row the hooks book sessions to.
  if (!studioSetup || !identity) {
    steps.push({
      label: 'registration',
      status: 'skipped',
      detail: !studioSetup ? (linked ? '--no-studio-setup' : 'main worktree') : 'no identity',
    });
  } else if (typeof identity.studioId === 'string' && UUID.test(identity.studioId)) {
    steps.push({
      label: 'registration',
      status: 'exists',
      detail: `studioId ${identity.studioId}`,
    });
  } else {
    let studioId: string | null =
      options.studioId && UUID.test(options.studioId) ? options.studioId : null;
    let via = 'recorded';
    if (!studioId && options.mainRoot) {
      via = 'registered';
      try {
        studioId = await register({
          sbSlug: typeof identity.sbSlug === 'string' ? identity.sbSlug : options.sbSlug,
          repoRoot: options.mainRoot,
          slug: typeof identity.studio === 'string' ? identity.studio : studioName,
          worktreePath,
          ...(options.branch ? { branch: options.branch } : {}),
          ...(options.purpose ? { purpose: options.purpose } : {}),
          ...(options.role ? { roleTemplate: options.role } : {}),
        });
      } catch {
        studioId = null;
      }
    }
    if (studioId) {
      identity.studioId = studioId;
      writeFileSync(identityPath, JSON.stringify(identity, null, 2) + '\n');
      steps.push({
        label: 'registration',
        status: via === 'recorded' ? 'updated' : 'created',
        detail: `studioId ${studioId} (${via})`,
      });
    } else {
      steps.push({
        label: 'registration',
        status: 'skipped',
        detail:
          'server not reachable or not signed in; sessions here are booked to the root studio until it is',
      });
    }
  }

  // Claude permissions (linked worktrees): an authored policy is kept, and
  // only a file with no `permissions` key at all gets the profile.
  const claudeDir = join(worktreePath, '.claude');
  const settingsPath = join(claudeDir, 'settings.local.json');
  const settingsFile = readSettingsFile(settingsPath);
  if (!linked) {
    steps.push({ label: 'permissions', status: 'skipped', detail: 'main worktree' });
  } else if (isSymlink(claudeDir) || isSymlink(settingsPath)) {
    steps.push({
      label: 'permissions',
      status: 'failed',
      detail: 'is a symlink; refusing to write through it',
    });
  } else if (settingsFile.state === 'malformed') {
    // Fail closed: a file that cannot be read may hold someone's rules, and
    // writing a profile over it would replace them.
    steps.push({
      label: 'permissions',
      status: 'failed',
      detail: 'settings.local.json is not a JSON object; left as it is (fix or remove it)',
    });
  } else if (settingsFile.state === 'read' && settingsFile.settings.permissions !== undefined) {
    const authored = settingsFile.settings.permissions;
    steps.push(
      isPlainObject(authored)
        ? {
            label: 'permissions',
            status: 'exists',
            detail: `${describePermissions(authored)}, kept as authored`,
          }
        : {
            label: 'permissions',
            status: 'failed',
            detail: 'permissions is not an object; left as it is (fix or remove it)',
          }
    );
  } else if (options.permissions === false) {
    steps.push({
      label: 'permissions',
      status: 'skipped',
      detail: "the studio's record could not be read, so its profile is unknown",
    });
  } else {
    const settings = settingsFile.state === 'read' ? settingsFile.settings : {};
    const inherited =
      options.inheritPermissions === true && options.mainRoot
        ? readJson(join(options.mainRoot, '.claude', 'settings.local.json'))?.permissions
        : undefined;
    // The profile and its owner come from the caller or the studio's row,
    // never from the checkout: identity.json is not quarantined in a review
    // checkout, so a PR could name any owner there (review 4177f7fe, P3).
    let profile = options.permissionProfile;
    let owner = options.permissionOwner ?? options.sbSlug;
    if (!isPlainObject(inherited) && !profile && options.lookupPermissions) {
      const found = await options.lookupPermissions().catch(() => undefined);
      profile = found?.profile;
      if (found?.owner) owner = found.owner;
    }
    let rules: ReturnType<typeof studioPermissionRules> | undefined;
    let refused: string | undefined;
    if (!isPlainObject(inherited) && profile) {
      try {
        rules = studioPermissionRules(profile, owner);
      } catch (error) {
        refused = error instanceof Error ? error.message : String(error);
      }
    }
    if (!isPlainObject(inherited) && !profile) {
      // No profile is no permissions: a default written here would be kept
      // by every later run (review 4177f7fe, P2 1).
      steps.push({
        label: 'permissions',
        status: 'skipped',
        detail:
          'no permission profile: the studio has no row to read one from (pass --permission-profile, or let the server complete it)',
      });
    } else if (refused) {
      steps.push({ label: 'permissions', status: 'failed', detail: refused });
    } else {
      const next = {
        ...settings,
        permissions: isPlainObject(inherited) ? inherited : rules,
        enableAllProjectMcpServers: settings.enableAllProjectMcpServers ?? true,
      };
      mkdirSync(claudeDir, { recursive: true });
      writeFileSync(settingsPath, JSON.stringify(next, null, 2) + '\n');
      steps.push({
        label: 'permissions',
        status: 'created',
        detail: isPlainObject(inherited)
          ? 'copied from the main worktree'
          : options.inheritPermissions === true
            ? `${profile} profile (the main worktree had no permissions to copy)`
            : `${profile} profile`,
      });
    }
  }

  // Hooks and backend config: every backend, every studio. The Claude
  // hooks share the settings file, and the installer replaces a file it
  // cannot parse, so a malformed one is refused here as well.
  if (readSettingsFile(settingsPath).state === 'malformed') {
    steps.push({
      label: 'hooks (claude-code)',
      status: 'failed',
      detail: 'settings.local.json is not a JSON object; left as it is (fix or remove it)',
    });
  } else {
    steps.push(hookStep(worktreePath, 'claude-code', options.force));
  }
  if (existsSync(join(worktreePath, '.mcp.json'))) {
    try {
      // syncMcpConfig always regenerates; the step reports what changed.
      const targets = [
        join(worktreePath, '.codex', 'config.toml'),
        join(worktreePath, '.gemini', 'settings.json'),
      ];
      const read = (p: string) => (existsSync(p) ? readFileSync(p, 'utf-8') : null);
      const before = targets.map(read);
      const synced = syncMcpConfig(worktreePath);
      const after = targets.map(read);
      const written = [synced.codex ? '.codex/' : null, synced.gemini ? '.gemini/' : null].filter(
        Boolean
      );
      const changedIndexes = targets.map((_, i) => i).filter((i) => before[i] !== after[i]);
      const allNew = changedIndexes.every((i) => before[i] === null);
      // A part the sync could not repair is a failed step, whatever it wrote:
      // the report must not claim a repair that did not happen (Myra, #701).
      const handEdit = synced.codexHandEdit ?? [];
      const keptOutside = synced.codexKeptOutside?.length
        ? [
            `kept outside ink's Codex block, as defined there: ${synced.codexKeptOutside.join(', ')}`,
          ]
        : [];
      const status: StepResult['status'] = handEdit.length
        ? 'failed'
        : !written.length
          ? 'skipped'
          : !changedIndexes.length
            ? 'exists'
            : allNew
              ? 'created'
              : 'updated';
      steps.push({
        label: 'backend configs',
        status,
        detail: [
          written.length ? written.join(', ') : 'no servers to sync',
          ...keptOutside,
          ...handEdit,
        ].join('; '),
      });
    } catch (error) {
      steps.push({
        label: 'backend configs',
        status: 'failed',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  } else {
    steps.push({ label: 'backend configs', status: 'skipped', detail: 'no .mcp.json' });
  }
  steps.push(hookStep(worktreePath, 'codex', options.force));
  steps.push(hookStep(worktreePath, 'gemini', options.force));

  // Skills: best effort, needs the server. Not when .mcp.json was refused
  // above (a link): the skills step writes that file too.
  if (steps.some((s) => s.label === '.mcp.json' && s.status === 'failed')) {
    steps.push({ label: 'skills sync', status: 'skipped', detail: '.mcp.json was refused' });
  } else {
    try {
      steps.push(await skills(worktreePath));
    } catch {
      steps.push({ label: 'skills sync', status: 'skipped', detail: 'error during sync' });
    }
  }

  return { worktreePath, linked, steps, audit: auditStudio(worktreePath, { linked }) };
}
