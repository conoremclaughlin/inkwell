import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  OBS_PROJECTION_TYPES,
  SessionLog,
  asyncJsonlFileSink,
  type SessionLogSink,
} from './session-log.js';

const readLines = (path: string): Array<Record<string, unknown>> =>
  readFileSync(path, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);

/** A sink whose writes settle only when the test says so. */
function controlledSink() {
  const calls: Array<{ line: string; resolve: () => void; reject: (e: unknown) => void }> = [];
  const sink: SessionLogSink = {
    write: (line) =>
      new Promise<void>((resolve, reject) => {
        calls.push({ line, resolve, reject });
      }),
  };
  return { sink, calls };
}

/** Let every already-settled promise continuation run. */
const drain = () => new Promise<void>((resolve) => setImmediate(resolve));

let dir: string;
const setup = () => {
  dir = mkdtempSync(join(tmpdir(), 'ink-session-log-test-'));
};
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('SessionLog — the ledger and its live mirror agree (spec:observer-attach §4.1)', () => {
  it('writes one JSONL line per append, numbering eids from 1', () => {
    setup();
    const path = join(dir, 'session.jsonl');
    const log = new SessionLog({ path });

    expect(log.append({ type: 'user', content: 'hi' })).toBe(1);
    expect(log.append({ type: 'backend_turn', success: true })).toBe(2);

    const lines = readLines(path);
    expect(lines.map((l) => [l.eid, l.type])).toEqual([
      [1, 'user'],
      [2, 'backend_turn'],
    ]);
    expect(typeof lines[0]!.ts).toBe('string');
    expect(lines[0]!.content).toBe('hi');
  });

  it('mirrors exactly the projection-type lines on disk, as the same entries, in order', () => {
    setup();
    const path = join(dir, 'session.jsonl');
    const observed: Array<Record<string, unknown>> = [];
    const log = new SessionLog({ path, onProjection: (entry) => observed.push(entry) });

    // Every projection type, with bookkeeping types interleaved between them.
    const bookkeeping = ['backend_turn', 'provider_sample', 'clone_start', 'context_evict'];
    [...OBS_PROJECTION_TYPES].forEach((type, i) => {
      log.append({ type, n: i });
      log.append({ type: bookkeeping[i % bookkeeping.length], n: i });
    });

    const projectedOnDisk = readLines(path).filter((l) =>
      OBS_PROJECTION_TYPES.has(l.type as string)
    );
    expect(projectedOnDisk).toHaveLength(OBS_PROJECTION_TYPES.size);
    // Replay and the live view are the same sequence, eid for eid.
    expect(observed).toEqual(projectedOnDisk);
  });

  it('a failed write throws to its caller and is never mirrored; the next append still writes', () => {
    setup();
    const written: string[] = [];
    let failNext = false;
    const sink: SessionLogSink = {
      write: (line) => {
        if (failNext) {
          failNext = false;
          throw new Error('disk full');
        }
        written.push(line);
      },
    };
    const observed: unknown[] = [];
    const log = new SessionLog({
      path: join(dir, 'unused.jsonl'),
      sink,
      onProjection: (e) => observed.push(e.eid),
    });

    log.append({ type: 'user', content: 'one' });
    failNext = true;
    expect(() => log.append({ type: 'assistant', content: 'lost' })).toThrow('disk full');
    // A synchronous failure is reported where it happened, as appendFileSync's
    // was, and does not poison the log.
    log.append({ type: 'assistant', content: 'three' });

    expect(observed).toEqual([1, 3]);
    expect(written.map((l) => JSON.parse(l).content)).toEqual(['one', 'three']);
  });

  it('an observer that throws never breaks the write path', () => {
    setup();
    const path = join(dir, 'session.jsonl');
    const log = new SessionLog({
      path,
      onProjection: () => {
        throw new Error('observer down');
      },
    });

    expect(() => log.append({ type: 'user', content: 'hi' })).not.toThrow();
    expect(readLines(path)).toHaveLength(1);
  });

  it('seed continues the sequence from an existing log and never lowers it', () => {
    setup();
    const log = new SessionLog({ path: join(dir, 'session.jsonl') });
    log.seed(41);
    log.seed(10);
    expect(log.append({ type: 'user' })).toBe(42);
  });

  it('a seed after the first append is refused: that append already took an eid the old log may hold', () => {
    setup();
    const path = join(dir, 'session.jsonl');
    const log = new SessionLog({ path });
    log.append({ type: 'user' });

    expect(() => log.seed(41)).toThrow('seeded after its first append');
    // Refused, not half-applied: the sequence carries on from the append.
    expect(log.append({ type: 'user' })).toBe(2);
  });
});

