import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

const STORE_VERSION = 1;
const DEFAULT_MAX_SEEN_IDS = 1000;
const DEFAULT_DEBOUNCE_MS = 500;

const LEVEL_INFO = 'info';
const LEVEL_WARN = 'warn';
const LEVEL_DEBUG = 'debug';

type LogLevel = typeof LEVEL_INFO | typeof LEVEL_WARN | 'error' | typeof LEVEL_DEBUG;
type LogData = Record<string, unknown>;
type LogFn = (level: LogLevel, message: string, data?: LogData) => void;

export interface CursorSnapshot {
  version: number;
  seenMessageIds: string[];
  lastThreadTimestamps: Record<string, string>;
  lastThreadMessageIds: Record<string, string>;
}

export interface CursorStoreOptions {
  path: string;
  maxSeenIds?: number;
  debounceMs?: number;
  log?: LogFn;
}

export interface DefaultPathOptions {
  studioId?: string;
  envOverride?: string;
}

const DEFAULT_SLUG = 'default';
const FILENAME_PREFIX = 'channel-plugin-cursors-';
const FILENAME_SUFFIX = '.json';
const INK_DIR = '.ink';
const ENOENT = 'ENOENT';
const STR_OBJECT = 'object';
const STR_STRING = 'string';
const ENC_UTF8 = 'utf-8';
const ENC_HEX = 'hex';

const MSG_NOT_FOUND = 'Cursor file not found, starting fresh';
const MSG_READ_FAIL = 'Cursor file read failed, starting fresh';
const MSG_CORRUPT = 'Cursor file corrupt, starting fresh';
const MSG_LOADED = 'Cursor state loaded';
const MSG_MKDIR_FAIL = 'Failed to create cursor dir';
const MSG_WRITE_FAIL = 'Failed to persist cursor state';

export function defaultCursorPath(opts: DefaultPathOptions = {}): string {
  if (opts.envOverride && opts.envOverride.length > 0) return opts.envOverride;
  const slug = opts.studioId && opts.studioId.length > 0 ? opts.studioId : DEFAULT_SLUG;
  const filename = FILENAME_PREFIX + slug + FILENAME_SUFFIX;
  return path.join(os.homedir(), INK_DIR, filename);
}

export class CursorStore {
  private readonly path: string;
  private readonly maxSeenIds: number;
  private readonly debounceMs: number;
  private readonly log: LogFn;

  private readonly seenSet = new Set<string>();
  private readonly seenOrder: string[] = [];

  private readonly lastThreadTimestamps = new Map<string, string>();
  private readonly lastThreadMessageIds = new Map<string, string>();

  private writeTimer: NodeJS.Timeout | null = null;
  private writeChain: Promise<void> = Promise.resolve();
  private dirty = false;
  private closed = false;

  constructor(opts: CursorStoreOptions) {
    this.path = opts.path;
    this.maxSeenIds = opts.maxSeenIds ?? DEFAULT_MAX_SEEN_IDS;
    this.debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.log = opts.log ?? (() => undefined);
  }

  async load(): Promise<void> {
    let raw: string;
    try {
      raw = await fs.promises.readFile(this.path, ENC_UTF8);
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === ENOENT) {
        this.logEvent(LEVEL_DEBUG, MSG_NOT_FOUND, this.pathOnly());
        return;
      }
      this.logEvent(LEVEL_WARN, MSG_READ_FAIL, this.pathWithError(err));
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      this.logEvent(LEVEL_WARN, MSG_CORRUPT, this.pathWithError(err));
      return;
    }

    const snap = parsed as Partial<CursorSnapshot>;
    if (!snap || typeof snap !== STR_OBJECT) return;

    this.loadSeenIds(snap);
    this.loadThreadMap(snap.lastThreadTimestamps, this.lastThreadTimestamps);
    this.loadThreadMap(snap.lastThreadMessageIds, this.lastThreadMessageIds);

