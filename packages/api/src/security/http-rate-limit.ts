import { rateLimit } from 'express-rate-limit';
import type { IncomingHttpHeaders } from 'http';
import { BlockList, isIP } from 'net';
import type { HttpRateLimitConfig } from '../config/http-rate-limit';

// Node's IP parser handles IPv4-mapped IPv6 without hand-written address regexes.
const loopback = new BlockList();
loopback.addSubnet('127.0.0.0', 8, 'ipv4');
loopback.addAddress('::1', 'ipv6');

/**
 * Exempt direct local clients, NOT remote traffic through a local reverse proxy.
 * Header presence can only REMOVE this exemption; no claimed IP grants one.
 * This is not proof against a proxy that strips every forwarding indicator.
 * Such deployments must disable the exemption until proxy trust is configured.
 */
export function isDirectLoopbackRequest(request: {
  socket: { remoteAddress?: string };
  headers: IncomingHttpHeaders;
}): boolean {
  const address = request.socket.remoteAddress;
  if (!address) return false;
  const family = isIP(address);
  if (family !== 4 && family !== 6) return false;
  if (!loopback.check(address, family === 4 ? 'ipv4' : 'ipv6')) return false;

  return !Object.keys(request.headers).some((name) => {
    const header = name.toLowerCase();
    return (
      header === 'forwarded' ||
      header.startsWith('x-forwarded-') ||
      header.startsWith('cf-') ||
      header === 'x-real-ip' ||
      header === 'true-client-ip' ||
      header === 'via' ||
      header === 'cdn-loop'
    );
  });
}

/**
 * Per-process budgets. Key directly on the socket even if some other middleware
 * later enables Express trust-proxy. Header-aware attribution needs a separately
 * reviewed deployment policy; see ink://specs/http-rate-limiting.
 */
function createHttpRateLimiter(limit: number, windowMs: number, exemptLoopback: boolean) {
  return rateLimit({
    windowMs,
    limit,
    keyGenerator: (request) => request.socket.remoteAddress || 'unknown',
    skip: (request) => exemptLoopback && isDirectLoopbackRequest(request),
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many requests. Please try again later.' },
  });
}

export function createHttpRateLimiters(config: HttpRateLimitConfig) {
  return {
    ingress: createHttpRateLimiter(
      config.INK_HTTP_RATE_LIMIT_MAX,
      config.INK_HTTP_RATE_LIMIT_WINDOW_MS,
      config.INK_RATE_LIMIT_EXEMPT_LOOPBACK
    ),
    oauth: createHttpRateLimiter(
      config.INK_OAUTH_RATE_LIMIT_MAX,
      config.INK_OAUTH_RATE_LIMIT_WINDOW_MS,
      config.INK_RATE_LIMIT_EXEMPT_LOOPBACK
    ),
  };
}
