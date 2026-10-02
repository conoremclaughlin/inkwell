/**
 * Per-launch Claude Code settings (design v5, phase A).
 *
 * A studio's permission profile reaches a spawned session at launch, in a
 * file of its own passed with `claude --settings`: one file per launch, so
 * two concurrent launches never share or restore each other's state, and
 * no shared file is patched and restored.
 *
 * DELIVERY, NOT ISOLATION. Claude Code reads a `--settings` file alongside
 * the stored sources, not instead of them. Measured model-free on 2.1.287
 * with `claude doctor`: in a worktree it reads the main checkout's
 * `.claude/settings.local.json`, the worktree's own local and project
 * files, user settings, and the `--settings` file. How their rules combine
 * for a given call (deny from any source wins over allow from any other) is
 * DOCUMENTED, NOT MEASURED (Claude Code docs: settings, "Settings
 * precedence"; permissions, "Manage permissions"). Nothing here removes a
 * stored source's rule; a user-level broad allow still applies. Measuring
 * the decision layer needs one deliberate probe session with a model call,
 * approved on its own, before phase B moves any lane rule.
 *
 * PATHS ARE ABSOLUTE. A `/path` rule in a `--settings` file anchors at that
 * file's own directory (docs, permissions, "/path"), which for a runner
 * temp file would grant the wrong tree. Every path rule is rendered against
 * the checkout's path in the filesystem the session executes in (`/studio`
 * inside a container) as `//abs/**`, or kept when it is home-anchored (`~/`).
 *
 * AUTHORED POLICY IS KEPT AT LAUNCH TOO. When the worktree's own settings
 * hold a permissions object other than the generated profile (an empty
 * object, mode-only, deny-only and so on), the launch file carries no
 * permissions: injecting the profile into the process would replace the
 * authored policy there, as surely as overwriting the file would.
 *
 * FAILS CLOSED. An unknown profile, an owner that cannot name a scratch
 * path, a root that is not absolute, or a worktree settings file that cannot
 * be read throws, and the runner fails the launch. Never a builder default.
 */

import { randomUUID } from 'crypto';
import { access, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { homedir } from 'os';
import { isAbsolute, join, normalize, resolve } from 'path';
import { studioPermissionRules, type StudioPermissionProfile } from '@inklabs/shared';

export class LaunchSettingsError extends Error {
  override name = 'LaunchSettingsError';
}

export interface LaunchSettingsRequest {
  /** Unique per launch; default a fresh UUID. */
  launchId?: string;
  /**
   * The studio row's worktree. The launch is refused unless `worktreePath`
   * (where it actually runs) is this directory: a working directory that
   * fell back to the server's own checkout must not be granted the
   * studio's profile (review 44db8c0c, P2 2).
   */
  studioWorktreePath: unknown;
  /** The directory the session runs in, on the host. */
  worktreePath: string;
  /** The main checkout when the studio is a linked worktree of it, for the source record. */
  mainRoot: string | null;
  /** From the studio row; validated here. */
  profile: unknown;
  /** Whose scratch paths the profile names: the row's SB; validated here. */
  owner: unknown;
  /** Host directory the file is written into. */
  outputDir: string;
  /** The checkout's path where the session runs (default worktreePath; `/studio` in a container). */
  executionRoot?: string;
  /** The file's path as the session sees it (default: its host path). */
  processPathFor?: (hostPath: string) => string;
  /** User settings file for the source record (default CLAUDE_CONFIG_DIR or ~/.claude). */
  userSettingsPath?: string;
}

export interface LaunchSource {
  scope: 'user' | 'project' | 'local (main checkout)' | 'local (worktree)' | 'command line';
  path: string;
  present: boolean;
}

export interface LaunchSettings {
  launchId: string;
  hostPath: string;
  /** What `--settings` is given. */
  processPath: string;
  profile: StudioPermissionProfile;
  /** `profile`: the rules are in the file; `authored-on-disk`: the worktree's own policy stands. */
  delivered: 'profile' | 'authored-on-disk';
  settings: { permissions?: { allow: string[]; deny: string[] } };
  sources: LaunchSource[];
  precedence: string;
  cleanup: () => Promise<void>;
}

export const LAUNCH_PRECEDENCE_NOTE =
  'documented, not measured: rules from every source apply and a deny anywhere wins (Claude Code docs, settings: Settings precedence; permissions: Manage permissions)';

const PROFILES: readonly StudioPermissionProfile[] = ['builder', 'reviewer'];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * One rule with its path made absolute against `root`. `Read(*)` and
 * `Edit(/**)` style rules become `Tool(//root/**)`; home-anchored (`~/`)
 * and already-absolute (`//`) paths are kept; tool rules without a path
 * are kept. Any other path form throws: it could not be placed safely.
 */
export function renderAbsoluteRule(rule: string, root: string): string {
  const match = rule.match(/^(Read|Edit)\((.*)\)$/s);
  if (!match) return rule;
  const [, tool, path] = match;
  if (path.startsWith('~/') || path.startsWith('//')) return rule;
  if (path === '*') return `${tool}(/${root}/**)`;
  if (path.startsWith('/')) return `${tool}(/${root}${path})`;
  throw new LaunchSettingsError(`cannot render the path rule ${rule} absolutely`);
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false
  );
}

