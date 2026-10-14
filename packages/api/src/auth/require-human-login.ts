import type { RequestHandler } from 'express';
import { verifyInkAccessToken } from './ink-tokens';

/**
 * A closed vocabulary keeps future binding claims from silently becoming human
 * credentials. Any other key is refused even if its value is empty or malformed.
 */
const HUMAN_LOGIN_CLAIMS = new Set(['type', 'sub', 'email', 'scope', 'iat', 'exp', 'nbf']);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Strict preflight for human consent routes. Mount BEFORE admin middleware:
 * rejecting a bearer must never fall through to that middleware's refresh cookie
 * or Supabase-login exchange. The app must refresh its own login and try again.
 *
 * This proves only an unbound human-login credential, not current account or
 * workspace authority. The ordinary account lease / existence / membership
 * checks must still run, and the route must compare their resolved user to
 * res.locals.humanLoginUserId before reading or changing an approval.
 * No route is mounted by this module, and no grant is made here.
 */
export const requireHumanLogin: RequestHandler = (req, res, next) => {
  delete res.locals.humanLoginUserId;
  const header = req.headers.authorization;
  const match = typeof header === 'string' ? /^Bearer (\S+)$/i.exec(header) : null;
  if (!match || match[0] !== header) {
    res.status(401).json({ error: 'Human login required', code: 'human_login_required' });
    return;
  }

  const payload = verifyInkAccessToken(match[1], 'pcp_admin');
  if (
    !payload ||
    payload.type !== 'pcp_admin' ||
    payload.scope !== 'admin' ||
    typeof payload.sub !== 'string' ||
    !UUID.test(payload.sub) ||
    typeof payload.exp !== 'number' ||
    !Number.isFinite(payload.exp) ||
    payload.exp <= Date.now() / 1000
  ) {
    res.status(401).json({ error: 'Human login required', code: 'human_login_required' });
    return;
  }
  if (Object.keys(payload).some((key) => !HUMAN_LOGIN_CLAIMS.has(key))) {
    res.status(403).json({ error: 'A human must confirm this action', code: 'human_login_bound' });
    return;
  }

  res.locals.humanLoginUserId = payload.sub;
  next();
};
