/**
 * The backend processes this server launched, kept so a restarted server can
 * stop the ones still running from before (task 2562f0f8).
 *
 * A restart signals only the server. The agent CLIs it started keep running,
 * reparented to init, while shutdown records their sessions as interrupted
 * (interrupt-active-runs.ts), so the next message to such a session started a
 * second backend beside the survivor. Every launch is now recorded with what
 * identifies the process: its pid, its group when it leads one, its start
 * time, and this host's boot. Before the restarted server handles any input,
 * it stops each process this server instance recorded on this boot that is
 * still alive with the same start time.
 *
 * Rows in one plain table, launched_processes, written by this code. No
 * database function decides anything.
 */
import { execFile } from 'child_process';
import { readFile } from 'fs/promises';
import { hostname } from 'os';
import { promisify } from 'util';
import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '../../utils/logger.js';
import { isGroupId, probeGroup } from './stop-process.js';

const exec = promisify(execFile);

export interface SpawnedProcess {
  pid: number;
  pgid?: number;
}

export interface LaunchRow {
  id: string;
  sessionId: string;
  backend: string;
  pid: number;
  pgid: number | null;
  startIdentity: string | null;
  bootId: string;
}

export interface LaunchStore {
  record(row: Omit<LaunchRow, 'id'> & { serverInstance: string }): Promise<string>;
  markExited(ids: string[]): Promise<void>;
  /** Rows of this server instance with no exit recorded. */
  listOpen(serverInstance: string): Promise<LaunchRow[]>;
}

