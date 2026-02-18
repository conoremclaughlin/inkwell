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
  (error: AxiosError<{ error?: string }>) => {
    if (isInvalidTokenAuthFailure(error)) {
      void handleInvalidTokenLogout();
    }

    const apiError = new Error(
      error.response?.data?.error || error.message || 'Request failed'
    ) as ApiError;
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
