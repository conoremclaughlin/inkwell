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
import { readdir, readFile, stat as stat_ } from 'fs/promises';
import { hostname } from 'os';
import { promisify } from 'util';
import type { SupabaseClient } from '@supabase/supabase-js';
import { LAUNCH_TAG } from '@inklabs/shared';
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

// The environment variable that carries a launch's row id into its process,
// set first in its environment by buildCleanEnv.
export { LAUNCH_TAG };

export interface TaggedProcess {
  pid: number;
  /** Set only when the process leads its own group. */
  pgid: number | null;
  /** Its command line, which says whether it could be a backend's launch; null when unread. */
  command: string | null;
}

export interface ProcessInventory {
  /** Processes carrying one of the asked-for launch ids, by id. */
  tagged: Map<string, TaggedProcess[]>;
  /**
   * This user's processes whose environment could not be read, with their
   * command line: any one of them could be carrying a tag, so no match is not
   * proof of exit while one of them could be the launch (`couldBeBackend`).
   */
  unreadable: TaggedProcess[];
}

/**
 * This user's processes, read for launch tags: from /proc on Linux, and from
 * `ps -E` on macOS, which shows a process's environment to its own user unless
 * the process is a system binary or has rewritten its argument area. Throws
 * when the table cannot be read, and on any other platform: an unread table is
 * not an empty one.
 */
