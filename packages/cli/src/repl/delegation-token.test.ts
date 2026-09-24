import { createHmac } from 'crypto';
import { describe, expect, it } from 'vitest';
import { decodeDelegationToken, mintDelegationToken, verifyDelegationToken } from '@inklabs/shared';

describe('delegation token helpers', () => {
  const secret = 'ink-delegation-test-secret';

  /**
   * A token as minted before #659, when `typ` was 'PCP-DELEGATION'.
   *
   * It has to be built by hand: `typ` is inside the signed header, so the
   * signature covers that exact string and the token cannot be re-spelled
   * after the fact. Mirrors mintDelegationToken's encoding exactly — any drift
   * there makes this token invalid for the wrong reason, which the "current
   * tokens still verify" case alongside it would not catch.
   */
  const base64url = (input: Buffer | string): string =>
    Buffer.from(input).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

  function mintLegacyToken(payload: Record<string, unknown>): string {
    const header = base64url(JSON.stringify({ typ: 'PCP-DELEGATION', alg: 'HS256' }));
    const body = base64url(JSON.stringify(payload));
    const data = `${header}.${body}`;
    const signature = base64url(createHmac('sha256', secret).update(data).digest());
    return `${data}.${signature}`;
  }

  it('mints + verifies valid token with scope/thread constraints', () => {
    const token = mintDelegationToken(
      {
        issuerSlug: 'lumen',
        delegateeSlug: 'wren',
        scopes: ['send_to_inbox', 'trigger_agent'],
        threadKey: 'pr:999',
        nowSeconds: 1_700_000_000,
        ttlSeconds: 600,
      },
      secret
    );

    const verified = verifyDelegationToken(token, secret, {
      expectedIssuerSlug: 'lumen',
      expectedDelegateeSlug: 'wren',
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
        issuerSlug: 'lumen',
        delegateeSlug: 'myra',
        scopes: ['send_response'],
        nowSeconds: 1_700_000_000,
      },
      secret
    );

    const wrongDelegatee = verifyDelegationToken(token, secret, {
      expectedDelegateeSlug: 'wren',
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
        issuerSlug: 'lumen',
        delegateeSlug: 'aster',
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

  // Renaming the signed `typ` would have invalidated every delegation minted
  // before the deploy — up to MAX_TTL (24h) of live tokens, all failing with
  // "Unsupported token header" and nothing to say why.
  it('still verifies a token minted with the pre-rename typ', () => {
    const token = mintLegacyToken({
      v: 1,
      iss: 'lumen',
      sub: 'wren',
      scopes: ['send_to_inbox'],
      iat: 1_700_000_000,
      exp: 1_700_000_600,
      jti: 'legacy-jti',
      threadKey: 'pr:999',
    });

    const verified = verifyDelegationToken(token, secret, {
      expectedIssuerSlug: 'lumen',
      expectedDelegateeSlug: 'wren',
      expectedThreadKey: 'pr:999',
      requiredScopes: ['send_to_inbox'],
      nowSeconds: 1_700_000_100,
    });

    expect(verified.valid).toBe(true);
    expect(verified.payload?.iss).toBe('lumen');
  });

  it('still rejects a legacy-typ token whose signature does not match', () => {
    // Control: accepting the old typ must not mean skipping verification.
    const token = mintLegacyToken({
      v: 1,
      iss: 'lumen',
      sub: 'wren',
      scopes: ['send_to_inbox'],
      iat: 1_700_000_000,
      exp: 1_700_000_600,
      jti: 'legacy-jti',
    });
    const tampered = `${token.slice(0, -4)}AAAA`;

    expect(
      verifyDelegationToken(tampered, secret, {
        expectedIssuerSlug: 'lumen',
        expectedDelegateeSlug: 'wren',
        requiredScopes: ['send_to_inbox'],
        nowSeconds: 1_700_000_100,
      }).valid
    ).toBe(false);
  });

  it('mints only the current typ', () => {
    const token = mintDelegationToken(
      { issuerSlug: 'lumen', delegateeSlug: 'wren', scopes: ['send_to_inbox'] },
      secret
    );
    const header = JSON.parse(
      Buffer.from(token.split('.')[0]!.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()
    );
    expect(header.typ).toBe('Inkwell-DELEGATION');
  });
});
