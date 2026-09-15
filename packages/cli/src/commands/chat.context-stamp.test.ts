import { describe, it, expect } from 'vitest';
import { buildPromptEnvelope, buildDeltaPrompt, turnContextOccupancy } from './chat';
import { ContextLedger } from '../repl/context-ledger';
import { formatContextStamp } from '../repl/context-tools';
import type { ChatRuntime } from './chat';

/**
 * Task 480b76f7, the WIRING half.
 *
 * context-occupancy.test.ts pins the arithmetic. These pin that the production
 * turn path uses it — a test that only checks a hook's reaction to a supplied
 * utilization cannot see which number the caller computed, and the caller is
 * where the bug was.
 */

const LIMIT = 1_000_000;

function makeRuntime(over: Partial<ChatRuntime> = {}): ChatRuntime {
  return {
    maxContextTokens: LIMIT,
    backend: 'claude',
    toolMode: 'off',
    toolRouting: 'local',
    strictTools: false,
    activeSkills: [],
    ...over,
  } as unknown as ChatRuntime;
}

/** A ledger whose estimate is far below what the provider actually reads. */
function ledgerOf(approxTokens: number): ContextLedger {
  const ledger = new ContextLedger();
  ledger.addEntry('user', 'x'.repeat(approxTokens * 4), 'repl');
  return ledger;
}

describe('turnContextOccupancy — the number the turn hooks gate on', () => {
  it('REGRESSION: reflects the provider measurement, not the ledger estimate', () => {
    // The shape that motivated the task: ledger 131K, provider 383K.
    const ledger = ledgerOf(131_071);
    const occ = turnContextOccupancy(ledger, makeRuntime(), { contextTokens: 383_046 });

    // Old wiring was `ledger.totalTokens() / (max - bootstrapReserve)` ≈ 0.131.
    // If anyone restores it, this goes red.
    expect(occ.utilization).toBeCloseTo(0.383, 2);
    expect(occ.utilization).not.toBeCloseTo(0.131, 2);
    expect(occ.effectiveTokens).toBe(383_046);
  });

  it('REGRESSION: a budget monitor armed at 80% fires on the provider number', () => {
    // The live consequence. Ledger says 30% of a 1M window; the provider says
    // 85%. Under the old wiring the monitor never fired and passive recall was
    // never suppressed, because both read the ledger.
    const ledger = ledgerOf(300_000);
    const occ = turnContextOccupancy(ledger, makeRuntime(), { contextTokens: 850_000 });

    expect(occ.utilization).toBeGreaterThan(0.8);
  });

  it('counts the identity envelope, which the ledger never holds, in its own bucket', () => {
    const ledger = ledgerOf(1_000);
    const withBootstrap = turnContextOccupancy(
      ledger,
      makeRuntime({ bootstrapContext: 'b'.repeat(40_000) } as Partial<ChatRuntime>),
      undefined
    );
    // 40,000 chars ÷ 4 = 10,000 tokens of envelope on top of the 1,000 ledger.
    // It counts toward the window (effectiveTokens) but is not evictable, so it
    // must not land in ledgerTokens — that is what the stamp bills as reclaimable.
    expect(withBootstrap.fixedTokens).toBe(10_000);
    expect(withBootstrap.ledgerTokens).toBe(1_000);
    expect(withBootstrap.effectiveTokens).toBe(11_000);
    expect(withBootstrap.splitKnown).toBe(false);
  });

  it('falls back to the estimate when the provider has not reported', () => {
    const occ = turnContextOccupancy(ledgerOf(50_000), makeRuntime(), undefined);
    expect(occ.effectiveTokens).toBeGreaterThan(0);
    expect(occ.splitKnown).toBe(false);
  });
});

describe('the stamp reaches BOTH turn paths (acceptance 1)', () => {
  // Built by the real formatter, not hand-written. A literal fixture here went
  // on asserting a format the formatter had stopped producing.
  const stamp = formatContextStamp(
    turnContextOccupancy(ledgerOf(131_071), makeRuntime(), { contextTokens: 383_046 })
  );

  it('rides the delta on a RESUMED session — the bridge seat', () => {
    // This is the path that matters: a resumed native session never re-reads
    // the envelope, so a stamp living only there is stale from turn two on.
    const prompt = buildDeltaPrompt(stamp, '', 'what is the status?');
    expect(prompt).toContain('[context]');
    expect(prompt).toContain('what is the status?');
  });

  it('keeps passive recall alongside the stamp, in order', () => {
    const prompt = buildDeltaPrompt(stamp, '[passive-recall] a memory', 'go');
    expect(prompt.indexOf('[context]')).toBeLessThan(prompt.indexOf('[passive-recall]'));
    expect(prompt.indexOf('[passive-recall]')).toBeLessThan(prompt.indexOf('go'));
  });

  it('omits the stamp cleanly when absent rather than leaving a blank gap', () => {
    expect(buildDeltaPrompt(undefined, '', 'go')).toBe('go');
  });

  it('appears in the full envelope on a FRESH session', () => {
    const prompt = buildPromptEnvelope('wren', makeRuntime(), ledgerOf(10), 'hello', stamp);
    expect(prompt).toContain('[context]');
    // Immediately before the latest user message — the freshest position.
    expect(prompt.indexOf('[context]')).toBeLessThan(prompt.indexOf('Latest user message:'));
  });

  it('an envelope built without a stamp is unchanged', () => {
    const prompt = buildPromptEnvelope('wren', makeRuntime(), ledgerOf(10), 'hello');
    expect(prompt).not.toContain('[context]');
    expect(prompt).toContain('Latest user message:');
  });
});