    this.logEvent(LEVEL_INFO, MSG_LOADED, this.loadedStats());
  }

  private loadSeenIds(snap: Partial<CursorSnapshot>): void {
    if (!Array.isArray(snap.seenMessageIds)) return;
    const ids = snap.seenMessageIds.filter(isString);
    const start = Math.max(0, ids.length - this.maxSeenIds);
    for (let i = start; i < ids.length; i++) {
      const id = ids[i];
      if (!this.seenSet.has(id)) {
        this.seenSet.add(id);
        this.seenOrder.push(id);
      }
    }
  }

  private loadThreadMap(src: Record<string, string> | undefined, dest: Map<string, string>): void {
    if (!src || typeof src !== STR_OBJECT) return;
    for (const [k, v] of Object.entries(src)) {
      if (typeof v === STR_STRING) dest.set(k, v);
    }
  }

  hasSeen(id: string): boolean {
    return this.seenSet.has(id);
  }

  getThreadTimestamp(threadKey: string): string | undefined {
    return this.lastThreadTimestamps.get(threadKey);
  }

  getThreadMessageId(threadKey: string): string | undefined {
    return this.lastThreadMessageIds.get(threadKey);
  }

  markSeen(id: string): void {
    if (this.seenSet.has(id)) return;
    this.seenSet.add(id);
    this.seenOrder.push(id);
    while (this.seenOrder.length > this.maxSeenIds) {
      const evicted = this.seenOrder.shift();
      if (evicted !== undefined) this.seenSet.delete(evicted);
    }
    this.markDirty();
  }

  setThreadTimestamp(threadKey: string, ts: string): void {
    if (this.lastThreadTimestamps.get(threadKey) === ts) return;
    this.lastThreadTimestamps.set(threadKey, ts);
    this.markDirty();
  }

  setThreadMessageId(threadKey: string, id: string): void {
    if (this.lastThreadMessageIds.get(threadKey) === id) return;
    this.lastThreadMessageIds.set(threadKey, id);
    this.markDirty();
  }

  private markDirty(): void {
    if (this.closed) return;
    this.dirty = true;
    if (this.writeTimer) clearTimeout(this.writeTimer);
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      void this.flush();
    }, this.debounceMs);
    if (this.writeTimer && typeof this.writeTimer.unref === STR_STRING) {
      this.writeTimer.unref();
    }
  }

  async flush(): Promise<void> {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    if (!this.dirty) {
      await this.writeChain;
      return;
    }
    this.dirty = false;
    const snapshot = this.snapshot();
    const next = this.writeChain.then(() => this.writeSnapshot(snapshot));
    this.writeChain = next.catch(() => undefined);
    await next;
  }

  async close(): Promise<void> {
    await this.flush();
    this.closed = true;
  }

  snapshot(): CursorSnapshot {
    return {
      version: STORE_VERSION,
      seenMessageIds: [...this.seenOrder],
      lastThreadTimestamps: Object.fromEntries(this.lastThreadTimestamps),
      lastThreadMessageIds: Object.fromEntries(this.lastThreadMessageIds),
    };
  }

  private async writeSnapshot(snap: CursorSnapshot): Promise<void> {
    const dir = path.dirname(this.path);
    try {
      await fs.promises.mkdir(dir, mkdirOpts());
    } catch (err) {
      this.logEvent(LEVEL_WARN, MSG_MKDIR_FAIL, this.dirWithError(dir, err));
      return;
    }

    const suffix = crypto.randomBytes(6).toString(ENC_HEX);
    const pid = process.pid;
    const tmp = this.path + '.' + pid + '.' + suffix + '.tmp';
    try {
      await fs.promises.writeFile(tmp, JSON.stringify(snap), ENC_UTF8);
      await fs.promises.rename(tmp, this.path);
    } catch (err) {
      this.logEvent(LEVEL_WARN, MSG_WRITE_FAIL, this.pathWithError(err));
      try {
        await fs.promises.unlink(tmp);
      } catch {
        // ignore
      }
    }
  }

  private logEvent(level: LogLevel, message: string, data: LogData): void {
    this.log(level, message, data);
  }

  private pathOnly(): LogData {
    const out: LogData = {};
    out.path = this.path;
    return out;
  }

  private pathWithError(err: unknown): LogData {
    const out: LogData = {};
    out.path = this.path;
    out.error = errorMessage(err);
    return out;
  }

  private dirWithError(dir: string, err: unknown): LogData {
    const out: LogData = {};
    out.dir = dir;
    out.error = errorMessage(err);
    return out;
  }

  private loadedStats(): LogData {
    const out: LogData = {};
    out.path = this.path;
    out.seenIds = this.seenOrder.length;
    out.threadTimestamps = this.lastThreadTimestamps.size;
    out.threadMessageIds = this.lastThreadMessageIds.size;
    return out;
  }
}

function isString(s: unknown): s is string {
  return typeof s === STR_STRING;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function mkdirOpts(): fs.MakeDirectoryOptions {
  const opts: fs.MakeDirectoryOptions = {} as fs.MakeDirectoryOptions;
  opts.recursive = true;
  return opts;
}
