/**
 * What a backend's startup hook writes to its Inkwell session, as
 * update_session_state arguments.
 *
 * A person starting a session marks it idle: it is waiting for input. A
 * backend the server spawned is not. The run already wrote `running` under its
 * turn epoch, and its finalize writes what comes after. An idle here landed a
 * second into the run, and the next `running` rotated the epoch out from under
 * it (2026-09-29: every fresh Claude Code server spawn, and each provider that
 * started a fresh session mid-turn under ink chat). So a spawn's startup write
 * carries the linkage and no lifecycle.
 */
export function sessionStartStateArgs(input: {
  sessionId: string;
  sbSlug: string;
  workingDir: string;
  /** True for a backend the server spawned (INK_CONTEXT cliAttached:false). */
  headless: boolean;
  email?: string;
  backendSessionId?: string;
  activeThreadKey?: string;
}): Record<string, unknown> {
  const args: Record<string, unknown> = {
    email: input.email,
    sbSlug: input.sbSlug,
    sessionId: input.sessionId,
    workingDir: input.workingDir,
  };
  if (!input.headless) args.lifecycle = 'idle';
  if (input.backendSessionId) args.backendSessionId = input.backendSessionId;
  if (input.activeThreadKey) args.activeThreadKey = input.activeThreadKey;
  return args;
}
