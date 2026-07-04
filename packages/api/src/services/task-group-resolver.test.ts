/**
 * Task Group Resolver Tests
 *
 * The resolver must never guess: only verified `task:`/`strategy:` ids and
 * unambiguous thread_key matches resolve to a group id.
 */

import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../data/supabase/types.js';
import { resolveTaskGroupForThreadKey } from './task-group-resolver.js';

const GROUP_ID = '11111111-2222-3333-4444-555555555555';
const TASK_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const USER_ID = 'user-1';

interface TableFixture {
  /** Result for .maybeSingle() queries against this table */
  single?: { data: unknown; error?: unknown };
  /** Result for awaited list queries (e.g. .limit(n)) against this table */
  list?: { data: unknown[] | null; error?: unknown };
}

/**
 * Minimal per-table supabase mock. Each chained call returns the builder;
 * `.maybeSingle()` resolves the table's `single` fixture, and awaiting the
 * builder directly resolves the `list` fixture. Also records `.eq()` filters
 * so tests can assert user scoping.
 */
function mockSupabase(fixtures: Record<string, TableFixture>) {
  const eqCalls: Array<{ table: string; column: string; value: unknown }> = [];

  const from = vi.fn((table: string) => {
    const fixture = fixtures[table] ?? {};
    const builder: Record<string, unknown> = {};
    for (const method of ['select', 'limit', 'order']) {
      builder[method] = vi.fn().mockReturnValue(builder);
    }
    builder.eq = vi.fn((column: string, value: unknown) => {
      eqCalls.push({ table, column, value });
      return builder;
    });
    builder.maybeSingle = vi.fn(() =>
      Promise.resolve(fixture.single ?? { data: null, error: null })
    );
    builder.then = (resolve: (v: unknown) => void) => {
      const result = fixture.list ?? { data: [], error: null };
      resolve(result);
      return Promise.resolve(result);
    };
    return builder;
  });

  return {
    client: { from } as unknown as SupabaseClient<Database>,
    from,
    eqCalls,
  };
}

describe('resolveTaskGroupForThreadKey', () => {
  it('returns null without querying when threadKey is missing or blank', async () => {
    const { client, from } = mockSupabase({});
    expect(await resolveTaskGroupForThreadKey(client, USER_ID, undefined)).toBeNull();
    expect(await resolveTaskGroupForThreadKey(client, USER_ID, null)).toBeNull();
    expect(await resolveTaskGroupForThreadKey(client, USER_ID, '   ')).toBeNull();
    expect(from).not.toHaveBeenCalled();
  });

  it('returns null without querying when userId is missing', async () => {
    const { client, from } = mockSupabase({});
    expect(await resolveTaskGroupForThreadKey(client, '', `task:${GROUP_ID}`)).toBeNull();
    expect(from).not.toHaveBeenCalled();
  });

  it('resolves task:<groupId> when the id is a task group', async () => {
    const { client, eqCalls } = mockSupabase({
      task_groups: { single: { data: { id: GROUP_ID } } },
    });
    const result = await resolveTaskGroupForThreadKey(client, USER_ID, `task:${GROUP_ID}`);
    expect(result).toBe(GROUP_ID);
    // Must be scoped to the user
    expect(eqCalls).toContainEqual({ table: 'task_groups', column: 'user_id', value: USER_ID });
  });

  it('resolves task:<taskId> to the parent group via tasks.task_group_id', async () => {
    const { client } = mockSupabase({
      task_groups: { single: { data: null }, list: { data: [] } },
      tasks: { single: { data: { task_group_id: GROUP_ID } } },
    });
    const result = await resolveTaskGroupForThreadKey(client, USER_ID, `task:${TASK_ID}`);
    expect(result).toBe(GROUP_ID);
  });

  it('resolves strategy:<groupId> (auto-generated fallback threadKey)', async () => {
    const { client, from } = mockSupabase({
      task_groups: { single: { data: { id: GROUP_ID } } },
    });
    const result = await resolveTaskGroupForThreadKey(client, USER_ID, `strategy:${GROUP_ID}`);
    expect(result).toBe(GROUP_ID);
    // strategy: ids never consult the tasks table
    expect(from).not.toHaveBeenCalledWith('tasks');
  });

  it('does not treat strategy:<unknownId> as a group; falls back to thread_key match', async () => {
    const { client } = mockSupabase({
      task_groups: { single: { data: null }, list: { data: [{ id: GROUP_ID }] } },
    });
    const result = await resolveTaskGroupForThreadKey(client, USER_ID, `strategy:${TASK_ID}`);
    expect(result).toBe(GROUP_ID);
  });

  it('resolves an explicit thread_key match (e.g. pr:239) when exactly one group claims it', async () => {
    const { client, eqCalls } = mockSupabase({
      task_groups: { list: { data: [{ id: GROUP_ID }] } },
    });
    const result = await resolveTaskGroupForThreadKey(client, USER_ID, 'pr:239');
    expect(result).toBe(GROUP_ID);
    expect(eqCalls).toContainEqual({ table: 'task_groups', column: 'thread_key', value: 'pr:239' });
    expect(eqCalls).toContainEqual({ table: 'task_groups', column: 'user_id', value: USER_ID });
  });

  it('returns null when multiple groups share the same thread_key (ambiguous)', async () => {
    const { client } = mockSupabase({
      task_groups: { list: { data: [{ id: GROUP_ID }, { id: TASK_ID }] } },
    });
    expect(await resolveTaskGroupForThreadKey(client, USER_ID, 'pr:239')).toBeNull();
  });

  it('returns null when nothing matches', async () => {
    const { client } = mockSupabase({
      task_groups: { single: { data: null }, list: { data: [] } },
      tasks: { single: { data: null } },
    });
    expect(await resolveTaskGroupForThreadKey(client, USER_ID, `task:${TASK_ID}`)).toBeNull();
    expect(await resolveTaskGroupForThreadKey(client, USER_ID, 'thread:some-topic')).toBeNull();
  });

  it('skips id lookups for non-UUID task ids and uses thread_key match only', async () => {
    const { client, from } = mockSupabase({
      task_groups: { list: { data: [{ id: GROUP_ID }] } },
    });
    const result = await resolveTaskGroupForThreadKey(client, USER_ID, 'task:abc123');
    expect(result).toBe(GROUP_ID);
    // Non-UUID → no .maybeSingle() id probes against tasks
    expect(from).not.toHaveBeenCalledWith('tasks');
  });

  it('returns null on database errors instead of throwing', async () => {
    const { client } = mockSupabase({
      task_groups: {
        single: { data: null, error: { message: 'boom' } },
        list: { data: null, error: { message: 'boom' } },
      },
    });
    expect(await resolveTaskGroupForThreadKey(client, USER_ID, `task:${GROUP_ID}`)).toBeNull();
    expect(await resolveTaskGroupForThreadKey(client, USER_ID, 'pr:1')).toBeNull();
  });

  it('returns null when the client throws unexpectedly', async () => {
    const client = {
      from: () => {
        throw new Error('connection lost');
      },
    } as unknown as SupabaseClient<Database>;
    expect(await resolveTaskGroupForThreadKey(client, USER_ID, 'pr:1')).toBeNull();
  });
});
