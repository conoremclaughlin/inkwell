import { rateLimit } from 'express-rate-limit';

/**
 * Per-process ingress budget, keyed on Express's socket-derived IP. Do not
 * enable blanket trust-proxy: a caller-supplied forwarded IP is not identity.
 * Credential routes retain their tighter per-account guessing limits too.
 */
export function createHttpRateLimiter(limit = 1200, windowMs = 60_000) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many requests. Please try again later.' },
  });
}
