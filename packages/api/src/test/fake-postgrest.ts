/**
 * An in-memory stand-in for the slice of supabase-js that the inkling and
 * admin thread routes use. Unlike a scripted mock it evaluates its filters:
 * a query scoped to the wrong user or workspace finds nothing here, exactly
 * as it would against PostgREST, so a missing scope fails a test instead of
 * being answered by a fixture.
 *
 * Supported: from(table) with select / insert / update / delete, eq
 * (including `column->>key`), gt, in, order, limit, range, maybeSingle,
 * single, and awaiting the builder for many rows; rpc through registered
 * handlers. Unique constraints are declared per table and refuse a write
 * with 23505, as Postgres does. A table with an updated_at column gets a
 * fresh one on every update, as the canonical trigger does.
 *
 * Why not services/sessions/fake-supabase.ts: that fake has no unique
 * constraints (every insert succeeds, and an array insert becomes one
 * keyless row), so it cannot raise the 23505 that the awakening and
 * client-message races turn on. Its lease tests depend on its exact
 * behaviour, so it was left as it is.
 */

import { randomUUID } from 'node:crypto';

export type Row = Record<string, unknown>;
export interface FakeError {
  code?: string;
  message: string;
}
export interface FakeResult<T = unknown> {
  data: T;
  error: FakeError | null;
}
export interface UniqueConstraint {
  name: string;
  /** The row's key under this constraint, or null when it does not apply (a partial index). */
  key: (row: Row) => string | null;
}
export type RpcHandler = (args: Record<string, unknown>, db: FakePostgrest) => FakeResult;

type Op = 'select' | 'insert' | 'update' | 'delete';

export class FakePostgrest {
  readonly tables: Record<string, Row[]> = {};
  readonly unique: Record<string, UniqueConstraint[]> = {};
  readonly rpcHandlers: Record<string, RpcHandler> = {};
  /** Every operation, in order: what a test asserts was (or was never) touched. */
  readonly log: Array<{ table: string; op: Op | 'rpc'; filters: string[] }> = [];
  /**
   * PostgREST's max-rows cap: a select returns at most this many rows, with
   * no error, whatever limit it asked for (Supabase defaults it to 1000).
   * Off unless a test sets it.
   */
  maxRows: number | undefined;
  /**
   * The longest `in` list a request may carry. A real request puts the list
   * in its URL, so an unbounded one eventually fails; here it fails at this
   * length. Off unless a test sets it.
   */
  maxInList: number | undefined;
  private clock = Date.parse('2026-10-02T08:00:00.000Z');

  /** A strictly increasing timestamp, so ordering and updated_at changes are observable. */
  now(): string {
    this.clock += 1000;
    return new Date(this.clock).toISOString();
  }

  rows(table: string): Row[] {
    return (this.tables[table] ??= []);
  }

  seed(table: string, row: Row): Row {
    const full: Row = { id: randomUUID(), created_at: this.now(), ...row };
    if ('updated_at' in row || table === 'agent_identities') full.updated_at ??= full.created_at;
    this.rows(table).push(full);
    return full;
  }

  from(table: string): FakeQuery {
    return new FakeQuery(this, table);
  }

  async rpc(fn: string, args: Record<string, unknown>): Promise<FakeResult> {
    this.log.push({ table: fn, op: 'rpc', filters: [] });
    const handler = this.rpcHandlers[fn];
    if (!handler) return { data: null, error: { message: `no rpc handler for ${fn}` } };
    return handler(args, this);
  }

  /** The first unique constraint `candidate` would violate on `table`, ignoring `self`. */
  violation(table: string, candidate: Row, self?: Row): UniqueConstraint | null {
    for (const constraint of this.unique[table] ?? []) {
      const key = constraint.key(candidate);
      if (key === null) continue;
      if (this.rows(table).some((r) => r !== self && constraint.key(r) === key)) return constraint;
    }
    return null;
  }
}

