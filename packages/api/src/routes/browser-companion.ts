/**
 * Browser companion router — the only surface a `browser_client` credential
 * can reach.
 *
 * The boundary is a **token type plus an explicit route allowlist, denied by
 * default**. That shape was not invented here: `admin.ts` already narrows
 * `mcp_access` tokens to two named route regexes on the admin router, and it
 * is the one capability narrowing in this codebase that actually enforces
 * something. Token `scope` strings do not — `mcp_tokens.scopes` is read in a
 * single place, joined into the next JWT, and no authorization decision
 * branches on it. So there is no scopes array here: it would have read like
 * least-privilege in review and granted everything at runtime.
 *
 * Two directions, both enforced:
 *   * a `browser_client` token reaches nothing outside ROUTES below;
 *   * `pcp_admin` and `mcp_access` tokens reach nothing inside it.
 *
 * Adding a companion endpoint means adding a ROUTES entry — a visible line in
 * a diff, in review. A handler added without one is unreachable, which is the
 * property worth having: routes cannot become companion-reachable by
 * accident.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../data/supabase/types';
import { logger } from '../utils/logger';
import {
  BROWSER_CLIENT_TOKEN_LIFETIME_SECONDS,
  readBearerToken,
  signBrowserClientToken,
  verifyBrowserClientToken,
  type BrowserClientTokenPayload,
} from '../auth/browser-client-tokens';
import {
  BrowserCompanionGrantService,
  normalizePairingCode,
} from '../services/browser-companion-grant.service';

export interface BrowserCompanionRequest extends Request {
  browserClient: BrowserClientTokenPayload;
}

/**
 * How a route's caller proves itself.
 *
 * `pairing_material` — the credential is in the body (a pairing code, or the
 * pairing secret). These are the only way to obtain a JWT, so they cannot
 * themselves require one.
 *
 * `browser_client_jwt` — bearer token, verified, then cross-checked against a
 * live grant row.
 *
 * `revocation` — bearer token **or** pairing secret, cross-checked against the
 * grant row for ownership but not for liveness. See REVOCATION below.
 */
type CompanionCredential = 'browser_client_jwt' | 'pairing_material' | 'revocation';

interface CompanionRoute {
  method: 'GET' | 'POST';
  path: string;
  credential: CompanionCredential;
}

/**
 * The allowlist. Four entries — this PR ships the credential boundary, not the
 * companion API. Thread reads, page observations and command/receipt
 * endpoints each arrive as their own entry.
 *
 * None of these is a page action. This grant is pairing and installation
 * authority: it says a `browser_client` credential may exist, and nothing
 * about whether a page may be read or written. Page-session authority is a
 * separate, separately human-authorized object with its own ceiling and its
 * own counter — `GET /session` reports the state of *this* grant and must not
 * be read as implying the other.
 */
const ROUTES: CompanionRoute[] = [
  { method: 'POST', path: '/auth/pair-claim', credential: 'pairing_material' },
  { method: 'POST', path: '/auth/token', credential: 'pairing_material' },
  { method: 'POST', path: '/auth/revoke', credential: 'revocation' },
  { method: 'GET', path: '/session', credential: 'browser_client_jwt' },
];

/** Exported so tests can assert the allowlist itself, not a copy of it. */
export const BROWSER_COMPANION_ALLOWLIST: ReadonlyArray<Readonly<CompanionRoute>> = ROUTES;

function matchRoute(method: string, path: string): CompanionRoute | null {
  // Exact match only. No prefixes, no parameters, no regex: a path either is
  // on the list or is not, and `/session` never spans `/session/../admin`.
  const normalized = path.endsWith('/') && path.length > 1 ? path.slice(0, -1) : path;
  return ROUTES.find((route) => route.method === method && route.path === normalized) ?? null;
}

type RevocationCaller =
  | { ok: true; claims: BrowserClientTokenPayload }
  | { ok: false; status: number; error: string };

/**
 * Identify the caller of `/auth/revoke` from either credential.
 *
 * The bearer token is tried first and, if present, is authoritative: a
 * malformed or foreign token is refused here rather than falling through to
 * the body, so presenting a bad JWT alongside a secret cannot downgrade the
 * check to the weaker of the two.
 *
 * This resolves *who*, not *whether*. Liveness is the caller's job — it is
 * deliberately not consulted on this path.
 */
