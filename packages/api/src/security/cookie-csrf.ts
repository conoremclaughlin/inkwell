import type { RequestHandler } from 'express';
import cors from 'cors';

/** Keep this policy coupled to the non-simple-header CSRF defense. */
export function createBrowserCors(): RequestHandler {
  return cors({
    origin: ['http://localhost:3001', 'http://localhost:3002', 'http://localhost:3003'],
    credentials: true,
  });
}

/**
 * Cookie-authenticated mutations require a non-simple request header. Browsers
 * cannot attach it cross-origin without a successful CORS preflight; keep the
 * API's explicit origin allowlist (never reflect arbitrary credentialed origins).
 *
 * The web proxy checks same-origin before converting cookies to bearer auth and
 * supplies this header. Direct cookie clients must supply it themselves. Bearer
 * presence is NOT an exemption: invalid/expired JWTs can fall back to cookies.
 * This is the OWASP custom-header API defense, not a secret CSRF token.
 */
export const requireCookieCsrfHeader: RequestHandler = (req, res, next) => {
  const safeMethod = ['GET', 'HEAD', 'OPTIONS'].includes(req.method);
  if (!safeMethod && req.headers.cookie && req.get('X-Inkwell-CSRF') !== '1') {
    res.status(403).json({ error: 'Cookie-authenticated mutations require CSRF protection' });
    return;
  }
  next();
};
