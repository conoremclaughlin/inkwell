/**
 * The app's HTTP layer: base-URL resolution, bearer auth, and one-shot
 * refresh-and-retry on 401.
 *
 * Base URL precedence: a server URL saved in Settings always wins, then the
 * build-time EXPO_PUBLIC_API_URL, then the Metro host (dev builds follow the
 * machine serving the bundle — the Inkwell server is on that same machine),
 * then the LAN address baked in by app.config.js and productionApiUrl, then
 * loopback.
 *
 * Those last two swap with the build: a dev build takes the LAN address first,
 * a release build takes the configured production URL first and keeps LAN only
 * as a fallback — otherwise a shipped app addresses the machine that built it.
 * resolveApiUrl owns that rule; see its doc comment.
 *
 * The discovered port applies to the tiers that only supply a HOST — Metro,
 * the baked LAN address, and loopback. EXPO_PUBLIC_API_URL and
 * productionApiUrl are full URLs and carry their own ports, which is the point
 * of setting them.
 */
import Constants from 'expo-constants';
import { describeApiUrlProblem, resolveApiUrl, type ResolvedApiUrl } from './resolveApiUrl';
import { clearAuth, getAuthState, storeLogin, storeRefreshedAccess } from './auth';
import { pickReachableUrl, type PairingPayload } from './pairing';
import {
  getServerUrlOverride,
  getWorkspaceId,
  setServerUrlOverride,
  setWorkspaceId,
} from './storage';
import type { LoginResponse, RefreshResponse, SignupResponse } from './types';

/**
 * Port the Inkwell API listens on, for the tiers that supply only a host.
 *
 * app.config.js reads INK_PORT_BASE — falling back to the legacy
 * PCP_PORT_BASE, matching the server's own resolution in
 * packages/api/src/config/env.ts — on the machine that started Metro, and
 * publishes it here. So an isolated server (4001, 4801, …) is reached without
 * anyone editing a constant or typing a URL on a phone keyboard. The literal
 * is only the floor for a config that predates the field.
 */
const PCP_API_PORT = Number(Constants.expoConfig?.extra?.apiPort) || 3001;

// Which of these Expo populates depends on the runtime, so try them all rather
// than trusting one and silently landing on loopback.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const constantsAny = Constants as unknown as Record<string, any>;

const resolved: ResolvedApiUrl = resolveApiUrl({
  explicit: process.env.EXPO_PUBLIC_API_URL,
  metroHostCandidates: [
    Constants.expoConfig?.hostUri,
    constantsAny.expoGoConfig?.debuggerHost,
    constantsAny.manifest?.debuggerHost,
    constantsAny.manifest2?.extra?.expoGo?.debuggerHost,
    Constants.linkingUri,
  ],
  lanHost: Constants.expoConfig?.extra?.lanHost as string | null | undefined,
  productionApiUrl: Constants.expoConfig?.extra?.productionApiUrl as string | undefined,
  isDev: __DEV__,
  port: PCP_API_PORT,
});

export const AUTO_API_BASE_URL = resolved.url;
export const API_URL_SOURCE = resolved.source;

/** Hint explaining a connection failure, or undefined if the setup looks sound. */
export const API_URL_HINT = describeApiUrlProblem(resolved, __DEV__);

