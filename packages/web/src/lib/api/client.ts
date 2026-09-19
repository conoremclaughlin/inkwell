import axios, { type AxiosError, type AxiosResponse } from 'axios';
import { getSelectedWorkspaceId } from '@/lib/workspace-selection';

export interface ApiError extends Error {
  status: number;
  data?: unknown;
}

/**
 * Axios client for API requests.
 * Auth is injected by middleware — no client-side token handling needed.
 */
const apiClient = axios.create({
  baseURL: '', // Use relative URLs for Next.js API routes
  headers: {
    'Content-Type': 'application/json',
  },
});

let invalidTokenRecoveryInFlight = false;

/**
 * Whether a failure means this browser's session is over.
 *
 * Deliberately narrow, and exported so it can be tested: it is the trigger for
 * a full logout and redirect, and the server relies on being able to refuse a
 * request WITHOUT setting it off. `Invalid token` is the terminal answer; a
 * superseded cookie or an unreachable database get their own, and a request
 * that fails for either of those reasons must leave the session alone.
 */
export function isInvalidTokenAuthFailure(error: AxiosError<{ error?: string }>): boolean {
  const status = error.response?.status;
  const serverMessage = error.response?.data?.error?.trim().toLowerCase();
  const requestUrl = error.config?.url || '';

  return (
    status === 401 &&
    serverMessage === 'invalid token' &&
    requestUrl.startsWith('/api/admin/') &&
    !requestUrl.startsWith('/api/admin/auth/logout')
  );
}

/** Where the browser asks whether the credential it holds now is alive. */
export const SESSION_PROBE_PATH = '/api/admin/auth/session';

/**
 * Whether the session this browser holds RIGHT NOW is still good.
 *
 * `Invalid token` is a verdict on the credential one request carried, and that
 * is not the same thing as a verdict on the browser. Two requests refresh at
 * once and the loser presents a secret the winner has already replaced; a
 * person signs in again while an older request is in flight. In both, the
 * refusal is true about the credential it names and false about the session,
 * and acting on it logs the browser out of a session a sibling request just
 * renewed.
 *
 * The server cannot fence this for us. An unrecognised refresh secret is named
 * by no column on the grant, so it cannot be distinguished from one that never
 * existed — which is why the check lives here, where the current credential is.
 *
 * Deliberately a bare `fetch`: routing it through `apiClient` would put its own
 * 401 back through the interceptor that called us.
 *
 * An unreachable or unreadable probe answers `true` — alive. The entire point
 * of the surrounding work is that only a definite refusal licenses destroying a
 * session, and "the network did not answer" is not one. A genuinely dead
 * session simply asks again on the next request.
 */
async function sessionIsStillAlive(): Promise<boolean> {
  try {
    const response = await fetch(SESSION_PROBE_PATH, {
      method: 'GET',
      credentials: 'include',
      headers: { 'Cache-Control': 'no-store' },
    });
    if (response.ok) return true;
    // Only the same terminal verdict, reached with the CURRENT credential,
    // means the session is over. A 503 or a 401 'Stale credential' does not.
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    return !(response.status === 401 && body?.error?.trim().toLowerCase() === 'invalid token');
  } catch {
    return true;
  }
}

async function handleInvalidTokenLogout(): Promise<void> {
  if (invalidTokenRecoveryInFlight || typeof window === 'undefined') return;
  invalidTokenRecoveryInFlight = true;

  try {
    if (await sessionIsStillAlive()) {
      // The failed request was carrying a credential this browser has already
      // moved past. Release the latch so a later failure is checked afresh
      // rather than being swallowed by this one.
      invalidTokenRecoveryInFlight = false;
      return;
    }

    await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
  } catch {
    // Best-effort cleanup only.
  }

  window.location.assign('/login?reason=session-expired');
}

// Request interceptor - inject workspace scope header when selected.
apiClient.interceptors.request.use(async (config) => {
  const workspaceId = getSelectedWorkspaceId();
  if (workspaceId) {
    config.headers['X-PCP-Workspace-Id'] = workspaceId;
  }

  return config;
});
// Response interceptor - transform errors
apiClient.interceptors.response.use(
  (response: AxiosResponse) => response,
  (error: AxiosError<{ error?: string; detail?: string }>) => {
    if (isInvalidTokenAuthFailure(error)) {
      void handleInvalidTokenLogout();
    }

    // In dev mode the API returns a `detail` field with the real error message.
    // Surface it so dashboard errors are immediately actionable.
    const serverError = error.response?.data?.error;
    const serverDetail = error.response?.data?.detail;
    const displayMessage = serverDetail
      ? `${serverError}: ${serverDetail}`
      : serverError || error.message || 'Request failed';

    const apiError = new Error(displayMessage) as ApiError;
    apiError.status = error.response?.status || 500;
    apiError.data = error.response?.data;
    return Promise.reject(apiError);
  }
);

export { apiClient };

/**
 * GET request
 */
export async function apiGet<T>(path: string): Promise<T> {
  const response = await apiClient.get<T>(path);
  return response.data;
}

/**
 * POST request
 */
export async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  const response = await apiClient.post<T>(path, body);
  return response.data;
}

/**
 * DELETE request
 */
export async function apiDelete<T>(path: string): Promise<T> {
  const response = await apiClient.delete<T>(path);
  return response.data;
}

/**
 * PATCH request
 */
export async function apiPatch<T>(path: string, body?: unknown): Promise<T> {
  const response = await apiClient.patch<T>(path, body);
  return response.data;
}

/**
 * PUT request
 */
export async function apiPut<T>(path: string, body?: unknown): Promise<T> {
  const response = await apiClient.put<T>(path, body);
  return response.data;
}
