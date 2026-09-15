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

  it('AC4: splits reclaimable-by-evict from reclaimable-only-by-compact', () => {
    const occ = computeContextOccupancy(MYRA_LEDGER, 0, LIMIT, {
      contextTokens: MYRA_PROVIDER,
    });

    expect(occ.ledgerTokens).toBe(MYRA_LEDGER);
    expect(occ.providerOnlyTokens).toBe(MYRA_PROVIDER - MYRA_LEDGER); // 251,975
    expect(occ.ledgerTokens + occ.providerOnlyTokens).toBe(occ.effectiveTokens);
    expect(occ.splitKnown).toBe(true);
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
    expect(occ.ledgerTokens).toBe(150);
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
  it('names both numbers and which tool reaches each', () => {
    const stamp = formatContextStamp(
      computeContextOccupancy(MYRA_LEDGER, 0, LIMIT, { contextTokens: MYRA_PROVIDER })
    );

    expect(stamp).toContain('383,046');
    expect(stamp).toContain('1,000,000');
    expect(stamp).toContain('38%');
    expect(stamp).toContain('131,071 reclaimable by evict_context');
    expect(stamp).toContain('251,975 only by compact_context');
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