export async function findTaggedProcesses(ids: Set<string>): Promise<ProcessInventory> {
  const inventory: ProcessInventory = { tagged: new Map(), unreadable: [] };
  const groupOf = (pid: number, pgid: number) => (pgid === pid ? pid : null);
  const prefix = `${LAUNCH_TAG}=`;
  const tag = (id: string, pid: number, pgid: number, command: string | null) => {
    if (!ids.has(id)) return;
    const found = inventory.tagged.get(id) ?? [];
    inventory.tagged.set(id, [...found, { pid, pgid: groupOf(pid, pgid), command }]);
  };
  const unresolved = (pid: number, pgid: number | null, command: string | null) =>
    inventory.unreadable.push({ pid, pgid: pgid === null ? null : groupOf(pid, pgid), command });
  const uid = process.getuid?.();
  if (process.platform === 'linux') {
    const vanished = (error: unknown) =>
      ['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '');
    for (const entry of await readdir('/proc')) {
      if (!/^\d+$/.test(entry)) continue;
      const pid = Number(entry);
      if (pid === process.pid) continue;
      // Any read failure other than the process having gone is unknown: it
      // stays visible, never read as "no tag" or "not the backend".
      const command = await readFile(`/proc/${entry}/cmdline`, 'utf8').then(
        (text) => text.split('\0').join(' '),
        (error: unknown) => (vanished(error) ? undefined : null)
      );
      if (command === undefined) continue;
      let pgrp: number | null = null;
      try {
        const [info, text] = await Promise.all([
          stat_(`/proc/${entry}`),
          readFile(`/proc/${entry}/stat`, 'utf8'),
        ]);
        if (info.uid !== uid) continue;
        // Fields after the parenthesised name: state, ppid, pgrp.
        const fields = text.slice(text.lastIndexOf(')') + 2).split(' ');
        if (fields[0] === 'Z') continue;
        pgrp = Number(fields[2]);
        const environ = await readFile(`/proc/${entry}/environ`, 'utf8');
        const pair = environ.split('\0').find((p) => p.startsWith(prefix));
        // An exact tag is that launch's; an unread command stays unknown.
        if (pair) tag(pair.slice(prefix.length), pid, pgrp, command);
      } catch (error) {
        if (vanished(error)) continue;
        unresolved(pid, pgrp, command);
      }
    }
    return inventory;
  }
  if (process.platform !== 'darwin' || uid === undefined) {
    throw new Error(`launch tags cannot be read on ${process.platform}`);
  }
  // `ps -E` prints the environment after the arguments. The same listing
  // without it says where the arguments end. The two are separate snapshots,
  // so a process that changed or appeared between them is unresolved, never
  // absent. Only the first variable is read: buildCleanEnv puts the tag
  // there, and the space-joined list could hold its text inside any later
  // variable's value.
  const opts = {
    timeout: 15_000,
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, LC_ALL: 'C' },
  };
  // ps exits 1 when none of the selected processes exist, and says so with
  // an empty listing.
  const list = async (args: string[]): Promise<string> => {
    try {
      return (await exec('ps', args, opts)).stdout;
    } catch (error) {
      const failed = error as { code?: number; stdout?: string };
      if (failed.code === 1) return failed.stdout ?? '';
      throw error;
    }
  };
  const columns = ['-ww', '-o', 'pid=,pgid=,command='];
  const parse = (line: string) => /^\s*(\d+)\s+(\d+)\s(.*)$/.exec(line);
  // One look at the selected processes: each one either read (its first
  // variable checked for a tag, or found unreadable) or returned as
  // inconsistent between the two listings, with its command when known.
  const look = async (selector: string[]) => {
    const [plain, withEnv] = await Promise.all([
      list([...columns, ...selector]),
      list(['-E', ...columns, ...selector]),
    ]);
    const argsOf = new Map<number, { line: string; pgid: number; command: string }>();
    for (const line of plain.split('\n')) {
      const match = parse(line);
      if (match) {
        argsOf.set(Number(match[1]), { line, pgid: Number(match[2]), command: match[3].trim() });
      }
    }
    const inconsistent = new Map<number, { pgid: number; command: string | null }>();
    const seen = new Set<number>();
    for (const line of withEnv.split('\n')) {
      const match = parse(line);
      if (!match) continue;
      const pid = Number(match[1]);
      const pgid = Number(match[2]);
      seen.add(pid);
      if (pid === process.pid) continue;
      const args = argsOf.get(pid);
      if (args === undefined || !line.startsWith(args.line)) {
        inconsistent.set(pid, { pgid, command: args?.command ?? null });
        continue;
      }
      if (args.command === '<defunct>') continue;
      const environment = line.slice(args.line.length);
      if (environment.trim() === '') {
        unresolved(pid, pgid, args.command);
        continue;
      }
      // The environment starts with a NAME= right after the arguments.
      // Anything else is an argument the plain listing did not have: the two
      // listings disagree, and the process gets another look.
      const first = /^\s+([A-Za-z_][A-Za-z0-9_]*=\S*)/.exec(environment)?.[1];
      if (first === undefined) {
        inconsistent.set(pid, { pgid, command: args.command });
        continue;
      }
      if (first.startsWith(prefix)) tag(first.slice(prefix.length), pid, pgid, args.command);
    }
    for (const [pid, args] of argsOf) {
      if (!seen.has(pid) && pid !== process.pid && args.command !== '<defunct>') {
        inconsistent.set(pid, { pgid: args.pgid, command: args.command });
      }
    }
    return inconsistent;
  };
  // A process that changed, started or exited between the two listings is
  // looked at once more on its own; one still inconsistent stays unresolved,
  // and one absent from both has exited.
  const changed = await look(['-U', String(uid)]);
  if (changed.size > 0) {
    const still = await look(['-p', [...changed.keys()].join(',')]);
    for (const [pid, again] of still) {
      unresolved(pid, again.pgid, again.command ?? changed.get(pid)?.command ?? null);
    }
  }
  return inventory;
}

/** The executables each backend is started as: a process named otherwise is not its launch. */
const BACKEND_EXECUTABLES: Record<string, string[]> = {
  'claude-code': ['claude'],
  'codex-cli': ['codex', 'codex.js'],
  gemini: ['gemini', 'gemini.js'],
  antigravity: ['agy'],
  ink: ['ink', 'cli.js'],
};

/**
 * Whether a process could be this backend's launch, from its command line: its
 * executable, or the script a node or shell interpreter runs, is one the
 * backend is started as. An unknown backend could be anything.
 */