export async function prepareLaunchSettings(req: LaunchSettingsRequest): Promise<LaunchSettings> {
  if (
    typeof req.profile !== 'string' ||
    !PROFILES.includes(req.profile as StudioPermissionProfile)
  ) {
    throw new LaunchSettingsError(`unknown permission profile: ${JSON.stringify(req.profile)}`);
  }
  const profile = req.profile as StudioPermissionProfile;
  if (typeof req.owner !== 'string') {
    throw new LaunchSettingsError(`no owner to name scratch paths: ${JSON.stringify(req.owner)}`);
  }
  if (
    typeof req.studioWorktreePath !== 'string' ||
    resolve(req.studioWorktreePath) !== resolve(req.worktreePath)
  ) {
    throw new LaunchSettingsError(
      `the launch would run in ${req.worktreePath}, not the studio's worktree ${String(req.studioWorktreePath)}`
    );
  }
  const root = req.executionRoot ?? req.worktreePath;
  if (!isAbsolute(root) || normalize(root) !== root || root.endsWith('/') || root === '/') {
    throw new LaunchSettingsError(
      `execution root must be an absolute, normalized directory: ${root}`
    );
  }

  let generated: ReturnType<typeof studioPermissionRules>;
  try {
    generated = studioPermissionRules(profile, req.owner);
  } catch (error) {
    throw new LaunchSettingsError(error instanceof Error ? error.message : String(error));
  }

  // The worktree's own policy, as authored on disk.
  const localPath = join(req.worktreePath, '.claude', 'settings.local.json');
  let authored = false;
  if (await exists(localPath)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(localPath, 'utf-8'));
    } catch {
      throw new LaunchSettingsError(
        `${localPath} cannot be parsed; its policy cannot be validated`
      );
    }
    if (!isPlainObject(parsed)) {
      throw new LaunchSettingsError(`${localPath} is not a JSON object`);
    }
    if (parsed.permissions !== undefined) {
      if (!isPlainObject(parsed.permissions)) {
        throw new LaunchSettingsError(`${localPath}: permissions is not an object`);
      }
      authored = JSON.stringify(parsed.permissions) !== JSON.stringify(generated);
    }
  }

  const settings: LaunchSettings['settings'] = authored
    ? {}
    : {
        permissions: {
          allow: generated.allow.map((rule) => renderAbsoluteRule(rule, root)),
          deny: generated.deny.map((rule) => renderAbsoluteRule(rule, root)),
        },
      };

  const launchId = req.launchId ?? randomUUID();
  if (!/^[A-Za-z0-9_-]+$/.test(launchId)) {
    throw new LaunchSettingsError(`launch id is not a safe file name: ${launchId}`);
  }
  await mkdir(req.outputDir, { recursive: true, mode: 0o700 });
  const hostPath = join(req.outputDir, `claude-settings-${launchId}.json`);
  // `wx`: a launch never writes over another launch's file.
  await writeFile(hostPath, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  const processPath = req.processPathFor ? req.processPathFor(hostPath) : hostPath;

  const userSettings =
    req.userSettingsPath ??
    join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'settings.json');
  const candidates: Array<Omit<LaunchSource, 'present'>> = [
    { scope: 'user', path: userSettings },
    { scope: 'project', path: join(req.worktreePath, '.claude', 'settings.json') },
    ...(req.mainRoot && req.mainRoot !== req.worktreePath
      ? [
          {
            scope: 'local (main checkout)' as const,
            path: join(req.mainRoot, '.claude', 'settings.local.json'),
          },
        ]
      : []),
    { scope: 'local (worktree)', path: localPath },
  ];
  const sources: LaunchSource[] = [
    ...(await Promise.all(candidates.map(async (c) => ({ ...c, present: await exists(c.path) })))),
    { scope: 'command line', path: processPath, present: true },
  ];

  return {
    launchId,
    hostPath,
    processPath,
    profile,
    delivered: authored ? 'authored-on-disk' : 'profile',
    settings,
    sources,
    precedence: LAUNCH_PRECEDENCE_NOTE,
    cleanup: () => rm(hostPath, { force: true }),
  };
}
