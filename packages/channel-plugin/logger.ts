/**
 * Channel-plugin file logger.
 *
 * Three properties this module exists to guarantee:
 *
 * 1. **Non-blocking.** Writes go through `fs/promises.appendFile`, never
 *    `appendFileSync`. The plugin polls on a 10s interval and logs on every
 *    tick; a synchronous write there stalls the plugin's event loop — and the
 *    MCP stdio transport shares it (repo rule: never block the event loop).
 *    The ONLY sync path is `logSync`, for `process.on('exit')` where an async
 *    write would simply be lost.
 *
 * 2. **Level-gated.** Default `info`. The per-tick `Poll result` line is
 *    `debug` and is what made the log grow ~35k lines/day across four plugins.
 *    Set `INK_PLUGIN_LOG_LEVEL=debug` to get it back.
 *
 * 3. **Size-capped.** Rotates to `<file>.1` past `maxBytes`, keeping one
 *    generation. Before this the file was uncapped (it reached 292MB).
 *
 * ## One writer per file — the invariant everything else rests on
 *
 * Each plugin process logs to its OWN file (`<pid>.log`); nothing is shared.
 * This is deliberate and was arrived at the hard way. The first two versions
 * had all four plugin processes appending to one path, which put rotation on a
 * concurrent path and produced three separate P1 defects in review (Lumen,
 * PR #499):
 *
 *   1. stat→rename was a cross-writer TOCTOU: a losing writer renamed a
 *      sibling's freshly recreated live file over a full `.1`, destroying a
 *      generation. `rename` overwrites on POSIX, so nothing threw.
 *   2. a per-instance byte counter could not see sibling appends, so the
 *      shared file grew to roughly N x the cap.
 *   3. the lockfile added to fix (1) had its own hole: several writers could
 *      observe the same stale lock, and a delayed reclaimer would unlink a
 *      lease another writer had already taken fresh — two owners, and the
 *      generation clobber returned (measured 4/5000 rounds).
 *
 * Each fix was locally correct and the next round found another hole, because
 * the shared file made rotation a distributed-consensus problem for a debug
 * log. Per-process files delete the problem instead of coordinating around it:
 * no lock, no lease, no reclaim, no fencing. Rotation is a single-writer
 * operation again, which is the only reason it can be simple.
 *
 * Cost: N files instead of one, bounded by `sweepStaleLogs` at startup. Worth
 * it — and interleaved output from four pollers was never readable anyway,
 * since you could not tell which process emitted a line.
 *
 * Callers MUST NOT point two loggers at one path. The module does not defend
 * against it; `logFileFor` exists so nobody has to hand-roll the name.
 */

import { mkdirSync, appendFileSync } from 'fs';
import { appendFile, mkdir, readdir, rename, stat, unlink } from 'fs/promises';
import { join } from 'path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function isLogLevel(value: unknown): value is LogLevel {
  // hasOwnProperty, not `in`: `in` walks the prototype chain, so 'toString',
  // 'constructor' and '__proto__' all passed. The resulting rank was a
  // function, every numeric comparison against it was false, and the gate
  // silently opened to debug instead of falling back to info.
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(LEVEL_RANK, value);
}

/** The per-process log file name. One writer per file is the core invariant. */
export function logFileFor(pid: number = process.pid): string {
  return `${pid}.log`;
}

export interface LoggerOptions {
  /** Directory holding the log file; created on demand. */
  dir: string;
  /** Absolute path of this process's log file. Must not be shared. */
  file: string;
  /** Minimum level written. Default 'info'. */
  level?: LogLevel;
  /** Rotate once the file would exceed this size. Default 10MB. */
  maxBytes?: number;
  /** Cap on lines queued behind the write chain. Default 1000. */
  maxPending?: number;
}

export interface Logger {
  log(level: LogLevel, message: string, data?: Record<string, unknown>): void;
  /** Blocking write. ONLY for exit handlers, where async writes never land. */
  logSync(level: LogLevel, message: string, data?: Record<string, unknown>): void;
  /** Resolves once every queued line has been written. */
  flush(): Promise<void>;
  /** Lines dropped because the write chain backed up. For tests/diagnostics. */
  droppedLines(): number;
  readonly level: LogLevel;
}

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_PENDING = 1000;

