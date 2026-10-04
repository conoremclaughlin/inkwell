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

/**
 * A number that names one process group we may address: a positive integer
 * above 1. `kill(-0)` would address our own group and `kill(-1)` every
 * process we may signal, so nothing else is ever probed or signalled.
 */
export function isGroupId(pgid: unknown): pgid is number {
  return typeof pgid === 'number' && Number.isInteger(pgid) && pgid > 1;
}

/** A stop in progress: its SIGKILL escalation can be called off. */
export interface StopHandle {
  /** Call off the pending SIGKILL (stopProcessAndWait does, once the group is seen empty). */
  cancelEscalation(): void;
}

/**
 * The SIGKILL escalation and the group it addresses. The group's number is
 * ours while our leader has not been reaped, and after that while any
 * process it started remains in it. stopProcessAndWait looks every
 * GROUP_POLL_MS once the leader has exited and calls the escalation off at
 * the first ESRCH. What remains is a group that empties and whose number is
 * taken by another process between two looks: then the escalation would
 * reach that group. That needs the system to hand out that exact number
 * again within one poll interval, and nothing here claims it cannot happen.
 */
export function stopProcess(
  proc: ChildProcess,
  options: { group?: boolean; graceMs?: number } = {}
): StopHandle {
  const group = options.group === true && isGroupId(proc.pid);
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
    // A group is killed whatever its leader did: the leader may have exited
    // on SIGTERM while a tool it started ignored it.
    if (!exited || group) send('SIGKILL');
  }, options.graceMs ?? STOP_GRACE_MS);
  escalate.unref();
  return { cancelEscalation: () => clearTimeout(escalate) };
}

/**
 * What one look at a process group saw, by signal 0, which checks without
 * delivering anything. Only ESRCH proves it empty: success means a process
 * holds the group, and EPERM, any other error, or a number that is not a
 * valid group id says nothing either way, so it is never read as empty.
 */
export type GroupState = 'empty' | 'alive' | 'unknown';

export function probeGroup(pgid: number): GroupState {
  if (!isGroupId(pgid)) return 'unknown';
  try {
    process.kill(-pgid, 0);
    return 'alive';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'empty' : 'unknown';
  }
}

/** How long past the grace period's SIGKILL to wait for an exit before giving up. */
export const STOP_GIVE_UP_MS = 2000;

/** How often a stopped group is looked at once its leader has exited. */
export const GROUP_POLL_MS = 50;

export interface StopOutcome {
  /** The process itself exited before the bound. */
  exited: boolean;
  /**
   * With `group`: the group as last seen. 'empty' only on an observed ESRCH;
   * the stop is confirmed only then.
   */
  group?: GroupState;
}

/**
 * stopProcess, settled when the process has gone rather than when it was
 * signalled. A run is not over while its process is still running: it can
 * still write to the session a next turn would resume, which made two
 * processes on one Claude session after a stopped inkling turn (measured,
 * #740 thread a0b00a78).
 *
 * With `group`, the leader's exit is not enough: a tool it started that
 * ignores SIGTERM stays in the group until the SIGKILL, and could still be
 * writing when a next turn starts. So a group stop settles when the leader
 * has exited and the group is observed empty (ESRCH). Once it is, the
 * pending SIGKILL is called off, because the group's number may be reused.
 *
 * Settles at the latest `giveUpMs` after the SIGKILL, with what was last
 * seen: past that the processes cannot be reached, and waiting longer helps
 * nobody. A process that left the group (its own session) is never
 * signalled and never seen here.
 */
export function stopProcessAndWait(
  proc: ChildProcess,
  options: { group?: boolean; graceMs?: number; giveUpMs?: number; pollMs?: number } = {}
): Promise<StopOutcome> {
  const group = options.group === true && isGroupId(proc.pid);
  const pgid = proc.pid as number;
  return new Promise((resolve) => {
    let exited = false;
    let state: GroupState | undefined;
    let settled = false;
    let giveUp: NodeJS.Timeout | undefined;
    let poll: NodeJS.Timeout | undefined;
    let handle: StopHandle | undefined;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (giveUp) clearTimeout(giveUp);
      if (poll) clearTimeout(poll);
      proc.off('exit', onExit);
      resolve(group ? { exited, group: state ?? probeGroup(pgid) } : { exited });
    };
    const look = () => {
      state = probeGroup(pgid);
      if (state === 'empty') {
        handle?.cancelEscalation();
        finish();
        return;
      }
      poll = setTimeout(look, options.pollMs ?? GROUP_POLL_MS);
    };
    const onExit = () => {
      exited = true;
      if (group) look();
      else finish();
    };
    proc.once('exit', onExit);
    handle = stopProcess(proc, options);
    if (proc.exitCode !== null || proc.signalCode !== null) {
      proc.off('exit', onExit);
      onExit();
    }
    if (settled) return;
    giveUp = setTimeout(
      () => {
        if (group) state = probeGroup(pgid);
        finish();
      },
      (options.graceMs ?? STOP_GRACE_MS) + (options.giveUpMs ?? STOP_GIVE_UP_MS)
    );
  });
}
