/**
 * Browser companion client tokens.
 *
 * A separate credential type for the browser extension, deliberately kept out
 * of `InkTokenPayload`. Two properties this file exists to hold:
 *
 * 1. **No `scope` claim.** `mcp_tokens.scopes` is read in exactly one place
 *    (ink-tokens.ts, where it is joined into the next JWT) and no
 *    authorization decision in `packages/api/src` branches on it. A scope
 *    string on a browser token would read as least-privilege in review and
 *    mean nothing at runtime. The boundary is the token *type* plus the
 *    companion router's route allowlist, both of which are enforced.
 *
 * 2. **The bindings are mandatory.** A `browser_client` token missing
 *    `workspaceId`, `installationId` or `grantId` is rejected outright rather
 *    than treated as an unbound-but-valid token. Those three claims are what
 *    the live grant row is cross-checked against on every companion call; a
 *    token that carries none of them has nothing to check and would sail
 *    through a checker written to skip absent claims.
 *
 * The secret these are signed with is shared with `ink-tokens.ts`, so the type
 * discriminator is the only thing separating a browser token from an admin or
 * MCP one. `verifyInkAccessToken` refuses any type outside its own union
 * (including this one) whether or not its caller passed an expected type —
 * see the note there.
 */

import jwt from 'jsonwebtoken';
import { env } from '../config/env';

export const BROWSER_CLIENT_TOKEN_TYPE = 'browser_client';

/**
 * Five minutes.
 *
 * A JWT is unrevocable for its own lifetime — verification is local, with no
 * DB read — so this number *is* the revocation lag for any route that does not
 * independently check the grant. Every companion route does check it today, so
 * revocation is already immediate; this bounds the damage from a future route
 * that forgets. An hour (the admin lifetime) would make that mistake cost an
 * hour of live browser authority after the user clicks Disconnect.
 */
export const BROWSER_CLIENT_TOKEN_LIFETIME_SECONDS = 300;

/**
 * Exactly four claims, and each one is load-bearing.
 *
 * No `email`. The other Ink tokens carry one, so the natural thing was to copy
 * it across — but nothing on the companion surface consumes it, and a claim
 * nobody reads is a value handed to the extension for free. It goes in when a
 * consumer exists, not before.
 */
export interface BrowserClientTokenPayload {
  type: typeof BROWSER_CLIENT_TOKEN_TYPE;
  /** Inkwell user id. */
  sub: string;
  /** Product workspace the grant belongs to. */
  workspaceId: string;
  /** The extension installation this token was minted for. */
  installationId: string;
  /** Row in `browser_companion_grants` this token's authority hangs from. */
  grantId: string;
}

export interface BrowserClientTokenClaims {
  userId: string;
  workspaceId: string;
  installationId: string;
  grantId: string;
}

export function signBrowserClientToken(
  claims: BrowserClientTokenClaims,
  expiresInSeconds: number = BROWSER_CLIENT_TOKEN_LIFETIME_SECONDS
): string {
  const payload: BrowserClientTokenPayload = {
    type: BROWSER_CLIENT_TOKEN_TYPE,
    sub: claims.userId,
    workspaceId: claims.workspaceId,
    installationId: claims.installationId,
    grantId: claims.grantId,
  };

  return jwt.sign(payload, env.JWT_SECRET, { expiresIn: expiresInSeconds });
}

/**
 * Verify a browser companion token.
 *
 * Returns null for anything that is not a well-formed, unexpired
 * `browser_client` token carrying all three bindings. Signature validity alone
 * is never enough: an admin or MCP token is signed with the same secret and
 * will verify cryptographically, so the type check is the boundary.
 *
 * This says nothing about whether the grant is still live — that is a DB read,
 * and it happens on every companion request in the grant service.
 */
export function verifyBrowserClientToken(token: string): BrowserClientTokenPayload | null {
  let decoded: unknown;
  try {
    decoded = jwt.verify(token, env.JWT_SECRET);
  } catch {
    return null;
  }

  if (typeof decoded !== 'object' || decoded === null) return null;

  const payload = decoded as Partial<BrowserClientTokenPayload>;

  if (payload.type !== BROWSER_CLIENT_TOKEN_TYPE) return null;

  // Every binding is required. Absent claim = invalid token, not "unbound".
  if (
    typeof payload.sub !== 'string' ||
    !payload.sub ||
    typeof payload.workspaceId !== 'string' ||
    !payload.workspaceId ||
    typeof payload.installationId !== 'string' ||
    !payload.installationId ||
    typeof payload.grantId !== 'string' ||
    !payload.grantId
  ) {
    return null;
  }

  // Rebuilt field by field rather than returned as-is: an extra claim someone
  // smuggles into a token they signed cannot ride along into the request.
  return {
    type: BROWSER_CLIENT_TOKEN_TYPE,
    sub: payload.sub,
    workspaceId: payload.workspaceId,
    installationId: payload.installationId,
    grantId: payload.grantId,
  };
}

/** Pull the raw token out of an `Authorization: Bearer …` header. */
export function readBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.substring(7).trim();
  return token || null;
}
