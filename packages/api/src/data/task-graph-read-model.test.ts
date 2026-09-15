/**
 * Workflow-graph read model — unit tests (spec: ink://specs/workflow-graph
 * v10, step 1).
 *
 * The contract under test: one canonical edge source per execution model.
 * Linear groups keep their stored blocked_by arrays; graph groups serve the
 * derived inbound edge set — INCLUDING when the legacy array still holds a
 * stale value, which is exactly the divergence the derivation exists to
 * hide. The DB-level RPC behavior (locking, CAS, cycle refusal) lives in
 * task-graph.integration.test.ts against a real database.
 */

import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './supabase/types';
import { applyGraphBlockedBy, assertBlockedByWritable } from './task-graph-read-model';

interface FakeConfig {
  groups?: Array<{ id: string; execution_model: string }>;
  edges?: Array<{ from_task: string; to_task: string }>;
  groupsError?: string;
  edgesError?: string;
}

function makeClient(cfg: FakeConfig) {
  const queriedTables: string[] = [];
  const client = {
    queriedTables,
    from(table: string) {
      return {
        select() {
          return this;
        },
        in(_col: string, vals: string[]) {
          queriedTables.push(table);
          if (table === 'task_groups') {
            if (cfg.groupsError) {
              return Promise.resolve({ data: null, error: { message: cfg.groupsError } });
            }
            return Promise.resolve({
              data: (cfg.groups ?? []).filter((g) => vals.includes(g.id)),
              error: null,
            });
          }
          if (cfg.edgesError) {
            return Promise.resolve({ data: null, error: { message: cfg.edgesError } });
          }
          return Promise.resolve({
            data: (cfg.edges ?? []).filter((e) => vals.includes(e.to_task)),
            error: null,
          });
        },
        eq(_col: string, val: string) {
          queriedTables.push(table);
          return {
            maybeSingle: () =>
              cfg.groupsError
                ? Promise.resolve({ data: null, error: { message: cfg.groupsError } })
                : Promise.resolve({
                    data: (cfg.groups ?? []).find((g) => g.id === val) ?? null,
                    error: null,
                  }),
          };
        },
      };
    },
  };
  return client as unknown as SupabaseClient<Database> & { queriedTables: string[] };
}

describe('applyGraphBlockedBy', () => {
  it('leaves linear-group rows and their stored arrays untouched', async () => {
    const client = makeClient({ groups: [{ id: 'g1', execution_model: 'linear' }] });
    const rows = [{ id: 't1', task_group_id: 'g1', blocked_by: ['t0'] }];

    const result = await applyGraphBlockedBy(client, rows);

    expect(result[0].blocked_by).toEqual(['t0']);
    // No graph groups in play — the edges table must not even be queried.
    expect(client.queriedTables).not.toContain('task_edges');
  });

  it('replaces a stale legacy array with the derived inbound edge set for graph groups', async () => {
    // The stored array says t0; the edge set says t2. The edge set wins —
    // blocked_by is not written for graph groups, so the array is stale by
    // construction the moment the graph mutates.
    const client = makeClient({
      groups: [{ id: 'g1', execution_model: 'graph' }],
      edges: [{ from_task: 't2', to_task: 't1' }],
    });
    const rows = [{ id: 't1', task_group_id: 'g1', blocked_by: ['t0'] }];

    const result = await applyGraphBlockedBy(client, rows);

    expect(result[0].blocked_by).toEqual(['t2']);
  });

  it('reads a graph task with no inbound edges as unblocked ([]), never the stale array', async () => {
    const client = makeClient({
      groups: [{ id: 'g1', execution_model: 'graph' }],
      edges: [],
    });
    const rows = [{ id: 't1', task_group_id: 'g1', blocked_by: ['t0'] }];

    const result = await applyGraphBlockedBy(client, rows);

    expect(result[0].blocked_by).toEqual([]);
  });

  it('aggregates multiple inbound edges per task and scopes overrides per group model', async () => {
    const client = makeClient({
      groups: [
        { id: 'graph-g', execution_model: 'graph' },
        { id: 'linear-g', execution_model: 'linear' },
      ],
      edges: [
        { from_task: 'a', to_task: 'converge' },
        { from_task: 'b', to_task: 'converge' },
      ],
    });
    const rows = [
      { id: 'converge', task_group_id: 'graph-g', blocked_by: null },
      { id: 'other', task_group_id: 'linear-g', blocked_by: ['keep'] },
    ];

    const result = await applyGraphBlockedBy(client, rows);

    expect(result[0].blocked_by?.sort()).toEqual(['a', 'b']);
    expect(result[1].blocked_by).toEqual(['keep']);
  });

  it('passes groupless rows through without touching the database', async () => {
    const client = makeClient({});
    const rows = [{ id: 't1', task_group_id: null, blocked_by: ['x'] }];

    const result = await applyGraphBlockedBy(client, rows);

    expect(result[0].blocked_by).toEqual(['x']);
    expect(client.queriedTables).toEqual([]);
  });

  it('throws when the group lookup fails — a lying read model is worse than a failed request', async () => {
    const client = makeClient({ groupsError: 'connection reset' });
    const rows = [{ id: 't1', task_group_id: 'g1', blocked_by: null }];

    await expect(applyGraphBlockedBy(client, rows)).rejects.toThrow(/execution models/);
  });

  it('throws when the edge lookup fails', async () => {
    const client = makeClient({
      groups: [{ id: 'g1', execution_model: 'graph' }],
      edgesError: 'connection reset',
    });
    const rows = [{ id: 't1', task_group_id: 'g1', blocked_by: null }];

    await expect(applyGraphBlockedBy(client, rows)).rejects.toThrow(/task edges/);
  });
});

describe('assertBlockedByWritable', () => {
  it('allows blocked_by writes into linear groups', async () => {
    const client = makeClient({ groups: [{ id: 'g1', execution_model: 'linear' }] });
    await expect(assertBlockedByWritable(client, 'g1')).resolves.toBeUndefined();
  });

  it('refuses blocked_by writes into graph groups', async () => {
    const client = makeClient({ groups: [{ id: 'g1', execution_model: 'graph' }] });
    await expect(assertBlockedByWritable(client, 'g1')).rejects.toThrow(/apply_task_graph/);
  });

  it('is a no-op for standalone tasks (no group, no query)', async () => {
    const client = makeClient({});
    await expect(assertBlockedByWritable(client, null)).resolves.toBeUndefined();
    expect(client.queriedTables).toEqual([]);
  });

  it('fails closed when the group model cannot be verified', async () => {
    const client = makeClient({ groupsError: 'connection reset' });
    await expect(assertBlockedByWritable(client, 'g1')).rejects.toThrow(/Cannot verify/);
  });
});
