import { describe, expect, it } from 'vitest';
import { decodeDelegationToken, mintDelegationToken, verifyDelegationToken } from '@inklabs/shared';

describe('delegation token helpers', () => {
  const secret = 'pcp-delegation-test-secret';

  it('mints + verifies valid token with scope/thread constraints', () => {
    const token = mintDelegationToken(
      {
        issuerAgentId: 'lumen',
        delegateeAgentId: 'wren',
        scopes: ['send_to_inbox', 'trigger_agent'],
        threadKey: 'pr:999',
        nowSeconds: 1_700_000_000,
        ttlSeconds: 600,
      },
      secret
    );

    const verified = verifyDelegationToken(token, secret, {
      expectedIssuerAgentId: 'lumen',
      expectedDelegateeAgentId: 'wren',
      expectedThreadKey: 'pr:999',
      requiredScopes: ['send_to_inbox'],
      nowSeconds: 1_700_000_100,
    });

    expect(verified.valid).toBe(true);
    expect(verified.payload?.iss).toBe('lumen');
    expect(verified.payload?.sub).toBe('wren');
  });

  it('rejects mismatched delegatee and missing scope', () => {
    const token = mintDelegationToken(
      {
        issuerAgentId: 'lumen',
        delegateeAgentId: 'myra',
        scopes: ['send_response'],
        nowSeconds: 1_700_000_000,
      },
      secret
    );

    const wrongDelegatee = verifyDelegationToken(token, secret, {
      expectedDelegateeAgentId: 'wren',
      nowSeconds: 1_700_000_010,
    });
    expect(wrongDelegatee.valid).toBe(false);
    expect(wrongDelegatee.error).toContain('delegatee');

    const missingScope = verifyDelegationToken(token, secret, {
      requiredScopes: ['trigger_agent'],
      nowSeconds: 1_700_000_010,
    });
    expect(missingScope.valid).toBe(false);
    expect(missingScope.error).toContain('Missing scope');
  });

  it('rejects expired tokens and decodes payload', () => {
    const token = mintDelegationToken(
      {
        issuerAgentId: 'lumen',
        delegateeAgentId: 'aster',
        scopes: ['remember'],
        nowSeconds: 1_700_000_000,
        ttlSeconds: 60,
      },
      secret
    );

    const payload = decodeDelegationToken(token);
    expect(payload.iss).toBe('lumen');
    expect(payload.sub).toBe('aster');

    const expired = verifyDelegationToken(token, secret, { nowSeconds: 1_700_000_100 });
    expect(expired.valid).toBe(false);
    expect(expired.error).toContain('expired');
  });
});
