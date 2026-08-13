import { describe, expect, it } from 'vitest';

import {
  ARGV_TRANSPORT_BUDGET_CAP,
  DEFAULT_MODEL_CONTEXT_WINDOW,
  INK_WORKING_BUDGET_CAP,
  MODEL_CONTEXT_WINDOWS,
  PROVIDER_HEADROOM_PCT,
  contextBudgetForWindow,
  resolveModelContextWindow,
} from './context-limits.js';

describe('resolveModelContextWindow', () => {
  it('resolves older Claude families to the conservative 200K window', () => {
    expect(resolveModelContextWindow('claude', 'claude-opus-4-8')).toBe(200_000);
    expect(resolveModelContextWindow('claude', 'claude-sonnet-5')).toBe(200_000);
    expect(resolveModelContextWindow('claude', 'claude-haiku-4-5-20251001')).toBe(200_000);
    // Unknown claude-* still matches the generic family entry.
    expect(resolveModelContextWindow('claude', 'claude-something-new')).toBe(200_000);
  });

  it('resolves Fable 5 / Opus 5 to their 1M windows (Conor, 2026-08-12)', () => {
    expect(resolveModelContextWindow('claude', 'claude-fable-5')).toBe(1_000_000);
    expect(resolveModelContextWindow('claude', 'claude-opus-5')).toBe(1_000_000);
    // The longest-prefix rule keeps opus-4-x on the conservative family entry.
    expect(resolveModelContextWindow('claude', 'claude-opus-4-6')).toBe(200_000);
    // Only Fable 5 is CONFIRMED at 1M — an unknown future fable version falls
    // back to the conservative family entry until verified (Lumen, PR #477).
    expect(resolveModelContextWindow('claude', 'claude-fable-6')).toBe(200_000);
    expect(resolveModelContextWindow('claude', 'claude-fable')).toBe(200_000);
  });

  it('resolves gemini to a 1M window', () => {
    expect(resolveModelContextWindow('gemini', 'gemini-2.0-flash')).toBe(1_000_000);
    expect(resolveModelContextWindow('gemini', 'gemini-1.5-pro')).toBe(1_000_000);
    expect(resolveModelContextWindow('gemini', 'gemini-experimental')).toBe(1_000_000);
  });

  it('resolves codex / gpt families conservatively', () => {
    // codex-mini-latest is a 200K-window model — the broad codex prefix must NOT
    // overestimate it (that is the unsafe direction this table exists to avoid).
    expect(resolveModelContextWindow('codex', 'codex-mini-latest')).toBe(200_000);
    expect(resolveModelContextWindow('codex', 'codex-mini')).toBe(200_000);
    // The larger window is reserved for the specific gpt-5-codex prefix.
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
    // codex default must match codex-mini-latest (200K), not overestimate it.
    expect(resolveModelContextWindow('codex')).toBe(200_000);
    expect(resolveModelContextWindow('gemini')).toBe(1_000_000);
  });

  it('falls back to the per-backend default for an unrecognized model id', () => {
    // Unknown model on a known backend → backend default, NOT a phantom large window.
    expect(resolveModelContextWindow('claude', 'mystery-model')).toBe(200_000);
    expect(resolveModelContextWindow('codex', 'mystery-model')).toBe(200_000);
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
    // min(cap, floor(0.85 * 200K)=170K) → 170K on either transport
    expect(contextBudgetForWindow(200_000, 'stdin')).toBe(170_000);
    expect(contextBudgetForWindow(200_000, 'argv')).toBe(170_000);
  });

  it('gives 1M windows the full headroom slice on stdin transports', () => {
    // floor(0.85 * 1M) = 850K sits under the 1M stdin cap → headroom binds.
    expect(contextBudgetForWindow(1_000_000, 'stdin')).toBe(850_000);
    // A hypothetical 2M window is where the absolute cap takes over.
    expect(contextBudgetForWindow(2_000_000, 'stdin')).toBe(INK_WORKING_BUDGET_CAP);
  });

  it('caps ARGV transports at the ARG_MAX-safe ceiling regardless of window', () => {
    // Gemini's 1M window must NOT produce a multi-MB `-p <prompt>` argv
    // (Lumen, PR #477 review — finding 1): argv budgets stay at 200K.
    expect(contextBudgetForWindow(1_000_000, 'argv')).toBe(ARGV_TRANSPORT_BUDGET_CAP);
    expect(contextBudgetForWindow(2_000_000, 'argv')).toBe(ARGV_TRANSPORT_BUDGET_CAP);
  });

  it('applies headroom for sub-200K windows', () => {
    expect(contextBudgetForWindow(128_000, 'stdin')).toBe(
      Math.floor(128_000 * PROVIDER_HEADROOM_PCT)
    );
    expect(contextBudgetForWindow(128_000, 'argv')).toBe(
      Math.floor(128_000 * PROVIDER_HEADROOM_PCT)
    );
  });

  it('never returns a non-positive budget for tiny windows', () => {
    expect(contextBudgetForWindow(1, 'stdin')).toBe(1);
    expect(contextBudgetForWindow(0, 'argv')).toBe(1);
  });
});

