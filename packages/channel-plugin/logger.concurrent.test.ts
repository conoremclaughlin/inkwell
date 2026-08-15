/**
 * Concurrent-writer coverage.
 *
 * All four plugin processes append to one shared path, and the single-writer
 * suite could not see either failure this exercises. Both were found in review
 * (Lumen, PR #499), not by the tests, which is the coverage gap this file
 * closes:
 *
 *   P1-1  stat→rename was a cross-writer TOCTOU. A losing writer renamed a
 *         sibling's freshly recreated live file over a full `.1`, destroying a
 *         generation. `rename` overwrites on POSIX, so nothing threw.
 *   P1-2  the size check used a per-instance byte counter, which cannot see
 *         sibling appends, so the shared file grew to ~N x the cap.
 *
 * Two logger instances over one path are genuine writers here: the lock is a
 * filesystem primitive and the races live at `await` boundaries, which is
 * exactly where these interleave.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createLogger } from './logger';

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ink-plugin-conc-'));
  file = join(dir, 'channel-plugin.log');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function read(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf-8') : '';
}

/** Everything still on disk, oldest generation first. */
function surviving(): string {
  return `${read(`${file}.1`)}${read(file)}`;
}

describe('P1-1: rotation must not destroy a generation', () => {
  /**
   * Four writers x three lines is what actually opens the window, and it is
   * also the production shape (one plugin process per Claude Code session).
   *
   * Sizing matters more than it looks. With ONE line per writer this test
   * passed against the broken code: a writer's rename and its follow-up append
   * sit one await apart, so a sibling's rename almost always lands while the
   * live file is still missing and fails harmlessly with ENOENT. Only a writer
   * with more lines queued recreates the file early enough for a straggler's
   * rename to clobber a full `.1`. Measured against the pre-lock code:
   * 4x3 lost a generation in 100/120 rounds, 2x3 in 34/120, 2x1 in 0/120.
   */
  it('never loses the previous generation across 150 concurrent rotations', async () => {
    const WRITERS = 4;
    const LINES = 3;
    let losses = 0;

    for (let round = 0; round < 150; round += 1) {
      rmSync(file, { force: true });
      rmSync(`${file}.1`, { force: true });
      rmSync(`${file}.lock`, { force: true });
      // Seeded just under the cap so the first line of the round rotates.
      writeFileSync(file, `OLDGEN-${round}\n${'x'.repeat(900)}\n`, { flag: 'w' });

      const loggers = Array.from({ length: WRITERS }, () =>
        createLogger({ dir, file, maxBytes: 1000 })
      );

      await Promise.all(
        loggers.map(async (logger, n) => {
          for (let i = 0; i < LINES; i += 1) logger.log('info', `w${n}-r${round}-${i}`);
          await logger.flush();
        })
      );

      if (!surviving().includes(`OLDGEN-${round}`)) losses += 1;
    }

    expect(losses).toBe(0);
  });

  it('keeps both writers’ lines across a shared rotation', async () => {
    writeFileSync(file, `${'x'.repeat(950)}\n`, { flag: 'w' });
    const a = createLogger({ dir, file, maxBytes: 1000 });
    const b = createLogger({ dir, file, maxBytes: 1000 });

    await Promise.all([
      (async () => {
        for (let i = 0; i < 5; i += 1) a.log('info', `alpha-${i}`);
        await a.flush();
      })(),
      (async () => {
        for (let i = 0; i < 5; i += 1) b.log('info', `beta-${i}`);
        await b.flush();
      })(),
    ]);

    const all = surviving();
    for (let i = 0; i < 5; i += 1) {
      expect(all).toContain(`alpha-${i}`);
      expect(all).toContain(`beta-${i}`);
    }
  });
});

describe('P1-2: the cap must hold across writers, not per writer', () => {
  // Ran red before: .1 reached 1737-1852 bytes against a 1000-byte cap.
  it('caps the shared file with two writers hammering it', async () => {
    const maxBytes = 1000;
    const a = createLogger({ dir, file, maxBytes });
    const b = createLogger({ dir, file, maxBytes });

    await Promise.all([
      (async () => {
        for (let i = 0; i < 40; i += 1) a.log('info', `alpha-${i}-${'x'.repeat(20)}`);
        await a.flush();
      })(),
      (async () => {
        for (let i = 0; i < 40; i += 1) b.log('info', `beta-${i}-${'x'.repeat(20)}`);
        await b.flush();
      })(),
    ]);

    // Writers can each commit one in-flight line past the check, so the bound
    // is the cap plus one line per additional writer — not a multiple of it.
    const slack = 200;
    expect(statSync(file).size).toBeLessThanOrEqual(maxBytes + slack);
    if (existsSync(`${file}.1`)) {
      expect(statSync(`${file}.1`).size).toBeLessThanOrEqual(maxBytes + slack);
    }
  });

  it('a third writer does not multiply the bound', async () => {
    const maxBytes = 1000;
    const loggers = [0, 1, 2].map(() => createLogger({ dir, file, maxBytes }));

    await Promise.all(
      loggers.map(async (logger, n) => {
        for (let i = 0; i < 30; i += 1) logger.log('info', `w${n}-${i}-${'x'.repeat(20)}`);
        await logger.flush();
      })
    );

    const slack = 300; // One in-flight line per writer.
    expect(statSync(file).size).toBeLessThanOrEqual(maxBytes + slack);
    if (existsSync(`${file}.1`)) {
      expect(statSync(`${file}.1`).size).toBeLessThanOrEqual(maxBytes + slack);
    }
  });
});

describe('rotation lock hygiene', () => {
  it('leaves no lock file behind', async () => {
    writeFileSync(file, `${'x'.repeat(950)}\n`, { flag: 'w' });
    const a = createLogger({ dir, file, maxBytes: 1000 });
    const b = createLogger({ dir, file, maxBytes: 1000 });

    await Promise.all([
      (async () => {
        a.log('info', 'a');
        await a.flush();
      })(),
      (async () => {
        b.log('info', 'b');
        await b.flush();
      })(),
    ]);

    expect(existsSync(`${file}.lock`)).toBe(false);
  });

  it('reclaims a stale lock left by a dead process instead of never rotating', async () => {
    writeFileSync(file, `${'x'.repeat(1200)}\n`, { flag: 'w' });
    // A lock with an old mtime = a process that died mid-rotation.
    writeFileSync(`${file}.lock`, '99999:1');
    const old = Date.now() / 1000 - 60;
    const { utimesSync } = await import('fs');
    utimesSync(`${file}.lock`, old, old);

    const logger = createLogger({ dir, file, maxBytes: 1000 });
    logger.log('info', 'after-stale-lock');
    await logger.flush();

    expect(existsSync(`${file}.1`)).toBe(true);
    expect(read(file)).toContain('after-stale-lock');
    expect(existsSync(`${file}.lock`)).toBe(false);
  });

  it('a fresh lock blocks rotation but never blocks the write', async () => {
    writeFileSync(file, `${'x'.repeat(1200)}\n`, { flag: 'w' });
    writeFileSync(`${file}.lock`, '99999:1'); // Held right now by a sibling.

    const logger = createLogger({ dir, file, maxBytes: 1000 });
    logger.log('info', 'not-dropped');
    await logger.flush();

    // The sibling owns the rotation; our line still lands.
    expect(read(file)).toContain('not-dropped');
    expect(existsSync(`${file}.lock`)).toBe(true);
  });
});
