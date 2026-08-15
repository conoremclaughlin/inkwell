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
 *    `debug` and is what made the shared log grow ~35k lines/day across four
 *    plugins. Set `INK_PLUGIN_LOG_LEVEL=debug` to get it back.
 *
 * 3. **Size-capped.** Rotates to `<file>.1` past `maxBytes`, keeping one
 *    generation. Before this the file was uncapped (it reached 292MB).
 *
 * Multi-writer note: every plugin process appends to the same path, so this
 * deliberately holds NO long-lived file descriptor. `appendFile` resolves the
 * path on every write, which means a process whose file was rotated away by a
 * sibling immediately starts writing to the new file instead of pinning the
 * renamed inode forever. Rotation itself is still racy between processes; the
 * loser detects the smaller file and re-syncs rather than clobbering it.
 */

import { mkdirSync, appendFileSync } from 'fs';
import { appendFile, mkdir, open, readFile, rename, stat, unlink } from 'fs/promises';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function isLogLevel(value: unknown): value is LogLevel {
  // hasOwnProperty, not `in`: `in` walks the prototype chain, so 'toString',
  // 'constructor' and '__proto__' all passed. The resulting rank was a
  // function, every numeric comparison against it was false, and the gate
  // silently opened to debug instead of falling back to info.
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(LEVEL_RANK, value);
}

/** A rotation lock older than this is treated as abandoned by a dead process. */
const LOCK_STALE_MS = 10_000;

/** Disambiguates repeat acquisitions by the same pid. */
let lockSeq = 0;

export interface LoggerOptions {
  /** Directory holding the log file; created on demand. */
  dir: string;
  /** Absolute path of the active log file. */
  file: string;
  /** Minimum level written. Default 'info'. */
  level?: LogLevel;
  /** Rotate once the active file would exceed this size. Default 10MB. */
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

  const lockPath = `${file}.lock`;

  async function sizeOf(path: string): Promise<number> {
    try {
      return (await stat(path)).size;
    } catch {
      return 0; // Missing file — starting fresh.
    }
  }

  async function claimLock(token: string): Promise<boolean> {
    // 'wx' = O_CREAT|O_EXCL: atomic create-or-fail, the exclusion primitive.
    const handle = await open(lockPath, 'wx');
    try {
      await handle.writeFile(token);
    } finally {
      await handle.close();
    }
    return true;
  }

  /**
   * Cross-process rotation lock. Returns the token held, or null when another
   * writer holds it — in which case the caller skips rotating rather than
   * waiting; the sibling is already doing it.
   */
  async function acquireRotationLock(): Promise<string | null> {
    const token = `${process.pid}:${(lockSeq += 1)}`;
    try {
      await claimLock(token);
      return token;
    } catch {
      // Held. It may also be stale, left by a process that died mid-rotation.
      try {
        const info = await stat(lockPath);
        if (Date.now() - info.mtimeMs > LOCK_STALE_MS) {
          await unlink(lockPath);
          await claimLock(token);
          return token;
        }
      } catch {
        // Lost the reclaim race — someone else got there first.
      }
      return null;
    }
  }

  async function releaseRotationLock(token: string): Promise<void> {
    try {
      // Only remove OUR lock: if it was reclaimed as stale while we ran, the
      // file now belongs to another rotation and must not be unlinked.
      const held = await readFile(lockPath, 'utf-8');
      if (held !== token) return;
      await unlink(lockPath);
    } catch {
      // Already gone.
    }
  }

  /**
   * Rotate under cross-process exclusion.
   *
   * The stat and the rename MUST happen under the same lock. Unlocked, a
   * writer that decided to rotate can have its rename land after a sibling
   * already rotated and recreated the live file — renaming that fresh, nearly
   * empty file over a full `.1` and destroying an entire generation. `rename`
   * overwrites an existing target on POSIX, so nothing throws and no recovery
   * path runs. Measured at 265/500 races before this lock (Lumen, PR #499).
   */
  async function rotateUnderLock(pendingBytes: number): Promise<void> {
    const token = await acquireRotationLock();
    // A sibling holds it and is rotating now. Appending anyway overshoots the
    // cap by at most the lines in flight; the next write re-evaluates.
    if (!token) return;
    try {
      // Re-stat under the lock — the pre-lock reading is already stale.
      if ((await sizeOf(file)) + pendingBytes <= maxBytes) return;
      await rename(file, `${file}.1`);
    } catch {
      // Rotation is best-effort; a failed rename must never lose the line.
    } finally {
      await releaseRotationLock(token);
    }
  }

  async function writeOne(line: string): Promise<void> {
    await mkdir(dir, { recursive: true });
    const size = Buffer.byteLength(line);

    // Size comes from the file itself on every write, never from a running
    // per-instance counter. A counter only sees THIS process's bytes, so with
    // N plugin processes sharing the path the shared file reached ~N x the cap
    // before anyone rotated (Lumen, PR #499: .1 at 1852 bytes for a 1000 cap).
    if ((await sizeOf(file)) + size > maxBytes) {
      await rotateUnderLock(size);
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
