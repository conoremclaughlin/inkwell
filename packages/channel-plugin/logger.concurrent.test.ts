/**
 * Per-process isolation and startup sweep.
 *
 * This file used to test shared-file rotation under concurrent writers. That
 * design is gone: three P1 defects in review (Lumen, PR #499) — a stat→rename
 * TOCTOU, a per-instance byte counter blind to siblings, then a stale-lease
 * reclaim that let two writers both believe they held the lock — all traced to
 * putting rotation on a concurrent path for a debug log. Each patch was
 * locally correct and the next round found another hole.
 *
 * Now every process owns its file, so rotation is single-writer by
 * construction and there is no race left to test. What IS worth testing is the
 * invariant that replaced it: files are per-process, concurrent loggers never
 * touch each other's, and the directory stays bounded without a live session
 * ever losing its log.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  existsSync,
  writeFileSync,
  statSync,
  utimesSync,
  mkdirSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createLogger, logFileFor, sweepStaleLogs } from './logger';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ink-plugin-proc-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function read(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf-8') : '';
}

/** A pid that is certain not to be running. */
const DEAD_PID = 999999;

describe('per-process file naming', () => {
  it('derives the name from the pid', () => {
    expect(logFileFor(4242)).toBe('4242.log');
    expect(logFileFor()).toBe(`${process.pid}.log`);
  });
});

describe('isolation between concurrent processes', () => {
  it('four concurrent loggers never write into each other’s files', async () => {
    const WRITERS = 4;
    const LINES = 25;

    const loggers = Array.from({ length: WRITERS }, (_, n) => ({
      n,
      file: join(dir, logFileFor(1000 + n)),
      logger: createLogger({ dir, file: join(dir, logFileFor(1000 + n)), maxBytes: 100_000 }),
    }));

    await Promise.all(
      loggers.map(async ({ n, logger }) => {
        for (let i = 0; i < LINES; i += 1) logger.log('info', `w${n}-line-${i}`);
        await logger.flush();
      })
    );

    for (const { n, file } of loggers) {
      const contents = read(file);
      for (let i = 0; i < LINES; i += 1) expect(contents).toContain(`w${n}-line-${i}`);
      // Nothing from any sibling leaked in.
      for (const other of loggers) {
        if (other.n !== n) expect(contents).not.toContain(`w${other.n}-line-`);
      }
    }
  });

  it('one logger rotating does not disturb another mid-write', async () => {
    const rotating = join(dir, logFileFor(2001));
    const steady = join(dir, logFileFor(2002));
    // Seeded near its cap so it rotates almost immediately.
    writeFileSync(rotating, `OLDGEN\n${'x'.repeat(950)}\n`);

    const a = createLogger({ dir, file: rotating, maxBytes: 1000 });
    const b = createLogger({ dir, file: steady, maxBytes: 100_000 });

    await Promise.all([
      (async () => {
        for (let i = 0; i < 10; i += 1) a.log('info', `rot-${i}`);
        await a.flush();
      })(),
      (async () => {
        for (let i = 0; i < 10; i += 1) b.log('info', `steady-${i}`);
        await b.flush();
      })(),
    ]);

    // The rotating writer's old generation survives as its own .1 ...
    expect(read(`${rotating}.1`)).toContain('OLDGEN');
    // ... and the steady writer is untouched by any of it.
    const steadyContents = read(steady);
    for (let i = 0; i < 10; i += 1) expect(steadyContents).toContain(`steady-${i}`);
    expect(existsSync(`${steady}.1`)).toBe(false);
    expect(steadyContents).not.toContain('rot-');
  });

  it('each file is capped independently — no shared-counter blind spot', async () => {
    const maxBytes = 1000;
    const files = [3001, 3002, 3003].map((pid) => join(dir, logFileFor(pid)));
    const loggers = files.map((file) => createLogger({ dir, file, maxBytes }));

    await Promise.all(
      loggers.map(async (logger, n) => {
        for (let i = 0; i < 40; i += 1) logger.log('info', `w${n}-${i}-${'x'.repeat(20)}`);
        await logger.flush();
      })
    );

    // Sole writer per file, so the cap is exact — no in-flight slack needed.
    for (const file of files) {
      expect(statSync(file).size).toBeLessThanOrEqual(maxBytes);
      if (existsSync(`${file}.1`)) {
        expect(statSync(`${file}.1`).size).toBeLessThanOrEqual(maxBytes);
      }
    }
  });
});

