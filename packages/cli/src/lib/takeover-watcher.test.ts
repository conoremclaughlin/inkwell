/**
 * Pending-takeover watcher (PR #563 round 9): on codex/gemini the on-prompt
 * hook cannot block and no channel plugin runs, so the `ink` wrapper is the
 * marker's only consumer. What these pin: a fresh marker converts into a
 * claim carrying its birth time (the server's tombstone CAS input); 'ok' and
 * 'stopped' both retire the marker; 'failed' leaves it for the next tick; an
 * aged or unreadable marker never claims; the interval wrapper actually
 * ticks, and stop() ends the watcher's scope (no claim after the child
 * exits) and clears the marker.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  takeoverMarkerPath,
  watchTick,
  startTakeoverWatcher,
  TAKEOVER_MARKER_MAX_AGE_MS,
} from './takeover-watcher.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'takeover-watch-'));
  mkdirSync(join(dir, '.ink'), { recursive: true });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
});

const write = (marker: Record<string, unknown>) => {
  const p = takeoverMarkerPath(dir);
  writeFileSync(p, JSON.stringify(marker));
  return p;
};

describe('watchTick', () => {
  it('claims a fresh marker with its session and birth time, then retires it', async () => {
    const at = new Date().toISOString();
    const p = write({ sessionId: 's1', at });
    const claim = vi.fn(async () => 'ok' as const);

    const outcome = await watchTick({ markerPath: p, expectedSessionId: 's1', claim });

    expect(outcome).toBe('claimed');
    // The birth time is what the server CASes against the stop tombstone —
    // a claim without it would be unconditional.
    expect(claim).toHaveBeenCalledWith('s1', at);
    expect(existsSync(p)).toBe(false);
  });

  it("a 'stopped' verdict retires the marker without re-marking a dead turn", async () => {
    const p = write({ sessionId: 's1', at: new Date().toISOString() });
    const claim = vi.fn(async () => 'stopped' as const);

    const outcome = await watchTick({ markerPath: p, expectedSessionId: 's1', claim });

    expect(outcome).toBe('stopped');
    expect(existsSync(p)).toBe(false);
  });

  it('a failed claim leaves the marker for the next tick', async () => {
    const p = write({ sessionId: 's1', at: new Date().toISOString() });
    const claim = vi.fn(async () => 'failed' as const);

    const outcome = await watchTick({ markerPath: p, expectedSessionId: 's1', claim });

    expect(outcome).toBe('failed');
    expect(existsSync(p)).toBe(true);
  });

  it('no marker, or a malformed one, never claims', async () => {
    const claim = vi.fn(async () => 'ok' as const);
    expect(
      await watchTick({ markerPath: takeoverMarkerPath(dir), expectedSessionId: 's1', claim })
    ).toBe('skipped');

    const p = takeoverMarkerPath(dir);
    writeFileSync(p, 'not json');
    expect(await watchTick({ markerPath: p, expectedSessionId: 's1', claim })).toBe('skipped');

    write({ at: new Date().toISOString() }); // no sessionId
    expect(await watchTick({ markerPath: p, expectedSessionId: 's1', claim })).toBe('skipped');

    write({ sessionId: 's1' }); // no timestamp — freshness unjudgeable
    expect(await watchTick({ markerPath: p, expectedSessionId: 's1', claim })).toBe('skipped');

    expect(claim).not.toHaveBeenCalled();
  });

  it('discards an AGED marker without claiming — its turn is long over', async () => {
    const now = Date.now();
    const p = write({
      sessionId: 's1',
      at: new Date(now - TAKEOVER_MARKER_MAX_AGE_MS - 60_000).toISOString(),
    });
    const claim = vi.fn(async () => 'ok' as const);

    const outcome = await watchTick({ markerPath: p, expectedSessionId: 's1', claim, now });

    expect(outcome).toBe('skipped');
    expect(claim).not.toHaveBeenCalled();
    expect(existsSync(p)).toBe(false);
  });
});

describe('startTakeoverWatcher', () => {
  it('ticks on the interval, and stop() ends the scope and clears the marker', async () => {
    vi.useFakeTimers();
    const p = write({ sessionId: 's1', at: new Date().toISOString() });
    const claim = vi.fn(async () => 'failed' as const); // keep the marker so ticks repeat
    const watcher = startTakeoverWatcher({
      cwd: dir,
      expectedSessionId: 's1',
      claim,
      intervalMs: 1000,
    });

    await vi.advanceTimersByTimeAsync(1000);
    expect(claim).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(claim).toHaveBeenCalledTimes(2);

    // The child exited: nothing may claim after the session's process is
    // gone, and the marker (this generation's scope) goes with it.
    watcher.stop();
    expect(existsSync(p)).toBe(false);
    await vi.advanceTimersByTimeAsync(5000);
    expect(claim).toHaveBeenCalledTimes(2);
  });

  it('a tick that throws never takes the watcher down', async () => {
    vi.useFakeTimers();
    write({ sessionId: 's1', at: new Date().toISOString() });
    const claim = vi
      .fn<() => Promise<'ok' | 'stopped' | 'failed'>>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue('failed');
    const watcher = startTakeoverWatcher({
      cwd: dir,
      expectedSessionId: 's1',
      claim,
      intervalMs: 1000,
    });

    await vi.advanceTimersByTimeAsync(1000);
    expect(claim).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(claim).toHaveBeenCalledTimes(2);
    watcher.stop();
  });
});

describe('session scoping (round 10)', () => {
  it('never claims a FOREIGN marker, and leaves it for its owner', async () => {
    // A crashed predecessor's marker for a different session in this
    // checkout: claiming it would re-mark that session's dead turn as
    // running; deleting it would strand its rightful consumer.
    const p = write({ sessionId: 'someone-else', at: new Date().toISOString() });
    const claim = vi.fn(async () => 'ok' as const);

    const outcome = await watchTick({ markerPath: p, expectedSessionId: 's1', claim });

    expect(outcome).toBe('skipped');
    expect(claim).not.toHaveBeenCalled();
    expect(existsSync(p)).toBe(true);
  });

  it('stop() clears only the OWN session marker — a foreign marker survives scope end', () => {
    vi.useFakeTimers();
    const claim = vi.fn(async () => 'ok' as const);
    const watcher = startTakeoverWatcher({
      cwd: dir,
      expectedSessionId: 's1',
      claim,
      intervalMs: 1000,
    });
    const p = write({ sessionId: 'someone-else', at: new Date().toISOString() });

    watcher.stop();
    expect(existsSync(p)).toBe(true);
  });
});

describe('CLI turn-epoch record (round 10)', () => {
  it('round-trips a claimed epoch, and clears only for the owning session', async () => {
    const { writeCliTurnEpoch, readCliTurnEpoch, clearCliTurnEpoch, cliTurnEpochPath } =
      await import('./takeover-watcher.js');

    writeCliTurnEpoch(dir, { sessionId: 's1', turnEpoch: 'epoch-a' });
    expect(readCliTurnEpoch(dir)).toMatchObject({ sessionId: 's1', turnEpoch: 'epoch-a' });

    // A different session cannot clear s1's record — the stop that ends
    // s1's turn still needs it.
    clearCliTurnEpoch(dir, 's2');
    expect(existsSync(cliTurnEpochPath(dir))).toBe(true);

    clearCliTurnEpoch(dir, 's1');
    expect(existsSync(cliTurnEpochPath(dir))).toBe(false);
    expect(readCliTurnEpoch(dir)).toBeNull();
  });
});

describe('wrapper wiring (reachability)', () => {
  const loadClaudeSource = async () => {
    const { readFileSync } = await import('fs');
    const { dirname } = await import('path');
    const { fileURLToPath } = await import('url');
    return readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'commands', 'claude.ts'),
      'utf-8'
    );
  };

  it('the shared helper gates on codex/gemini, scopes to the OWN session, and reclaims with the marker birth time', async () => {
    const source = await loadClaudeSource();
    const helper = source.indexOf('function startSessionTakeoverWatcher(');
    const gate = source.indexOf(
      "if (backend !== 'codex' && backend !== 'gemini') return undefined;",
      helper
    );
    const scoped = source.indexOf('expectedSessionId: pcpSessionId', helper);
    const reclaim = source.indexOf('reclaimOf: markerAt', helper);
    const epoch = source.indexOf('writeCliTurnEpoch(', helper);
    expect(helper).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(helper);
    expect(scoped).toBeGreaterThan(helper);
    expect(reclaim).toBeGreaterThan(helper);
    // A successful reclaim records the claimed epoch for the stop boundary.
    expect(epoch).toBeGreaterThan(helper);
  });

  it('the ONE-SHOT spawn path starts the watcher and stops it on child close', async () => {
    const source = await loadClaudeSource();
    const fn = source.indexOf('export async function runClaude(');
    const next = source.indexOf('export async function runClaudeInteractive(');
    const start = source.indexOf('startSessionTakeoverWatcher(', fn);
    const stop = source.indexOf('takeoverWatcher?.stop()', start);
    expect(fn).toBeGreaterThan(-1);
    // Bound the search INSIDE runClaude — round 10 caught the previous pin
    // matching across function scope.
    expect(start).toBeGreaterThan(fn);
    expect(start).toBeLessThan(next);
    expect(stop).toBeGreaterThan(start);
    expect(stop).toBeLessThan(next);
  });

  it('the INTERACTIVE wrapper starts the watcher and stops it before exiting (round 10)', async () => {
    const source = await loadClaudeSource();
    const fn = source.indexOf('export async function runClaudeInteractive(');
    const start = source.indexOf('startSessionTakeoverWatcher(', fn);
    const stop = source.indexOf('interactiveTakeoverWatcher?.stop()', start);
    expect(fn).toBeGreaterThan(-1);
    expect(start).toBeGreaterThan(fn);
    expect(stop).toBeGreaterThan(start);
  });
});
