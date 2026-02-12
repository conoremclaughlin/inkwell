import { vi } from 'vitest';

export type QueryResult = { data: unknown; error: unknown };

export interface BuilderSpec {
  single?: QueryResult[];
  maybeSingle?: QueryResult[];
  then?: QueryResult;
}

export function createTableAwareSupabaseMock(specs: Record<string, BuilderSpec[]>) {
  const calls: Array<{ table: string; builder: Record<string, unknown> }> = [];

  const from = vi.fn((table: string) => {
    const queue = specs[table];
    if (!queue || queue.length === 0) {
      throw new Error(`No query builder configured for table "${table}"`);
    }

    const spec = queue.shift() as BuilderSpec;
    const singleQueue = [...(spec.single || [])];
    const maybeSingleQueue = [...(spec.maybeSingle || [])];

    const builder: Record<string, unknown> = {};
    const methods = [
      'select', 'insert', 'update', 'delete', 'upsert',
      'eq', 'neq', 'in', 'is', 'or', 'and',
      'gt', 'gte', 'lt', 'lte',
      'ilike', 'like', 'overlaps', 'contains',
      'order', 'limit', 'range',
    ];

    for (const method of methods) {
      builder[method] = vi.fn().mockReturnValue(builder);
    }

    builder.single = vi.fn().mockImplementation(() =>
      Promise.resolve(singleQueue.shift() || { data: null, error: null })
    );

    builder.maybeSingle = vi.fn().mockImplementation(() =>
      Promise.resolve(maybeSingleQueue.shift() || { data: null, error: null })
    );

    builder.then = (resolve: (value: QueryResult) => void) => {
      const result = spec.then || { data: null, error: null };
      resolve(result);
      return Promise.resolve(result);
    };

    calls.push({ table, builder });
    return builder;
  });

  return { from, calls };
}
