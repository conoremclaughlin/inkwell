/**
 * A table-backed stand-in for the Supabase client, for tests that need
 * SessionService to have one.
 *
 * Passing `undefined` for supabase makes SessionService skip whole branches —
 * including the identity fetch that reads a per-SB model pin — so any test of
 * those paths needs a client that answers arbitrary query chains rather than a
 * hand-rolled mock per call site.
 *
 * Extracted from lease-terminal-boundary.test.ts so there is one of these and
 * not two drifting copies.
 */

export type Row = Record<string, unknown>;

function getCol(row: Row, col: string): unknown {
  if (col.includes('->>')) {
    const [base, key] = col.split('->>');
    const obj = row[base];
    if (!obj || typeof obj !== 'object') return null;
    return (obj as Row)[key] ?? null;
  }
  return row[col] ?? null;
}

class FakeQuery {
  private filters: Array<(r: Row) => boolean> = [];
  private limitN?: number;

  constructor(
    private rows: Row[],
    private mode: 'select' | 'update' | 'insert',
    private payload?: Row
  ) {}

  eq(col: string, val: unknown) {
    this.filters.push((r) => getCol(r, col) === val);
    return this;
  }
  is(col: string, val: unknown) {
    if (val === null) this.filters.push((r) => getCol(r, col) == null);
    return this;
  }
  not(col: string, op: string, val: unknown) {
    if (op === 'is' && val === null) this.filters.push((r) => getCol(r, col) != null);
    else if (op === 'eq') this.filters.push((r) => getCol(r, col) !== val);
    return this;
  }
  in(col: string, vals: unknown[]) {
    this.filters.push((r) => vals.includes(getCol(r, col)));
    return this;
  }
  limit(n: number) {
    this.limitN = n;
    return this;
  }
  select(_cols?: string) {
    return this;
  }
  order() {
    return this;
  }

  private exec(): Row[] {
    if (this.mode === 'insert') {
      this.rows.push({ ...this.payload });
      return [{ ...this.payload }];
    }
    let matched = this.rows.filter((r) => this.filters.every((f) => f(r)));
    if (this.mode === 'update') {
      for (const r of matched) Object.assign(r, this.payload);
    }
    if (this.limitN !== undefined) matched = matched.slice(0, this.limitN);
    return matched.map((r) => ({ ...r }));
  }

  maybeSingle(): Promise<{ data: Row | null; error: null }> {
    return Promise.resolve({ data: this.exec()[0] ?? null, error: null });
  }
  single(): Promise<{ data: Row | null; error: { code: string; message: string } | null }> {
    const rows = this.exec();
    return Promise.resolve(
      rows[0]
        ? { data: rows[0], error: null }
        : { data: null, error: { code: 'PGRST116', message: 'no rows' } }
    );
  }
  then<T>(resolve: (v: { data: Row[]; error: null }) => T): Promise<T> {
    return Promise.resolve({ data: this.exec(), error: null }).then(resolve);
  }
}

export function makeFakeSupabase(tables: Record<string, Row[]>) {
  return {
    from(table: string) {
      const rows = tables[table] ?? (tables[table] = []);
      return {
        select: () => new FakeQuery(rows, 'select'),
        update: (payload: Row) => new FakeQuery(rows, 'update', payload),
        insert: (payload: Row) => new FakeQuery(rows, 'insert', payload),
      };
    },
  } as never;
}
