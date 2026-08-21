/**
 * Workflow graph step 1 — Integration Tests (real DB)
 *
 * The step-1 guarantees live in plpgsql (row lock before read, graph_version
 * CAS, structural validation, one-transaction conversion with the model flip
 * last) — invisible to unit mocks by construction. This suite exercises the
 * two RPCs and the read-model derivation end-to-end through the real
 * repositories against local Supabase.
 *
 * Requires .env.local with SUPABASE_URL + SUPABASE_SECRET_KEY.
 * Skipped automatically when credentials are unavailable.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import dotenv from 'dotenv';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { randomUUID } from 'crypto';
import { INTEGRATION_TEST_USER_ID } from '../test/integration-fixtures';
import type { Database } from './supabase/types';
import { TaskGroupsRepository } from './repositories/task-groups.repository';
import { ProjectTasksRepository } from './repositories/project-tasks.repository';

const projectRoot = resolve(__dirname, '../../../../');
const envLocalPath = resolve(projectRoot, '.env.local');
if (existsSync(envLocalPath)) {
  const parsed = dotenv.parse(readFileSync(envLocalPath));
  for (const [key, value] of Object.entries(parsed)) {
    if (!process.env[key]) process.env[key] = value;
  }
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_KEY;
const available = !!(SUPABASE_URL && SUPABASE_KEY);

const d = available ? describe : describe.skip;

const USER = INTEGRATION_TEST_USER_ID;

d('workflow graph step 1 (real DB)', () => {
  let client: SupabaseClient<Database>;
  let groups: TaskGroupsRepository;
  let tasksRepo: ProjectTasksRepository;

  // g1: three-task chain converted to graph mode; g2: stays linear.
  const g1 = randomUUID();
  const g2 = randomUUID();
  const t1 = randomUUID();
  const t2 = randomUUID();
  const t3 = randomUUID();
  const x1 = randomUUID();

  beforeAll(async () => {
    client = createClient<Database>(SUPABASE_URL!, SUPABASE_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    groups = new TaskGroupsRepository(client);
    tasksRepo = new ProjectTasksRepository(client);

    const { error: gErr } = await client.from('task_groups').insert([
      { id: g1, user_id: USER, title: 'graph-itest chain' },
      { id: g2, user_id: USER, title: 'graph-itest linear' },
    ]);
    if (gErr) throw new Error(`fixture groups: ${gErr.message}`);

    const { error: tErr } = await client.from('tasks').insert([
      { id: t1, user_id: USER, task_group_id: g1, title: 't1' },
      { id: t2, user_id: USER, task_group_id: g1, title: 't2', blocked_by: [t1] },
      { id: t3, user_id: USER, task_group_id: g1, title: 't3', blocked_by: [t2] },
      { id: x1, user_id: USER, task_group_id: g2, title: 'x1' },
    ]);
    if (tErr) throw new Error(`fixture tasks: ${tErr.message}`);
  });

  afterAll(async () => {
    // Edge rows cascade with tasks; revision rows cascade with the group.
    await client.from('tasks').delete().in('id', [t1, t2, t3, x1]);
    await client.from('task_groups').delete().in('id', [g1, g2]);
  });

  it('refuses edge mutations on a linear group — one canonical source per model', async () => {
    const result = await groups.applyTaskGraph({
      userId: USER,
      taskGroupId: g1,
      expectedVersion: 0,
      edges: [{ from: t1, to: t2 }],
      systemActor: true,
    });
    expect(result).toMatchObject({ success: false, reason: 'not-graph-mode' });
  });

  it('converts a valid linear group: edges from blocked_by, model flipped, revision appended', async () => {
    const result = await groups.convertToGraph({
      userId: USER,
      taskGroupId: g1,
      expectedVersion: 0,
      systemActor: true,
    });
    expect(result).toMatchObject({ success: true, graphVersion: 1, edgeCount: 2 });

    const { data: group } = await client
      .from('task_groups')
      .select('execution_model, graph_version')
      .eq('id', g1)
      .single();
    expect(group).toMatchObject({ execution_model: 'graph', graph_version: 1 });

    const edges = await groups.getEdges(g1);
    expect(edges).toHaveLength(2);
    expect(edges).toContainEqual({ from_task: t1, to_task: t2 });
    expect(edges).toContainEqual({ from_task: t2, to_task: t3 });
  });

  it('CASes graph_version — a stale expected version is refused with the current one', async () => {
    const result = await groups.applyTaskGraph({
      userId: USER,
      taskGroupId: g1,
      expectedVersion: 0,
      edges: [],
      systemActor: true,
    });
    expect(result).toMatchObject({ success: false, reason: 'version-conflict', currentVersion: 1 });
  });

  it('refuses a cyclic desired graph', async () => {
    const result = await groups.applyTaskGraph({
      userId: USER,
      taskGroupId: g1,
      expectedVersion: 1,
      edges: [
        { from: t1, to: t2 },
        { from: t2, to: t1 },
      ],
      systemActor: true,
    });
    expect(result).toMatchObject({ success: false, reason: 'cycle' });
  });

  it('refuses cross-group edges with an explicit report', async () => {
    const result = (await groups.applyTaskGraph({
      userId: USER,
      taskGroupId: g1,
      expectedVersion: 1,
      edges: [{ from: t1, to: x1 }],
      systemActor: true,
    })) as { success: boolean; reason: string; invalid: Array<{ problem: string }> };
    expect(result.success).toBe(false);
    expect(result.reason).toBe('invalid-edges');
    expect(result.invalid[0].problem).toBe('cross-group');
  });

  it('serves the edge-derived blockedBy through the repository, ignoring the stale array', async () => {
    // Mutate the graph away from what the frozen arrays say: t1 fans out to
    // both t2 and t3; the stored t3.blocked_by still reads [t2].
    const mutation = await groups.applyTaskGraph({
      userId: USER,
      taskGroupId: g1,
      expectedVersion: 1,
      edges: [
        { from: t1, to: t2 },
        { from: t1, to: t3 },
      ],
      systemActor: true,
    });
    expect(mutation).toMatchObject({ success: true, graphVersion: 2 });

    const { data: rawT3 } = await client.from('tasks').select('blocked_by').eq('id', t3).single();
    expect(rawT3?.blocked_by).toEqual([t2]); // the stale array is untouched...

    const groupTasks = await tasksRepo.findByGroupId(g1);
    const byId = new Map(groupTasks.map((t) => [t.id, t]));
    expect(byId.get(t3)?.blocked_by).toEqual([t1]); // ...and the read model wins
    expect(byId.get(t2)?.blocked_by).toEqual([t1]);
    expect(byId.get(t1)?.blocked_by).toEqual([]);
  });

  it('refuses legacy blocked_by writes into a graph group', async () => {
    await expect(tasksRepo.update(t2, { blocked_by: [t3] })).rejects.toThrow(/apply_task_graph/);
  });

  it('appends one revision per mutation with constructor provenance', async () => {
    const { data: revisions } = await client
      .from('task_graph_revisions')
      .select('graph_version, system_actor, constructor')
      .eq('task_group_id', g1)
      .order('graph_version');
    expect(revisions).toHaveLength(2);
    expect(revisions?.[0]).toMatchObject({
      graph_version: 1,
      system_actor: true,
      constructor: 'linear-conversion',
    });
    expect(revisions?.[1]).toMatchObject({ graph_version: 2, system_actor: true });
  });

  it('preflight-fails a group with a dangling blocker and leaves it linear, array intact', async () => {
    const dangling = randomUUID();
    await client
      .from('tasks')
      .update({ blocked_by: [dangling] })
      .eq('id', x1);

    const result = (await groups.convertToGraph({
      userId: USER,
      taskGroupId: g2,
      expectedVersion: 0,
      systemActor: true,
    })) as { success: boolean; reason: string; invalid: Array<{ problem: string }> };
    expect(result.success).toBe(false);
    expect(result.reason).toBe('preflight-failed');
    expect(result.invalid[0].problem).toBe('dangling');

    const { data: group } = await client
      .from('task_groups')
      .select('execution_model')
      .eq('id', g2)
      .single();
    expect(group?.execution_model).toBe('linear');
    const { data: task } = await client.from('tasks').select('blocked_by').eq('id', x1).single();
    expect(task?.blocked_by).toEqual([dangling]);
  });
});
