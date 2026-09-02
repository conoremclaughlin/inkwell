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

    const outcome = await watchTick({ markerPath: p, claim });

    expect(outcome).toBe('claimed');
    // The birth time is what the server CASes against the stop tombstone —
    // a claim without it would be unconditional.
    expect(claim).toHaveBeenCalledWith('s1', at);
    expect(existsSync(p)).toBe(false);
  });

  it("a 'stopped' verdict retires the marker without re-marking a dead turn", async () => {
    const p = write({ sessionId: 's1', at: new Date().toISOString() });
    const claim = vi.fn(async () => 'stopped' as const);

    const outcome = await watchTick({ markerPath: p, claim });

    expect(outcome).toBe('stopped');
    expect(existsSync(p)).toBe(false);
  });

  it('a failed claim leaves the marker for the next tick', async () => {
    const p = write({ sessionId: 's1', at: new Date().toISOString() });
    const claim = vi.fn(async () => 'failed' as const);

    const outcome = await watchTick({ markerPath: p, claim });

    expect(outcome).toBe('failed');
    expect(existsSync(p)).toBe(true);
  });

  it('no marker, or a malformed one, never claims', async () => {
    const claim = vi.fn(async () => 'ok' as const);
    expect(await watchTick({ markerPath: takeoverMarkerPath(dir), claim })).toBe('skipped');

    const p = takeoverMarkerPath(dir);
    writeFileSync(p, 'not json');
    expect(await watchTick({ markerPath: p, claim })).toBe('skipped');

    write({ at: new Date().toISOString() }); // no sessionId
    expect(await watchTick({ markerPath: p, claim })).toBe('skipped');

    write({ sessionId: 's1' }); // no timestamp — freshness unjudgeable
    expect(await watchTick({ markerPath: p, claim })).toBe('skipped');

    expect(claim).not.toHaveBeenCalled();
  });

  it('discards an AGED marker without claiming — its turn is long over', async () => {
    const now = Date.now();
    const p = write({
      sessionId: 's1',
      at: new Date(now - TAKEOVER_MARKER_MAX_AGE_MS - 60_000).toISOString(),
    });
    const claim = vi.fn(async () => 'ok' as const);

    const outcome = await watchTick({ markerPath: p, claim, now });

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
    const watcher = startTakeoverWatcher({ cwd: dir, claim, intervalMs: 1000 });

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
    const watcher = startTakeoverWatcher({ cwd: dir, claim, intervalMs: 1000 });

    await vi.advanceTimersByTimeAsync(1000);
    expect(claim).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(claim).toHaveBeenCalledTimes(2);
    watcher.stop();
  });
});

describe('wrapper wiring (reachability)', () => {
  it('the codex/gemini spawn path actually starts the watcher and stops it on child close', async () => {
    const { readFileSync } = await import('fs');
    const { dirname } = await import('path');
    const { fileURLToPath } = await import('url');
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'commands', 'claude.ts'),
      'utf-8'
    );
    const gate = source.indexOf("options.backend === 'codex' || options.backend === 'gemini'");
    const start = source.indexOf('startTakeoverWatcher({', gate);
    const stop = source.indexOf('takeoverWatcher?.stop()', start);
    expect(gate).toBeGreaterThan(-1);
    expect(start).toBeGreaterThan(gate);
    // The claim carries the marker birth time as reclaimOf — the tombstone CAS input.
    expect(source.indexOf('reclaimOf: markerAt', start)).toBeGreaterThan(start);
    expect(stop).toBeGreaterThan(start);
  });
});
