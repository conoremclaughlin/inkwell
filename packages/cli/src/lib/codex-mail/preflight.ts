import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { prepareCodexMailHooks } from './hooks.js';
import { isCodexMailHookScope } from './hook-scope.js';
import { splitCodexMailArgs } from './launch.js';

type LaunchInput = {
  binary: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
};

/** All refusal/fallback decisions happen before starting an execution owner.
 * No fallback is allowed after a gateway, turn, or mail send has started. */
export function prepareCodexMailLaunch(options: LaunchInput) {
  if (process.platform === 'win32') throw new Error('Codex Inkmail requires macOS or Linux');
  const cwd = realpathSync(options.cwd);
  const launch = splitCodexMailArgs(options.args, cwd);
  const version = spawnSync(options.binary, ['--version'], {
    env: options.env,
    cwd,
    encoding: 'utf8',
    timeout: 5000,
  });
  if (version.status !== 0 || !/^codex-cli 0\.159\.2\s*$/.test(version.stdout)) {
    throw new Error('Codex Inkmail currently requires codex-cli 0.159.2');
  }
  // Last preflight operation: only supported launches may migrate config.
  // Unknown/custom blocks refuse without modification. Trust stays human-owned.
  const expectedHooks = prepareCodexMailHooks(cwd);
  launch.serverArgs.splice(1, 0, '--enable', 'hooks');
  return { ...launch, cwd, expectedHooks };
}
export type CodexMailLaunch = ReturnType<typeof prepareCodexMailLaunch>;
export type CodexMailSelection =
  | { kind: 'native'; reason?: string }
  | { kind: 'mail'; launch: CodexMailLaunch }
  | { kind: 'error'; reason: string };

export function selectCodexMailLaunch(
  options: LaunchInput & {
    mode?: boolean;
    backend: string;
    sessionTracked: boolean;
    interactive: boolean;
    sessionId?: string;
    studioId?: string;
  },
  prepare = prepareCodexMailLaunch
): CodexMailSelection {
  if (options.mode === false) return { kind: 'native' };
  const eligible = options.backend === 'codex' && options.sessionTracked && options.interactive;
  if (!eligible && options.mode !== true) return { kind: 'native' };
  try {
    if (!eligible)
      throw new Error('Codex Inkmail requires an interactive, session-tracked Codex terminal');
    if (
      !options.sessionId ||
      !options.studioId ||
      options.env.INK_SESSION_ID !== options.sessionId ||
      options.env.INK_STUDIO_ID !== options.studioId ||
      !isCodexMailHookScope({ ...options.env, INK_CODEX_INKMAIL: '1' })
    )
      throw new Error('Codex Inkmail requires an exact attached Inkwell session and studio');
    return { kind: 'mail', launch: prepare(options) };
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Codex Inkmail preflight failed';
    return { kind: options.mode === true ? 'error' : 'native', reason };
  }
}
