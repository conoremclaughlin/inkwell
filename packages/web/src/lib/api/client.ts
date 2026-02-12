import axios, { type AxiosError, type AxiosResponse } from 'axios';

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

// Response interceptor - transform errors
apiClient.interceptors.response.use(
  (response: AxiosResponse) => response,
  (error: AxiosError<{ error?: string }>) => {
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
