import { describe, it, expect } from 'vitest';
import { createHmac } from 'crypto';
import { deriveDelegationSecret } from './delegation-secret';

describe('deriveDelegationSecret', () => {
  it('is deterministic for one key, so every child of one server verifies the others', () => {
    const a = deriveDelegationSecret('synthetic-signing-key');
    const b = deriveDelegationSecret('synthetic-signing-key');
    expect(a).toBeDefined();
    expect(a).toBe(b);
  });

  it('is an HMAC under the key, never the key itself, and differs per key', () => {
    const key = 'synthetic-signing-key';
    const derived = deriveDelegationSecret(key)!;
    expect(derived).not.toBe(key);
    expect(derived).not.toContain(key);
    expect(derived).toBe(
      createHmac('sha256', key).update('ink-delegation-secret:v1').digest('hex')
    );
    expect(deriveDelegationSecret('another-synthetic-key')).not.toBe(derived);
  });

  it('is undefined when the server has no signing key, so the child gets no secret rather than an empty one', () => {
    expect(deriveDelegationSecret(undefined)).toBeUndefined();
    expect(deriveDelegationSecret('')).toBeUndefined();
    expect(deriveDelegationSecret('   ')).toBeUndefined();
  });
});
