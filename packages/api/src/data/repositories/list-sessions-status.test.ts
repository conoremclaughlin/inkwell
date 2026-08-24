/**
 * `list_sessions` status filtering — behaviour, not query shape.
 *
 * The five real callers (chat.ts:3218/3275/3391/3796, mission.ts:730) pass
 * status 'active' and mean "sessions that are still going". The filter used to
 * read the deprecated `sessions.status` column, which no terminal path keeps in
 * sync: `endSession()` writes ended_at + lifecycle 'completed' and leaves
 * status at its 'active' default, and lifecycle-only completions do the same.
 * So finished sessions came back as active to every one of those callers.
 *
 * The existing supabase mock resolves whatever data the test sets, ignoring the
 * filters — which can prove a query was *built*, never that it *selects the
 * right rows*. These tests run the real query chain against an in-memory table
 * instead, so a regression shows up as the wrong rows rather than the wrong
 * method calls.
 */

import { describe, it, expect } from 'vitest';
import { MemoryRepository } from './memory-repository';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../supabase/types';

type Row = Record<string, unknown>;
type Predicate = (row: Row) => boolean;

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A Supabase query builder that actually filters.
 *
 * It models only the operators `listSessions` uses, and **throws on anything
 * else** — a fake that silently ignores an unmodelled operator would report
 * green for a query it never ran.
 *
 * Where SQL and JavaScript disagree, SQL wins:
 *   - `NOT IN` over a NULL column is NULL, not true, so the row is excluded.
 *   - `eq` never matches NULL.
 * Getting that backwards is the difference between this test and a lie.
 */
function createFilteringSupabase(rows: Row[]) {
  const predicates: Predicate[] = [];
  let sortColumn: string | null = null;
  let sortAscending = true;
  let rangeFrom = 0;
  let rangeTo = Number.MAX_SAFE_INTEGER;

  const parseInList = (list: string): string[] => {
    const match = /^\((.*)\)$/.exec(list);
    if (!match) throw new Error(`Unmodelled PostgREST in-list: ${list}`);
    return match[1].split(',').map((v) => v.trim().replace(/^"|"$/g, ''));
  };

  /**
   * PostgREST `ilike` pattern → RegExp. `*` is the wildcard alias for `%`;
   * everything else is literal, so a pattern like `complete:*` must not let
   * its colon or any regex metacharacter through as syntax.
   */
  const ilikeToRegExp = (pattern: string): RegExp =>
    new RegExp(`^${pattern.split('*').map(escapeRegExp).join('.*')}$`, 'i');

  /** Parse one clause of an `.or(...)` string, e.g. `lifecycle.in.(a,b)`. */
  const parseOrClause = (clause: string): Predicate => {
    if (clause === 'ended_at.not.is.null') {
      return (row) => row.ended_at !== null && row.ended_at !== undefined;
    }
    const inMatch = /^([a-z_]+)\.in\.(\(.*\))$/.exec(clause);
    if (inMatch) {
      const [, column, list] = inMatch;
      const values = parseInList(list);
      return (row) => typeof row[column] === 'string' && values.includes(row[column] as string);
    }
    const isNullMatch = /^([a-z_]+)\.is\.null$/.exec(clause);
    if (isNullMatch) {
      const [, column] = isNullMatch;
      return (row) => row[column] === null || row[column] === undefined;
    }
    const notIlikeMatch = /^([a-z_]+)\.not\.ilike\.(.+)$/.exec(clause);
    if (notIlikeMatch) {
      const [, column, pattern] = notIlikeMatch;
      const regex = ilikeToRegExp(pattern);
      // SQL: `col NOT ILIKE pattern` over NULL is NULL, not true. Inside an
      // or() the NULL row is carried by its own is.null clause, so returning
      // false here is both correct and the reason that pairing is required.
      return (row) => typeof row[column] === 'string' && !regex.test(row[column] as string);
    }
    throw new Error(`Unmodelled PostgREST or-clause: ${clause}`);
  };

  const builder: Record<string, unknown> = {
    select: () => builder,
    eq: (column: string, value: unknown) => {
      // SQL: `col = value` is never true for NULL.
      predicates.push((row) => row[column] !== null && row[column] === value);
      return builder;
    },
    is: (column: string, value: unknown) => {
      if (value !== null) throw new Error(`Unmodelled is() value: ${String(value)}`);
      predicates.push((row) => row[column] === null || row[column] === undefined);
      return builder;
    },
    neq: (column: string, value: unknown) => {
      // SQL: `col <> value` over NULL yields NULL, so the row drops out —
      // same three-valued logic as the NOT IN above, and the same answer for
      // a NULL lifecycle, which keeps 'attachable' and 'active' consistent.
      predicates.push((row) => typeof row[column] === 'string' && row[column] !== value);
      return builder;
    },
    not: (column: string, operator: string, list: string) => {
      if (operator !== 'in') throw new Error(`Unmodelled not() operator: ${operator}`);
      const values = parseInList(list);
      // SQL: `col NOT IN (...)` over NULL yields NULL, so the row drops out.
      predicates.push(
        (row) => typeof row[column] === 'string' && !values.includes(row[column] as string)
      );
      return builder;
    },
    or: (clauses: string) => {
      // Split on the commas that separate clauses, not the ones inside an
      // in-list. Nested and()/or() groups are not modelled and will throw
      // out of parseOrClause rather than quietly matching nothing.
      const parts = clauses.split(/,(?![^()]*\))/).map(parseOrClause);
      predicates.push((row) => parts.some((p) => p(row)));
      return builder;
    },
    order: (column: string, opts?: { ascending?: boolean }) => {
      sortColumn = column;
      sortAscending = opts?.ascending !== false;
      return builder;
    },
    range: (from: number, to: number) => {
      rangeFrom = from;
      rangeTo = to;
      return builder;
    },
    then: (resolve: (value: { data: Row[]; error: null }) => void) => {
      let result = rows.filter((row) => predicates.every((p) => p(row)));
      if (sortColumn) {
        const column = sortColumn;
        result = [...result].sort((a, b) => {
          const left = String(a[column] ?? '');
          const right = String(b[column] ?? '');
          return sortAscending ? left.localeCompare(right) : right.localeCompare(left);
        });
      }
      result = result.slice(rangeFrom, rangeTo + 1);
      resolve({ data: result, error: null });
      return Promise.resolve({ data: result, error: null });
    },
  };

  return { from: () => builder } as unknown as SupabaseClient<Database>;
}