/** `metadata->>client` reads metadata.client as text; a plain column reads itself. */
function read(row: Row, column: string): unknown {
  const [base, key] = column.split('->>');
  if (key === undefined) return row[base];
  const json = row[base];
  if (json === null || typeof json !== 'object') return null;
  const value = (json as Row)[key];
  return value === undefined || value === null ? null : String(value);
}

function sameValue(a: unknown, b: unknown): boolean {
  // SQL: NULL equals nothing.
  if (a === null || a === undefined || b === null || b === undefined) return false;
  return String(a) === String(b);
}

function duplicate(constraint: UniqueConstraint): FakeError {
  return {
    code: '23505',
    message: `duplicate key value violates unique constraint "${constraint.name}"`,
  };
}

export class FakeQuery implements PromiseLike<FakeResult> {
  private op: Op = 'select';
  private columns: string[] | null = null;
  private returning = false;
  private filters: Array<{ label: string; test: (row: Row) => boolean }> = [];
  private ordering: Array<{ column: string; ascending: boolean }> = [];
  private limitCount: number | undefined;
  private offset = 0;
  private inListLengths: number[] = [];
  private values: Row[] = [];
  private patch: Row = {};

  constructor(
    private readonly db: FakePostgrest,
    private readonly table: string
  ) {}

  select(columns = '*'): this {
    if (this.op === 'select') this.columns = columns === '*' ? null : this.parse(columns);
    else {
      this.returning = true;
      this.columns = columns === '*' ? null : this.parse(columns);
    }
    return this;
  }

  insert(values: Row | Row[]): this {
    this.op = 'insert';
    this.values = Array.isArray(values) ? values : [values];
    return this;
  }

  update(patch: Row): this {
    this.op = 'update';
    this.patch = patch;
    return this;
  }

  delete(): this {
    this.op = 'delete';
    return this;
  }

  eq(column: string, value: unknown): this {
    this.filters.push({
      label: `${column}=${String(value)}`,
      test: (row) => sameValue(read(row, column), value),
    });
    return this;
  }

  /** PostgREST's `is`, for null and booleans; a column a row never set reads as null. */
  is(column: string, value: null | boolean): this {
    this.filters.push({
      label: `${column} is ${String(value)}`,
      test: (row) => {
        const own = read(row, column);
        return value === null ? own === null || own === undefined : own === value;
      },
    });
    return this;
  }

  gt(column: string, value: unknown): this {
    this.filters.push({
      label: `${column}>${String(value)}`,
      test: (row) => {
        const own = read(row, column);
        return own !== null && own !== undefined && String(own) > String(value);
      },
    });
    return this;
  }

  lt(column: string, value: unknown): this {
    this.filters.push({
      label: `${column}<${String(value)}`,
      test: (row) => {
        const own = read(row, column);
        return own !== null && own !== undefined && String(own) < String(value);
      },
    });
    return this;
  }

  in(column: string, values: unknown[]): this {
    this.inListLengths.push(values.length);
    this.filters.push({
      label: `${column} in (${values.map(String).join(',')})`,
      test: (row) => values.some((v) => sameValue(read(row, column), v)),
    });
    return this;
  }

  order(column: string, options: { ascending?: boolean } = {}): this {
    this.ordering.push({ column, ascending: options.ascending !== false });
    return this;
  }

  limit(count: number): this {
    this.limitCount = count;
    return this;
  }

  /** Rows `from` through `to`, inclusive, as PostgREST's Range header asks. */
  range(from: number, to: number): this {
    this.offset = from;
    this.limitCount = to - from + 1;
    return this;
  }

  async maybeSingle(): Promise<FakeResult<Row | null>> {
    const { data, error } = await this.execute();
    if (error) return { data: null, error };
    if (data.length > 1) {
      return { data: null, error: { code: 'PGRST116', message: 'multiple rows returned' } };
    }
    return { data: data[0] ?? null, error: null };
  }

