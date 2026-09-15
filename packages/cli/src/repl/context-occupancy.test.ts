import { describe, it, expect } from 'vitest';
import {
  computeContextOccupancy,
  formatContextStamp,
  effectiveContextTokens,
} from './context-tools';

/**
 * Task 480b76f7. The acceptance criteria are written against a specific failure:
 * an indicator wired to the ledger estimate reports 131K at 383K occupancy —
 * wrong, and wrong in the direction that says everything is fine.
 *
 * Measurements from myra session 64e1eb49 (2026-09-15T08:00:53Z) are used as
 * the fixture so the numbers in these tests are the numbers that motivated them.
 */
const MYRA_LEDGER = 131_071;
const MYRA_PROVIDER = 383_046;
const LIMIT = 1_000_000;

describe('computeContextOccupancy', () => {
  it('AC3: reports the provider measurement, NOT the ledger total, when they differ', () => {
    const occ = computeContextOccupancy(MYRA_LEDGER, 0, LIMIT, {
      contextTokens: MYRA_PROVIDER,
    });

    // The whole point. If someone rewires this to the ledger estimate, this
    // assertion is what goes red — not a "a number is present" check, which
    // passes on the wrong number.
    expect(occ.effectiveTokens).toBe(MYRA_PROVIDER);
    expect(occ.effectiveTokens).not.toBe(MYRA_LEDGER);
    expect(occ.utilization).toBeCloseTo(0.383, 3);
  });

  it('AC4: splits the window by what can reach each part', () => {
    const occ = computeContextOccupancy(MYRA_LEDGER, 0, LIMIT, {
      contextTokens: MYRA_PROVIDER,
    });

    expect(occ.ledgerTokens).toBe(MYRA_LEDGER);
    expect(occ.providerOnlyTokens).toBe(MYRA_PROVIDER - MYRA_LEDGER); // 251,975
    expect(occ.fixedTokens + occ.ledgerTokens + occ.providerOnlyTokens).toBe(occ.effectiveTokens);
    expect(occ.splitKnown).toBe(true);
  });

  it('REGRESSION: the identity envelope is its OWN bucket, not part of the evictable one', () => {
    // Lumen, PR #639: bootstrap belongs in the numerator (the provider counts
    // it) but buildPromptEnvelope re-renders runtime.bootstrapContext on every
    // seed, so nothing reclaims it. Folding it into ledgerTokens told the agent
    // the envelope was evictable. Against fd068a65 ledgerTokens was 150_000.
    const occ = computeContextOccupancy(100_000, 50_000, LIMIT, { contextTokens: 200_000 });

    expect(occ.ledgerTokens).toBe(100_000);
    expect(occ.fixedTokens).toBe(50_000);
    // Still counted: dropping it from the numerator would under-report the window.
    expect(occ.effectiveTokens).toBe(200_000);
    expect(occ.providerOnlyTokens).toBe(50_000);
  });

  it('REGRESSION: the three buckets account for every effective token', () => {
    // The invariant that makes the split trustworthy: no token is in two
    // buckets and none is in none. A bucket added later without a remedy
    // attached breaks this before it can mislead anyone.
    for (const [ledger, fixed, measured] of [
      [100_000, 50_000, 200_000],
      [100_000, 50_000, 0],
      [0, 0, 1_000],
      [7, 11, 13],
    ] as const) {
      const occ = computeContextOccupancy(ledger, fixed, LIMIT, { contextTokens: measured });
      expect(occ.fixedTokens + occ.ledgerTokens + occ.providerOnlyTokens).toBe(occ.effectiveTokens);
    }
  });

  it('AC4: says the split is UNKNOWN rather than implying it is all actionable', () => {
    const occ = computeContextOccupancy(MYRA_LEDGER, 0, LIMIT, undefined);

    expect(occ.splitKnown).toBe(false);
    // Not silently 0 — a zero here would read as "nothing is provider-only",
    // which is a claim we have not measured.
    expect(formatContextStamp(occ)).toContain('unknown');
    expect(formatContextStamp(occ)).not.toContain('reclaimable by evict_context');
  });

  it('counts the identity envelope in the numerator, not against the limit', () => {
    // Both sides whole-window: the provider measurement includes bootstrap, so
    // the estimate must too or max() compares different quantities.
    const occ = computeContextOccupancy(100, 50, 1000, undefined);
    expect(occ.ledgerTokens).toBe(100);
    expect(occ.fixedTokens).toBe(50);
    expect(occ.utilization).toBeCloseTo(0.15, 5);
  });

  it('keeps the estimate when the provider reports SMALLER (a fresh sample lags the ledger)', () => {
    const occ = computeContextOccupancy(MYRA_LEDGER, 0, LIMIT, { contextTokens: 10 });
    expect(occ.effectiveTokens).toBe(MYRA_LEDGER);
    expect(occ.providerOnlyTokens).toBe(0);
    // Still "known" — we have a measurement, it is just not the larger one.
    expect(occ.splitKnown).toBe(true);
  });

  it('does not clamp utilization at 1 — over-budget must read as over-budget', () => {
    const occ = computeContextOccupancy(0, 0, 1000, { contextTokens: 1500 });
    expect(occ.utilization).toBeCloseTo(1.5, 5);
  });

  it('survives a zero limit without dividing by zero', () => {
    const occ = computeContextOccupancy(100, 0, 0, undefined);
    expect(Number.isFinite(occ.utilization)).toBe(true);
  });

  it('agrees with effectiveContextTokens so the budget check and the tool cannot drift', () => {
    const measured = { contextTokens: MYRA_PROVIDER };
    const occ = computeContextOccupancy(MYRA_LEDGER, 0, LIMIT, measured);
    expect(occ.effectiveTokens).toBe(effectiveContextTokens(MYRA_LEDGER, measured));
  });
});