const USER = 'user-1';

function session(overrides: Row): Row {
  return {
    user_id: USER,
    agent_id: 'wren',
    studio_id: null,
    started_at: '2026-08-01T00:00:00Z',
    ended_at: null,
    lifecycle: 'running',
    status: 'active',
    metadata: {},
    ...overrides,
  };
}

/**
 * Every one of these carries `status: 'active'` in the legacy column, because
 * nothing ever writes anything else there on the way out. That is the whole
 * bug: the column cannot distinguish these rows, so the filter must not use it.
 */
const LIVE = session({ id: 'live', lifecycle: 'running', started_at: '2026-08-05T00:00:00Z' });
const ENDED_BY_HOOK = session({
  id: 'ended-by-hook',
  ended_at: '2026-08-02T00:00:00Z',
  lifecycle: 'completed',
  started_at: '2026-08-02T00:00:00Z',
});
const COMPLETED_WITHOUT_ENDED_AT = session({
  id: 'lifecycle-only',
  ended_at: null,
  lifecycle: 'completed',
  started_at: '2026-08-03T00:00:00Z',
});
const FAILED = session({ id: 'failed', ended_at: null, lifecycle: 'failed' });
const PAUSED = session({ id: 'paused', lifecycle: 'idle', status: 'paused' });
const RESUMABLE_LIVE = session({ id: 'resumable-live', lifecycle: 'idle', status: 'resumable' });
const RESUMABLE_THEN_ENDED = session({
  id: 'resumable-then-ended',
  ended_at: '2026-08-04T00:00:00Z',
  lifecycle: 'completed',
  status: 'resumable',
});

const ALL = [
  LIVE,
  ENDED_BY_HOOK,
  COMPLETED_WITHOUT_ENDED_AT,
  FAILED,
  PAUSED,
  RESUMABLE_LIVE,
  RESUMABLE_THEN_ENDED,
];

function repoOver(rows: Row[]): MemoryRepository {
  return new MemoryRepository(createFilteringSupabase(rows));
}

async function idsFor(
  rows: Row[],
  status: 'active' | 'paused' | 'resumable' | 'completed' | 'attachable'
) {
  const sessions = await repoOver(rows).listSessions(USER, { status });
  return sessions.map((s) => s.id).sort();
}