export function couldBeBackend(backend: string, command: string | null): boolean {
  const names = BACKEND_EXECUTABLES[backend];
  if (!names || command === null) return true;
  const [first = '', second = ''] = command.trim().split(/\s+/);
  const base = (word: string) => word.slice(word.lastIndexOf('/') + 1);
  return names.includes(base(first)) || names.includes(base(second));
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
  findTagged?: (ids: Set<string>) => Promise<ProcessInventory>;
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
  // Nothing of an earlier boot survives it.
  const current = rows.filter((row) => row.bootId === options.bootId);
  outcome.gone.push(...rows.filter((row) => row.bootId !== options.bootId));

  // Every launch of this boot is looked for by its tag, whatever pid its row
  // names: one launch can start several processes (a fallback attempt), and
  // the row names only the last pid written, or none.
  const inventory =
    current.length > 0
      ? await findTagged(new Set(current.map((row) => row.id)))
      : { tagged: new Map<string, TaggedProcess[]>(), unreadable: [] };

  await Promise.all(
    current.map(async (row) => {
      // A process carrying the tag that is the backend itself is that launch,
      // and is stopped without a start time to compare. One that is not (a
      // tool the backend started, or another variable's value that happens to
      // hold the text) is never signalled on the tag alone.
      const found = (inventory.tagged.get(row.id) ?? []).filter((proc) =>
        couldBeBackend(row.backend, proc.command)
      );
      const targets: LaunchRow[] = found.map((proc) => ({
        ...row,
        pid: proc.pid,
        pgid: proc.pgid,
      }));
      let unresolved = false;
      if (row.pid !== null && !found.some((proc) => proc.pid === row.pid)) {
        const verdict = await judgeRecordedPid(row as LaunchRow & { pid: number }, identityOf);
        if (verdict === 'running') targets.push(row);
        if (verdict === 'uncertain') {
          outcome.uncertain.push(row);
          unresolved = true;
        }
      }
      for (const target of targets) {
        if (await stop(target, graceMs)) outcome.stopped.push(target);
        else outcome.unstoppable.push(target);
      }
      // What the scan could not read could be another attempt of this
      // launch, found or not: a match does not make the inventory complete.
      // Each process that could be its backend holds the row open, and its
      // session, until it exits.
      const suspects = inventory.unreadable.filter((proc) =>
        couldBeBackend(row.backend, proc.command)
      );
      outcome.uncertain.push(
        ...suspects.map((proc) => ({ ...row, pid: proc.pid, pgid: proc.pgid }))
      );
      if (targets.length > 0 || unresolved || suspects.length > 0) return;
      outcome.gone.push(row);
    })
  );

  // A launch found as several processes stays open while any of them does.
  const open = new Set([...outcome.uncertain, ...outcome.unstoppable].map((row) => row.id));
  const done = new Set([...outcome.stopped, ...outcome.gone].map((row) => row.id));
  await store.markExited([...done].filter((id) => !open.has(id)));
  return outcome;
}

/**
 * What the row's recorded pid says: still the launch (`running`), gone, or
 * alive with nothing to confirm it by (`uncertain`). With the leader gone
 * there is no start time to compare, and a group number can be reused once
 * the old group has emptied: a group seen empty is gone, one still populated
 * or one that cannot be probed is never signalled or cleared on a guess.
 */
async function judgeRecordedPid(
  row: LaunchRow & { pid: number },
  identityOf: (pid: number) => Promise<string | null>
): Promise<'running' | 'gone' | 'uncertain'> {
  if (!pidAlive(row.pid)) {
    const group = row.pgid !== null ? probeGroup(row.pgid) : 'empty';
    return group === 'empty' ? 'gone' : 'uncertain';
  }
  const now = await identityOf(row.pid);
  if (now === null || row.startIdentity === null) return 'uncertain';
  return now === row.startIdentity ? 'running' : 'gone';
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
