import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MODEL_CONTEXT_WINDOW,
  INK_WORKING_BUDGET_CAP,
  MODEL_CONTEXT_WINDOWS,
  PROVIDER_HEADROOM_PCT,
  contextBudgetForWindow,
  resolveModelContextWindow,
} from './context-limits.js';

describe('resolveModelContextWindow', () => {
  it('resolves Claude families to the conservative 200K window', () => {
    expect(resolveModelContextWindow('claude', 'claude-opus-4-8')).toBe(200_000);
    expect(resolveModelContextWindow('claude', 'claude-opus-5')).toBe(200_000);
    expect(resolveModelContextWindow('claude', 'claude-sonnet-5')).toBe(200_000);
    expect(resolveModelContextWindow('claude', 'claude-haiku-4-5-20251001')).toBe(200_000);
    expect(resolveModelContextWindow('claude', 'claude-fable-5')).toBe(200_000);
    // Unknown claude-* still matches the generic family entry.
    expect(resolveModelContextWindow('claude', 'claude-something-new')).toBe(200_000);
  });

  it('resolves gemini to a 1M window', () => {
    expect(resolveModelContextWindow('gemini', 'gemini-2.0-flash')).toBe(1_000_000);
    expect(resolveModelContextWindow('gemini', 'gemini-1.5-pro')).toBe(1_000_000);
    expect(resolveModelContextWindow('gemini', 'gemini-experimental')).toBe(1_000_000);
  });

  it('resolves codex / gpt families conservatively', () => {
    expect(resolveModelContextWindow('codex', 'codex-mini')).toBe(256_000);
    expect(resolveModelContextWindow('codex', 'gpt-5-codex')).toBe(256_000);
    expect(resolveModelContextWindow('codex', 'gpt-4o')).toBe(128_000);
  });

  it('uses LONGEST prefix match, not first match', () => {
    // gpt-5 (256K) must beat the shorter gpt- (128K) entry regardless of order.
    expect(resolveModelContextWindow('codex', 'gpt-5-turbo')).toBe(256_000);
    // gpt-4 stays on the 128K entry.
    expect(resolveModelContextWindow('codex', 'gpt-4.1')).toBe(128_000);
  });

  it('is case-insensitive and trims whitespace on the model id', () => {
    expect(resolveModelContextWindow('claude', '  CLAUDE-SONNET-5  ')).toBe(200_000);
    expect(resolveModelContextWindow('gemini', 'Gemini-2.0')).toBe(1_000_000);
  });

  it('falls back to a conservative per-backend default when no model id is given', () => {
    expect(resolveModelContextWindow('claude')).toBe(200_000);
    expect(resolveModelContextWindow('claude', '')).toBe(200_000);
    expect(resolveModelContextWindow('claude', '   ')).toBe(200_000);
    expect(resolveModelContextWindow('codex')).toBe(256_000);
    expect(resolveModelContextWindow('gemini')).toBe(1_000_000);
  });

  it('falls back to the per-backend default for an unrecognized model id', () => {
    // Unknown model on a known backend → backend default, NOT a phantom large window.
    expect(resolveModelContextWindow('claude', 'mystery-model')).toBe(200_000);
    expect(resolveModelContextWindow('codex', 'mystery-model')).toBe(256_000);
  });

  it('uses the global safe default for an unknown backend with no known model', () => {
    expect(resolveModelContextWindow('mystery-backend')).toBe(DEFAULT_MODEL_CONTEXT_WINDOW);
    expect(resolveModelContextWindow('mystery-backend', 'mystery-model')).toBe(
      DEFAULT_MODEL_CONTEXT_WINDOW
    );
  });
});

describe('contextBudgetForWindow', () => {
  it('applies provider headroom below the cap for a 200K window', () => {
    // min(200K cap, floor(0.85 * 200K)=170K) → 170K
    expect(contextBudgetForWindow(200_000)).toBe(170_000);
  });

  it('applies the global cap for large (1M+) windows', () => {
    // floor(0.85 * 1M)=850K is above the cap → capped at 200K
    expect(contextBudgetForWindow(1_000_000)).toBe(INK_WORKING_BUDGET_CAP);
    expect(contextBudgetForWindow(2_000_000)).toBe(INK_WORKING_BUDGET_CAP);
  });

  it('applies headroom for sub-200K windows', () => {
    expect(contextBudgetForWindow(128_000)).toBe(Math.floor(128_000 * PROVIDER_HEADROOM_PCT));
  });

  it('never returns a non-positive budget for tiny windows', () => {
    expect(contextBudgetForWindow(1)).toBe(1);
    expect(contextBudgetForWindow(0)).toBe(1);
  });
});

describe('keystone safety invariant — ink compacts before the provider', () => {
  // The in-budget compaction threshold used by chat.ts (AUTO_COMPACT_THRESHOLD_PCT).
  // Kept in sync here to assert the end-to-end safety margin; it only ever lowers
  // ink's compaction point further below the provider trigger.
  const INK_COMPACT_THRESHOLD_PCT = 0.8;

  // Representative real windows across every provider family we support.
  const windows = [128_000, 200_000, 256_000, 1_000_000, 2_000_000];

  it('keeps ink’s ENTIRE working budget within the provider-headroom slice', () => {
    for (const w of windows) {
      const budget = contextBudgetForWindow(w);
      // Budget never exceeds the fraction of the window at which we assume the
      // provider might begin its own auto-compaction.
      expect(budget).toBeLessThanOrEqual(Math.floor(w * PROVIDER_HEADROOM_PCT));
      // And of course never exceeds the raw window.
      expect(budget).toBeLessThan(w);
    }
  });

  it('places ink’s compaction point strictly below the provider trigger for every model', () => {
    // For each known model, derive its window → budget → compaction point and
    // assert it fires before the provider would (headroom slice of the window).
    const models = [
      ['claude', 'claude-opus-4-8'],
      ['claude', 'claude-sonnet-5'],
      ['claude', 'claude-haiku-4-5'],
      ['codex', 'gpt-5-codex'],
      ['codex', 'gpt-4o'],
      ['gemini', 'gemini-2.0-flash'],
    ] as const;
    for (const [backend, model] of models) {
      const window = resolveModelContextWindow(backend, model);
      const budget = contextBudgetForWindow(window);
      const inkCompactAt = budget * INK_COMPACT_THRESHOLD_PCT;
      const providerTriggerAt = window * PROVIDER_HEADROOM_PCT;
      expect(inkCompactAt).toBeLessThan(providerTriggerAt);
    }
  });

  it('every table window is positive and yields a positive budget', () => {
    for (const [prefix, window] of MODEL_CONTEXT_WINDOWS) {
      expect(window, `${prefix} window`).toBeGreaterThan(0);
      expect(contextBudgetForWindow(window), `${prefix} budget`).toBeGreaterThan(0);
    }
  });
});
