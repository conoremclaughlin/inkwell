/**
 * The `browser_client` credential boundary.
 *
 * Browser, admin and MCP tokens are all signed with the same JWT_SECRET, so
 * every one of them verifies cryptographically everywhere. The `type`
 * discriminator is the entire boundary, which is why it is tested in both
 * directions rather than only the one that matters today.
 */

import { describe, it, expect, vi } from 'vitest';
import jwt from 'jsonwebtoken';

vi.mock('../config/env', async () => ({
  env: {
    ...(await import('../test/fake-env')).fakeEnv,
  },
}));

import {
  BROWSER_CLIENT_TOKEN_TYPE,
  readBearerToken,
  signBrowserClientToken,
  verifyBrowserClientToken,
} from './browser-client-tokens';
import { signInkAccessToken, verifyInkAccessToken } from './ink-tokens';
import { fakeEnv } from '../test/fake-env';

const { JWT_SECRET } = fakeEnv;

const CLAIMS = {
  userId: '11111111-1111-4111-8111-111111111111',
  workspaceId: '22222222-2222-4222-8222-222222222222',
  installationId: 'installation-abc',
  grantId: '33333333-3333-4333-8333-333333333333',
};

/** The other Ink credentials do carry one; the browser token does not. */
const OTHER_CREDENTIAL_EMAIL = 'operator@example.com';

function adminToken(): string {
  return signInkAccessToken(
    { type: 'pcp_admin', sub: CLAIMS.userId, email: OTHER_CREDENTIAL_EMAIL, scope: 'admin' },
    3600
  );
}

function mcpToken(): string {
  return signInkAccessToken(
    { type: 'mcp_access', sub: CLAIMS.userId, email: OTHER_CREDENTIAL_EMAIL, scope: 'mcp:tools' },
    3600
  );
}

