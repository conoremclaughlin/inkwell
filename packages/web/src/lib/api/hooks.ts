import {
  useQuery,
  useMutation,
  useQueryClient,
  type UseQueryOptions,
  type UseMutationOptions,
} from '@tanstack/react-query';
import { apiGet, apiPost, apiPut, apiPatch, apiDelete, type ApiError } from './client';

/**
 * Hook for authenticated GET requests with React Query caching.
 *
 * @example
 * const { data, isLoading } = useApiQuery<{ users: User[] }>(
 *   ['trusted-users'],
 *   '/api/admin/trusted-users'
 * );
 */
export function useApiQuery<T>(
  queryKey: unknown[],
  path: string,
  options?: Omit<UseQueryOptions<T, ApiError>, 'queryKey' | 'queryFn'>
) {
  return useQuery<T, ApiError>({
    queryKey,
    queryFn: () => apiGet<T>(path),
    ...options,
  });
}

/**
 * Hook for authenticated POST mutations.
 *
 * @example
 * const mutation = useApiPost<{ user: User }, CreateUserInput>(
 *   '/api/admin/trusted-users',
 *   { onSuccess: () => queryClient.invalidateQueries(['trusted-users']) }
 * );
 * mutation.mutate({ platform: 'telegram', platformUserId: '123' });
 */
export function useApiPost<TResponse, TInput = void>(
  path: string,
  options?: Omit<UseMutationOptions<TResponse, ApiError, TInput>, 'mutationFn'>
) {
  return useMutation<TResponse, ApiError, TInput>({
    mutationFn: (input) => apiPost<TResponse>(path, input),
    ...options,
  });
}

/**
 * Hook for authenticated DELETE mutations.
 *
 * @example
 * const mutation = useApiDelete('/api/admin/trusted-users', {
 *   onSuccess: () => queryClient.invalidateQueries(['trusted-users'])
 * });
 * mutation.mutate('user-id-123');
 */
export function useApiDelete<TResponse = void>(
  basePath: string,
  options?: Omit<UseMutationOptions<TResponse, ApiError, string>, 'mutationFn'>
) {
  return useMutation<TResponse, ApiError, string>({
    mutationFn: (id) => apiDelete<TResponse>(`${basePath}/${id}`),
    ...options,
  });
}

/**
 * Hook for authenticated PUT mutations with dynamic path.
 *
 * @example
 * const mutation = useApiPut<Task, { id: string; body: UpdateInput }>(
 *   ({ id }) => `/api/admin/tasks/${id}`,
 *   ({ body }) => body,
 *   { onSuccess: () => queryClient.invalidateQueries(['tasks']) }
 * );
 */
export function useApiPut<TResponse, TInput>(
  pathFn: (input: TInput) => string,
  bodyFn: (input: TInput) => unknown,
  options?: Omit<UseMutationOptions<TResponse, ApiError, TInput>, 'mutationFn'>
) {
  return useMutation<TResponse, ApiError, TInput>({
    mutationFn: (input) => apiPut<TResponse>(pathFn(input), bodyFn(input)),
    ...options,
  });
}

/**
 * Hook for authenticated PATCH mutations with dynamic path.
 */
export function useApiPatch<TResponse, TInput>(
  pathFn: (input: TInput) => string,
  bodyFn: (input: TInput) => unknown,
  options?: Omit<UseMutationOptions<TResponse, ApiError, TInput>, 'mutationFn'>
) {
  return useMutation<TResponse, ApiError, TInput>({
    mutationFn: (input) => apiPatch<TResponse>(pathFn(input), bodyFn(input)),
    ...options,
  });
}

/**
 * Hook for dynamic POST mutations where path depends on input.
 *
 * @example
 * const mutation = useApiPostDynamic<void, { id: string; body: RevokeInput }>(
 *   ({ id }) => `/api/admin/groups/${id}/revoke`,
 *   ({ body }) => body
 * );
 */
export function useApiPostDynamic<TResponse, TInput>(
  pathFn: (input: TInput) => string,
  bodyFn: (input: TInput) => unknown,
  options?: Omit<UseMutationOptions<TResponse, ApiError, TInput>, 'mutationFn'>
) {
  return useMutation<TResponse, ApiError, TInput>({
    mutationFn: (input) => apiPost<TResponse>(pathFn(input), bodyFn(input)),
    ...options,
  });
}

// Re-export useQueryClient for convenience
export { useQueryClient };
