import { describe, it, expect, vi, afterEach } from 'vitest';
import { getBackend, deprecatedBackendReason, DEPRECATED_BACKENDS } from './index.js';

describe('deprecated backends (Conor, 2026-09-03: Gemini CLI needs an enterprise plan)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('gemini is deprecated for now, with a reason that names the alternatives', () => {
    expect(deprecatedBackendReason('gemini')).toMatch(/deprecated for now/);
    expect(deprecatedBackendReason('gemini')).toMatch(/enterprise plan/);
    expect(deprecatedBackendReason('claude')).toBeUndefined();
    expect(deprecatedBackendReason('codex')).toBeUndefined();
    expect(Object.keys(DEPRECATED_BACKENDS)).toEqual(['gemini']);
  });

  it('REGRESSION (Lumen): inherited keys are not reasons', () => {
    for (const name of ['toString', '__proto__', 'constructor', 'hasOwnProperty']) {
      expect(deprecatedBackendReason(name)).toBeUndefined();
    }
  });

  it('still resolves the adapter, warning once per process on stderr', () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(getBackend('gemini')).toBeDefined();
    expect(getBackend('gemini')).toBeDefined();
    const warnings = write.mock.calls.filter((c) => String(c[0]).includes('backend "gemini"'));
    expect(warnings).toHaveLength(1);
    expect(String(warnings[0]![0])).toMatch(/deprecated for now/);
  });
});
