import { describe, expect, it } from 'vitest';
import { FixedWindowLimiter } from './fixed-window-limiter';

const WINDOW = 15 * 60 * 1000;

describe('FixedWindowLimiter', () => {
  it('allows `limit` hits per key per window and refuses the next', () => {
    const limiter = new FixedWindowLimiter(WINDOW);
    const t0 = 1_000_000;
    for (let i = 0; i < 10; i += 1) expect(limiter.hit('a', 10, t0 + i)).toBe(false);
    expect(limiter.hit('a', 10, t0 + 10)).toBe(true);
    // Another key is untouched by a's count.
    expect(limiter.hit('b', 10, t0 + 11)).toBe(false);
  });

  it('starts a fresh window once the old one has elapsed', () => {
    const limiter = new FixedWindowLimiter(WINDOW);
    const t0 = 1_000_000;
    for (let i = 0; i < 11; i += 1) limiter.hit('a', 10, t0);
    expect(limiter.hit('a', 10, t0 + WINDOW - 1)).toBe(true);
    expect(limiter.hit('a', 10, t0 + WINDOW)).toBe(false);
  });

  it('prunes expired keys on the amortised schedule, not on every hit', () => {
    const limiter = new FixedWindowLimiter(WINDOW, 10_000, 4);
    const t0 = 1_000_000;
    limiter.hit('old-1', 10, t0);
    limiter.hit('old-2', 10, t0);
    expect(limiter.size).toBe(2);
    // Two hits later, in a new window: the 4th hit overall triggers a prune.
    limiter.hit('new-1', 10, t0 + WINDOW);
    expect(limiter.size).toBe(3); // no prune yet (3rd hit)
    limiter.hit('new-2', 10, t0 + WINDOW);
    expect(limiter.size).toBe(2); // pruned: old-1, old-2 gone; new-1, new-2 remain
  });

  it('caps the map under a spray of distinct keys, evicting the oldest first', () => {
    const limiter = new FixedWindowLimiter(WINDOW, 100, 1_000_000);
    const t0 = 1_000_000;
    for (let i = 0; i < 150; i += 1) limiter.hit(`spray-${i}`, 10, t0 + i);
    expect(limiter.size).toBeLessThanOrEqual(100);
    // The newest key survived; the oldest did not.
    expect(limiter.hit('spray-149', 1, t0 + 200)).toBe(true); // second hit on a live key
    expect(limiter.hit('spray-0', 1, t0 + 201)).toBe(false); // evicted → counts as first hit
  });

  it('a refreshed key is not evicted as if it were stale', () => {
    const limiter = new FixedWindowLimiter(WINDOW, 10, 1_000_000);
    const t0 = 1_000_000;
    for (let i = 0; i < 9; i += 1) limiter.hit(`k${i}`, 10, t0 + i);
    // k0 gets a new window later — it should now be the youngest, not the oldest.
    limiter.hit('k0', 10, t0 + WINDOW);
    for (let i = 0; i < 5; i += 1) limiter.hit(`late-${i}`, 10, t0 + WINDOW + 1 + i);
    limiter.prune(t0 + WINDOW + 10);
    expect(limiter.hit('k0', 1, t0 + WINDOW + 20)).toBe(true); // still tracked: over limit 1
  });
});