describe('listSessions status filtering', () => {
  it("excludes a session ended by the hook whose legacy status is still 'active'", async () => {
    // Lumen's reported case, and the reason ink attach and Mission have been
    // listing sessions that finished hours ago.
    expect(await idsFor(ALL, 'active')).not.toContain('ended-by-hook');
  });

  it('excludes a lifecycle-only completion, which never stamps ended_at', async () => {
    expect(await idsFor(ALL, 'active')).not.toContain('lifecycle-only');
  });

  it('excludes a failed session, which is terminal without an ended_at', async () => {
    expect(await idsFor(ALL, 'active')).not.toContain('failed');
  });

  it("returns every non-terminal session for 'active', including paused ones", async () => {
    // 'active' means "not finished", so a session an agent marked paused or
    // resumable is still active — which is what `ink attach` wants, since a
    // resumable session is precisely one you can attach to. The consequence is
    // that 'active' overlaps 'paused' rather than partitioning against it.
    expect(await idsFor(ALL, 'active')).toEqual(['live', 'paused', 'resumable-live']);
  });

  it("returns a live resumable session under both 'active' and 'resumable'", async () => {
    // The attach rationale stated positively rather than by exclusion. Without
    // this the fixtures only prove that a *terminal* resumable row is filtered
    // out, which would also hold if 'active' still read the legacy column and
    // dropped every resumable session — the exact behaviour this contract
    // changes. The overlap is the point, so both memberships are asserted.
    expect(await idsFor(ALL, 'active')).toContain('resumable-live');
    expect(await idsFor(ALL, 'resumable')).toContain('resumable-live');
  });

  it("returns terminal sessions for 'completed', by either spelling", async () => {
    expect(await idsFor(ALL, 'completed')).toEqual([
      'ended-by-hook',
      'failed',
      'lifecycle-only',
      'resumable-then-ended',
    ]);
  });

  it("reads the legacy column for 'paused', which has no authoritative equivalent", async () => {
    expect(await idsFor(ALL, 'paused')).toEqual(['paused']);
  });

  it("does not return a terminal session for 'resumable' just because it says so", async () => {
    // resumable-then-ended still carries status 'resumable'; it ended anyway.
    // The live one is returned, so this is exclusion of the terminal row rather
    // than the filter matching nothing at all.
    expect(await idsFor(ALL, 'resumable')).toEqual(['resumable-live']);
  });

  it('treats a NULL lifecycle as non-active, matching SQL three-valued logic', async () => {
    // Unreachable for real rows — the column has defaulted to 'idle' since the
    // lifecycle migration and existing rows were backfilled — but asserted so
    // the behaviour is a decision rather than an accident. getActiveSessions
    // has the same property, so the two agree.
    const legacy = session({ id: 'null-lifecycle', lifecycle: null });
    expect(await idsFor([LIVE, legacy], 'active')).toEqual(['live']);
  });

  it('still applies agent, studio and backend filters alongside status', async () => {
    const otherAgent = session({ id: 'other-agent', agent_id: 'lumen' });
    const sessions = await repoOver([LIVE, otherAgent, ENDED_BY_HOOK]).listSessions(USER, {
      agentId: 'wren',
      status: 'active',
    });
    expect(sessions.map((s) => s.id)).toEqual(['live']);
  });

  it('returns unfiltered results when no status is given', async () => {
    const sessions = await repoOver(ALL).listSessions(USER, {});
    expect(sessions).toHaveLength(ALL.length);
  });

  it('orders by started_at descending and honours limit', async () => {
    // live started 08-05, lifecycle-only 08-03 — newest first, capped at two.
    const sessions = await repoOver(ALL).listSessions(USER, { limit: 2 });
    expect(sessions.map((s) => s.id)).toEqual(['live', 'lifecycle-only']);
  });
});

/**
 * 'attachable' — what a session picker needs.
 *
 * A crashed session is the one its agent resumes next, so a picker must see
 * lifecycle 'failed'; trigger routing must not. 'active' serves the second
 * and cannot serve the first, hence a separate filter rather than a change
 * to 'active' semantics.
 */
