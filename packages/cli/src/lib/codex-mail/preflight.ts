import { realpathSync } from 'node:fs';
import {
  codexMailHooks,
  codexMailHookArgs,
  codexMailHookState,
  codexMailHookWarning,
} from './hooks.js';
import { probeCodexMailHooks } from './hook-probe.js';
import { isCodexMailHookScope } from './hook-scope.js';
import { splitCodexMailArgs } from './launch.js';
import { probeCodexMailCapabilities } from './capabilities.js';

type LaunchInput = {
  binary: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
};

/** All refusal/fallback decisions happen before starting an execution owner.
 * No fallback is allowed after a gateway, turn, or mail send has started. */
export async function prepareCodexMailLaunch(options: LaunchInput) {
  if (process.platform === 'win32') throw new Error('Codex Inkmail requires macOS or Linux');
  const cwd = realpathSync(options.cwd);
  const launch = splitCodexMailArgs(options.args, cwd);
  probeCodexMailCapabilities({ ...options, cwd });
  const expectedHooks = codexMailHooks();
  launch.serverArgs.splice(1, 0, '--enable', 'hooks');
  const probe = () => probeCodexMailHooks({ ...options, cwd, serverArgs: launch.serverArgs });
  const before = await probe();
  if (!before.enabled) throw new Error(codexMailHookWarning('feature-disabled'));
  let effective = before.hooks;
  let state = codexMailHookState(effective, expectedHooks);
  if (state === 'missing') {
    // Never overwrite a caller's hook arrays. User/project/plugin layers remain
    // additive and untouched. Native /hooks still owns trust and enablement.
    if (before.sessionHooks)
      throw new Error('Codex Inkmail cannot replace custom session hook overrides');
    launch.serverArgs.push(...codexMailHookArgs(expectedHooks));
    const after = await probe();
    effective = after.hooks;
    state = codexMailHookState(effective, expectedHooks);
    if (!after.enabled) throw new Error(codexMailHookWarning('feature-disabled'));
  }
  if (!['ready', 'untrusted', 'disabled'].includes(state))
    throw new Error(codexMailHookWarning(state, effective));
  return { ...launch, cwd, expectedHooks };
}
export type CodexMailLaunch = Awaited<ReturnType<typeof prepareCodexMailLaunch>>;
export type CodexMailSelection =
  | { kind: 'native'; reason?: string }
  | { kind: 'mail'; launch: CodexMailLaunch }
  | { kind: 'error'; reason: string };

export async function selectCodexMailLaunch(
  options: LaunchInput & {
    mode?: boolean;
    backend: string;
    sessionTracked: boolean;
    interactive: boolean;
    sessionId?: string;
    studioId?: string;
  },
  prepare = prepareCodexMailLaunch
): Promise<CodexMailSelection> {
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
    return { kind: 'mail', launch: await prepare(options) };
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Codex Inkmail preflight failed';
    return { kind: options.mode === true ? 'error' : 'native', reason };
  }
}
