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
    // grant_studio_lease at SQL parity (Phase 6b): sibling scan over rows
    // sharing the worktree_path, then the vacant/exact-prior CAS. Atomic here
    // because JS is single-threaded, as the advisory xact lock makes it in
    // Postgres. Lease tests exercise real grant behavior, not stubs.
    async rpc(fn: string, args: Row) {
      if (fn !== 'grant_studio_lease') {
        return { data: null, error: { message: `no fake for rpc ${fn}` } };
      }
      const studios = tables['studios'] ?? [];
      const target = studios.find((r) => r.id === args.p_studio_id && r.user_id === args.p_user_id);
      if (!target) return { data: { outcome: 'lost' }, error: null };

      const pLease = args.p_lease as Row;
      const staleMs = (args.p_stale_ms as number) ?? 30 * 60 * 1000;
      const conflict = studios.find((r) => {
        if (r.id === args.p_studio_id) return false;
        if (r.user_id !== args.p_user_id) return false;
        if (r.worktree_path !== target.worktree_path) return false;
        const sib = r.lease as Row | null;
        if (!sib) return false;
        if (sib.threadKey === pLease.threadKey) return false;
        const hb = Date.parse(String(sib.heartbeatAt ?? sib.acquiredAt ?? ''));
        return Number.isFinite(hb) && Date.now() - hb <= staleMs;
      });
      if (conflict) {
        return {
          data: {
            outcome: 'path-conflict',
            conflictStudioId: conflict.id,
            conflictHolder: conflict.lease,
          },
          error: null,
        };
      }

      const acquirable = target.status === 'active' || target.status === 'idle';
      const prior = args.p_expected_prior as Row | null;
      const priorMatches = prior
        ? !!target.lease &&
          (target.lease as Row).sessionId === prior.sessionId &&
          (target.lease as Row).acquiredAt === prior.acquiredAt &&
          (target.lease as Row).heartbeatAt === prior.heartbeatAt
        : target.lease == null;
      if (acquirable && priorMatches) {
        target.lease = pLease;
        return { data: { outcome: 'granted' }, error: null };
      }
      return { data: { outcome: 'lost' }, error: null };
    },
  } as never;
}
