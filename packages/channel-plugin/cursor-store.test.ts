import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CursorStore, defaultCursorPath } from './cursor-store.js';

const MAX_SEEN_FOR_TEST = 5;
const DEBOUNCE_FOR_TEST = 20;
const STUDIO_ALPHA = 'studio-alpha';
const STUDIO_BETA = 'studio-beta';
const ENV_OVERRIDE_PATH = '/tmp/forced/path/to/cursors.json';
const KEY_THREAD_A = 'pr:101';
const KEY_THREAD_B = 'pr:202';
const TS_T1 = '2026-04-17T00:00:00.000Z';
const TS_T2 = '2026-04-17T00:01:00.000Z';
const ID_M1 = 'msg-id-1';
const ID_M2 = 'msg-id-2';
const VERSION_EXPECTED = 1;
const PREFIX_TMP_DIR = 'channel-cursor-test-';
const ENC_UTF8 = 'utf-8';
const FILENAME = 'cursors.json';
const FIX_CORRUPT = 'this is not valid json';
const ALPHA_FILE = 'channel-plugin-cursors-studio-alpha.json';
const DEFAULT_FILE = 'channel-plugin-cursors-default.json';
const INK_DIR = '.ink';
const PREFIX_ID = 'id-';
const PREFIX_OVERFLOW = 'overflow-';
const D_DEFAULT_CURSOR_PATH = 'defaultCursorPath';
const D_USES_STUDIO = 'uses studioId in the filename when provided';
const D_USES_DEFAULT = 'uses default slug when no studioId is provided';
const D_HONORS_OVERRIDE = 'honors envOverride above all else';
const D_PLACES_INK = 'places file inside ~/.ink by default';
const D_LOAD = 'CursorStore.load';
const D_TOLERATES_MISSING = 'tolerates a missing file (starts fresh)';
const D_TOLERATES_CORRUPT = 'tolerates a corrupt JSON file (starts fresh)';
const D_ROUNDTRIPS = 'round-trips: write then a fresh store loads the same state';
const D_FIFO = 'CursorStore.markSeen bounded FIFO';
const D_EVICTS = 'evicts oldest ids when maxSeenIds is reached';
const D_NO_DOUBLE = 'does not double-track or re-evict on duplicate markSeen';
const D_DEBOUNCED = 'CursorStore debounced writes';
const D_NOT_IMMEDIATE = 'does not write immediately on a single mutator';
const D_AFTER_DEBOUNCE = 'writes after debounce expires';
const D_FLUSH_FORCES = 'flush forces an immediate write';
const D_FLUSH_NOOP = 'flush with no pending changes is a no-op';
const D_SNAPSHOT = 'CursorStore snapshot shape';
const D_SNAP_VERSION = 'produces a snapshot with version and three keyed sections';
const D_PERSIST = 'CursorStore persisted file shape';
const D_VALID_JSON = 'writes valid JSON with the expected schema';
const D_TRIMS = 'trims seenIds to maxSeenIds on load';

function makeTmpDir(): string {
  const base = path.join(os.tmpdir(), PREFIX_TMP_DIR + Math.random().toString(36).slice(2));
  fs.mkdirSync(base, mkdirArgs());
  return base;
}

function mkdirArgs(): fs.MakeDirectoryOptions {
  const o = {} as fs.MakeDirectoryOptions;
  o.recursive = true;
  return o;
}

function rmArgs(): fs.RmOptions {
  const o = {} as fs.RmOptions;
  o.recursive = true;
  o.force = true;
  return o;
}

function targetPath(tmpDir: string): string {
  return path.join(tmpDir, FILENAME);
}

