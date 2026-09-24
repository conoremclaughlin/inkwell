/** Check before cookie-to-bearer injection; never trust forwarded-host headers. */
export function hasSameOrigin(request: { headers: Headers; url: string }): boolean {
  // Treat same-site siblings as untrusted too. A subdomain is not our origin.
  const fetchSite = request.headers.get('sec-fetch-site');
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') return false;
  const origin = request.headers.get('origin');
  const referer = request.headers.get('referer');
  try {
    const url = new URL(request.url);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    // Next can build request.url from its bind address and normalize loopback
    // IPs to localhost. HTTP Host retains the browser's requested authority.
    // Browsers cannot override Host; a reverse proxy must preserve it. Never
    // substitute X-Forwarded-Host without a separately reviewed trust policy.
    const host = request.headers.get('host');
    if (host !== null && (!host || host.length > 512 || /[\\/?#@\s,]/.test(host))) return false;
    const expected = host === null ? url.origin : new URL(`${url.protocol}//${host}`).origin;
    // Never let a Referer override a present but invalid or opaque Origin.
    if (origin !== null) return origin === expected;
    return referer !== null && new URL(referer).origin === expected;
  } catch {
    return false;
  }
}