async function resolveRevocationCaller(
  req: Request,
  grants: BrowserCompanionGrantService
): Promise<RevocationCaller> {
  const raw = readBearerToken(req.headers.authorization);
  if (raw) {
    const payload = verifyBrowserClientToken(raw);
    if (!payload) return { ok: false, status: 401, error: 'browser_credential_invalid' };
    return { ok: true, claims: payload };
  }

  const pairingSecret = typeof req.body?.pairingSecret === 'string' ? req.body.pairingSecret : '';
  const installationId =
    typeof req.body?.installationId === 'string' ? req.body.installationId.trim() : '';

  if (!pairingSecret || !installationId) {
    return { ok: false, status: 401, error: 'browser_credential_required' };
  }

  // The revocation lookup, not the token one: it also finds a secret that an
  // earlier revoke retired, so a retry whose first acknowledgement was lost
  // gets the same 200 rather than a 401 it cannot interpret.
  const resolved = await grants.resolveGrantForRevocation({ pairingSecret, installationId });
  if (!resolved.ok) return { ok: false, status: 401, error: 'invalid_secret' };

  return {
    ok: true,
    claims: {
      type: 'browser_client',
      sub: resolved.userId,
      workspaceId: resolved.workspaceId,
      installationId,
      grantId: resolved.grantId,
    },
  };
}

