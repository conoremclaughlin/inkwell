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

  // Ordered results: a test can queue what each successive read/write
  // resolves to (consumed by BOTH `.single()` and a direct `await`), so a
  // handler that performs several round-trips is sequenced explicitly
  // instead of every call sharing one value. Falls back to the shared value.
  const queued: Array<{ data: unknown; error: unknown }> = [];

  // Create a thenable result for await
  const createResult = () =>
    queued.length > 0
      ? (queued.shift() as { data: unknown; error: unknown })
      : {
          data: resolveData,
          error: resolveError,
        };

  // Create a chainable mock - all methods return the mock itself
  const queryBuilder: Record<string, unknown> = {};

  const chainableMethods = [
    'select',
    'insert',
    'update',
    'delete',
    'upsert',
    'eq',
    'neq',
    'in',
    'is',
    'not',
    'or',
    'and',
    'gt',
    'gte',
    'lt',
    'lte',
    'ilike',
    'like',
    'overlaps',
    'contains',
    'order',
    'limit',
    'range',
  ];

  // Create mock for each method that returns the queryBuilder itself
  for (const method of chainableMethods) {
    queryBuilder[method] = vi.fn().mockReturnValue(queryBuilder);
  }

  // single() and maybeSingle() return a promise
  queryBuilder.single = vi.fn().mockImplementation(() => Promise.resolve(createResult()));
  queryBuilder.maybeSingle = vi.fn().mockImplementation(() => Promise.resolve(createResult()));

  // Make queryBuilder thenable for direct await (for queries without .single())
  queryBuilder.then = (resolve: (value: { data: unknown; error: unknown }) => void) => {
    // Evaluate ONCE per await: with queued results, a second evaluation
    // would silently consume the next test step's result.
    const result = createResult();
    resolve(result);
    return Promise.resolve(result);
  };

  return {
    from: vi.fn().mockReturnValue(queryBuilder),
    rpc: vi.fn().mockImplementation(() => Promise.resolve(createResult())),
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

    // Queue the result of the NEXT round-trip (single() or direct await), in call order
    _queueReturnData: (data: unknown, error: unknown = null) => {
      queued.push({ data, error });
    },

    // Reset all mocks
    _reset: () => {
      resolveData = null;
      resolveError = null;
      queued.length = 0;
      vi.clearAllMocks();
    },
  };
}

export type MockSupabaseClient = ReturnType<typeof createMockSupabaseClient>;
