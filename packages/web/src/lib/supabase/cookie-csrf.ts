/** Check before cookie-to-bearer injection; never trust forwarded-host headers. */
export function hasSameOrigin(request: { headers: Headers; url: string }): boolean {
  // Treat same-site siblings as untrusted too. A subdomain is not our origin.
  const fetchSite = request.headers.get('sec-fetch-site');
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') return false;
  const origin = request.headers.get('origin');
  const referer = request.headers.get('referer');
  try {
    const expected = new URL(request.url).origin;
    // Never let a Referer override a present but invalid or opaque Origin.
    if (origin !== null) return origin === expected;
    return referer !== null && new URL(referer).origin === expected;
  } catch {
    return false;
  }
}