describe('keystone safety invariant — ink compacts before the provider', () => {
  // The in-budget compaction threshold used by chat.ts (AUTO_COMPACT_THRESHOLD_PCT).
  // Kept in sync here to assert the end-to-end safety margin; it only ever lowers
  // ink's compaction point further below the provider trigger.
  const INK_COMPACT_THRESHOLD_PCT = 0.8;

  // Representative real windows across every provider family we support.
  const windows = [128_000, 200_000, 256_000, 1_000_000, 2_000_000];
  const TRANSPORTS = ['stdin', 'argv'] as const;
  // Mirrors each adapter's declared promptTransport (pinned in
  // adapters.test.ts): claude streams via stdin; codex/gemini ride argv.
  const BACKEND_TRANSPORT = { claude: 'stdin', codex: 'argv', gemini: 'argv' } as const;

  it('keeps ink’s ENTIRE working budget within the provider-headroom slice', () => {
    for (const w of windows) {
      for (const transport of TRANSPORTS) {
        const budget = contextBudgetForWindow(w, transport);
        // Budget never exceeds the fraction of the window at which we assume
        // the provider might begin its own auto-compaction.
        expect(budget).toBeLessThanOrEqual(Math.floor(w * PROVIDER_HEADROOM_PCT));
        // And of course never exceeds the raw window.
        expect(budget).toBeLessThan(w);
      }
    }
  });

  it('places ink’s compaction point strictly below the provider trigger for every model', () => {
    // For each known model, derive its window → budget → compaction point and
    // assert it fires before the provider would (headroom slice of the window).
    const models = [
      ['claude', 'claude-opus-4-8'],
      ['claude', 'claude-fable-5'],
      ['claude', 'claude-sonnet-5'],
      ['claude', 'claude-haiku-4-5'],
      ['codex', 'gpt-5-codex'],
      ['codex', 'gpt-4o'],
      ['gemini', 'gemini-2.0-flash'],
    ] as const;
    for (const [backend, model] of models) {
      const window = resolveModelContextWindow(backend, model);
      const budget = contextBudgetForWindow(window, BACKEND_TRANSPORT[backend]);
      const inkCompactAt = budget * INK_COMPACT_THRESHOLD_PCT;
      const providerTriggerAt = window * PROVIDER_HEADROOM_PCT;
      expect(inkCompactAt).toBeLessThan(providerTriggerAt);
    }
  });

  // Documented REAL context windows, specified INDEPENDENTLY of the table so
  // this guard catches over-estimation (the unsafe direction). If the resolver
  // ever assumes a window larger than reality, the derived budget can exceed the
  // real provider-headroom slice and the provider wins the compaction race —
  // exactly the codex-mini-latest bug this test was added for.
  const KNOWN_REAL_WINDOWS: ReadonlyArray<readonly [string, string, number]> = [
    ['claude', 'claude-opus-4-8', 200_000],
    ['claude', 'claude-sonnet-5', 200_000],
    ['claude', 'claude-fable-5', 1_000_000], // confirmed by Conor, 2026-08-12
    ['claude', 'claude-opus-5', 1_000_000], // confirmed by Conor, 2026-08-12
    ['codex', 'codex-mini-latest', 200_000],
    ['codex', undefined as unknown as string, 200_000], // codex backend default
    ['gemini', 'gemini-2.0-flash', 1_000_000],
  ];

  it('never budgets above the REAL provider-headroom slice for documented models', () => {
    for (const [backend, model, realWindow] of KNOWN_REAL_WINDOWS) {
      const assumed = resolveModelContextWindow(backend, model);
      // The resolver must never assume MORE context than the model really has.
      expect(assumed, `${backend}/${model ?? '(default)'} assumed window`).toBeLessThanOrEqual(
        realWindow
      );
      // And ink's whole budget must sit under the real provider trigger —
      // on the backend's REAL transport.
      const budget = contextBudgetForWindow(
        assumed,
        BACKEND_TRANSPORT[backend as keyof typeof BACKEND_TRANSPORT]
      );
      expect(
        budget,
        `${backend}/${model ?? '(default)'} budget vs real headroom`
      ).toBeLessThanOrEqual(Math.floor(realWindow * PROVIDER_HEADROOM_PCT));
    }
  });

  it('every table window is positive and yields a positive budget', () => {
    for (const [prefix, window] of MODEL_CONTEXT_WINDOWS) {
      expect(window, `${prefix} window`).toBeGreaterThan(0);
      expect(contextBudgetForWindow(window, 'stdin'), `${prefix} budget`).toBeGreaterThan(0);
      expect(contextBudgetForWindow(window, 'argv'), `${prefix} argv budget`).toBeGreaterThan(0);
    }
  });
});
