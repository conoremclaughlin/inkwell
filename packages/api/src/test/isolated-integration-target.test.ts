import { describe, expect, it } from 'vitest';
import {
  isolatedIntegrationTarget,
  shouldRunOnIsolatedIntegrationDb,
} from './isolated-integration-target.js';

/** Pure: no database is touched anywhere in this file. */
describe('isolatedIntegrationTarget', () => {
  const HARNESS = {
    INTEGRATION_SUPABASE_WORKDIR: '/tmp/ink-supabase-it',
    INTEGRATION_MANAGED_API_PORT: '55421',
    SUPABASE_URL: 'http://127.0.0.1:55421',
    SUPABASE_SECRET_KEY: 'service-role-test-key',
  };

  it('runs exactly on the stack the harness reserved', () => {
    expect(isolatedIntegrationTarget(HARNESS)).toEqual({ kind: 'isolated' });
    expect(shouldRunOnIsolatedIntegrationDb(HARNESS)).toBe(true);
  });

  it('skips an ordinary run with no harness marker, even with local credentials', () => {
    const shell = { SUPABASE_URL: 'http://127.0.0.1:54321', SUPABASE_SECRET_KEY: 'k' };
    expect(isolatedIntegrationTarget(shell)).toEqual({ kind: 'not-under-harness' });
    expect(shouldRunOnIsolatedIntegrationDb(shell)).toBe(false);
  });

  it('refuses a harness marker beside the shared stack (the PR #723 case)', () => {
    const inherited = { ...HARNESS, SUPABASE_URL: 'http://127.0.0.1:54321' };
    expect(isolatedIntegrationTarget(inherited)).toEqual({
      kind: 'mismatch',
      expected: 'http://127.0.0.1:55421',
    });
    expect(() => shouldRunOnIsolatedIntegrationDb(inherited)).toThrow(
      /not the isolated integration stack/
    );
  });

  it('refuses near-misses: substrings, paths, fragments, credentials, other hosts', () => {
    for (const url of [
      'http://127.0.0.1:55421/',
      'http://127.0.0.1:55421/#x',
      'http://user:pw@127.0.0.1:55421',
      'http://localhost:55421',
      'https://127.0.0.1:55421',
      'http://127.0.0.1:54321/#:55421',
      'https://foreign.invalid:55421',
    ]) {
      expect(isolatedIntegrationTarget({ ...HARNESS, SUPABASE_URL: url }).kind).toBe('mismatch');
    }
  });

  it('refuses a marker with no usable port', () => {
    for (const port of [undefined, '', 'abc', '55421 ']) {
      expect(
        isolatedIntegrationTarget({ ...HARNESS, INTEGRATION_MANAGED_API_PORT: port }).kind
      ).toBe('mismatch');
    }
  });

  it('never puts the rejected URL in the error', () => {
    const secret = 'http://user:hunter2@127.0.0.1:54321';
    try {
      shouldRunOnIsolatedIntegrationDb({ ...HARNESS, SUPABASE_URL: secret });
      throw new Error('expected a refusal');
    } catch (err) {
      expect((err as Error).message).not.toContain('hunter2');
      expect((err as Error).message).not.toContain('54321');
    }
  });

  it('does not run without a service key', () => {
    const { SUPABASE_SECRET_KEY: _omit, ...noKey } = HARNESS;
    expect(shouldRunOnIsolatedIntegrationDb(noKey)).toBe(false);
  });
});
