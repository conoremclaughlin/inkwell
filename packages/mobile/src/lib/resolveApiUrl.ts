/**
 * API base URL resolution, kept pure so it can be tested without Expo or a
 * React Native runtime. The wiring to expo-constants lives in ./api.ts.
 */

export type ApiUrlSource =
  /** EXPO_PUBLIC_API_URL was set explicitly. */
  | 'env'
  /** Derived from the Metro host serving the bundle. */
  | 'metro'
  /** The dev machine's LAN address, recorded in app config at bundle time. */
  | 'lan'
  /** Production URL configured in app.json under extra.productionApiUrl. */
  | 'config'
  /** Nothing else applied — loopback, which only works in a simulator. */
  | 'fallback';

export interface ResolveApiUrlInput {
  /** Raw EXPO_PUBLIC_API_URL, inlined at build time. */
  explicit?: unknown;
  /**
   * Candidate strings that might carry the Metro host, tried in order.
   *
   * Which one Expo populates varies by runtime — `expoConfig.hostUri` is
   * documented as dev-only, `expoGoConfig.debuggerHost` appears under Expo Go,
   * and `linkingUri` is a full `exp://host:port/` URL. Reading only one of them
   * silently falls through to loopback, which is fatal on a physical device.
   */
  metroHostCandidates?: (string | undefined | null)[];
  /**
   * The dev machine's LAN IPv4, captured by app.config.js at bundle time.
   *
   * Only reachable when the phone is on the same network, so it sits below the
   * live Metro host — but it is the difference between a working release build
   * on a device and a loopback URL that can never resolve.
   */
  lanHost?: unknown;
  /**
   * Production API URL from app config. Typed `unknown` on purpose: app config
   * is JSON that Expo rewrites on the way through, so this is not guaranteed
   * to be a string even when app.json says it is.
   */
  productionApiUrl?: unknown;
  /** React Native's __DEV__ — false in release builds. */
  isDev: boolean;
  /**
   * Port the Inkwell API server listens on — from app.config.js, which reads
   * PCP_PORT_BASE on the machine that started Metro. Not guessable on-device,
   * which is why it is passed in rather than assumed.
   */
  port: number;
}

export interface ResolvedApiUrl {
  url: string;
  source: ApiUrlSource;
}

/**
 * Pull the bare hostname out of anything Expo might hand us — "host:port",
 * "exp://host:port/path", or a plain hostname.
 */
export function hostnameFrom(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  let s = raw.trim();
  if (!s) return undefined;

  const scheme = s.indexOf('://');
  if (scheme >= 0) s = s.slice(scheme + 3);

  s = s.split('/')[0];

  const colon = s.lastIndexOf(':');
  if (colon > 0) s = s.slice(0, colon);

  // A leftover colon means there was no host part at all (":8081"), which is
  // not something we can build a URL from.
  if (!s || s.includes(':')) return undefined;

  return s;
}

/**
 * Resolve the API base URL. Precedence:
 *
 *   1. EXPO_PUBLIC_API_URL — an explicit override always wins, so pointing a
 *      build at a remote API is a one-line change.
 *   2. Metro's host — in a dev build the phone is already talking to the dev
 *      machine, and the API is on that same machine at `port`. This makes the
 *      app follow a changing LAN IP with no rebuild and no .env edit.
 *   3. extra.lanHost — the dev machine's address, recorded at bundle time. This
 *      is what saves an on-device build that has no Metro to ask: without it
 *      the only remaining answer is loopback, which on a phone is the phone.
 *   4. extra.productionApiUrl — a real deployment, once dev autodiscovery is
 *      out of the picture.
 *   5. Loopback — last resort. Correct for the iOS simulator, useless on a
 *      physical device, which is why callers surface `source` in errors.
 *
 * Metro is checked before the baked LAN address rather than after, so a dev
 * build follows a changing DHCP lease instead of a stale build-time snapshot;
 * and both are checked before the production URL, so a dev build keeps
 * autodiscovering even once a production URL is configured.
 */
export function resolveApiUrl(input: ResolveApiUrlInput): ResolvedApiUrl {
  const explicit = asTrimmedString(input.explicit);
  if (explicit) return { url: stripTrailingSlash(explicit), source: 'env' };

  for (const candidate of input.metroHostCandidates ?? []) {
    const host = hostnameFrom(candidate);
    if (host) return { url: `http://${host}:${input.port}`, source: 'metro' };
  }

  const lan = asTrimmedString(input.lanHost);
  if (lan) return { url: `http://${lan}:${input.port}`, source: 'lan' };

  const production = asTrimmedString(input.productionApiUrl);
  if (production) return { url: stripTrailingSlash(production), source: 'config' };

  return { url: `http://127.0.0.1:${input.port}`, source: 'fallback' };
}

/**
 * Values reaching here come from app config, which is not type-checked at the
 * boundary: Expo resolves a JSON `null` in `extra` to `{}`, and `{}?.trim()`
 * does not short-circuit — it throws. That crashed at module import, which in
 * a release build means the app dies on launch with no useful message. Anything
 * that is not a non-empty string is treated as absent.
 */
function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

/** True when the URL points at the device itself — never right on hardware. */
export function isLoopback(url: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(url);
}

/**
 * Human-readable explanation of why a request to `url` might have failed,
 * given how the URL was chosen. Generic "network error" text sends people
 * hunting in the wrong place.
 */
export function describeApiUrlProblem(
  resolved: ResolvedApiUrl,
  isDev: boolean
): string | undefined {
  if (resolved.source === 'fallback' && !isDev) {
    return 'No production API URL is configured. Set extra.productionApiUrl in app.json, or EXPO_PUBLIC_API_URL for this build.';
  }
  if (isLoopback(resolved.url)) {
    return 'On a physical device localhost is the phone itself. Start Metro so the host can be detected, or set EXPO_PUBLIC_API_URL to your machine’s LAN address.';
  }
  if (resolved.source === 'metro') {
    return 'Auto-detected from the Metro host. Check the web dev server is running and on the same network.';
  }
  if (resolved.source === 'lan') {
    return "Using the build machine's LAN address, recorded when this build was made. If that machine moved network or changed IP, rebuild or set the server URL in Settings.";
  }
  return undefined;
}