export function formatLine(
  level: LogLevel,
  message: string,
  data?: Record<string, unknown>,
  now: Date = new Date()
): string {
  const ts = now.toISOString();
  if (!data) return `${ts} [${level}] ${message}\n`;
  let encoded: string;
  try {
    encoded = JSON.stringify(data);
  } catch {
    // Circular/unserializable payload must never take the plugin down.
    encoded = '"[unserializable]"';
  }
  return `${ts} [${level}] ${message} ${encoded}\n`;
}

/** True when a pid belongs to a running process (EPERM still means alive). */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

export interface SweepOptions {
  dir: string;
  /** Delete logs untouched for longer than this. */
  maxAgeMs: number;
  /** Never delete this process's own files. */
  keepPid?: number;
  now?: number;
}

/**
 * Startup cleanup for per-process logs. Deletes only files older than the
 * retention window whose owning process is gone, so a quiet-but-live session's
 * log is never pulled out from under it. Best effort throughout: a log sweep
 * must never prevent the plugin from starting.
 *
 * Returns the files removed (for tests and diagnostics).
 */
export async function sweepStaleLogs(options: SweepOptions): Promise<string[]> {
  const { dir, maxAgeMs, keepPid = process.pid, now = Date.now() } = options;
  const removed: string[] = [];
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return removed; // No directory yet — nothing to sweep.
  }

  for (const entry of entries) {
    // Matches "<pid>.log" and its rotated "<pid>.log.1".
    const match = /^(\d+)\.log(\.1)?$/.exec(entry);
    if (!match) continue;

    const pid = Number(match[1]);
    if (pid === keepPid) continue;
    if (pidAlive(pid)) continue;

    const path = join(dir, entry);
    try {
      const info = await stat(path);
      if (now - info.mtimeMs <= maxAgeMs) continue;
      await unlink(path);
      removed.push(entry);
    } catch {
      // Vanished, unreadable, or raced with another sweep — all fine.
    }
  }
  return removed;
}

export function createLogger(options: LoggerOptions): Logger {
  const { dir, file } = options;
  // Validate rather than trust: an unrecognised level resolves to a non-numeric
  // rank, which makes every gate comparison false and opens the log to debug —
  // the opposite of a safe default. Callers outside TypeScript reach this too.
  const level = isLogLevel(options.level) ? options.level : 'info';
  const minRank = LEVEL_RANK[level];
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxPending = options.maxPending ?? DEFAULT_MAX_PENDING;

  /** Serializes writes so lines land in call order. */
  let chain: Promise<void> = Promise.resolve();
  let queued = 0;
  let dropped = 0;

  async function sizeOf(path: string): Promise<number> {
    try {
      return (await stat(path)).size;
    } catch {
      return 0; // Missing file — starting fresh.
    }
  }

  async function writeOne(line: string): Promise<void> {
    await mkdir(dir, { recursive: true });
    const size = Buffer.byteLength(line);

    // Sole writer, so stat→rename needs no coordination: nothing else can
    // rotate this file or append between the two calls. Size still comes from
    // the file rather than a counter, which keeps this correct across a
    // restart that inherits an existing file (and across pid reuse).
    if ((await sizeOf(file)) + size > maxBytes) {
      try {
        await rename(file, `${file}.1`);
      } catch {
        // Rotation is best-effort; a failed rename must never lose the line.
      }
    }

    await appendFile(file, line);
  }

  function enqueue(line: string): void {
    if (queued >= maxPending) {
      dropped += 1;
      return;
    }
    queued += 1;
    chain = chain.then(
      () =>
        writeOne(line)
          .catch(() => {
            // Unwritable log (permissions, disk full) must never surface.
            // Every write re-stats anyway, so there is no cached state to
            // invalidate — the next line simply retries against the real file.
          })
          .finally(() => {
            queued -= 1;
          }),
      () => {
        queued -= 1;
      }
    );
  }

  return {
    level,

    log(lineLevel, message, data) {
      if (LEVEL_RANK[lineLevel] < minRank) return;
      try {
        enqueue(formatLine(lineLevel, message, data));
      } catch {
        // Logging must never take down the plugin.
      }
    },

    logSync(lineLevel, message, data) {
      if (LEVEL_RANK[lineLevel] < minRank) return;
      try {
        mkdirSync(dir, { recursive: true });
        appendFileSync(file, formatLine(lineLevel, message, data));
      } catch {
        // Same contract as log(): best effort, never throws.
      }
    },

    async flush() {
      // Each awaited chain may have grown while we waited; settle repeatedly.
      while (queued > 0) {
        await chain;
      }
      await chain;
    },

    droppedLines() {
      return dropped;
    },
  };
}