describe("listSessions status 'attachable'", () => {
  it('includes crashed sessions, unlike active', async () => {
    expect(await idsFor(ALL, 'attachable')).toContain('failed');
    expect(await idsFor(ALL, 'active')).not.toContain('failed');
  });

  it('is exactly active plus the crashed ones', async () => {
    expect(await idsFor(ALL, 'attachable')).toEqual(['failed', 'live', 'paused', 'resumable-live']);
  });

  it('still excludes both spellings of a finished session', async () => {
    const ids = await idsFor(ALL, 'attachable');
    expect(ids).not.toContain('ended-by-hook');
    expect(ids).not.toContain('lifecycle-only');
    expect(ids).not.toContain('resumable-then-ended');
  });

  it('treats a NULL lifecycle as non-attachable, agreeing with active', async () => {
    const legacy = session({ id: 'null-lifecycle', lifecycle: null });
    expect(await idsFor([LIVE, legacy], 'attachable')).toEqual(['live']);
  });

  /**
   * The regression this filter exists to prevent.
   *
   * Filtering client-side after the query applies the row limit *before* the
   * exclusion, so newer finished sessions consume the page and push older
   * resumable ones off it — which is how the picker went empty for an agent
   * whose recent sessions had all completed. Server-side, the limit applies
   * to rows that survived the filter.
   */
  it('does not let newer finished sessions push a crashed one off the page', async () => {
    const olderCrashed = session({
      id: 'older-crashed',
      lifecycle: 'failed',
      started_at: '2026-07-01T00:00:00Z',
    });
    const newerFinished = Array.from({ length: 5 }, (_, i) =>
      session({
        id: `finished-${i}`,
        ended_at: '2026-08-10T00:00:00Z',
        lifecycle: 'completed',
        started_at: `2026-08-1${i}T00:00:00Z`,
      })
    );

    const sessions = await repoOver([...newerFinished, olderCrashed]).listSessions(USER, {
      status: 'attachable',
      limit: 3,
    });

    expect(sessions.map((s) => s.id)).toEqual(['older-crashed']);
  });

  /**
   * The same defect one column further in, and the reason the agent-declared
   * markers cannot be left to the client.
   *
   * `update_session_state({ phase: 'complete' })` writes current_phase and
   * nothing else — ended_at stays null, lifecycle stays 'idle'. Excluding
   * only the authoritative columns server-side lets those rows fill the
   * page, and the client discards them afterwards, leaving the picker empty
   * with the older attachable session never having been sent.
   */
  it('does not let newer phase-complete sessions push a crashed one off the page', async () => {
    const olderCrashed = session({
      id: 'older-crashed',
      lifecycle: 'failed',
      started_at: '2026-07-01T00:00:00Z',
    });
    const newerPhaseComplete = Array.from({ length: 5 }, (_, i) =>
      session({
        id: `phase-complete-${i}`,
        ended_at: null,
        lifecycle: 'idle',
        current_phase: 'complete',
        started_at: `2026-08-1${i}T00:00:00Z`,
      })
    );

    const sessions = await repoOver([...newerPhaseComplete, olderCrashed]).listSessions(USER, {
      status: 'attachable',
      limit: 3,
    });

    expect(sessions.map((s) => s.id)).toEqual(['older-crashed']);
  });

  it('excludes the prefixed spellings of both markers before the limit', async () => {
    const rows = [
      session({ id: 'phase-complete-prefixed', current_phase: 'complete:shipped' }),
      session({ id: 'status-completed-prefixed', status: 'completed:merged' }),
      session({ id: 'status-completed', status: 'completed' }),
      session({ id: 'live-row', current_phase: 'implementing' }),
    ];

    expect(await idsFor(rows, 'attachable')).toEqual(['live-row']);
  });

  it('keeps a session that never declared a phase', async () => {
    // NULL current_phase means "never set", which is attachable — but SQL's
    // `col <> x` over NULL is NULL, so without the paired is.null allowance
    // every such row would silently vanish.
    const rows = [
      session({ id: 'no-phase', current_phase: null }),
      session({ id: 'phase-complete', current_phase: 'complete' }),
    ];

    expect(await idsFor(rows, 'attachable')).toEqual(['no-phase']);
  });

  it('does not mistake an in-progress phase for a terminal one', async () => {
    // 'completing-review' starts with 'complete' — a prefix match rather than
    // the exact/`complete:` forms would wrongly drop it.
    const rows = [
      session({ id: 'completing', current_phase: 'completing-review' }),
      session({ id: 'blocked', current_phase: 'blocked:backend-error' }),
      session({ id: 'done', current_phase: 'complete' }),
    ];

    expect(await idsFor(rows, 'attachable')).toEqual(['blocked', 'completing']);
  });

  it('matches the markers case-insensitively, as the client predicate does', async () => {
    const rows = [
      session({ id: 'shouty', current_phase: 'COMPLETE' }),
      session({ id: 'mixed', status: 'Completed' }),
      session({ id: 'live-row', current_phase: 'reviewing' }),
    ];

    expect(await idsFor(rows, 'attachable')).toEqual(['live-row']);
  });
});
