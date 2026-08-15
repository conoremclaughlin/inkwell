/**
 * Ownership safety for the host-global agy MCP config lock.
 *
 * Three hand-rolled versions of this were wrong in the same way: POSIX has no
 * atomic compare-and-delete, so "check who owns the lock, then remove it" always
 * leaves a window. The last attempt made the stale break a `rename` — atomic as
 * an operation, but it does not compare the owner, so a waiter that had already
 * judged lock A stale could resume after A was released and move B's fresh lock
 * instead. Lumen reproduced that schedule mechanically.
 *
 * These tests assert the properties that must hold regardless of implementation:
 * mutual exclusion under real concurrency, a genuinely abandoned lock still
 * being recoverable, and — the one that replaces "prevent theft", which is not
 * achievable here — a robbed owner failing closed instead of reporting a write
 * it cannot vouch for.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, existsSync, utimesSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { withFileLock, LockCompromisedError } from './antigravity-runner.js';

let dir: string;
let target: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agy-lock-'));
  target = join(dir, 'mcp_config.json');
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('mutual exclusion', () => {
  it('never admits two writers to the critical section at once', async () => {
    // The failure this replaces put two writers inside simultaneously, so the
    // assertion is on overlap, not on ordering.
    let inside = 0;
    let maxInside = 0;
    let entries = 0;

    await Promise.all(
      Array.from({ length: 8 }, () =>
        withFileLock(target, async () => {
          inside += 1;
          entries += 1;
          maxInside = Math.max(maxInside, inside);
          // Yield so a broken implementation has a real chance to interleave.
          await new Promise((resolve) => setTimeout(resolve, 15));
          inside -= 1;
        })
      )
    );

    expect(maxInside).toBe(1);
    expect(entries).toBe(8);
  }, 30_000);

  it('releases the lock when the critical section throws', async () => {
    await expect(withFileLock(target, () => Promise.reject(new Error('boom')))).rejects.toThrow(
      'boom'
    );

    // If release leaked, this would block until the retry budget ran out.
    let ran = false;
    await withFileLock(target, async () => {
      ran = true;
      await Promise.resolve();
    });
    expect(ran).toBe(true);
  }, 20_000);
});

describe('stale handoff', () => {
  it('recovers a lock abandoned by a dead process', async () => {
    // A crash must not disable MCP for this backend permanently.
    const lockDir = `${target}.lock`;
    mkdirSync(lockDir, { recursive: true });
    const longAgo = new Date(Date.now() - 10 * 60 * 1000);
    utimesSync(lockDir, longAgo, longAgo);

    let ran = false;
    await withFileLock(target, async () => {
      ran = true;
      await Promise.resolve();
    });

    expect(ran).toBe(true);
  }, 20_000);

  it('does not treat a live owner as stale', async () => {
    // The owner refreshes the lock's mtime while it holds it, which is what
    // makes "stale" mean dead rather than merely slow. A long critical section
    // must not be stolen out from under itself.
    let stolenFrom = false;
    await withFileLock(target, async () => {
      // Comfortably longer than a single refresh interval.
      await new Promise((resolve) => setTimeout(resolve, 1200));
      stolenFrom = !existsSync(`${target}.lock`);
    });

    expect(stolenFrom).toBe(false);
  }, 20_000);
});

describe('theft is detected, not claimed as success', () => {
  it('throws LockCompromisedError when the lock is removed mid-write', async () => {
    // Theft cannot be prevented on POSIX — there is no atomic
    // compare-and-delete. The contract is that the robbed writer refuses to
    // report success, so ensureGlobalMcpConfig fails closed rather than
    // letting agy start against a config it cannot vouch for.
    let sawCriticalSection = false;

    await expect(
      withFileLock(target, async () => {
        sawCriticalSection = true;
        rmSync(`${target}.lock`, { recursive: true, force: true });
        // Long enough for at least two refresh ticks to find it gone.
        await new Promise((resolve) => setTimeout(resolve, 2600));
      })
    ).rejects.toBeInstanceOf(LockCompromisedError);

    expect(sawCriticalSection).toBe(true);
  }, 20_000);
});
