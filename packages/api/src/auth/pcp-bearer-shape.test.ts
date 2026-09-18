import { describe, it, expect } from 'vitest';
import { isPcpIssuedJwt } from './pcp-bearer-shape';

const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const jwt = (payload: unknown) =>
  [part({ alg: 'HS256', typ: 'JWT' }), part(payload), 'signature'].join('.');

describe('isPcpIssuedJwt', () => {
  it('recognises both token types we mint', () => {
    expect(isPcpIssuedJwt(jwt({ type: 'pcp_admin', sub: 'user-1' }))).toBe(true);
    expect(isPcpIssuedJwt(jwt({ type: 'mcp_access', sub: 'user-1' }))).toBe(true);
  });

  it('recognises one that has already expired', () => {
    // The whole point of asking by shape: the caller already knows this token
    // failed verification, and is deciding which verifier it belonged in front
    // of. An expiry check here would answer a different question.
    expect(isPcpIssuedJwt(jwt({ type: 'pcp_admin', sub: 'user-1', exp: 1 }))).toBe(true);
  });

  it('rejects a token carrying a type we never mint', () => {
    expect(isPcpIssuedJwt(jwt({ type: 'supabase_access', sub: 'user-1' }))).toBe(false);
  });

  it('rejects a JWT with no type or no subject', () => {
    expect(isPcpIssuedJwt(jwt({ sub: 'user-1' }))).toBe(false);
    expect(isPcpIssuedJwt(jwt({ type: 'pcp_admin' }))).toBe(false);
    expect(isPcpIssuedJwt(jwt({ type: 'pcp_admin', sub: '' }))).toBe(false);
  });

  it('rejects a type or subject of the wrong JSON type', () => {
    expect(isPcpIssuedJwt(jwt({ type: 123, sub: 'user-1' }))).toBe(false);
    expect(isPcpIssuedJwt(jwt({ type: 'pcp_admin', sub: { id: 1 } }))).toBe(false);
  });

  it('rejects anything that is not three base64url segments of JSON', () => {
    expect(isPcpIssuedJwt('')).toBe(false);
    expect(isPcpIssuedJwt('opaque-supabase-token')).toBe(false);
    expect(isPcpIssuedJwt('two.parts')).toBe(false);
    expect(isPcpIssuedJwt('a.b.c.d')).toBe(false);
    expect(isPcpIssuedJwt('header.!!!not-base64!!!.sig')).toBe(false);
    expect(isPcpIssuedJwt(`header.${part('a bare string')}.sig`)).toBe(false);
  });
});
