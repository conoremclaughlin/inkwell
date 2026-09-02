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
  it('ticks IMMEDIATELY, then on the interval; stop() ends the scope and clears the marker', async () => {
    vi.useFakeTimers();
    const p = write({ sessionId: 's1', at: new Date().toISOString() });
    const claim = vi.fn(async () => 'failed' as const); // keep the marker so ticks repeat
    const watcher = startTakeoverWatcher({
      cwd: dir,
      expectedSessionId: 's1',
      claim,
      intervalMs: 1000,
    });

    // Round 16: the first tick runs at START — a short one-shot backend can
    // finish inside the first interval, and its scope-end stop() would have
    // cleared the marker before any claim ever ran.
    await vi.advanceTimersByTimeAsync(0);
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

    await vi.advanceTimersByTimeAsync(0); // immediate tick throws
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

describe('epoch record failure is reported (round 11)', () => {
  it('returns false when the record cannot be written — the caller must know', async () => {
    const { writeCliTurnEpoch } = await import('./takeover-watcher.js');
    // `.ink` exists as a FILE, so mkdir/write must fail — the ENOSPC/
    // permission class, reproduced portably.
    const broken = mkdtempSync(join(tmpdir(), 'takeover-broken-'));
    rmSync(join(broken, '.ink'), { recursive: true, force: true });
    writeFileSync(join(broken, '.ink'), 'not a directory');

    expect(writeCliTurnEpoch(broken, { sessionId: 's1', turnEpoch: 'e' })).toBe(false);
    expect(writeCliTurnEpoch(dir, { sessionId: 's1', turnEpoch: 'e' })).toBe(true);
    rmSync(broken, { recursive: true, force: true });
  });
});

describe('reclaim wiring round 11 (reachability)', () => {
  it('the wrapper claim carries the studio and refuses an unheld lease report', async () => {
    const { readFileSync } = await import('fs');
    const { dirname } = await import('path');
    const { fileURLToPath } = await import('url');
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'commands', 'claude.ts'),
      'utf-8'
    );
    const helper = source.indexOf('function startSessionTakeoverWatcher(');
    const studio = source.indexOf(
      "...(studioId && studioId !== 'main' ? { studioId } : {})",
      helper
    );
    const unheld = source.indexOf(
      "if (body?.studioLeaseHeld === false) return 'unprotected';",
      helper
    );
    expect(helper).toBeGreaterThan(-1);
    expect(studio).toBeGreaterThan(helper);
    // Round 15: NOT HELD is a PERMANENT refusal — it surfaces as
    // 'unprotected', which retires the marker and triggers enforcement.
    expect(unheld).toBeGreaterThan(helper);
  });

  it('a cross-tenant 403 maps to unprotected, and enforcement carries a non-zero exit (round 16)', async () => {
    const { readFileSync } = await import('fs');
    const { dirname } = await import('path');
    const { fileURLToPath } = await import('url');
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'commands', 'claude.ts'),
      'utf-8'
    );
    const helper = source.indexOf('function startSessionTakeoverWatcher(');
    expect(
      source.indexOf("if (resp.status === 403) return 'unprotected';", helper)
    ).toBeGreaterThan(helper);

    // Enforcement must not exit 0 (SIGTERM closes with code=null) nor retry.
    const oneShot = source.indexOf('export async function runClaude(');
    const interactive = source.indexOf('export async function runClaudeInteractive(');
    const oneShotExit = source.indexOf('if (takeoverEnforced) process.exit(1);', oneShot);
    expect(oneShotExit).toBeGreaterThan(oneShot);
    expect(oneShotExit).toBeLessThan(interactive);
    const interactiveGuard = source.indexOf('if (interactiveEnforced) {', interactive);
    const interactiveExit = source.indexOf('process.exit(1);', interactiveGuard);
    const retryBranch = source.indexOf('const shouldRetry =', interactive);
    expect(interactiveGuard).toBeGreaterThan(interactive);
    expect(interactiveExit).toBeGreaterThan(interactiveGuard);
    // The enforcement check precedes the retry decision — no fresh-session retry.
    expect(interactiveGuard).toBeLessThan(retryBranch);
  });

  it('a permanent refusal terminates the backend at BOTH spawn sites (round 15)', async () => {
    const { readFileSync } = await import('fs');
    const { dirname } = await import('path');
    const { fileURLToPath } = await import('url');
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'commands', 'claude.ts'),
      'utf-8'
    );
    const helper = source.indexOf('function startSessionTakeoverWatcher(');
    const forward = source.indexOf('onUnprotected,', helper);
    expect(forward).toBeGreaterThan(helper);

    const oneShot = source.indexOf('export async function runClaude(');
    const oneShotKill = source.indexOf('takeoverChild?.kill', oneShot);
    const interactive = source.indexOf('export async function runClaudeInteractive(');
    const interactiveKill = source.indexOf('interactiveChild?.kill', interactive);
    expect(oneShotKill).toBeGreaterThan(oneShot);
    expect(oneShotKill).toBeLessThan(interactive);
    expect(interactiveKill).toBeGreaterThan(interactive);
  });
});

