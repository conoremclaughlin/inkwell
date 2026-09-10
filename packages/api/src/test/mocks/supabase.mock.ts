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

  /**
   * Per-call results, consumed in order, for handlers that run more than one
   * query. Without this every query in a handler resolves to the same value,
   * so a mocked test cannot tell "read the existing row" from "write the new
   * one" — which is how an upsert that INSERTED instead of UPDATING passed a
   * full unit suite while duplicating rows against a real database.
   */
  let resultQueue: Array<{ data: unknown; error: unknown }> = [];

  // Create a thenable result for await
  const createResult = () => {
    if (resultQueue.length > 0) return resultQueue.shift()!;
    return {
      data: resolveData,
      error: resolveError,
    };
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

  // Make queryBuilder thenable for direct await (for queries without .single()).
  // Resolve ONE result per await: calling createResult() twice here would
  // consume two queued results for a single query and silently shift every
  // later query's answer by one.
  queryBuilder.then = (resolve: (value: { data: unknown; error: unknown }) => void) => {
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

    /**
     * Queue results for successive queries, in call order. Once exhausted,
     * further queries fall back to the value from _setReturnData.
     */
    _setResultQueue: (results: Array<{ data: unknown; error?: unknown }>) => {
      resultQueue = results.map((result) => ({ data: result.data, error: result.error ?? null }));
    },

    /** Results still unconsumed — assert this is empty to catch a stale queue. */
    _pendingResultCount: () => resultQueue.length,

    // Reset all mocks
    _reset: () => {
      resolveData = null;
      resolveError = null;
      resultQueue = [];
      vi.clearAllMocks();
    },
  };
}

export type MockSupabaseClient = ReturnType<typeof createMockSupabaseClient>;
