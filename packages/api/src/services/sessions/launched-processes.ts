/**
 * The backend processes this server launched, kept so a restarted server can
 * stop the ones still running from before (task 2562f0f8).
 *
 * A restart signals only the server. The agent CLIs it started keep running,
 * reparented to init, while shutdown records their sessions as interrupted
 * (interrupt-active-runs.ts), so the next message to such a session started a
 * second backend beside the survivor.
 *
 * Every launch is now written before its process exists, and the row's id is
 * set in the process's environment as INK_LAUNCH_ID. A launch that cannot be
 * written is not started. Once the process is up, its pid, its group when it
 * leads one, and its start time are added to the row. Before the restarted
 * server handles any input, it stops each process this server instance
 * launched on this boot that is still running: by pid and start time, or,
 * when the pid never reached the row (the server went down first), by the
 * launch id in its environment.
 *
 * Rows in one plain table, launched_processes, written by this code. No
 * database function decides anything.
 */
import { execFile } from 'child_process';
import { readdir, readFile } from 'fs/promises';
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
  /** Null until the process is up and its pid written; found by its tag meanwhile. */
  pid: number | null;
  pgid: number | null;
  startIdentity: string | null;
  bootId: string;
}

export interface LaunchStore {
  /** Written before the process is started; returns the row's id, its tag. */
  reserve(row: {
    sessionId: string;
    backend: string;
    bootId: string;
    serverInstance: string;
  }): Promise<string>;
  /** The started process, added to its reserved row. */
  attach(
    id: string,
    process: { pid: number; pgid: number | null; startIdentity: string | null }
  ): Promise<void>;
  markExited(ids: string[]): Promise<void>;
  /** Rows of this server instance with no exit recorded. */
  listOpen(serverInstance: string): Promise<LaunchRow[]>;
}

/** The environment variable that carries a launch's row id into its process. */
export const LAUNCH_TAG = 'INK_LAUNCH_ID';

export interface TaggedProcess {
  pid: number;
  /** Set only when the process leads its own group. */
  pgid: number | null;
}

/**
 * The processes on this host carrying one of these launch ids in their
 * environment, by id. Read from /proc on Linux and `ps -E` on macOS, both of
 * which show a process's environment to its own user. Throws when the table
 * cannot be read, and on any other platform: an unread table is not an empty
 * one.
 */
export async function findTaggedProcesses(ids: Set<string>): Promise<Map<string, TaggedProcess[]>> {
  const found = new Map<string, TaggedProcess[]>();
  const add = (id: string, pid: number, pgid: number) => {
    if (!ids.has(id) || pid === process.pid) return;
    found.set(id, [...(found.get(id) ?? []), { pid, pgid: pgid === pid ? pid : null }]);
  };
  const prefix = `${LAUNCH_TAG}=`;
  if (process.platform === 'linux') {
    for (const entry of await readdir('/proc')) {
      if (!/^\d+$/.test(entry)) continue;
      let environ: string;
      let stat: string;
      try {
        [environ, stat] = await Promise.all([
          readFile(`/proc/${entry}/environ`, 'utf8'),
          readFile(`/proc/${entry}/stat`, 'utf8'),
        ]);
      } catch {
        continue; // Exited meanwhile, or not ours to read.
      }
      const tag = environ.split('\0').find((pair) => pair.startsWith(prefix));
      if (!tag) continue;
      // Fields after the parenthesised name: state, ppid, pgrp.
      const pgrp = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[2]);
      add(tag.slice(prefix.length), Number(entry), pgrp);
    }
    return found;
  }
  if (process.platform !== 'darwin') {
    throw new Error(`launch tags cannot be read on ${process.platform}`);
  }
  // `ps -E` prints the environment after the arguments; the same listing
  // without it says where the arguments end, so an argument that merely
  // mentions a tag is never read as one.
  const opts = {
    timeout: 15_000,
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, LC_ALL: 'C' },
  };
  const columns = ['-ww', '-ax', '-o', 'pid=,pgid=,command='];
  const [plain, withEnv] = await Promise.all([
    exec('ps', columns, opts),
    exec('ps', ['-E', ...columns], opts),
  ]);
  const argsOf = new Map<string, string>();
  for (const line of plain.stdout.split('\n')) {
    const pid = /^\s*(\d+)/.exec(line)?.[1];
    if (pid) argsOf.set(pid, line);
  }
  for (const line of withEnv.stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)/.exec(line);
    const args = match ? argsOf.get(match[1]) : undefined;
    if (!match || args === undefined || !line.startsWith(args)) continue;
    for (const pair of line.slice(args.length).split(' ')) {
      if (pair.startsWith(prefix))
        add(pair.slice(prefix.length), Number(match[1]), Number(match[2]));
    }
  }
  return found;
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
    async reserve(row) {
      const { data, error } = await client
        .from('launched_processes')
        .insert({
          session_id: row.sessionId,
          backend: row.backend,
          boot_id: row.bootId,
          server_instance: row.serverInstance,
        })
        .select('id')
        .single();
      if (error || !data) throw new Error(`launch record failed: ${error?.message}`);
      return data.id as string;
    },
    async attach(id, started) {
      const { error } = await client
        .from('launched_processes')
        .update({ pid: started.pid, pgid: started.pgid, start_identity: started.startIdentity })
        .eq('id', id);
      if (error) throw new Error(`launch pid write failed: ${error.message}`);
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
        pid: (r.pid as number | null) ?? null,
        pgid: (r.pgid as number | null) ?? null,
        startIdentity: (r.start_identity as string | null) ?? null,
        bootId: r.boot_id as string,
      }));
    },
  };
}

// ── Recording, while the server runs ───────────────────────────────────────

