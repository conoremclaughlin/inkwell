/**
 * ProjectTasksRepository — blocked_by write-guard unit tests (workflow graph
 * step 1, PR #522 round 1).
 *
 * The authoritative freeze is the enforce_blocked_by_source DB trigger
 * (integration-tested in ../task-graph.integration.test.ts); the repository
 * precheck exists for a friendly error. What these tests pin is the
 * precheck's FAIL-CLOSED posture: an errored task lookup must refuse the
 * write, never silently skip the guard (round-1 finding: the lookup error
 * was dropped, turning transient DB errors into guard bypasses).
 */

import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../supabase/types';
import { ProjectTasksRepository } from './project-tasks.repository';

interface FakeConfig {
  taskLookupError?: string;
  taskRow?: { task_group_id: string | null };
  groupModel?: string;
}

function makeClient(cfg: FakeConfig) {
  const updates: unknown[] = [];
  const client = {
    updates,
    from(table: string) {
      const chain = {
        select: () => chain,
        eq: () => chain,
        single: () => Promise.resolve({ data: null, error: null }),
        maybeSingle: () => {
          if (table === 'tasks') {
            return cfg.taskLookupError
              ? Promise.resolve({ data: null, error: { message: cfg.taskLookupError } })
              : Promise.resolve({ data: cfg.taskRow ?? null, error: null });
          }
          return Promise.resolve({
            data: cfg.groupModel ? { execution_model: cfg.groupModel } : null,
            error: null,
          });
        },
        update: (input: unknown) => {
          updates.push(input);
          return {
            eq: () => ({
              select: () => ({
                single: () => Promise.resolve({ data: { id: 't1' }, error: null }),
              }),
            }),
          };
        },
      };
      return chain;
    },
  };
  return client as unknown as SupabaseClient<Database> & { updates: unknown[] };
}

describe('ProjectTasksRepository blocked_by guard', () => {
  it('fails closed when the task lookup errors — the guard is never skipped', async () => {
    const client = makeClient({ taskLookupError: 'connection reset' });
    const repo = new ProjectTasksRepository(client);

    await expect(repo.update('t1', { blocked_by: ['x'] })).rejects.toThrow(/blocked_by/);
    expect(client.updates).toHaveLength(0);
  });

  it('refuses blocked_by updates when the task belongs to a graph group', async () => {
    const client = makeClient({ taskRow: { task_group_id: 'g1' }, groupModel: 'graph' });
    const repo = new ProjectTasksRepository(client);

    await expect(repo.update('t1', { blocked_by: ['x'] })).rejects.toThrow(/apply_task_graph/);
    expect(client.updates).toHaveLength(0);
  });

  it('allows blocked_by updates in linear groups', async () => {
    const client = makeClient({ taskRow: { task_group_id: 'g1' }, groupModel: 'linear' });
    const repo = new ProjectTasksRepository(client);

    await repo.update('t1', { blocked_by: ['x'] });
    expect(client.updates).toHaveLength(1);
  });

  it('does not run the lookup at all for updates that leave blocked_by alone', async () => {
    const client = makeClient({ taskLookupError: 'would explode if consulted' });
    const repo = new ProjectTasksRepository(client);

    await repo.update('t1', { status: 'completed' });
    expect(client.updates).toHaveLength(1);
  });
});

describe('update — empty-payload guard (PR #503 r1 P3)', () => {
  it('rejects an all-undefined payload — one key wearing no value is still empty', async () => {
    // JSON.stringify drops undefined-valued properties from the PostgREST
    // body, so { due_date: undefined } IS the empty payload; only the MCP
    // handler happened to pre-filter, leaving other repository callers open.
    const client = makeClient({});
    const repo = new ProjectTasksRepository(client);

    await expect(repo.update('t1', { due_date: undefined })).rejects.toThrow('No fields to update');
    expect(client.updates).toHaveLength(0);
  });

  it('strips undefined values from a mixed payload before writing', async () => {
    const client = makeClient({});
    const repo = new ProjectTasksRepository(client);

    await repo.update('t1', { title: 'renamed', due_date: undefined });

    expect(client.updates).toHaveLength(1);
    expect(client.updates[0]).toEqual({ title: 'renamed' });
  });
});