function newStore(tmpDir: string): CursorStore {
  const opts = {} as ConstructorParameters<typeof CursorStore>[0];
  opts.path = targetPath(tmpDir);
  opts.maxSeenIds = MAX_SEEN_FOR_TEST;
  opts.debounceMs = DEBOUNCE_FOR_TEST;
  return new CursorStore(opts);
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

type DefaultPathOpts = { studioId?: string; envOverride?: string };

function defaultPathOpts(studioId?: string, envOverride?: string): DefaultPathOpts {
  const o: DefaultPathOpts = {};
  if (studioId !== undefined) o.studioId = studioId;
  if (envOverride !== undefined) o.envOverride = envOverride;
  return o;
}

function makeRawSnap(seen: string[]): Record<string, unknown> {
  const snap = {} as Record<string, unknown>;
  snap.version = VERSION_EXPECTED;
  snap.seenMessageIds = seen;
  snap.lastThreadTimestamps = {};
  snap.lastThreadMessageIds = {};
  return snap;
}

describe(D_DEFAULT_CURSOR_PATH, () => {
  it(D_USES_STUDIO, () => {
    const out = defaultCursorPath(defaultPathOpts(STUDIO_ALPHA));
    expect(path.basename(out)).toBe(ALPHA_FILE);
  });

  it(D_USES_DEFAULT, () => {
    const out = defaultCursorPath(defaultPathOpts());
    expect(path.basename(out)).toBe(DEFAULT_FILE);
  });

  it(D_HONORS_OVERRIDE, () => {
    const out = defaultCursorPath(defaultPathOpts(STUDIO_BETA, ENV_OVERRIDE_PATH));
    expect(out).toBe(ENV_OVERRIDE_PATH);
  });

  it(D_PLACES_INK, () => {
    const out = defaultCursorPath(defaultPathOpts());
    const expectedDir = path.join(os.homedir(), INK_DIR);
    expect(path.dirname(out)).toBe(expectedDir);
  });
});

describe(D_LOAD, () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = makeTmpDir();
  });
  afterEach(() => {
    fs.rmSync(tmpDir, rmArgs());
  });

  it(D_TOLERATES_MISSING, async () => {
    const store = newStore(tmpDir);
    await store.load();
    expect(store.hasSeen(ID_M1)).toBe(false);
    expect(store.getThreadTimestamp(KEY_THREAD_A)).toBeUndefined();
    expect(store.getThreadMessageId(KEY_THREAD_A)).toBeUndefined();
    await store.close();
  });

  it(D_TOLERATES_CORRUPT, async () => {
    fs.writeFileSync(targetPath(tmpDir), FIX_CORRUPT);
    const store = newStore(tmpDir);
    await store.load();
    expect(store.hasSeen(ID_M1)).toBe(false);
    await store.close();
  });

  it(D_ROUNDTRIPS, async () => {
    const store1 = newStore(tmpDir);
    store1.markSeen(ID_M1);
    store1.setThreadTimestamp(KEY_THREAD_A, TS_T1);
    store1.setThreadMessageId(KEY_THREAD_A, ID_M1);
    await store1.flush();
    await store1.close();
    const store2 = newStore(tmpDir);
    await store2.load();
    expect(store2.hasSeen(ID_M1)).toBe(true);
    expect(store2.getThreadTimestamp(KEY_THREAD_A)).toBe(TS_T1);
    expect(store2.getThreadMessageId(KEY_THREAD_A)).toBe(ID_M1);
    await store2.close();
  });
});

describe(D_FIFO, () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = makeTmpDir();
  });
  afterEach(() => {
    fs.rmSync(tmpDir, rmArgs());
  });

  it(D_EVICTS, () => {
    const store = newStore(tmpDir);
    const ids: string[] = [];
    for (let i = 0; i < MAX_SEEN_FOR_TEST + 3; i++) ids.push(PREFIX_ID + i);
    for (const id of ids) store.markSeen(id);
    for (let i = 0; i < 3; i++) expect(store.hasSeen(ids[i])).toBe(false);
    for (let i = 3; i < ids.length; i++) expect(store.hasSeen(ids[i])).toBe(true);
  });

  it(D_NO_DOUBLE, () => {
    const store = newStore(tmpDir);
    store.markSeen(ID_M1);
    store.markSeen(ID_M1);
    store.markSeen(ID_M2);
    expect(store.hasSeen(ID_M1)).toBe(true);
    expect(store.hasSeen(ID_M2)).toBe(true);
  });
});

