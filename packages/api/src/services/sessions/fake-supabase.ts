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
  // Nested JSON paths as PostgREST parses them: base->child->>leaf — any
  // depth, both arrow forms (the single-level split this replaced silently
  // resolved `lease->pendingRelease->>requestedAt` to null, which made
  // exact-state CAS guards match when they must not).
  const parts = col.split('->');
  let cur: unknown = row;
  for (let part of parts) {
    if (part.startsWith('>')) part = part.slice(1);
    if (!cur || typeof cur !== 'object') return null;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur ?? null;
}

class FakeQuery {
  private filters: Array<(r: Row) => boolean> = [];
  private sorts: Array<{ col: string; ascending: boolean }> = [];
  private limitN?: number;

  constructor(
    private rows: Row[],
    private mode: 'select' | 'update' | 'insert',
    private payload?: Row
  ) {}

  eq(col: string, val: unknown) {
    this.filters.push((r) => {
      const cur = getCol(r, col);
      // `->` (not `->>`) path filters compare jsonb structurally: PostgREST
      // casts the filter value to jsonb. Mirror that for object/array values
      // (the threadKeys exact-set guard) — order-sensitive, like jsonb arrays.
      if (cur !== null && typeof cur === 'object' && typeof val === 'string') {
        try {
          return JSON.stringify(cur) === JSON.stringify(JSON.parse(val));
        } catch {
          return false;
        }
      }
      return cur === val;
    });
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
  neq(col: string, val: unknown) {
    // PostgREST `neq` is `not.eq`; like SQL `<>`, a NULL column never matches.
    this.filters.push((r) => {
      const cur = getCol(r, col);
      return cur != null && cur !== val;
    });
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
  gte(col: string, val: unknown) {
    this.filters.push((r) => String(getCol(r, col) ?? '') >= String(val));
    return this;
  }
  /**
   * PostgREST `or=(a.eq.x,b.is.null)`. Supports the `is`/`eq`/`gt` operators
   * this codebase actually passes; anything else matches everything rather
   * than silently filtering rows out. Multiple `.or()` calls AND together,
   * matching PostgREST.
   */
  or(expr: string) {
    const clauses = expr.split(',').map((c) => c.trim());
    this.filters.push((r) =>
      clauses.some((clause) => {
        const [col, op, ...rest] = clause.split('.');
        const raw = rest.join('.');
        const actual = getCol(r, col);
        if (op === 'is') return raw === 'null' ? actual == null : actual === raw;
        if (op === 'eq') return String(actual) === raw;
        if (op === 'gt') {
          const bound = raw === 'now()' ? new Date().toISOString() : raw;
          return actual != null && String(actual) > bound;
        }
        return true;
      })
    );
    return this;
  }
  select(_cols?: string) {
    return this;
  }
  order(col?: string, opts?: { ascending?: boolean }) {
    if (col) this.sorts.push({ col, ascending: opts?.ascending !== false });
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
    for (const { col, ascending } of [...this.sorts].reverse()) {
      matched = [...matched].sort((a, b) => {
        const av = String(getCol(a, col) ?? '');
        const bv = String(getCol(b, col) ?? '');
        return ascending ? av.localeCompare(bv) : bv.localeCompare(av);
      });
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

        if (fn === 'reopen_inbox_thread') {
          // Mirrors migration 20260913090000 (post-cutover): the actor is a
          // principal — exactly one of p_actor_sb_id / p_actor_user_id — the
          // guarded flip and the audit event happen together or not at all
          // (JS is single-threaded, as the function is one transaction in
          // Postgres), and the event says system by kind. false = the row was
          // not closed; nothing written.
          const sbId = (args.p_actor_sb_id as string | null | undefined) ?? null;
          const userId = (args.p_actor_user_id as string | null | undefined) ?? null;
          if ((sbId === null) === (userId === null)) {
            return {
              data: null,
              error: {
                message:
                  'reopen_inbox_thread: exactly one of p_actor_sb_id, p_actor_user_id must be set',
              },
            };
          }
          const thread = (tables['inbox_threads'] ?? []).find(
            (r) => r.id === args.p_thread_id && r.status === 'closed'
          );
          if (!thread) return { data: false, error: null };
          Object.assign(thread, {
            status: 'open',
            closed_at: null,
            closed_by_kind: null,
            closed_by_sb_id: null,
            closed_by_user_id: null,
            updated_at: new Date().toISOString(),
          });
          const label = sbId
            ? (((tables['agent_identities'] ?? []).find((r) => r.id === sbId)?.agent_id as
                | string
                | undefined) ?? sbId)
            : null;
          const messages =
            tables['inbox_thread_messages'] ?? (tables['inbox_thread_messages'] = []);
          messages.push({
            thread_id: args.p_thread_id,
            sender_kind: 'system',
            sender_sb_id: null,
            sender_user_id: null,
            sender_agent_id: null,
            content: sbId ? `Thread reopened by ${label}` : 'Thread reopened by a workspace member',
            message_type: 'system',
            metadata: sbId
              ? { type: 'thread_reopened', reopenedBySbId: sbId }
              : { type: 'thread_reopened', reopenedByUserId: userId },
          });
          return { data: true, error: null };
        }

        if (fn === 'update_inbox_thread_metadata') {
          // Mirrors migration 20260916020035 as redefined by 20260924071839 for
          // the post-cutover message columns: the title/summary write and the
          // timeline event happen together or not at all. The real atomicity —
          // a rejected audit rolling the edit back — is pinned against Postgres
          // in thread-metadata.integration.test.ts; this mirror exists so the
          // handler's own branches are testable, and it must not be laxer than
          // the function it stands in for.
          const setTitle = args.p_set_title === true;
          const setSummary = args.p_set_summary === true;
          const slug = args.p_editor_slug as string | null | undefined;
          const attributedBy = args.p_attributed_by as string;
          if (!setTitle && !setSummary) {
            return {
              data: null,
              error: {
                message: 'update_inbox_thread_metadata: provide at least one of title or summary',
              },
            };
          }
          if (!slug) {
            return {
              data: null,
              error: { message: 'update_inbox_thread_metadata: an editor slug is required' },
            };
          }
          if (attributedBy !== 'identity' && attributedBy !== 'slug-only') {
            return {
              data: null,
              error: {
                message: `update_inbox_thread_metadata: attributed_by must be identity or slug-only, got ${attributedBy}`,
              },
            };
          }
          const thread = (tables['inbox_threads'] ?? []).find((r) => r.id === args.p_thread_id);
          if (!thread) {
            return {
              data: null,
              error: {
                message: `update_inbox_thread_metadata: thread ${args.p_thread_id} not found`,
              },
            };
          }
          const stamp = new Date().toISOString();
          const fields: string[] = [];
          if (setTitle) {
            Object.assign(thread, {
              title: args.p_title ?? null,
              title_updated_by_sb_id: args.p_editor_sb_id ?? null,
              title_updated_at: stamp,
            });
            fields.push('title');
          }
          if (setSummary) {
            Object.assign(thread, {
              summary: args.p_summary ?? null,
              summary_updated_by_sb_id: args.p_editor_sb_id ?? null,
              summary_updated_at: stamp,
            });
            fields.push('summary');
          }
          thread.updated_at = stamp;
          const metaMessages =
            tables['inbox_thread_messages'] ?? (tables['inbox_thread_messages'] = []);
          metaMessages.push({
            thread_id: args.p_thread_id,
            // Post-cutover principal columns (20260924071839): the system
            // borrows nobody's identity — kind says system, both ids null,
            // no slug.
            sender_kind: 'system',
            sender_sb_id: null,
            sender_user_id: null,
            sender_agent_id: null,
            content: `Thread ${fields.join(' and ')} updated by ${slug}`,
            message_type: 'system',
            metadata: {
              type: 'thread_metadata_updated',
              updatedBy: slug,
              updatedBySbId: args.p_editor_sb_id ?? null,
              attributedBy,
              updatedFields: fields,
              ...(setTitle ? { title: args.p_title ?? null } : {}),
              ...(setSummary ? { summary: args.p_summary ?? null } : {}),
            },
          });
          return { data: stamp, error: null };
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
