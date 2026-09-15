/**
 * The alert query routes are throttled (CodeQL, PR #539 r3).
 *
 * Both GETs are authenticated, so this is not the anti-guessing throttle that
 * guards the credential routes. It bounds cost: each request runs a query
 * against alert_events / alert_sources for whoever holds a valid token, and a
 * leaked token or a client stuck in a retry loop would otherwise let the
 * alerting tables become the thing taking the database down — the alerting
 * path turning into the outage, which is the failure this whole PR exists to
 * avoid.
 *
 * Exercised against the real FixedWindowLimiter rather than a stub, because
 * the thing being pinned is the budget arithmetic and the per-key isolation,
 * and a stub would only restate what this file already believes.
 */

import { describe, it, expect } from 'vitest';
import { FixedWindowLimiter } from '../../utils/fixed-window-limiter';

// Mirrors routes/alerts.ts. Kept in step by the budget assertion below, which
// fails if the route's numbers drift away from these.
const ALERT_READ_WINDOW_MS = 60 * 1000;
const ALERT_READS_PER_MINUTE = 60;

function makeReadLimiter() {
  const limiter = new FixedWindowLimiter(ALERT_READ_WINDOW_MS);
  return (userId: string, ip: string, now?: number) =>
    limiter.hit(`alertread:${userId}|${ip}`, ALERT_READS_PER_MINUTE, now);
}

describe('alert read throttle', () => {
  it('allows a normal polling rate and refuses a runaway loop', async () => {
    const limited = makeReadLimiter();
    const t0 = 1_000_000;

    const allowed: number[] = [];
    for (let i = 0; i < ALERT_READS_PER_MINUTE; i += 1) {
      if (!limited('user-1', '10.0.0.1', t0)) allowed.push(i);
    }

    // The control: the budget is spent, not refused from the first call. A
    // limiter that said no to everything would also pass a bare "eventually
    // returns true" assertion, and would be a differently broken route.
    expect(allowed).toHaveLength(ALERT_READS_PER_MINUTE);

    expect(limited('user-1', '10.0.0.1', t0)).toBe(true);
  });

  it('gives each user their own budget', async () => {
    const limited = makeReadLimiter();
    const t0 = 2_000_000;

    for (let i = 0; i < ALERT_READS_PER_MINUTE + 5; i += 1) limited('noisy', '10.0.0.1', t0);

    // One client exhausting itself must not deny everyone else their alerts.
    expect(limited('noisy', '10.0.0.1', t0)).toBe(true);
    expect(limited('quiet', '10.0.0.1', t0)).toBe(false);
  });

  it('separates the same user arriving from different addresses', async () => {
    const limited = makeReadLimiter();
    const t0 = 3_000_000;

    for (let i = 0; i < ALERT_READS_PER_MINUTE + 5; i += 1) limited('user-1', '10.0.0.1', t0);

    expect(limited('user-1', '10.0.0.1', t0)).toBe(true);
    expect(limited('user-1', '10.0.0.2', t0)).toBe(false);
  });

  it('refills once the window rolls over', async () => {
    const limited = makeReadLimiter();
    const t0 = 4_000_000;

    for (let i = 0; i < ALERT_READS_PER_MINUTE + 5; i += 1) limited('user-1', '10.0.0.1', t0);
    expect(limited('user-1', '10.0.0.1', t0)).toBe(true);

    // A throttle that never recovers would silence a monitor permanently after
    // one burst, which is the same outcome as the bug it guards against.
    expect(limited('user-1', '10.0.0.1', t0 + ALERT_READ_WINDOW_MS + 1)).toBe(false);
  });

  it('keeps the route wired to these budgets', async () => {
    // Reading the route source is deliberate. The limiter above is a faithful
    // copy of the route's key and budget, and a copy silently stops matching:
    // this fails when the route's numbers move without this file moving.
    const { readFileSync } = await import('fs');
    const { resolve } = await import('path');
    const src = readFileSync(resolve(__dirname, '../../routes/alerts.ts'), 'utf8');

    expect(src).toContain(`const ALERT_READ_WINDOW_MS = 60 * 1000;`);
    expect(src).toContain(`const ALERT_READS_PER_MINUTE = ${ALERT_READS_PER_MINUTE};`);
    expect(src).toContain('alertread:${userId}|${ip}');
    // Both GET routes, not just the first one.
    expect(src.match(/readRateLimited\(userData\.userId/g) ?? []).toHaveLength(2);
    expect(src.match(/res\.status\(429\)/g) ?? []).toHaveLength(2);
  });
});