describe('startup sweep', () => {
  function seed(name: string, ageMs: number) {
    const path = join(dir, name);
    writeFileSync(path, 'old content');
    const when = (Date.now() - ageMs) / 1000;
    utimesSync(path, when, when);
    return path;
  }

  const WEEK = 7 * 24 * 60 * 60 * 1000;

  it('removes dead processes’ logs past the retention window', async () => {
    seed(`${DEAD_PID}.log`, WEEK * 2);
    seed(`${DEAD_PID}.log.1`, WEEK * 2);

    const removed = await sweepStaleLogs({ dir, maxAgeMs: WEEK });
    expect(removed.sort()).toEqual([`${DEAD_PID}.log`, `${DEAD_PID}.log.1`]);
    expect(existsSync(join(dir, `${DEAD_PID}.log`))).toBe(false);
  });

  it('keeps recent logs even from dead processes', async () => {
    const path = seed(`${DEAD_PID}.log`, 60 * 60 * 1000); // 1 hour old
    const removed = await sweepStaleLogs({ dir, maxAgeMs: WEEK });
    expect(removed).toEqual([]);
    expect(existsSync(path)).toBe(true);
  });

  it('never deletes a LIVE process’s log, however old it looks', async () => {
    // A long, quiet session: old mtime, but the process is very much alive.
    // Deleting this would silently redirect that session's log to a dead inode.
    const path = seed(`${process.pid}.log`, WEEK * 10);
    const removed = await sweepStaleLogs({ dir, maxAgeMs: WEEK, keepPid: 0 });
    expect(removed).toEqual([]);
    expect(existsSync(path)).toBe(true);
  });

  it('never deletes our own log even if the pid check is bypassed', async () => {
    const path = seed(`${process.pid}.log`, WEEK * 10);
    const removed = await sweepStaleLogs({ dir, maxAgeMs: WEEK, keepPid: process.pid });
    expect(removed).toEqual([]);
    expect(existsSync(path)).toBe(true);
  });

  it('ignores files that are not per-process logs', async () => {
    seed('channel-plugin.log', WEEK * 2); // The old shared file.
    seed('notes.txt', WEEK * 2);
    const removed = await sweepStaleLogs({ dir, maxAgeMs: WEEK });
    expect(removed).toEqual([]);
    expect(existsSync(join(dir, 'channel-plugin.log'))).toBe(true);
  });

  it('is a no-op on a missing directory and never throws', async () => {
    await expect(sweepStaleLogs({ dir: join(dir, 'nope'), maxAgeMs: WEEK })).resolves.toEqual([]);
  });

  it('tolerates a concurrent sweep removing the same files', async () => {
    for (let i = 0; i < 5; i += 1) seed(`${DEAD_PID + i}.log`, WEEK * 2);
    const [a, b] = await Promise.all([
      sweepStaleLogs({ dir, maxAgeMs: WEEK }),
      sweepStaleLogs({ dir, maxAgeMs: WEEK }),
    ]);

    // The contract is that neither call throws and every stale file is gone.
    // Which sweep reports which file is not a contract — concurrent unlinks of
    // the same path can both be reported depending on scheduling, and that is
    // harmless for a cleanup pass. Asserting the split would pin scheduling.
    const expected = Array.from({ length: 5 }, (_, i) => `${DEAD_PID + i}.log`);
    expect([...new Set([...a, ...b])].sort()).toEqual(expected.sort());
    for (const name of expected) expect(existsSync(join(dir, name))).toBe(false);
  });

  it('sweeps a nested directory created on demand', async () => {
    const nested = join(dir, 'channel-plugin');
    mkdirSync(nested);
    const path = join(nested, `${DEAD_PID}.log`);
    writeFileSync(path, 'x');
    const when = (Date.now() - WEEK * 2) / 1000;
    utimesSync(path, when, when);

    await sweepStaleLogs({ dir: nested, maxAgeMs: WEEK });
    expect(existsSync(path)).toBe(false);
  });
});
