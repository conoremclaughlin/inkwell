/**
 * The Inkling app's view of its Google connection (Connectors).
 *
 * Mounted by routes/admin.ts under /api/admin/connectors, after admin auth.
 * It reads and changes the person's cloud connection only (connected_accounts,
 * scoped as the existing routes scope it) and never returns tokens, host paths
 * or desktop-credential details.
 *
 * A desktop credential (`ink google login` on the server host, bound by email)
 * is reported as one fact, `serverSignIn`: `yes` if the server could use one
 * for this person, `no` if it couldn't, `unknown` if that can't be read. The
 * server may still use one after the person disconnects here. Whether a
 * deployment runs with GOOGLE_CREDENTIAL_SOURCES=cloud is its operator's
 * choice; this route only reports what the running service would do.
 *
 * Connecting is an attempt: start returns the provider's sign-in address and an
 * attempt id, and only the OAuth callback for that attempt's own state settles
 * it (services/oauth-attempts.ts). The app asks how its attempt ended; an
 * account that was already connected is never evidence that a new attempt
 * worked.
 */
import { Router, type Request, type Response } from 'express';
import { getOAuthService } from '../services/oauth';
import { attemptStatus, oauthRedirectUri, startAppAttempt } from '../services/oauth-attempts';
import { logger } from '../utils/logger';

type SignedIn = Request & { inkUserId: string; inkWorkspaceId: string };

const PROVIDER = 'google';

/** The Google services this server's tools use, by the scopes that grant them. */
export const GOOGLE_SERVICES = [
  { service: 'gmail', scopePrefix: 'https://www.googleapis.com/auth/gmail.' },
  { service: 'calendar', scopePrefix: 'https://www.googleapis.com/auth/calendar' },
  { service: 'drive', scopePrefix: 'https://www.googleapis.com/auth/drive' },
  { service: 'docs', scopePrefix: 'https://www.googleapis.com/auth/documents' },
  { service: 'sheets', scopePrefix: 'https://www.googleapis.com/auth/spreadsheets' },
] as const;

export type GoogleService = (typeof GOOGLE_SERVICES)[number]['service'];

/** The services an account's granted scopes cover. */
export function servicesFrom(scopes: readonly string[]): GoogleService[] {
  return GOOGLE_SERVICES.filter(({ scopePrefix }) =>
    scopes.some((scope) => scope.startsWith(scopePrefix))
  ).map(({ service }) => service);
}

export type ServerSignIn = 'yes' | 'no' | 'unknown';

/**
 * Whether the server could use a desktop credential for this person. A lookup
 * that fails, or storage that can't be read, is `unknown`, never `no`.
 */
async function serverSignIn(userId: string): Promise<ServerSignIn> {
  const oauth = getOAuthService();
  if (!oauth.getCredentialSources().includes('desktop')) return 'no';
  try {
    const desktop = await oauth.describeDesktopCredentials(userId);
    if (desktop.error) return 'unknown';
    return desktop.credentials.some((credential) => credential.state !== 'unusable') ? 'yes' : 'no';
  } catch {
    return 'unknown';
  }
}

export const connectorsRouter: Router = Router();

/**
 * GET /api/admin/connectors/google
 * The person's Google accounts: email, name, stored status (`active` or
 * `needs_attention`; not a live check), the services its granted scopes cover.
 * Never tokens or paths.
 */
connectorsRouter.get('/google', async (req: Request, res: Response) => {
  try {
    const { inkUserId, inkWorkspaceId } = req as SignedIn;
    const oauth = getOAuthService();
    const accounts = (await oauth.getConnectedAccounts(inkUserId, inkWorkspaceId)).filter(
      (account) => account.provider === PROVIDER
    );
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      configured: oauth.isProviderConfigured(PROVIDER),
      accounts: accounts.map((account) => ({
        id: account.id,
        email: account.email,
        displayName: account.displayName,
        // The stored status, not a live check: a token can still fail when used.
        status: account.status === 'active' ? 'active' : 'needs_attention',
        services: servicesFrom(account.scopes),
        connectedAt: account.createdAt,
      })),
      serverSignIn: await serverSignIn(inkUserId),
    });
  } catch (error) {
    logger.error('Connectors: failed to list Google accounts', {
      reason: error instanceof Error ? error.name : 'unknown',
    });
    res.status(500).json({ error: 'Failed to list Google accounts' });
  }
});

/**
 * POST /api/admin/connectors/google/start
 * Starts a connection: { authUrl, attemptId }. The app opens authUrl in the
 * system browser and asks how attemptId ended when the person comes back.
 */
connectorsRouter.post('/google/start', async (req: Request, res: Response) => {
  try {
    const { inkUserId, inkWorkspaceId } = req as SignedIn;
    const oauth = getOAuthService();
    if (!oauth.isProviderConfigured(PROVIDER)) {
      res.status(409).json({
        error: 'Google isn’t set up on this server',
        code: 'google_not_configured',
      });
      return;
    }
    const { attemptId, state } = startAppAttempt(inkUserId, inkWorkspaceId, PROVIDER);
    const authUrl = oauth.getAuthorizationUrl(PROVIDER, oauthRedirectUri(PROVIDER), state);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ authUrl, attemptId });
  } catch (error) {
    logger.error('Connectors: failed to start a Google connection', {
      reason: error instanceof Error ? error.name : 'unknown',
    });
    res.status(500).json({ error: 'Failed to start the connection' });
  }
});

/**
 * GET /api/admin/connectors/google/attempts/:attemptId
 * How the person's own attempt ended: pending, connected (with the account it
 * saved), denied, expired, failed, or unknown (not theirs, a restart, or long
 * ago).
 */
connectorsRouter.get('/google/attempts/:attemptId', (req: Request, res: Response) => {
  const { inkUserId } = req as SignedIn;
  res.setHeader('Cache-Control', 'no-store');
  res.json(attemptStatus(inkUserId, req.params.attemptId));
});

/**
 * DELETE /api/admin/connectors/google/:accountId
 * Disconnects one account: Inkling's copy is removed, and Google is asked to
 * revoke the grant. The answer says what happened to each, and whether the
 * server could still use a desktop credential for this person.
 */
connectorsRouter.delete('/google/:accountId', async (req: Request, res: Response) => {
  try {
    const { inkUserId, inkWorkspaceId } = req as SignedIn;
    const oauth = getOAuthService();
    const own = (await oauth.getConnectedAccounts(inkUserId, inkWorkspaceId)).some(
      (account) => account.id === req.params.accountId && account.provider === PROVIDER
    );
    if (!own) {
      res.status(404).json({ error: 'No such Google account', code: 'account_not_found' });
      return;
    }
    const { revoked } = await oauth.disconnectAccount(
      req.params.accountId,
      inkUserId,
      inkWorkspaceId
    );
    res.json({
      removed: true,
      revokedAtGoogle: revoked,
      serverSignIn: await serverSignIn(inkUserId),
    });
  } catch (error) {
    logger.error('Connectors: failed to disconnect a Google account', {
      reason: error instanceof Error ? error.name : 'unknown',
    });
    res.status(500).json({ error: 'Failed to disconnect the account' });
  }
});