/** What names this host's current boot: a different value is a different boot. */
export async function readBootId(): Promise<string> {
  if (process.platform === 'linux') {
    return (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
  }
  const { stdout } = await exec('sysctl', ['-n', 'kern.boottime'], { timeout: 5000 });
  const sec = /sec = (\d+)/.exec(stdout)?.[1];
  if (!sec) throw new Error('kern.boottime did not name a boot time');
  return `boottime:${sec}`;
}

/** The process's start time as ps prints it, or null when it cannot be read. */
export async function processStartIdentity(pid: number): Promise<string | null> {
  try {
    const { stdout } = await exec('ps', ['-o', 'lstart=', '-p', String(pid)], {
      timeout: 5000,
      env: { ...process.env, LC_ALL: 'C' },
    });
    const text = stdout.trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

/** One server per host and port: a test server never sweeps the main server's children. */
export function serverInstanceOf(port: number | string): string {
  return `${hostname()}:${port}`;
}

export function supabaseLaunchStore(client: SupabaseClient): LaunchStore {
  return {
    async record(row) {
      const { data, error } = await client
        .from('launched_processes')
        .insert({
          session_id: row.sessionId,
          backend: row.backend,
          pid: row.pid,
          pgid: row.pgid,
          start_identity: row.startIdentity,
          boot_id: row.bootId,
          server_instance: row.serverInstance,
        })
        .select('id')
        .single();
      if (error || !data) throw new Error(`launch record failed: ${error?.message}`);
      return data.id as string;
    },
    async markExited(ids) {
      if (ids.length === 0) return;
      const { error } = await client
        .from('launched_processes')
        .update({ exited_at: new Date().toISOString() })
        .in('id', ids)
        .is('exited_at', null);
      if (error) throw new Error(`launch exit failed: ${error.message}`);
    },
    async listOpen(serverInstance) {
      const { data, error } = await client
        .from('launched_processes')
        .select('id, session_id, backend, pid, pgid, start_identity, boot_id')
        .eq('server_instance', serverInstance)
        .is('exited_at', null);
      if (error) throw new Error(`launch listing failed: ${error.message}`);
      return (data ?? []).map((r) => ({
        id: r.id as string,
        sessionId: r.session_id as string,
        backend: r.backend as string,
        pid: r.pid as number,
        pgid: (r.pgid as number | null) ?? null,
        startIdentity: (r.start_identity as string | null) ?? null,
        bootId: r.boot_id as string,
      }));
    },
  };
}

// ── Recording, while the server runs ───────────────────────────────────────

let recording: { store: LaunchStore; serverInstance: string; bootId: string } | undefined;

/** Turned on at startup. Unconfigured (tests, tools), recording does nothing. */
export function configureLaunchRecording(
  config: { store: LaunchStore; serverInstance: string; bootId: string } | undefined
): void {
  recording = config;
}

/**
 * Record one launch. Never throws and never delays the turn: a launch that
 * cannot be recorded is logged, and the turn runs as it did before this
 * existed. `exited()` stamps the row once the run has settled.
 */
export function recordLaunch(
  sessionId: string,
  backend: string,
  spawned: SpawnedProcess
): { exited(): void } {
  const r = recording;
  if (!r) return { exited() {} };
  const id = processStartIdentity(spawned.pid)
    .then((startIdentity) =>
      r.store.record({
        sessionId,
        backend,
        pid: spawned.pid,
        pgid: spawned.pgid ?? null,
        startIdentity,
        bootId: r.bootId,
        serverInstance: r.serverInstance,
      })
    )
    .catch((error: unknown) => {
      // Without a row a restart cannot find it, so at least no second turn of
      // this session starts beside it while this server runs.
      held.set(sessionId, [
        ...(held.get(sessionId) ?? []),
        {
          id: '',
          sessionId,
          backend,
          pid: spawned.pid,
          pgid: spawned.pgid ?? null,
          startIdentity: null,
          bootId: r.bootId,
        },
      ]);
      logger.error('Could not record a backend launch; holding its session while it runs', {
        sessionId,
        backend,
        pid: spawned.pid,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    });
  const target: LaunchRow = {
    id: '',
    sessionId,
    backend,
    pid: spawned.pid,
    pgid: spawned.pgid ?? null,
    startIdentity: null,
    bootId: r.bootId,
  };
  return {
    exited() {
      // Settled is not exited: a runner can settle with its process still
      // alive (a timeout's kill not waited for). Only a pid or group seen
      // gone is stamped; anything else stays open for the next sweep.
      if (!targetGone(target)) return;
      void id
        .then((rowId) => (rowId ? r.store.markExited([rowId]) : undefined))
        .catch((error: unknown) => {
          logger.warn('Could not record a backend exit', {
            sessionId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
    },
  };
}

// ── Holds: no new turn beside a survivor that may still be alive ───────────

const held = new Map<string, LaunchRow[]>();
let sweepPending = false;

/**
 * Why a new turn for this session must not start now, or undefined. A
 * session is held while a process the sweep could not confirm or could not
 * stop may still be alive; each check looks again and lets the session go
 * once its processes are gone. Every session is held while the startup sweep
 * has not yet run (it failed, and is being retried).
 */
export function launchHoldFor(sessionId: string): string | undefined {
  if (sweepPending) {
    return 'The startup check for backend processes left by the previous server has not completed; not starting a turn beside them.';
  }
  const rows = held.get(sessionId);
  if (!rows) return undefined;
  const remaining = rows.filter((row) => !targetGone(row));
  if (remaining.length === 0) {
    held.delete(sessionId);
    const store = recording?.store;
    if (store) {
      void store.markExited(rows.map((row) => row.id).filter(Boolean)).catch(() => undefined);
    }
    return undefined;
  }
  held.set(sessionId, remaining);
  return `A backend process from before the restart (pid ${remaining[0].pid}) may still be running this session; not starting another beside it.`;
}

/** Hold each session the sweep could not resolve (uncertain or unstoppable). */
export function holdSurvivors(outcome: SweepOutcome): void {
  for (const row of [...outcome.uncertain, ...outcome.unstoppable]) {
    held.set(row.sessionId, [...(held.get(row.sessionId) ?? []), row]);
  }
}

/** For tests: forget every hold. */
export function resetLaunchHolds(): void {
  held.clear();
  sweepPending = false;
}

// ── The sweep, at startup ──────────────────────────────────────────────────

export interface SweepOutcome {
  /** Still running from before, and stopped. */
  stopped: LaunchRow[];
  /** Already gone: exited, another boot, or the pid now names another process. */
  gone: LaunchRow[];
  /** Alive, but its start time could not be compared: not signalled, row left open. */
  uncertain: LaunchRow[];
  /** Signalled to the end and still there: row left open. */
  unstoppable: LaunchRow[];
}

export interface SweepOptions {
  serverInstance: string;
  bootId: string;
  /** How long each signal gets before the next, harder one. */
  graceMs?: number;
  identityOf?: (pid: number) => Promise<string | null>;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: a process holds the pid, and it is not ours to signal.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Gone means the pid is dead and, when the run led a group, the group is empty. */
function targetGone(row: LaunchRow): boolean {
  if (pidAlive(row.pid)) return false;
  return row.pgid === null || !isGroupId(row.pgid) || probeGroup(row.pgid) === 'empty';
}

async function waitGone(row: LaunchRow, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (targetGone(row)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return targetGone(row);
}

/**
 * SIGINT first, the interrupt both Claude Code and Codex treat as Ctrl-C, so
 * the CLI can stop its turn the way a person would; then SIGTERM; then
 * SIGKILL. A run that led a group is stopped as the group, tools included.
 */
async function stop(row: LaunchRow, graceMs: number): Promise<boolean> {
  const target = row.pgid !== null && isGroupId(row.pgid) ? -row.pgid : row.pid;
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGKILL'] as const) {
    try {
      process.kill(target, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
    }
    if (await waitGone(row, graceMs)) return true;
  }
  return false;
}

/**
 * Stop what this server instance launched before its restart and left
 * running. Run before any input is handled, so no turn can start a second
 * backend beside a survivor.
 */
export async function stopSurvivingLaunches(
  store: LaunchStore,
  options: SweepOptions
): Promise<SweepOutcome> {
  const graceMs = options.graceMs ?? 2000;
  const identityOf = options.identityOf ?? processStartIdentity;
  const outcome: SweepOutcome = { stopped: [], gone: [], uncertain: [], unstoppable: [] };
  const rows = await store.listOpen(options.serverInstance);

  await Promise.all(
    rows.map(async (row) => {
      // Nothing of an earlier boot survives it.
      if (row.bootId !== options.bootId) {
        outcome.gone.push(row);
        return;
      }
      const leaderAlive = pidAlive(row.pid);
      if (!leaderAlive) {
        // With the leader gone there is no start time to compare, and a group
        // number can be reused once the old group has emptied. A group seen
        // empty is gone; one still populated, or one that cannot be probed,
        // is never signalled or cleared on a guess.
        const group = row.pgid !== null ? probeGroup(row.pgid) : 'empty';
        if (group === 'empty') {
          outcome.gone.push(row);
          return;
        }
        outcome.uncertain.push(row);
        return;
      } else {
        const now = await identityOf(row.pid);
        if (now === null || row.startIdentity === null) {
          outcome.uncertain.push(row);
          return;
        }
        if (now !== row.startIdentity) {
          outcome.gone.push(row);
          return;
        }
      }
      if (await stop(row, graceMs)) outcome.stopped.push(row);
      else outcome.unstoppable.push(row);
    })
  );

  await store.markExited([...outcome.stopped, ...outcome.gone].map((row) => row.id));
  return outcome;
}

/**
 * Server startup: sweep, then record from here on. Until one attempt has
 * read this host's boot and swept, every agent turn is held and the attempt
 * retries every 30s; the server itself still comes up, channels and routes
 * included.
 */
export async function startLaunchTracking(
  client: SupabaseClient,
  port: number | string,
  retryMs = 30_000,
  readBoot: () => Promise<string> = readBootId
): Promise<SweepOutcome | undefined> {
  const serverInstance = serverInstanceOf(port);
  const store = supabaseLaunchStore(client);
  const attempt = async (): Promise<SweepOutcome> => {
    // Without the boot, this boot's survivors cannot be told from an earlier one's.
    const bootId = await readBoot();
    configureLaunchRecording({ store, serverInstance, bootId });
    const outcome = await stopSurvivingLaunches(store, { serverInstance, bootId });
    holdSurvivors(outcome);
    sweepPending = false;
    const summary = (rows: LaunchRow[]) =>
      rows.map((r) => ({ sessionId: r.sessionId, backend: r.backend, pid: r.pid }));
    if (outcome.stopped.length || outcome.uncertain.length || outcome.unstoppable.length) {
      logger.warn('Stopped backend processes left running by the previous server', {
        stopped: summary(outcome.stopped),
        held: summary([...outcome.uncertain, ...outcome.unstoppable]),
      });
    }
    return outcome;
  };
  try {
    return await attempt();
  } catch (error) {
    sweepPending = true;
    logger.error(
      'The startup check of launched processes failed; holding agent turns until it runs',
      {
        error: error instanceof Error ? error.message : String(error),
      }
    );
    const retry = setInterval(() => {
      void attempt()
        .then(() => {
          clearInterval(retry);
          logger.info('The startup check of launched processes ran; agent turns resume');
        })
        .catch(() => undefined);
    }, retryMs);
    retry.unref();
    return undefined;
  }
}