describe('scope-end wiring (round 17, reachability)', () => {
  it('the wrapper finalizes scope with a fenced stop (or tombstone) and AWAITS stop() everywhere', async () => {
    const { readFileSync } = await import('fs');
    const { dirname } = await import('path');
    const { fileURLToPath } = await import('url');
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'commands', 'claude.ts'),
      'utf-8'
    );
    const helper = source.indexOf('function startSessionTakeoverWatcher(');
    const finalize = source.indexOf('finalizeScope: async (turnEpoch) => {', helper);
    const fenced = source.indexOf(
      '...(turnEpoch ? { turnEpoch } : { turnEpochMissing: true })',
      finalize
    );
    expect(finalize).toBeGreaterThan(helper);
    expect(fenced).toBeGreaterThan(finalize);
    // Every stop is awaited — the boundary is real, not fire-and-forget.
    expect(source.indexOf('await takeoverWatcher?.stop()')).toBeGreaterThan(-1);
    expect(source).not.toContain('\n    takeoverWatcher?.stop();');
    expect(source.indexOf('await interactiveTakeoverWatcher?.stop()')).toBeGreaterThan(-1);
  });
});

describe('permanent refusal enforcement (round 15)', () => {
  it("an 'unprotected' verdict retires the marker and fires the enforcement hook", async () => {
    vi.useFakeTimers();
    const p = write({ sessionId: 's1', at: new Date().toISOString() });
    const claim = vi.fn(async () => 'unprotected' as const);
    const onUnprotected = vi.fn();
    const watcher = startTakeoverWatcher({
      cwd: dir,
      expectedSessionId: 's1',
      claim,
      intervalMs: 1000,
      onUnprotected,
    });

    await vi.advanceTimersByTimeAsync(0); // the immediate tick enforces
    expect(onUnprotected).toHaveBeenCalledTimes(1);
    // The marker retired — recovery cannot converge, so no retry loop.
    expect(existsSync(p)).toBe(false);
    await vi.advanceTimersByTimeAsync(3000);
    expect(claim).toHaveBeenCalledTimes(1);
    watcher.stop();
  });

  it("watchTick reports 'unprotected' distinctly and consumes the marker", async () => {
    const p = write({ sessionId: 's1', at: new Date().toISOString() });
    const claim = vi.fn(async () => 'unprotected' as const);

    const outcome = await watchTick({ markerPath: p, expectedSessionId: 's1', claim });

    expect(outcome).toBe('unprotected');
    expect(existsSync(p)).toBe(false);
  });
});

/**
 * Round 17 (Lumen): the marker is written by the backend's prompt hook AFTER
 * spawn, so a purely timed first tick could not see it and a short one-shot
 * kept its 3s escape; and stop() could not fence a claim already in flight.
 * The watcher now ticks on the marker FILE event, and stop() is an async
 * boundary: it awaits the in-flight tick, closes a claimed turn with its
 * fenced stop, and stamps the tombstone when nothing was claimed.
 */
describe('event-driven ticks and the stop boundary (round 17)', () => {
  it('a marker written AFTER start triggers a claim without waiting for the interval', async () => {
    const claim = vi.fn(async () => 'ok' as const);
    const watcher = startTakeoverWatcher({
      cwd: dir,
      expectedSessionId: 's1',
      claim,
      intervalMs: 60_000, // the interval alone could never fire in this test
    });

    // Production ordering: the watcher exists BEFORE the marker (the prompt
    // hook writes it after spawn).
    await new Promise((r) => setTimeout(r, 20));
    expect(claim).not.toHaveBeenCalled();
    write({ sessionId: 's1', at: new Date().toISOString() });

    await vi.waitFor(() => expect(claim).toHaveBeenCalledTimes(1), { timeout: 2000 });
    await watcher.stop();
  });

  it('stop() AWAITS the in-flight claim and closes the claimed turn with its epoch', async () => {
    const { writeCliTurnEpoch } = await import('./takeover-watcher.js');
    let releaseClaim: (() => void) | undefined;
    const claim = vi.fn(
      () =>
        new Promise<'ok'>((resolve) => {
          releaseClaim = () => {
            // The claim commits and records its epoch BEFORE resolving —
            // exactly what the real callback does on a 2xx.
            writeCliTurnEpoch(dir, { sessionId: 's1', turnEpoch: 'epoch-crash' });
            resolve('ok');
          };
        })
    );
    const finalizeScope = vi.fn(async () => undefined);
    write({ sessionId: 's1', at: new Date().toISOString() });
    const watcher = startTakeoverWatcher({
      cwd: dir,
      expectedSessionId: 's1',
      claim,
      finalizeScope,
      intervalMs: 60_000,
    });
    await vi.waitFor(() => expect(claim).toHaveBeenCalled(), { timeout: 2000 });

    // The child crashes: stop() must not race past the parked claim.
    const stopped = watcher.stop();
    releaseClaim!();
    await stopped;

    expect(finalizeScope).toHaveBeenCalledWith('epoch-crash');
  });

  it('an UNCLAIMED scope finalizes with undefined — the tombstone path', async () => {
    const finalizeScope = vi.fn(async () => undefined);
    const watcher = startTakeoverWatcher({
      cwd: dir,
      expectedSessionId: 's1',
      claim: vi.fn(async () => 'ok' as const),
      finalizeScope,
      intervalMs: 60_000,
    });

    await watcher.stop();

    expect(finalizeScope).toHaveBeenCalledWith(undefined);
  });

  it('no new tick starts after stop() begins', async () => {
    const claim = vi.fn(async () => 'failed' as const);
    const watcher = startTakeoverWatcher({
      cwd: dir,
      expectedSessionId: 's1',
      claim,
      intervalMs: 60_000,
    });
    await watcher.stop();

    write({ sessionId: 's1', at: new Date().toISOString() });
    await new Promise((r) => setTimeout(r, 60));
    expect(claim).not.toHaveBeenCalled();
  });
});
