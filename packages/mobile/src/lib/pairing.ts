/**
 * Pairing: what the dashboard's QR encodes, and how the phone turns it into
 * a server to talk to. Pure — the network probe is injected — so the parsing
 * and the URL choice are testable without a camera or a server.
 *
 * Payload (mirrors POST /api/admin/auth/mobile-pair): `{ ink: 1, c, u }`
 * where `c` is the bare 12-symbol code and `u` the candidate base URLs in the
 * server's order of preference (public URL, dashboard host, LAN addresses).
 */

export const PAIRING_CODE_LENGTH = 12;

export interface PairingPayload {
  /** Bare, normalised code — uppercase, no separators. */
  code: string;
  /** Candidate server URLs; empty when the code was typed rather than scanned. */
  urls: string[];
}

/** Accept the code however it was typed: lowercase, dashes, spaces. */
export function normalizePairingCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z2-9]/g, '');
}

export function formatPairingCode(code: string): string {
  return code.match(/.{1,4}/g)?.join('-') ?? code;
}

const isHttps = (url: string) => /^https:\/\//i.test(url);

function cleanUrls(candidates: unknown): string[] {
  if (!Array.isArray(candidates)) return [];
  const urls: string[] = [];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || !/^https?:\/\/\S+$/i.test(candidate)) continue;
    const normalized = candidate.replace(/\/+$/, '');
    if (!urls.includes(normalized)) urls.push(normalized);
  }
  // TLS first, whatever order arrived: the claim response is a long-lived
  // credential, and a reachable https address must never lose to a cleartext
  // one just because it was listed later. Stable sort keeps the server's
  // order within each group.
  return urls.sort((a, b) => Number(isHttps(b)) - Number(isHttps(a)));
}

/**
 * Parse a scanned QR or a hand-typed code. Returns null for anything that is
 * not a pairing payload — a QR for something else, a half-typed code.
 */
export function parsePairingInput(raw: string): PairingPayload | null {
  const text = raw.trim();
  if (!text) return null;

  if (text.startsWith('{')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return null;
    }
    if (!parsed || typeof parsed !== 'object') return null;
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.c !== 'string') return null;
    const code = normalizePairingCode(obj.c);
    if (code.length !== PAIRING_CODE_LENGTH) return null;
    return { code, urls: cleanUrls(obj.u) };
  }

  const code = normalizePairingCode(text);
  return code.length === PAIRING_CODE_LENGTH ? { code, urls: [] } : null;
}

/**
 * The first candidate (in the server's order) that answers the probe. Probes
 * run in parallel so a dead public URL does not delay the LAN one, but list
 * order still decides among the ones that answer — the order is the server's
 * preference, not an accident.
 */
export async function pickReachableUrl(
  urls: string[],
  probe: (url: string) => Promise<boolean>
): Promise<string | null> {
  const answers = await Promise.all(
    urls.map(async (url) => {
      try {
        return await probe(url);
      } catch {
        return false;
      }
    })
  );
  const index = answers.findIndex(Boolean);
  return index === -1 ? null : urls[index];
}