describe('browser_client tokens', () => {
  describe('round trip', () => {
    it('carries every binding through signing', () => {
      const payload = verifyBrowserClientToken(signBrowserClientToken(CLAIMS));

      expect(payload).not.toBeNull();
      expect(payload).toMatchObject({
        type: BROWSER_CLIENT_TOKEN_TYPE,
        sub: CLAIMS.userId,
        workspaceId: CLAIMS.workspaceId,
        installationId: CLAIMS.installationId,
        grantId: CLAIMS.grantId,
      });
    });

    it('does not carry a scope claim', () => {
      const decoded = jwt.decode(signBrowserClientToken(CLAIMS)) as Record<string, unknown>;

      // `mcp_tokens.scopes` is relayed into the JWT and read by no
      // authorization decision anywhere in packages/api/src. A scope string
      // here would read as least-privilege in review and mean nothing at
      // runtime, so the boundary is type + route allowlist instead.
      expect(decoded).not.toHaveProperty('scope');
    });

    it('expires', () => {
      const expired = signBrowserClientToken(CLAIMS, -1);
      expect(verifyBrowserClientToken(expired)).toBeNull();
    });

    it('carries four claims and no identity beyond them', () => {
      const decoded = jwt.decode(signBrowserClientToken(CLAIMS)) as Record<string, unknown>;

      // No email. The other Ink tokens carry one, so copying it across was the
      // natural thing to do — but nothing on the companion surface consumes
      // it, and a claim nobody reads is a value handed to the extension for
      // free. It goes in when a consumer exists.
      expect(decoded).not.toHaveProperty('email');
      expect(Object.keys(decoded).sort()).toEqual([
        'exp',
        'grantId',
        'iat',
        'installationId',
        'sub',
        'type',
        'workspaceId',
      ]);
    });

    it('strips a claim someone smuggles into a token they signed', () => {
      // The verifier rebuilds the payload field by field rather than handing
      // back what it decoded, so an extra claim cannot ride along into a
      // request and be read downstream as though the server had put it there.
      const smuggled = jwt.sign(
        {
          type: BROWSER_CLIENT_TOKEN_TYPE,
          ...CLAIMS,
          sub: CLAIMS.userId,
          email: 'someone@example.com',
          scope: 'admin',
        },
        JWT_SECRET,
        { expiresIn: 300 }
      );

      const payload = verifyBrowserClientToken(smuggled);
      expect(payload).not.toBeNull();
      expect(payload).not.toHaveProperty('email');
      expect(payload).not.toHaveProperty('scope');
    });
  });

  describe('mandatory bindings', () => {
    // A token missing one of these has nothing for the grant checker to
    // cross-check. Treating it as valid-but-unbound is the downgrade this
    // refuses: mint one without a grantId and the live-grant check has no row
    // to look up.
    for (const missing of ['workspaceId', 'installationId', 'grantId', 'sub'] as const) {
      it(`refuses a token with no ${missing}`, () => {
        const claims: Record<string, unknown> = {
          type: BROWSER_CLIENT_TOKEN_TYPE,
          sub: CLAIMS.userId,
          workspaceId: CLAIMS.workspaceId,
          installationId: CLAIMS.installationId,
          grantId: CLAIMS.grantId,
        };
        delete claims[missing];

        const forged = jwt.sign(claims, JWT_SECRET, { expiresIn: 300 });
        expect(verifyBrowserClientToken(forged)).toBeNull();
      });

      it(`refuses a token whose ${missing} is empty`, () => {
        const forged = jwt.sign(
          {
            type: BROWSER_CLIENT_TOKEN_TYPE,
            sub: CLAIMS.userId,
            workspaceId: CLAIMS.workspaceId,
            installationId: CLAIMS.installationId,
            grantId: CLAIMS.grantId,
            [missing]: '',
          },
          JWT_SECRET,
          { expiresIn: 300 }
        );
        expect(verifyBrowserClientToken(forged)).toBeNull();
      });
    }

    it('CONTROL: the same construction with every binding present is accepted', () => {
      // Without this the sixteen refusals above would all pass against a
      // verifier that refuses everything.
      const wellFormed = jwt.sign(
        {
          type: BROWSER_CLIENT_TOKEN_TYPE,
          sub: CLAIMS.userId,
          workspaceId: CLAIMS.workspaceId,
          installationId: CLAIMS.installationId,
          grantId: CLAIMS.grantId,
        },
        JWT_SECRET,
        { expiresIn: 300 }
      );
      expect(verifyBrowserClientToken(wellFormed)).not.toBeNull();
    });
  });

  describe('the browser verifier refuses other credential types', () => {
    it('refuses a pcp_admin token', () => {
      expect(verifyBrowserClientToken(adminToken())).toBeNull();
    });

    it('refuses an mcp_access token', () => {
      expect(verifyBrowserClientToken(mcpToken())).toBeNull();
    });

    it('refuses a token signed with a different secret', () => {
      const foreign = jwt.sign(
        { type: BROWSER_CLIENT_TOKEN_TYPE, ...CLAIMS, sub: CLAIMS.userId },
        'a-different-fake-secret-min-32-chars',
        { expiresIn: 300 }
      );
      expect(verifyBrowserClientToken(foreign)).toBeNull();
    });
  });

  describe('the Ink verifier refuses browser tokens', () => {
    const browser = () => signBrowserClientToken(CLAIMS);

    it('refuses one presented as pcp_admin', () => {
      expect(verifyInkAccessToken(browser(), 'pcp_admin')).toBeNull();
    });

    it('refuses one presented as mcp_access', () => {
      expect(verifyInkAccessToken(browser(), 'mcp_access')).toBeNull();
    });

    it('refuses one when no expected type is named at all', () => {
      // The case the type union alone does not cover. `verifyInkAccessToken`
      // only compared `payload.type` against `expectedType` *when one was
      // passed*, so a call site that omitted it accepted any type that
      // verified — and a browser token verifies, because it shares the
      // secret. Every call site today passes a type; this closes the next one
      // that does not.
      expect(verifyInkAccessToken(browser())).toBeNull();
    });

    it('CONTROL: a pcp_admin token with no expected type is still accepted', () => {
      // Pins the guard to unknown types. Without this the assertion above
      // would also pass if the no-expectedType path had simply been broken.
      const payload = verifyInkAccessToken(adminToken());
      expect(payload).not.toBeNull();
      expect(payload!.type).toBe('pcp_admin');
    });

    it('CONTROL: an mcp_access token with no expected type is still accepted', () => {
      expect(verifyInkAccessToken(mcpToken())?.type).toBe('mcp_access');
    });
  });

  describe('readBearerToken', () => {
    it('reads a bearer token', () => {
      expect(readBearerToken('Bearer abc.def.ghi')).toBe('abc.def.ghi');
    });

    it.each([undefined, '', 'abc.def.ghi', 'Basic abc', 'bearer abc', 'Bearer   '])(
      'returns null for %p',
      (header) => {
        expect(readBearerToken(header as string | undefined)).toBeNull();
      }
    );
  });
});
