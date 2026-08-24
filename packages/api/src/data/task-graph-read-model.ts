/**
 * Workflow-graph read model (spec: ink://specs/workflow-graph v10, step 1).
 *
 * One canonical edge source per execution model: linear groups keep their
 * frozen blocked_by arrays and drain on the old executor; graph groups store
 * dependencies ONLY in task_edges (forward push edges). Existing consumers —
 * list_tasks, the admin task endpoints, the Tasks page, the command graph —
 * all read blockedBy, so this helper substitutes the derived inbound edge
 * set for tasks in graph-mode groups. No reader has to know which model a
 * group runs; the array column is never written for graph groups.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './supabase/types';

export interface GraphReadModelRow {
  id: string;
  task_group_id?: string | null;
  blocked_by?: string[] | null;
}

/**
 * Replace blocked_by with the inbound edge set for every row that belongs to
 * a graph-mode group. Rows in linear groups (or no group) pass through
 * untouched. Lookup errors throw — a read model that silently serves the
 * stale array for a graph group is worse than a failed request.
 */
export async function applyGraphBlockedBy<T extends GraphReadModelRow>(
  client: SupabaseClient<Database>,
  rows: T[]
): Promise<T[]> {
  const groupIds = [
    ...new Set(rows.map((r) => r.task_group_id).filter((g): g is string => Boolean(g))),
  ];
  if (groupIds.length === 0) return rows;

  const { data: groups, error: groupsError } = await client
    .from('task_groups')
    .select('id, execution_model')
    .in('id', groupIds);
  if (groupsError) {
    throw new Error(`Failed to resolve group execution models: ${groupsError.message}`);
  }
  const graphGroups = new Set(
    (groups ?? []).filter((g) => g.execution_model === 'graph').map((g) => g.id)
  );
  if (graphGroups.size === 0) return rows;

  const graphTaskIds = rows
    .filter((r) => r.task_group_id && graphGroups.has(r.task_group_id))
    .map((r) => r.id);
  const { data: edges, error: edgesError } = await client
    .from('task_edges')
    .select('from_task, to_task')
    .in('to_task', graphTaskIds);
  if (edgesError) {
    throw new Error(`Failed to read task edges: ${edgesError.message}`);
  }

  const inbound = new Map<string, string[]>();
  for (const edge of edges ?? []) {
    const list = inbound.get(edge.to_task);
    if (list) list.push(edge.from_task);
    else inbound.set(edge.to_task, [edge.from_task]);
  }

  return rows.map((r) =>
    r.task_group_id && graphGroups.has(r.task_group_id)
      ? { ...r, blocked_by: inbound.get(r.id) ?? [] }
      : r
  );
}

/**
 * Refuse blocked_by writes into graph-mode groups. The edge set is mutated
 * only through the serialized apply_task_graph RPC; letting the legacy array
 * path write would create a second, silently diverging source. Fails closed:
 * if the group's model cannot be verified, the write is refused.
 */
export async function assertBlockedByWritable(
  client: SupabaseClient<Database>,
  taskGroupId: string | null | undefined
): Promise<void> {
  if (!taskGroupId) return; // standalone tasks carry no graph
  const { data, error } = await client
    .from('task_groups')
    .select('execution_model')
    .eq('id', taskGroupId)
    .maybeSingle();
  if (error) {
    throw new Error(`Cannot verify group execution model for blocked_by write: ${error.message}`);
  }
  if (data?.execution_model === 'graph') {
    throw new Error(
      'blocked_by is frozen for graph-mode groups — mutate dependencies via apply_task_graph'
    );
  }
}
