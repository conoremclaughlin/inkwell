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

export function normalizePath(p: unknown): string | null {
  if (typeof p !== 'string' || p === '') return null;
  // SQL parity (r4 P0-1): canonical input or error. The DB rejects relative
  // paths and '.'/'..' segments instead of guessing at them; what remains
  // (slash collapse, trailing slash except root) is idempotent.
  if (!p.startsWith('/')) {
    throw new Error(`worktree_path must be absolute: ${p}`);
  }
  if (/(^|\/)\.\.?(\/|$)/.test(p)) {
    throw new Error(`worktree_path must not contain . or .. segments: ${p}`);
  }
  let v = p.replace(/\/{2,}/g, '/');
  if (v.length > 1) v = v.replace(/\/$/, '');
  return v;
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
    // grant_studio_lease + studio_path_conflict at SQL parity (Phase 6b
    // round 2): ANY sibling lease on the same NORMALIZED path conflicts — no
    // thread exception (a thread is not one writer), no staleness exception
    // (stale is not proof of departure; the sweep rescues). NULL paths back
    // no shared tree and skip the scan. Atomic here because JS is
    // single-threaded, as the advisory xact lock makes it in Postgres.
    async rpc(fn: string, args: Row) {
      try {
        const studios = tables['studios'] ?? [];
        const target = studios.find(
          (r) => r.id === args.p_studio_id && r.user_id === args.p_user_id
        );
        // The pre-lock read (SQL: SELECT normalize_worktree_path INTO
        // v_path). A non-canonical stored path RAISEs in SQL — mirrored by
        // the throw propagating to the catch below as an RPC error.
        const lockedPath = target ? normalizePath(target.worktree_path) : null;
        const findSibling = () => {
          if (!target) return undefined;
          // Pathless rows all execute in the shared defaultWorkingDirectory —
          // ONE backing class per user (r3 P0-3). Scanned against the LOCKED
          // backing, never a re-read (SQL scans v_path).
          return studios.find(
            (r) =>
              r.id !== args.p_studio_id &&
              r.user_id === args.p_user_id &&
              (lockedPath == null
                ? normalizePath(r.worktree_path) == null
                : normalizePath(r.worktree_path) === lockedPath) &&
              r.lease != null
          );
        };
        // r4 P0-2: the CAS proves the row still belongs to the backing the
        // lock serializes; a moved row matches zero rows.
        const backingMatches = () => {
          if (!target) return false;
          const now = normalizePath(target.worktree_path);
          return lockedPath == null ? now == null : now === lockedPath;
        };

        if (fn === 'studio_path_conflict') {
          if (!target) return { data: { conflict: true }, error: null };
          if (!backingMatches()) return { data: { conflict: true }, error: null };
          const sibling = findSibling();
          return sibling
            ? {
                data: {
                  conflict: true,
                  conflictStudioId: sibling.id,
                  conflictHolder: sibling.lease,
                },
                error: null,
              }
            : { data: { conflict: false }, error: null };
        }

        if (fn !== 'grant_studio_lease') {
          return { data: null, error: { message: `no fake for rpc ${fn}` } };
        }
        if (!target) return { data: { outcome: 'lost' }, error: null };

        const conflict = findSibling();
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
        const pLease = args.p_lease as Row;
        const prior = args.p_expected_prior as Row | null;
        const priorMatches = prior
          ? !!target.lease &&
            (target.lease as Row).sessionId === prior.sessionId &&
            (target.lease as Row).acquiredAt === prior.acquiredAt &&
            (target.lease as Row).heartbeatAt === prior.heartbeatAt
          : target.lease == null;
        if (acquirable && priorMatches && backingMatches()) {
          target.lease = pLease;
          return { data: { outcome: 'granted' }, error: null };
        }
        return { data: { outcome: 'lost' }, error: null };
      } catch (err) {
        return {
          data: null,
          error: { message: err instanceof Error ? err.message : String(err) },
        };
      }
    },
  } as never;
}
