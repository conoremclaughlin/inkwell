/**
 * Durable takeover recovery (PR #563 round 8): the marker is the contract
 * between the short-lived hook process (writer), the on-stop hook (scope
 * end), and this long-lived plugin (claimer). What these pin: only the OWN
 * session's fresh marker converts into a claim; a stop that deleted the
 * marker means no late claim; a failed claim leaves the marker for the next
 * tick; success consumes it.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  pendingTakeoverMarkerPath,
  readPendingTakeover,
  shouldReclaim,
  processPendingTakeover,
  MARKER_MAX_AGE_MS,
} from './pending-takeover.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'takeover-'));
  mkdirSync(join(dir, '.ink'), { recursive: true });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const write = (marker: Record<string, unknown>) => {
  const p = pendingTakeoverMarkerPath(dir);
  writeFileSync(p, JSON.stringify(marker));
  return p;
};

describe('shouldReclaim', () => {
  it('claims only its own session, only while fresh', () => {
    const now = Date.now();
    const fresh = { sessionId: 's1', at: new Date(now - 1000).toISOString() };
    expect(shouldReclaim(fresh, 's1', now)).toBe(true);
    expect(shouldReclaim(fresh, 's2', now)).toBe(false);
    expect(shouldReclaim(fresh, undefined, now)).toBe(false);
    expect(shouldReclaim(null, 's1', now)).toBe(false);
    const stale = { sessionId: 's1', at: new Date(now - MARKER_MAX_AGE_MS - 1000).toISOString() };
    expect(shouldReclaim(stale, 's1', now)).toBe(false);
    expect(shouldReclaim({ sessionId: 's1' }, 's1', now)).toBe(false); // no timestamp
  });
});

describe('processPendingTakeover', () => {
  it('claims a fresh own-session marker and consumes it', async () => {
    const at = new Date().toISOString();
    const p = write({ sessionId: 's1', at, attemptId: 'attempt-p' });
    const claim = vi.fn(async () => 'ok' as const);

    const outcome = await processPendingTakeover({ markerPath: p, sessionId: 's1', claim });

    expect(outcome).toBe('claimed');
    // The marker's birth time AND attempt token ride into the claim
    // (round 25) — the token is the clock-free fence; the timestamp
    // fallback survives only for genuinely tokenless legacy markers.
    expect(claim).toHaveBeenCalledWith(at, 'attempt-p');
    expect(existsSync(p)).toBe(false);
  });

  it("a server 'stopped' verdict retires the marker without claiming a dead turn", async () => {
    // The parked-claim race Lumen reproduced (round 9): the claim reached
    // the server AFTER a stop. The tombstone CAS refuses it atomically; the
    // plugin's job is just to retire the marker so nothing retries.
    const p = write({ sessionId: 's1', at: new Date().toISOString() });
    const claim = vi.fn(async () => 'stopped' as const);

    const outcome = await processPendingTakeover({ markerPath: p, sessionId: 's1', claim });

    expect(outcome).toBe('stopped');
    expect(existsSync(p)).toBe(false);
  });

  it('a stop that deleted the marker means NO late claim', async () => {
    // The stop-race, at the module boundary: the marker is gone before the
    // tick reads it, so the claim never fires and the finished turn is never
    // re-marked running.
    const p = pendingTakeoverMarkerPath(dir);
    const claim = vi.fn(async () => 'ok' as const);

    const outcome = await processPendingTakeover({ markerPath: p, sessionId: 's1', claim });

    expect(outcome).toBe('skipped');
    expect(claim).not.toHaveBeenCalled();
  });

  it('leaves the marker in place when the claim fails, for the next tick', async () => {
    const p = write({ sessionId: 's1', at: new Date().toISOString() });
    const claim = vi.fn(async () => 'failed' as const);

    const outcome = await processPendingTakeover({ markerPath: p, sessionId: 's1', claim });

    expect(outcome).toBe('failed');
    expect(existsSync(p)).toBe(true);
  });

  it('never claims a foreign marker, and leaves it for its owner', async () => {
    const p = write({ sessionId: 'someone-else', at: new Date().toISOString() });
    const claim = vi.fn(async () => 'ok' as const);

    const outcome = await processPendingTakeover({ markerPath: p, sessionId: 's1', claim });

    expect(outcome).toBe('skipped');
    expect(claim).not.toHaveBeenCalled();
    expect(existsSync(p)).toBe(true);
  });

  it('discards an AGED own-session marker without claiming — its turn is over', async () => {
    const p = write({
      sessionId: 's1',
      at: new Date(Date.now() - MARKER_MAX_AGE_MS - 60_000).toISOString(),
    });
    const claim = vi.fn(async () => 'ok' as const);

    const outcome = await processPendingTakeover({ markerPath: p, sessionId: 's1', claim });

    expect(outcome).toBe('skipped');
    expect(claim).not.toHaveBeenCalled();
    expect(existsSync(p)).toBe(false);
  });
});

describe('marker path contract', () => {
  it('matches the CLI hook writer path shape', () => {
    expect(pendingTakeoverMarkerPath('/some/cwd')).toBe('/some/cwd/.ink/pending-takeover.json');
    expect(readPendingTakeover('/nonexistent')).toBeNull();
  });
});

describe('plugin wiring (reachability)', () => {
  it('the poll loop actually invokes the recovery — not just exports it', async () => {
    const { readFileSync } = await import('fs');
    const { join, dirname } = await import('path');
    const { fileURLToPath } = await import('url');
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'index.ts'), 'utf-8');
    const poll = source.indexOf('async function pollInbox');
    const call = source.indexOf('processPendingTakeover({', poll);
    expect(poll).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(poll);
    expect(source.indexOf('claim: claimPendingTakeover', call)).toBeGreaterThan(call);
  });
});

describe('reclaim wiring round 25 (reachability)', () => {
  it('the plugin claim carries attemptId and studioId to the boundary', async () => {
    const { readFileSync } = await import('fs');
    const { join, dirname } = await import('path');
    const { fileURLToPath } = await import('url');
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'index.ts'), 'utf-8');
    const claim = source.indexOf('async function claimPendingTakeover(');
    const attempt = source.indexOf('...(attemptId ? { attemptId } : {})', claim);
    const studio = source.indexOf(
      "...(studioId && studioId !== 'main' ? { studioId } : {})",
      claim
    );
    expect(claim).toBeGreaterThan(-1);
    expect(attempt).toBeGreaterThan(claim);
    expect(studio).toBeGreaterThan(claim);
  });
});
