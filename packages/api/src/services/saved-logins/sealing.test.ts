import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { open, seal, sealingKeyFrom } from './sealing';
import { bindingFor } from './store';

describe('the sealing key', () => {
  it('is 32 bytes of base64, or the sealed store is unavailable', () => {
    const key = randomBytes(32);
    expect(sealingKeyFrom({ SAVED_LOGINS_SEALING_KEY: key.toString('base64') })).toEqual(key);
    expect(sealingKeyFrom({})).toBeNull();
    expect(sealingKeyFrom({ SAVED_LOGINS_SEALING_KEY: '  ' })).toBeNull();
    expect(
      sealingKeyFrom({ SAVED_LOGINS_SEALING_KEY: randomBytes(16).toString('base64') })
    ).toBeNull();
    // Only canonical base64: a stray character isn't skipped over.
    const text = key.toString('base64');
    expect(sealingKeyFrom({ SAVED_LOGINS_SEALING_KEY: `!${text}` })).toBeNull();
    expect(sealingKeyFrom({ SAVED_LOGINS_SEALING_KEY: text.replace(/=$/, '') })).toBeNull();
    expect(sealingKeyFrom({ SAVED_LOGINS_SEALING_KEY: ` ${text}\n` })).toEqual(key);
  });
});

describe('sealing', () => {
  const key = randomBytes(32);
  const bound = bindingFor('user-1', 'login-1', 'secret');

  it('opens only with the same key and the same binding', () => {
    const sealed = seal(key, 'correct horse', bound);
    expect(sealed.startsWith('v1.')).toBe(true);
    expect(sealed).not.toContain('correct horse');
    expect(open(key, sealed, bound)).toBe('correct horse');
    expect(() => open(randomBytes(32), sealed, bound)).toThrow();
    for (const other of [
      bindingFor('user-2', 'login-1', 'secret'),
      bindingFor('user-1', 'login-2', 'secret'),
      bindingFor('user-1', 'login-1', 'item'),
    ]) {
      expect(() => open(key, sealed, other)).toThrow();
    }
  });

  it('never seals the same text the same way, and refuses any change', () => {
    expect(seal(key, 'same', bound)).not.toBe(seal(key, 'same', bound));
    const sealed = seal(key, 'correct horse', bound);
    const bytes = Buffer.from(sealed.slice(3), 'base64');
    bytes[bytes.length - 1] ^= 1;
    expect(() => open(key, `v1.${bytes.toString('base64')}`, bound)).toThrow();
    expect(() => open(key, sealed.replace('v1.', 'v2.'), bound)).toThrow();
    expect(() => open(key, 'v1.AAAA', bound)).toThrow();
  });
});
