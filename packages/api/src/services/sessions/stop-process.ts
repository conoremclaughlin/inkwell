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
