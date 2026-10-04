/**
 * Stop a spawned backend process so that it really stops: SIGTERM, then
 * SIGKILL after a grace period if it has not exited.
 *
 * The escalation asks whether the process EXITED (exitCode, signalCode).
 * `proc.killed` cannot say that: Node sets it as soon as a signal is SENT,
 * so the old `if (!proc.killed) proc.kill('SIGKILL')` never fired, and a
 * process that ignored SIGTERM ran on after its timeout.
 *
 * With `group`, the whole process group is signalled. The child must have
 * been spawned with `detached: true`, which makes it a group leader. That
 * takes the tools it started (shells, servers, scripts) down with it,
 * where signalling the child alone would leave them running.
 */

import type { ChildProcess } from 'node:child_process';

export const STOP_GRACE_MS = 5000;

export function stopProcess(
  proc: ChildProcess,
  options: { group?: boolean; graceMs?: number } = {}
): void {
  const group = options.group === true && typeof proc.pid === 'number';
  const send = (signal: NodeJS.Signals) => {
    try {
      if (group) process.kill(-(proc.pid as number), signal);
      else proc.kill(signal);
    } catch {
      // Already gone (ESRCH): nothing left to stop.
    }
  };

  send('SIGTERM');
  const escalate = setTimeout(() => {
    const exited = proc.exitCode !== null || proc.signalCode !== null;
    // A group is killed regardless: its leader may have exited on SIGTERM
    // while a tool it started ignored it.
    if (!exited || group) send('SIGKILL');
  }, options.graceMs ?? STOP_GRACE_MS);
  escalate.unref();
}

/** How long past the grace period's SIGKILL to wait for an exit before giving up. */
export const STOP_GIVE_UP_MS = 2000;

/**
 * stopProcess, settled when the process has exited rather than when it was
 * signalled. A run is not over while its process is still running: it can
 * still write to the session a next turn would resume, which made two
 * processes on one Claude session after a stopped inkling turn (measured,
 * #740 thread a0b00a78).
 *
 * Resolves true on the exit. Resolves false if it has not exited `giveUpMs`
 * after the SIGKILL: past that the process cannot be reached, and waiting
 * longer helps nobody. "Exited" is the process itself: with `group`, a tool
 * it started that left the group (its own session) is never signalled, and
 * one that ignores SIGTERM dies with the group's SIGKILL, not before.
 */
export function stopProcessAndWait(
  proc: ChildProcess,
  options: { group?: boolean; graceMs?: number; giveUpMs?: number } = {}
): Promise<boolean> {
  return new Promise((resolve) => {
    let giveUp: NodeJS.Timeout | undefined;
    const finish = (exited: boolean) => {
      if (giveUp) clearTimeout(giveUp);
      proc.off('exit', onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    proc.once('exit', onExit);
    stopProcess(proc, options);
    if (proc.exitCode !== null || proc.signalCode !== null) {
      finish(true);
      return;
    }
    giveUp = setTimeout(
      () => finish(false),
      (options.graceMs ?? STOP_GRACE_MS) + (options.giveUpMs ?? STOP_GIVE_UP_MS)
    );
  });
}
