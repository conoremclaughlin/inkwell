import { describe, it, expect } from 'vitest';
import { assessContextPressure } from './context-pressure.js';

const base = {
  ledgerThreshold: 200_000,
  providerThreshold: 240_000,
  hasProviderSession: true,
};

describe('assessContextPressure — two yardsticks for one window (Lumen, PR #583)', () => {
  it('nothing over: nothing to do', () => {
    expect(
      assessContextPressure({ ...base, ledgerTokens: 150_000, providerTokens: 200_000 }).action
    ).toBe('none');
    expect(assessContextPressure({ ...base, ledgerTokens: 150_000 }).action).toBe('none');
  });

  it('the ledger over its allowance compacts, with or without a provider reading', () => {
    const p = assessContextPressure({ ...base, ledgerTokens: 250_000, providerTokens: 100_000 });
    expect(p.action).toBe('compact');
    expect(p.ledgerOver).toBe(true);
    expect(p.providerOver).toBe(false);
    expect(assessContextPressure({ ...base, ledgerTokens: 250_000 }).action).toBe('compact');
  });

  it('the provider is judged against the FULL window, not the ledger allowance', () => {
    // 230K is over the 200K ledger allowance but under the 240K window share.
    expect(
      assessContextPressure({ ...base, ledgerTokens: 100_000, providerTokens: 230_000 }).action
    ).toBe('none');
  });

  it('provider-only excess with a native session rolls it instead of destroying ledger history', () => {
    const p = assessContextPressure({ ...base, ledgerTokens: 100_000, providerTokens: 541_000 });
    expect(p.action).toBe('reseed');
    expect(p.providerOver).toBe(true);
    expect(p.ledgerOver).toBe(false);
    expect(p.reason).toContain('native session');
  });

  it('provider-only excess with no native session compacts — the ledger is the only lever', () => {
    const p = assessContextPressure({
      ...base,
      hasProviderSession: false,
      ledgerTokens: 100_000,
      providerTokens: 541_000,
    });
    expect(p.action).toBe('compact');
    expect(p.providerOver).toBe(true);
  });

  it('names both breaches when both are over', () => {
    const p = assessContextPressure({
      ...base,
      ledgerTokens: 250_000,
      providerTokens: 541_000,
      format: (n) => `${Math.round(n / 1000)}K`,
    });
    expect(p.action).toBe('compact');
    expect(p.reason).toBe(
      'ledger ~250K > 200K allowance; provider measured ~541K > 240K of the window'
    );
  });
});
