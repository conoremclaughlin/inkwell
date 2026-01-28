/**
 * Supabase Mock
 *
 * Creates a mock Supabase client for unit testing
 * Properly handles fluent API chaining
 */

import { vi } from 'vitest';

export function createMockSupabaseClient() {
  let resolveData: unknown = null;
  let resolveError: unknown = null;

  // Create a thenable result for await
  const createResult = () => ({
    data: resolveData,
    error: resolveError,
  });

  // Create a chainable mock - all methods return the mock itself
  const queryBuilder: Record<string, unknown> = {};

  const chainableMethods = [
    'select', 'insert', 'update', 'delete', 'upsert',
    'eq', 'neq', 'in', 'is', 'or', 'and',
    'gt', 'gte', 'lt', 'lte',
    'ilike', 'like', 'overlaps', 'contains',
    'order', 'limit', 'range',
  ];

  // Create mock for each method that returns the queryBuilder itself
  for (const method of chainableMethods) {
    queryBuilder[method] = vi.fn().mockReturnValue(queryBuilder);
  }

  // single() returns a promise
  queryBuilder.single = vi.fn().mockImplementation(() => Promise.resolve(createResult()));

  // Make queryBuilder thenable for direct await (for queries without .single())
  queryBuilder.then = (resolve: (value: { data: unknown; error: unknown }) => void) => {
    resolve(createResult());
    return Promise.resolve(createResult());
  };

  return {
    from: vi.fn().mockReturnValue(queryBuilder),
    _queryBuilder: queryBuilder,

    // Helper to set return data for single() calls
    _setReturnData: (data: unknown, error: unknown = null) => {
      resolveData = data;
      resolveError = error;
    },

    // Helper to set return data for array calls (same as _setReturnData for this mock)
    _setArrayData: (data: unknown[], error: unknown = null) => {
      resolveData = data;
      resolveError = error;
    },

    // Reset all mocks
    _reset: () => {
      resolveData = null;
      resolveError = null;
      vi.clearAllMocks();
    },
  };
}

export type MockSupabaseClient = ReturnType<typeof createMockSupabaseClient>;