export function createBrowserCompanionRouter(client: SupabaseClient<Database>): Router {
  const router = Router();
  const grants = new BrowserCompanionGrantService(client);

  // --- Deny by default -----------------------------------------------------
  //
  // Runs before every handler. An unlisted path is refused here, so a handler
  // below can never be reached without a matching ROUTES entry.
  router.use(async (req: Request, res: Response, next: NextFunction) => {
    const route = matchRoute(req.method, req.path);
    if (!route) {
      res.status(403).json({ error: 'companion_route_not_allowed' });
      return;
    }

    if (route.credential === 'pairing_material') {
      // Pairing endpoints carry their credential in the body and are the only
      // way to obtain a JWT. A bearer token presented here is ignored rather
      // than honoured — no endpoint accepts two kinds of credential.
      next();
      return;
    }

    // --- REVOCATION ------------------------------------------------------
    //
    // Withdrawing a grant has to stay possible after it expires, which is
    // exactly when a user is most likely to want it gone. Two consequences,
    // and they are the whole of the exemption:
    //
    //   * the 300 s JWT is not the only accepted credential here — the
    //     pairing secret, which lives as long as the grant, also works, so a
    //     user is never locked out by a token that lapsed while the tab sat
    //     open;
    //   * the grant check runs with `requireLive: false`, dropping revoked
    //     and expired while keeping every identity condition.
    //
    // What it does NOT do is grant a read. This branch reaches one handler,
    // that handler writes `revoked_at` and returns an acknowledgement, and
    // `/session` — the only route that reports anything — is not on it.
    if (route.credential === 'revocation') {
      const payload = await resolveRevocationCaller(req, grants);
      if (!payload.ok) {
        res.status(payload.status).json({ error: payload.error });
        return;
      }

      let ownership;
      try {
        ownership = await grants.checkGrant(payload.claims, { requireLive: false });
      } catch {
        res.status(503).json({ error: 'grant_check_unavailable' });
        return;
      }

      if (!ownership.ok) {
        res.status(403).json({ error: 'grant_not_owned', reason: ownership.reason });
        return;
      }

      (req as BrowserCompanionRequest).browserClient = payload.claims;
      next();
      return;
    }

    const raw = readBearerToken(req.headers.authorization);
    if (!raw) {
      res.status(401).json({ error: 'browser_credential_required' });
      return;
    }

    // Deliberately only this verifier. A `pcp_admin` or `mcp_access` token is
    // signed with the same secret and verifies cryptographically; it is the
    // type discriminator that refuses it, and there is no fallback path that
    // would try another verifier if this one says no.
    const payload = verifyBrowserClientToken(raw);
    if (!payload) {
      res.status(401).json({ error: 'browser_credential_invalid' });
      return;
    }

    let check;
    try {
      check = await grants.checkGrant(payload, { requireLive: true });
    } catch {
      // Fail closed, but distinguishably: an outage is 503, not a 403 that
      // would read back as "the user revoked this".
      res.status(503).json({ error: 'grant_check_unavailable' });
      return;
    }

    if (!check.ok) {
      res.status(403).json({ error: 'grant_not_live', reason: check.reason });
      return;
    }

    (req as BrowserCompanionRequest).browserClient = payload;
    res.locals.grantState = { expiresAt: check.expiresAt, revokedAt: check.revokedAt };
    next();
  });

  // --- POST /auth/pair-claim ----------------------------------------------
  router.post('/auth/pair-claim', async (req: Request, res: Response) => {
    try {
      const code = normalizePairingCode(
        typeof req.body?.pairingCode === 'string' ? req.body.pairingCode : ''
      );
      const installationId =
        typeof req.body?.installationId === 'string' ? req.body.installationId.trim() : '';
      // The preimage of the commitment recorded when the code was minted. The
      // code and the installation id are both observable; this is not.
      const installationSecret =
        typeof req.body?.installationSecret === 'string' ? req.body.installationSecret : '';

      if (!code || !installationId || !installationSecret) {
        res.status(400).json({ error: 'pairing_code_installation_and_secret_required' });
        return;
      }

      const claim = await grants.claimPairingCode({
        pairingCode: code,
        installationId,
        installationSecret,
      });
      if (!claim.ok) {
        res.status(401).json({ error: 'invalid_or_expired_code' });
        return;
      }

      // The secret is returned exactly once. It belongs in the extension's
      // `storage.session` — cleared when the browser session ends, and not in
      // `storage.local` where it would outlive the user's intent.
      res.json({
        grantId: claim.grantId,
        pairingSecret: claim.pairingSecret,
        expiresAt: claim.expiresAt,
        storage: 'session',
      });
    } catch (error) {
      logger.error('Browser companion pair-claim failed', { error });
      res.status(500).json({ error: 'pairing_failed' });
    }
  });

  // --- POST /auth/token ----------------------------------------------------
  router.post('/auth/token', async (req: Request, res: Response) => {
    try {
      const pairingSecret =
        typeof req.body?.pairingSecret === 'string' ? req.body.pairingSecret : '';
      const installationId =
        typeof req.body?.installationId === 'string' ? req.body.installationId.trim() : '';

      if (!pairingSecret || !installationId) {
        res.status(400).json({ error: 'pairing_secret_and_installation_required' });
        return;
      }

      const resolved = await grants.resolveGrantForSecret({ pairingSecret, installationId });
      if (!resolved.ok) {
        res.status(401).json({ error: 'invalid_secret' });
        return;
      }

      // Liveness goes through the same RPC every request uses rather than a
      // second copy of the rules here.
      const check = await grants.checkGrant(
        {
          type: 'browser_client',
          sub: resolved.userId,
          workspaceId: resolved.workspaceId,
          installationId,
          grantId: resolved.grantId,
        },
        { requireLive: true }
      );

      if (!check.ok) {
        res.status(403).json({ error: 'grant_not_live', reason: check.reason });
        return;
      }

      const accessToken = signBrowserClientToken({
        userId: resolved.userId,
        workspaceId: resolved.workspaceId,
        installationId,
        grantId: resolved.grantId,
      });

      await grants.recordEvent(resolved.grantId, 'token_issued');

      res.json({
        accessToken,
        tokenType: 'Bearer',
        expiresIn: BROWSER_CLIENT_TOKEN_LIFETIME_SECONDS,
        grantExpiresAt: check.expiresAt,
      });
    } catch (error) {
      logger.error('Browser companion token mint failed', { error });
      res.status(500).json({ error: 'token_mint_failed' });
    }
  });

  // --- POST /auth/revoke ---------------------------------------------------
  //
  // Idempotent with either credential: a repeat answers exactly as the first
  // call did. Whether this call or an earlier one did the revoking is not in
  // the response. The caller asked for the grant to be dead, and it is.
  router.post('/auth/revoke', async (req: Request, res: Response) => {
    const { browserClient } = req as BrowserCompanionRequest;
    try {
      await grants.revokeGrant(browserClient.grantId, 'user_revoked');
      res.json({ revoked: true, grantId: browserClient.grantId });
    } catch (error) {
      logger.error('Browser companion revoke failed', { error });
      res.status(500).json({ error: 'revoke_failed' });
    }
  });

  // --- GET /session --------------------------------------------------------
  //
  // Reports the state of the PAIRING grant and nothing else. It is not a page
  // session, it does not imply permission to read or write a page, and the
  // `scope` it deliberately does not carry is not hiding in here either.
  router.get('/session', (req: Request, res: Response) => {
    const { browserClient } = req as BrowserCompanionRequest;
    const state = res.locals.grantState as { expiresAt: string; revokedAt: string | null };

    // Fields, not prose. A receipt that composes its own sentence eventually
    // asserts a cause nobody measured — `studio_lease_events` has already done
    // exactly that, stitching "tier studio-hint resolved a studio held by X"
    // out of two independently-correct fields when the hint was undefined.
    res.json({
      grantId: browserClient.grantId,
      installationId: browserClient.installationId,
      workspaceId: browserClient.workspaceId,
      userId: browserClient.sub,
      grantExpiresAt: state.expiresAt,
      grantRevokedAt: state.revokedAt,
      /** No page authority is conferred by this grant. Stated, not implied. */
      pageAuthority: 'none',
    });
  });

  return router;
}
