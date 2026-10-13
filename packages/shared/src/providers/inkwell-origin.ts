/**
 * What counts as the same origin as this session's Inkwell server, for the
 * effective-config checks (codex-mcp-list.ts, gemini-settings-routing.ts).
 * Loopback aliases are one origin (Myra, #701): a config pointing at
 * 127.0.0.1 reaches the Inkwell the host names as localhost.
 */

/**
 * Loopback hosts, which all reach this machine: `localhost` and its
 * subdomains, 127.0.0.0/8, `::1` (bare or IPv4-mapped) and `0.0.0.0`, which
 * a client connecting to it lands on the local server with.
 */
function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    /^127(\.\d{1,3}){3}$/.test(host) ||
    host === '::1' ||
    host === '0.0.0.0' ||
    /^::ffff:(127(\.\d{1,3}){3}|7f[0-9a-f]{2}:[0-9a-f]{1,4})$/.test(host)
  );
}

/**
 * An origin with every loopback alias folded into one host. URL parsing has
 * already lower-cased the host, canonicalised IPv4 spellings and dropped a
 * default port written out.
 */
export function comparableOrigin(url: URL): string {
  const host = isLoopbackHost(url.hostname) ? 'loopback' : url.hostname;
  return `${url.protocol}//${host}:${url.port}`;
}

export function parseUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}