/** Settings override beats autodiscovery; empty override means "auto". */
export function apiBaseUrl(): string {
  const override = getServerUrlOverride();
  return override || AUTO_API_BASE_URL;
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function parseError(res: Response): Promise<ApiError> {
  let message = `HTTP ${res.status}`;
  try {
    const body = (await res.json()) as { error?: string };
    if (body?.error) message = body.error;
  } catch {
    // Non-JSON error body; the status alone will have to do.
  }
  return new ApiError(res.status, message);
}

/**
 * One refresh at a time: concurrent 401s (thread list + messages + sessions
 * all polling) must not each burn a refresh call. Everyone awaits the same
 * in-flight exchange.
 */
let refreshInFlight: Promise<boolean> | null = null;

async function tryRefresh(): Promise<boolean> {
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      const { refreshToken } = getAuthState();
      if (!refreshToken) return false;
      try {
        const res = await fetch(`${apiBaseUrl()}/api/admin/auth/mobile-refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken }),
        });
        if (!res.ok) return false;
        const body = (await res.json()) as RefreshResponse;
        await storeRefreshedAccess(body);
        return true;
      } catch {
        return false;
      }
    })().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

/**
 * Authenticated JSON request. On 401, refreshes once and retries; a second
 * 401 signs the user out — the refresh token is dead and every subsequent
 * call would fail the same way.
 */
export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const attempt = async (): Promise<Response> => {
    const { accessToken } = getAuthState();
    const workspaceId = getWorkspaceId();
    return fetch(`${apiBaseUrl()}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        // Scope every call to the selected workspace; absent means the
        // server's default (the personal workspace).
        ...(workspaceId ? { 'x-ink-workspace-id': workspaceId } : {}),
        ...(init?.headers ?? {}),
      },
    });
  };

  let res = await attempt();
  if (res.status === 401) {
    const refreshed = await tryRefresh();
    if (!refreshed) {
      await clearAuth();
      throw new ApiError(401, 'Session expired — sign in again');
    }
    res = await attempt();
    if (res.status === 401) {
      await clearAuth();
      throw new ApiError(401, 'Session expired — sign in again');
    }
  }
  // A remembered workspace the account can no longer reach (membership
  // revoked, workspace archived, different account signed in) would otherwise
  // wedge every screen. The middleware answers 403/404 "Workspace not found…"
  // for exactly that; fall back to the default workspace and retry once.
  if ((res.status === 403 || res.status === 404) && getWorkspaceId()) {
    const err = await parseError(res);
    if (/workspace not found/i.test(err.message)) {
      await setWorkspaceId(null);
      res = await attempt();
    } else {
      throw err;
    }
  }
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as T;
}

/** Email/password login; stores the token pair on success. */
export async function login(email: string, password: string): Promise<void> {
  const res = await fetch(`${apiBaseUrl()}/api/admin/auth/mobile-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw await parseError(res);
  const body = (await res.json()) as LoginResponse;
  await storeLogin(body);
}

/** Create an account; signs in immediately when the server says it can. */
export async function signup(email: string, password: string): Promise<SignupResponse> {
  const res = await fetch(`${apiBaseUrl()}/api/admin/auth/mobile-signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw await parseError(res);
  const body = (await res.json()) as SignupResponse;
  if (!body.confirmationRequired) await storeLogin(body);
  return body;
}

/** Does a PCP server answer at this base URL? Bounded so a dead LAN address fails fast. */
export async function probeServer(url: string, timeoutMs = 2500): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${url}/health`, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Redeem a pairing code. A scanned QR carries the server's candidate URLs:
 * the first reachable one becomes the saved server, so pairing configures
 * the app as well as signing it in. A hand-typed code has no URLs and is
 * claimed against whatever the app already points at.
 */
export async function claimPairingCode(payload: PairingPayload): Promise<void> {
  if (payload.urls.length > 0) {
    const url = await pickReachableUrl(payload.urls, (candidate) => probeServer(candidate));
    if (!url) {
      throw new ApiError(
        0,
        `Couldn't reach the server (tried ${payload.urls.join(', ')}). Is the phone on the same network as your computer?`
      );
    }
    await setServerUrlOverride(url);
  }
  const res = await fetch(`${apiBaseUrl()}/api/admin/auth/mobile-pair/claim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: payload.code }),
  });
  if (!res.ok) throw await parseError(res);
  await storeLogin((await res.json()) as LoginResponse);
}

/** Revoke the refresh token server-side, then clear local state regardless. */
export async function logout(): Promise<void> {
  const { refreshToken } = getAuthState();
  try {
    if (refreshToken) {
      await fetch(`${apiBaseUrl()}/api/admin/auth/logout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });
    }
  } catch {
    // Offline logout still logs out locally; the 90-day token dies at expiry.
  }
  await clearAuth();
  // The workspace selection belongs to the account that made it.
  await setWorkspaceId(null);
}