  async single(): Promise<FakeResult<Row | null>> {
    const { data, error } = await this.execute();
    if (error) return { data: null, error };
    if (data.length !== 1) {
      return { data: null, error: { code: 'PGRST116', message: `${data.length} rows returned` } };
    }
    return { data: data[0], error: null };
  }

  then<A = FakeResult, B = never>(
    onFulfilled?: ((value: FakeResult) => A | PromiseLike<A>) | null,
    onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null
  ): PromiseLike<A | B> {
    return this.execute().then(onFulfilled, onRejected);
  }

  private parse(columns: string): string[] {
    return columns.split(',').map((c) => c.trim());
  }

  private project(row: Row): Row {
    if (!this.columns) return { ...row };
    return Object.fromEntries(this.columns.map((c) => [c, row[c] ?? null]));
  }

  private matching(): Row[] {
    return this.db.rows(this.table).filter((row) => this.filters.every((f) => f.test(row)));
  }

  private async execute(): Promise<FakeResult<Row[]>> {
    this.db.log.push({ table: this.table, op: this.op, filters: this.filters.map((f) => f.label) });
    const longest = Math.max(0, ...this.inListLengths);
    if (this.db.maxInList !== undefined && longest > this.db.maxInList) {
      return {
        data: [],
        error: { code: '414', message: `request URI too long: an in list of ${longest} values` },
      };
    }
    if (this.op === 'insert') return this.runInsert();
    if (this.op === 'update') return this.runUpdate();
    if (this.op === 'delete') return this.runDelete();

    const rows = this.matching();
    for (const { column, ascending } of [...this.ordering].reverse()) {
      rows.sort((a, b) => {
        const [x, y] = [String(read(a, column) ?? ''), String(read(b, column) ?? '')];
        return (x < y ? -1 : x > y ? 1 : 0) * (ascending ? 1 : -1);
      });
    }
    const cap = Math.min(this.limitCount ?? Infinity, this.db.maxRows ?? Infinity);
    const fromOffset = rows.slice(this.offset);
    const limited = cap === Infinity ? fromOffset : fromOffset.slice(0, cap);
    return { data: limited.map((r) => this.project(r)), error: null };
  }

  private runInsert(): FakeResult<Row[]> {
    const inserted: Row[] = [];
    for (const value of this.values) {
      const at = this.db.now();
      const row: Row = { id: randomUUID(), created_at: at, ...value };
      if (this.table === 'agent_identities' || this.table === 'kindle_tokens') {
        row.updated_at ??= at;
      }
      const violated = this.db.violation(this.table, row);
      if (violated) return { data: [], error: duplicate(violated) };
      this.db.rows(this.table).push(row);
      inserted.push(row);
    }
    return { data: this.returning ? inserted.map((r) => this.project(r)) : [], error: null };
  }

  private runDelete(): FakeResult<Row[]> {
    const targets = new Set(this.matching());
    const table = this.db.rows(this.table);
    const kept = table.filter((row) => !targets.has(row));
    table.splice(0, table.length, ...kept);
    return { data: this.returning ? [...targets].map((r) => this.project(r)) : [], error: null };
  }

  private runUpdate(): FakeResult<Row[]> {
    const targets = this.matching();
    for (const row of targets) {
      const next = { ...row, ...this.patch };
      if ('updated_at' in row && !('updated_at' in this.patch)) next.updated_at = this.db.now();
      const violated = this.db.violation(this.table, next, row);
      if (violated) return { data: [], error: duplicate(violated) };
    }
    for (const row of targets) {
      const touchesUpdatedAt = 'updated_at' in row && !('updated_at' in this.patch);
      Object.assign(row, this.patch);
      if (touchesUpdatedAt) row.updated_at = this.db.now();
    }
    return { data: this.returning ? targets.map((r) => this.project(r)) : [], error: null };
  }
}