interface RecordingConfig {
  store: LaunchStore;
  serverInstance: string;
  bootId: string;
  /** Waits before each attempt to write a launch; the default tries three times. */
  reserveDelaysMs?: number[];
}

let recording: RecordingConfig | undefined;

/** Turned on at startup. Unconfigured (tests, tools), recording does nothing. */
export function configureLaunchRecording(config: RecordingConfig | undefined): void {
  recording = config;
}

export interface LaunchReservation {
  /** Why the launch must not start: it could not be written first. */
  refused?: string;
  /** For the process's environment: the tag a restarted server finds it by. */
  env: Record<string, string>;
  /** Each process the run starts, added to the row as soon as it has a pid. */
  spawned(started: SpawnedProcess): void;
  /** The run has settled: the row is stamped once its processes are seen gone. */
  exited(): void;
}

const NOT_RECORDING: LaunchReservation = { env: {}, spawned() {}, exited() {} };

/**
 * Write a launch before its process exists, so a restart can find the process
 * whatever happens after: the row carries no pid until `spawned`, and the
 * process carries the row's id in its environment meanwhile. A launch that
 * cannot be written after its retries is refused, and nothing is started.
 */
export async function reserveLaunch(
  sessionId: string,
  backend: string
): Promise<LaunchReservation> {
  const r = recording;
  if (!r) return NOT_RECORDING;
  let rowId: string | undefined;
  let lastError: unknown;
  for (const delay of r.reserveDelaysMs ?? [0, 250, 1000]) {
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    try {
      rowId = await r.store.reserve({
        sessionId,
        backend,
        bootId: r.bootId,
        serverInstance: r.serverInstance,
      });
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (rowId === undefined) {
    logger.error('Could not record a backend launch before starting it; not starting it', {
      sessionId,
      backend,
      error: lastError instanceof Error ? lastError.message : String(lastError),
    });
    return {
      ...NOT_RECORDING,
      refused:
        'The launch could not be recorded before starting it, so a restarted server could not stop it; not starting it.',
    };
  }
  const id = rowId;
  const targets: LaunchRow[] = [];
  return {
    env: { [LAUNCH_TAG]: id },
    spawned(started) {
      const pgid = started.pgid ?? null;
      targets.push({
        id,
        sessionId,
        backend,
        pid: started.pid,
        pgid,
        startIdentity: null,
        bootId: r.bootId,
      });
      void processStartIdentity(started.pid)
        .then((startIdentity) => r.store.attach(id, { pid: started.pid, pgid, startIdentity }))
        .catch((error: unknown) => {
          // The row and the process's tag remain: a restart still finds it.
          logger.warn('Could not add a backend launch’s pid to its record', {
            sessionId,
            pid: started.pid,
            error: error instanceof Error ? error.message : String(error),
          });
        });
    },
    exited() {
      // Settled is not exited: a runner can settle with its process still
      // alive (a timeout's kill not waited for). Only processes seen gone are
      // stamped; anything else stays open for the next sweep.
      if (!targets.every(targetGone)) return;
      void r.store.markExited([id]).catch((error: unknown) => {
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
  findTagged?: (ids: Set<string>) => Promise<Map<string, TaggedProcess[]>>;
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

/**
 * Gone means the pid is dead and, when the run led a group, the group is
 * empty. A row with no pid names no process here: the sweep resolves those by
 * their tag before anything asks this.
 */
function targetGone(row: LaunchRow): boolean {
  if (row.pid === null) return true;
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
  if (row.pid === null) return true;
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
  const findTagged = options.findTagged ?? findTaggedProcesses;
  const outcome: SweepOutcome = { stopped: [], gone: [], uncertain: [], unstoppable: [] };
  const rows = await store.listOpen(options.serverInstance);

  // A row of this boot whose pid never landed is resolved by the processes
  // carrying its id: each one found is that launch, whatever its pid, so it is
  // stopped without a start time to compare. None found means it has gone.
  const thisBoot = (row: LaunchRow) => row.bootId === options.bootId;
  const unattached = rows.filter((row) => row.pid === null && thisBoot(row));
  const tagged =
    unattached.length > 0 ? await findTagged(new Set(unattached.map((row) => row.id))) : new Map();
  const confirmed = new Set<LaunchRow>();
  const candidates = rows.flatMap((row) => {
    if (row.pid !== null || !thisBoot(row)) return [row];
    const found: TaggedProcess[] = tagged.get(row.id) ?? [];
    if (found.length === 0) outcome.gone.push(row);
    return found.map((proc) => {
      const resolved = { ...row, pid: proc.pid, pgid: proc.pgid };
      confirmed.add(resolved);
      return resolved;
    });
  });

  await Promise.all(
    candidates.map(async (row) => {
      // Nothing of an earlier boot survives it.
      if (!thisBoot(row) || row.pid === null) {
        outcome.gone.push(row);
        return;
      }
      if (confirmed.has(row)) {
        if (await stop(row, graceMs)) outcome.stopped.push(row);
        else outcome.unstoppable.push(row);
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

  // A launch found as several processes stays open while any of them does.
  const open = new Set([...outcome.uncertain, ...outcome.unstoppable].map((row) => row.id));
  const done = new Set([...outcome.stopped, ...outcome.gone].map((row) => row.id));
  await store.markExited([...done].filter((id) => !open.has(id)));
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
    // One attempt at a time: the next is scheduled only once this one has
    // failed, so none is still sweeping after another has opened admission.
    const retry = (): void => {
      setTimeout(() => {
        attempt().then(
          () => logger.info('The startup check of launched processes ran; agent turns resume'),
          retry
        );
      }, retryMs).unref();
    };
    retry();
    return undefined;
  }
}
