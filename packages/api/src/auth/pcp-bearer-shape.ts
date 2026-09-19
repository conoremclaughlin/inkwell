/**
 * Is this bearer one of ours, by shape alone?
 *
 * Its own module rather than another export from `pcp-tokens`, because a dozen
 * suites mock that module wholesale and every export added there is a missing
 * function in one of them. Nothing here touches the database or the signing
 * key, so there is nothing to mock.
 *
 * SHAPE, not validity. This answers "was this minted by us" for a token we may
 * already know to be expired — the question a router asks when deciding which
 * verifier a credential belongs in front of. It is never a substitute for
 * `verifyPcpAccessToken`: the payload is read without checking the signature,
 * so anyone can produce a string that satisfies it. Use it to route, never to
 * authorise.
 */

const PCP_TOKEN_TYPES = new Set(['mcp_access', 'pcp_admin']);

export function isPcpIssuedJwt(token: string): boolean {
  const parts = token.split('.');
  if (parts.length !== 3) return false;

  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8')) as {
      type?: unknown;
      sub?: unknown;
    };
    return (
      typeof payload.type === 'string' &&
      PCP_TOKEN_TYPES.has(payload.type) &&
      typeof payload.sub === 'string' &&
      payload.sub.length > 0
    );
  } catch {
    return false;
  }
}
