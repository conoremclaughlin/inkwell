import { describe, expect, it } from 'vitest';
import { normaliseSessionKey, SESSION_KEY_MAX_LENGTH } from './session-key.js';

/**
 * A session key is the typed, routable name of a session (`wren:inkwell:main`).
 * The normaliser is the one place its spelling is decided, so the setter,
 * the send path and the hook route cannot drift: a key set as
 * " Wren:Inkwell:Main " and addressed as "wren:inkwell:main" must be the
 * same key.
 */
describe('normaliseSessionKey', () => {
  it('trims and lowercases', () => {
    expect(normaliseSessionKey('  Wren:Inkwell:Main ')).toEqual({
      ok: true,
      value: 'wren:inkwell:main',
    });
  });

  it('accepts colons, slashes, dots, underscores and hyphens inside the key', () => {
    for (const key of ['main', 'review', 'wren:inkwell:main', 'wren/inkwell/main', 'pr-716.r2_x']) {
      expect(normaliseSessionKey(key), key).toEqual({ ok: true, value: key });
    }
  });

  it('treats an empty or whitespace-only key as a clear', () => {
    expect(normaliseSessionKey('')).toEqual({ ok: true, value: '' });
    expect(normaliseSessionKey('   ')).toEqual({ ok: true, value: '' });
  });

  it('refuses whitespace inside, sigils, and a separator in first position', () => {
    for (const key of [
      'has space',
      '@wren:main',
      '/wren/main',
      ':main',
      'wren:main!',
      'wren\tmain',
    ]) {
      const result = normaliseSessionKey(key);
      expect(result.ok, key).toBe(false);
      if (!result.ok) expect(result.reason).toContain('sessionKey');
    }
  });

  it('refuses a key longer than the limit', () => {
    const long = 'a'.repeat(SESSION_KEY_MAX_LENGTH + 1);
    expect(normaliseSessionKey(long).ok).toBe(false);
    expect(normaliseSessionKey('a'.repeat(SESSION_KEY_MAX_LENGTH)).ok).toBe(true);
  });
});