describe(D_DEBOUNCED, () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = makeTmpDir();
  });
  afterEach(() => {
    fs.rmSync(tmpDir, rmArgs());
  });

  it(D_NOT_IMMEDIATE, async () => {
    const store = newStore(tmpDir);
    store.markSeen(ID_M1);
    expect(fs.existsSync(targetPath(tmpDir))).toBe(false);
    await store.close();
  });

  it(D_AFTER_DEBOUNCE, async () => {
    const store = newStore(tmpDir);
    store.markSeen(ID_M1);
    await sleep(DEBOUNCE_FOR_TEST + 30);
    await store.flush();
    expect(fs.existsSync(targetPath(tmpDir))).toBe(true);
    await store.close();
  });

  it(D_FLUSH_FORCES, async () => {
    const store = newStore(tmpDir);
    store.markSeen(ID_M1);
    await store.flush();
    expect(fs.existsSync(targetPath(tmpDir))).toBe(true);
    await store.close();
  });

  it(D_FLUSH_NOOP, async () => {
    const store = newStore(tmpDir);
    await store.flush();
    expect(fs.existsSync(targetPath(tmpDir))).toBe(false);
    await store.close();
  });
});

describe(D_SNAPSHOT, () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = makeTmpDir();
  });
  afterEach(() => {
    fs.rmSync(tmpDir, rmArgs());
  });

  it(D_SNAP_VERSION, () => {
    const store = newStore(tmpDir);
    store.markSeen(ID_M1);
    store.setThreadTimestamp(KEY_THREAD_A, TS_T1);
    store.setThreadMessageId(KEY_THREAD_A, ID_M1);
    const snap = store.snapshot();
    expect(snap.version).toBe(VERSION_EXPECTED);
    expect(Array.isArray(snap.seenMessageIds)).toBe(true);
    expect(snap.seenMessageIds).toContain(ID_M1);
    expect(snap.lastThreadTimestamps[KEY_THREAD_A]).toBe(TS_T1);
    expect(snap.lastThreadMessageIds[KEY_THREAD_A]).toBe(ID_M1);
  });
});

describe(D_PERSIST, () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = makeTmpDir();
  });
  afterEach(() => {
    fs.rmSync(tmpDir, rmArgs());
  });

  it(D_VALID_JSON, async () => {
    const store = newStore(tmpDir);
    store.markSeen(ID_M1);
    store.markSeen(ID_M2);
    store.setThreadTimestamp(KEY_THREAD_A, TS_T2);
    store.setThreadMessageId(KEY_THREAD_B, ID_M2);
    await store.flush();
    const raw = fs.readFileSync(targetPath(tmpDir), ENC_UTF8);
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed.version).toBe(VERSION_EXPECTED);
    expect(parsed.seenMessageIds).toEqual([ID_M1, ID_M2]);
    const tsMap = parsed.lastThreadTimestamps as Record<string, string>;
    const idMap = parsed.lastThreadMessageIds as Record<string, string>;
    expect(tsMap[KEY_THREAD_A]).toBe(TS_T2);
    expect(idMap[KEY_THREAD_B]).toBe(ID_M2);
    await store.close();
  });

  it(D_TRIMS, async () => {
    const overflow: string[] = [];
    for (let i = 0; i < MAX_SEEN_FOR_TEST + 3; i++) overflow.push(PREFIX_OVERFLOW + i);
    const snap = makeRawSnap(overflow);
    fs.writeFileSync(targetPath(tmpDir), JSON.stringify(snap));
    const store = newStore(tmpDir);
    await store.load();
    for (let i = 0; i < 3; i++) expect(store.hasSeen(overflow[i])).toBe(false);
    for (let i = 3; i < overflow.length; i++) expect(store.hasSeen(overflow[i])).toBe(true);
    await store.close();
  });
});
