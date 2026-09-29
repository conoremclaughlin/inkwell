/**
 * The delegation secret a spawned SB is handed.
 *
 * The ink chat child verifies and mints inter-SB delegation tokens
 * (`@inklabs/shared` security/delegation-token.ts) with a symmetric secret it
 * reads from `INK_DELEGATION_SECRET`, falling back to `JWT_SECRET`. Until
 * Phase 0 of spec:sender-token-binding the server set neither, and the child
 * inherited the server's whole environment, so the fallback meant every
 * spawned SB signed and verified with the API signing key itself.
 *
 * The child now receives a value DERIVED from the signing key: HMAC-SHA256 of
 * a fixed label under the key. Every child of one server derives the same
 * value, so tokens minted by one SB verify in another, and nothing that holds
 * the derived value can recover the key or sign an `mcp_access` token.
 */
import { createHmac } from 'crypto';

const DELEGATION_SECRET_LABEL = 'ink-delegation-secret:v1';

export function deriveDelegationSecret(jwtSecret: string | undefined): string | undefined {
  const key = jwtSecret?.trim();
  if (!key) return undefined;
  return createHmac('sha256', key).update(DELEGATION_SECRET_LABEL).digest('hex');
}