describe('formatContextStamp', () => {
  it('names every number and which remedy reaches each', () => {
    const stamp = formatContextStamp(
      computeContextOccupancy(MYRA_LEDGER, 0, LIMIT, { contextTokens: MYRA_PROVIDER })
    );

    expect(stamp).toContain('383,046');
    expect(stamp).toContain('1,000,000');
    expect(stamp).toContain('38%');
    expect(stamp).toContain('131,071 in the ledger (evict_context/compact_context)');
    expect(stamp).toContain('251,975 provider-side (any reseed clears it)');
  });

  it('REGRESSION: never tells the agent the provider-side excess needs compaction', () => {
    // recordEviction clears activeBackendSessionId and providerSample, so an
    // eviction reseeds too; assessContextPressure rolls the session outright
    // for this case. "only by compact_context" named the one remedy this
    // bucket least needs. Against fd068a65 the stamp said exactly that.
    const stamp = formatContextStamp(
      computeContextOccupancy(MYRA_LEDGER, 0, LIMIT, { contextTokens: MYRA_PROVIDER })
    );
    expect(stamp).not.toContain('only by compact_context');
  });

  it('REGRESSION: never bills the identity envelope as evictable', () => {
    const stamp = formatContextStamp(
      computeContextOccupancy(100_000, 50_000, LIMIT, { contextTokens: 200_000 })
    );
    // Against fd068a65: "150,000 reclaimable by evict_context".
    expect(stamp).not.toContain('150,000');
    expect(stamp).toContain('100,000 in the ledger');
    expect(stamp).toContain('50,000 identity envelope (fixed, re-sent every seed)');
  });

  it('leads with the number the agent must budget against', () => {
    const stamp = formatContextStamp(
      computeContextOccupancy(MYRA_LEDGER, 0, LIMIT, { contextTokens: MYRA_PROVIDER })
    );
    // The effective number comes before the ledger number in reading order —
    // the first figure in the line is the one that means "how full am I".
    expect(stamp.indexOf('383,046')).toBeLessThan(stamp.indexOf('131,071'));
  });
});
