import axios, { type AxiosError, type AxiosResponse } from 'axios';
import { getSelectedWorkspaceId } from '@/lib/workspace-selection';

export interface ApiError extends Error {
  status: number;
  data?: unknown;
}

/**
 * A request that belongs to one workspace, whichever one is selected by the
 * time it is sent. Null is the server's default (the personal workspace).
 *
 * Unbound requests take the selection at send time, which is what most of
 * the dashboard wants: a switch invalidates every query, and the refetch
 * asks the new workspace. A query whose cache key names a workspace must
 * bind instead. The sidebar selects the new workspace and invalidates
 * before any component re-renders, so the old workspace's still-active
 * query refetches first, and an unbound request would store the new
 * workspace's data under the old workspace's key (Lumen, #679).
 */
export interface WorkspaceBinding {
  workspaceId: string | null;
}

declare module 'axios' {
  interface AxiosRequestConfig {
    /** Set by a workspace-bound request; the request interceptor honours it. */
    inkWorkspace?: WorkspaceBinding;
  }
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

function isInvalidTokenAuthFailure(error: AxiosError<{ error?: string }>): boolean {
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

async function handleInvalidTokenLogout(): Promise<void> {
  if (invalidTokenRecoveryInFlight || typeof window === 'undefined') return;
  invalidTokenRecoveryInFlight = true;

  try {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
  } catch {
    // Best-effort cleanup only.
  } finally {
    window.location.assign('/login?reason=session-expired');
  }
}

// Request interceptor - inject workspace scope header: the request's own
// binding when it has one, otherwise the current selection.
apiClient.interceptors.request.use((config) => {
  const workspaceId = config.inkWorkspace
    ? config.inkWorkspace.workspaceId
    : getSelectedWorkspaceId();
  if (!workspaceId) {
    // Bound to the default workspace: no header, whatever is selected.
    delete config.headers['x-ink-workspace-id'];
  } else {
    // Must match what the server reads (server.ts, admin.ts): `x-ink-workspace-id`.
    // This said `X-Inkwell-Workspace-Id` until #659 — a name the server stopped
    // reading in 01b9047b, so every workspace selection here was silently
    // dropped and the request fell back to the personal workspace.
    config.headers['x-ink-workspace-id'] = workspaceId;
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
export async function apiGet<T>(path: string, binding?: WorkspaceBinding): Promise<T> {
  const response = await apiClient.get<T>(path, binding ? { inkWorkspace: binding } : undefined);
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
