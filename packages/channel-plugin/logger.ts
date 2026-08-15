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
import { appendFile, mkdir, rename, stat } from 'fs/promises';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && value in LEVEL_RANK;
}

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
  const level = options.level ?? 'info';
  const minRank = LEVEL_RANK[level];
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxPending = options.maxPending ?? DEFAULT_MAX_PENDING;

  /** Serializes writes so lines land in call order. */
  let chain: Promise<void> = Promise.resolve();
  let queued = 0;
  let dropped = 0;
  /** Running size of the active file; null means "re-stat before writing". */
  let approxBytes: number | null = null;

  async function sizeOf(path: string): Promise<number> {
    try {
      return (await stat(path)).size;
    } catch {
      return 0; // Missing file — starting fresh.
    }
  }

  /**
   * Called when the pending line would push the file past the cap. Confirms
   * against the real file first: if it is much smaller than the cap, a sibling
   * process already rotated and we only need to re-sync our counter.
   */
  async function rotateIfStillOversized(): Promise<void> {
    const actual = await sizeOf(file);
    if (actual < maxBytes / 2) {
      approxBytes = actual; // Someone else rotated — adopt the new file.
      return;
    }
    try {
      await rename(file, `${file}.1`);
      approxBytes = 0;
    } catch {
      // Lost the rename race (or the file vanished) — re-sync and carry on.
      approxBytes = await sizeOf(file);
    }
  }

  async function writeOne(line: string): Promise<void> {
    await mkdir(dir, { recursive: true });
    if (approxBytes === null) approxBytes = await sizeOf(file);

    const size = Buffer.byteLength(line);
    if (approxBytes + size > maxBytes) await rotateIfStillOversized();

    await appendFile(file, line);
    approxBytes += size;
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
            // Force a re-stat next time in case the situation changed.
            approxBytes = null;
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