describe('SessionLog — two sessions in one process stay apart', () => {
  it("each observer sees only its own session's projection entries", () => {
    setup();
    const seenByA: Array<Record<string, unknown>> = [];
    const seenByB: Array<Record<string, unknown>> = [];
    const a = new SessionLog({
      path: join(dir, 'a.jsonl'),
      onProjection: (e) => seenByA.push(e),
    });
    const b = new SessionLog({
      path: join(dir, 'b.jsonl'),
      onProjection: (e) => seenByB.push(e),
    });

    a.append({ type: 'user', content: 'a1' });
    b.append({ type: 'user', content: 'b1' });
    a.append({ type: 'assistant', content: 'a2' });
    b.append({ type: 'assistant', content: 'b2' });

    expect(seenByA.map((e) => e.content)).toEqual(['a1', 'a2']);
    expect(seenByB.map((e) => e.content)).toEqual(['b1', 'b2']);
  });

  it("a log with no observer (a shadow clone's) never reaches another session's observer", () => {
    setup();
    const parentSeen: unknown[] = [];
    const parent = new SessionLog({
      path: join(dir, 'parent.jsonl'),
      onProjection: (e) => parentSeen.push(e.content),
    });
    const clone = new SessionLog({ path: join(dir, 'parent.c1.jsonl') });

    parent.append({ type: 'user', content: 'parent' });
    // Clones only write bookkeeping types today, which is all that kept them
    // out of the parent's stream under a process-wide emitter. Ownership has
    // to hold for a projection type too.
    clone.append({ type: 'assistant', content: 'clone' });
    clone.append({ type: 'clone_end', content: 'clone' });

    expect(parentSeen).toEqual(['parent']);
  });

  it('eid sequences are independent, and seeding one log leaves the other alone', () => {
    setup();
    const a = new SessionLog({ path: join(dir, 'a.jsonl') });
    const b = new SessionLog({ path: join(dir, 'b.jsonl') });

    expect(a.append({ type: 'user' })).toBe(1);
    // b reattaches while a is already writing.
    b.seed(100);
    expect(a.append({ type: 'user' })).toBe(2);
    expect(b.append({ type: 'user' })).toBe(101);
    expect(a.append({ type: 'user' })).toBe(3);
  });
});

describe('SessionLog — asynchronous sinks', () => {
  it('serializes writes: a slow write is never overtaken', async () => {
    const { sink, calls } = controlledSink();
    const log = new SessionLog({ path: 'unused', sink });

    log.append({ type: 'user', content: 'first' });
    log.append({ type: 'user', content: 'second' });
    log.append({ type: 'user', content: 'third' });
    await drain();
    // Only the first write has started; the rest wait behind it.
    expect(calls).toHaveLength(1);

    calls[0]!.resolve();
    await drain();
    expect(calls).toHaveLength(2);
    calls[1]!.resolve();
    await drain();
    calls[2]!.resolve();
    await log.flush();

    expect(calls.map((c) => JSON.parse(c.line).content)).toEqual(['first', 'second', 'third']);
  });

  it('mirrors a projection entry only after its own write lands', async () => {
    const { sink, calls } = controlledSink();
    const observed: unknown[] = [];
    const log = new SessionLog({ path: 'unused', sink, onProjection: (e) => observed.push(e.eid) });

    const eid = log.append({ type: 'assistant', content: 'pending' });
    expect(eid).toBe(1);
    await drain();
    expect(observed).toEqual([]);

    calls[0]!.resolve();
    await log.flush();
    expect(observed).toEqual([1]);
  });

  it('a failed write stops the log: later appends throw, flush rejects, queued entries are dropped', async () => {
    const { sink, calls } = controlledSink();
    const observed: unknown[] = [];
    const log = new SessionLog({ path: 'unused', sink, onProjection: (e) => observed.push(e.eid) });

    log.append({ type: 'user', content: 'fails' });
    log.append({ type: 'user', content: 'queued behind it' });
    calls[0]!.reject(new Error('disk full'));

    await expect(log.flush()).rejects.toThrow('disk full');
    // The queued entry was never handed to the sink, and nothing was mirrored.
    expect(calls).toHaveLength(1);
    expect(observed).toEqual([]);
    expect(() => log.append({ type: 'user', content: 'after' })).toThrow('disk full');
  });

  it('a failed write nobody flushes raises no unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const { sink, calls } = controlledSink();
      const log = new SessionLog({ path: 'unused', sink });
      log.append({ type: 'user', content: 'fails' });
      log.append({ type: 'user', content: 'queued behind it' });
      calls[0]!.reject(new Error('disk full'));
      // Unhandled rejections are reported after the microtask queue drains.
      await drain();
      await drain();
      expect(unhandled).toEqual([]);
      // The failure is still there for whoever asks.
      expect(() => log.append({ type: 'user' })).toThrow('disk full');
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('close drains queued writes, then refuses new ones, and leaves other logs open', async () => {
    const { sink, calls } = controlledSink();
    const log = new SessionLog({ path: 'closing', sink });
    const other = new SessionLog({ path: 'other', sink: { write: () => {} } });

    log.append({ type: 'user', content: 'first' });
    log.append({ type: 'user', content: 'second' });
    let closed = false;
    const closing = log.close().then(() => {
      closed = true;
    });

    // Appends are refused as soon as close is called, not once it resolves.
    expect(() => log.append({ type: 'user', content: 'late' })).toThrow('session log closed');
    calls[0]!.resolve();
    await drain();
    expect(closed).toBe(false);
    calls[1]!.resolve();
    await closing;

    // Both queued entries were written: their eids had already been handed out.
    expect(calls.map((c) => JSON.parse(c.line).content)).toEqual(['first', 'second']);
    expect(other.append({ type: 'user' })).toBe(1);
  });

  it('the async JSONL sink writes the same file the synchronous one does', async () => {
    setup();
    const syncPath = join(dir, 'sync.jsonl');
    const asyncPath = join(dir, 'async.jsonl');
    const syncLog = new SessionLog({ path: syncPath });
    const asyncLog = new SessionLog({ path: asyncPath, sink: asyncJsonlFileSink(asyncPath) });

    for (let i = 0; i < 200; i++) {
      const event = { type: i % 3 === 0 ? 'user' : 'backend_turn', n: i };
      syncLog.append(event);
      asyncLog.append(event);
    }
    await asyncLog.flush();

    const withoutTs = (path: string) =>
      readLines(path).map(({ ts: _ts, ...rest }) => rest as Record<string, unknown>);
    const asyncLines = withoutTs(asyncPath);
    expect(asyncLines).toEqual(withoutTs(syncPath));
    expect(asyncLines.map((l) => l.eid)).toEqual(Array.from({ length: 200 }, (_, i) => i + 1));
  });
});
