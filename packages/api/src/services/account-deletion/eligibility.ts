/**
 * Whether an account can be deleted from the app (ink://specs/account-deletion
 * v6 §2), asked when the deletion is requested and again when it closes.
 * delete_account repeats the same checks where the rows are, so a change in
 * between removes nothing.
 *
 * v1 deletes a consumer account: its identities are all inklings, no space
 * it owns has other members (the person deletes the space first, which is
 * its own action), and no operator record names it. The person's own
 * self-serve awakening token and lineage go with the account; any other
 * kindle record links it to someone else and holds the deletion.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../../data/supabase/types';
import { INKLING_CLIENT } from '../inklings/inkling-client';

export type Ineligibility =
  | { reason: 'operator-account'; detail: string }
  | { reason: 'owns-shared-space'; spaces: Array<{ id: string; name: string; members: number }> };

type Db = SupabaseClient<Database>;

export async function deletionIneligibility(db: Db, userId: string): Promise<Ineligibility | null> {
  const identities = await db.from('agent_identities').select('id, metadata').eq('user_id', userId);
  if (identities.error) throw new Error(`identity read failed: ${identities.error.message}`);
  const sbIds: string[] = [];
  for (const row of identities.data ?? []) {
    const client = (row.metadata as { client?: unknown } | null)?.client;
    if (client !== INKLING_CLIENT) {
      return { reason: 'operator-account', detail: 'it owns an identity that is not an inkling' };
    }
    sbIds.push(row.id);
  }

  const owned = await db.from('workspaces').select('id, name').eq('user_id', userId);
  if (owned.error) throw new Error(`space read failed: ${owned.error.message}`);
  const ownedIds = (owned.data ?? []).map((w) => w.id);
  if (ownedIds.length > 0) {
    const members = await db
      .from('workspace_members')
      .select('workspace_id, user_id')
      .in('workspace_id', ownedIds)
      .neq('user_id', userId);
    if (members.error) throw new Error(`member read failed: ${members.error.message}`);
    const counts = new Map<string, number>();
    for (const m of members.data ?? []) {
      counts.set(m.workspace_id, (counts.get(m.workspace_id) ?? 0) + 1);
    }
    if (counts.size > 0) {
      return {
        reason: 'owns-shared-space',
        spaces: (owned.data ?? [])
          .filter((w) => counts.has(w.id))
          .map((w) => ({ id: w.id, name: w.name, members: counts.get(w.id)! })),
      };
    }
  }

  const sb = sbIds.length > 0 ? sbIds : ['00000000-0000-0000-0000-000000000000'];
  const operator: Array<[string, Promise<{ count: number | null; error: unknown }>]> = [
    [
      'task gate events',
      count(
        db,
        'task_gate_events',
        `actor_user_id.eq.${userId},assignee_user_id.eq.${userId},actor_identity_id.in.(${sb}),assignee_identity_id.in.(${sb})`
      ),
    ],
    [
      'task graph revisions',
      count(db, 'task_graph_revisions', `actor_user_id.eq.${userId},actor_identity_id.in.(${sb})`),
    ],
    [
      'publication operations',
      count(
        db,
        'publication_operations',
        `authorizer_user_id.eq.${userId},authorizer_identity_id.in.(${sb}),executor_identity_id.in.(${sb})`
      ),
    ],
    [
      'publication operation events',
      count(
        db,
        'publication_operation_events',
        `actor_user_id.eq.${userId},actor_identity_id.in.(${sb})`
      ),
    ],
    [
      'skills',
      count(
        db,
        'skills',
        `author_user_id.eq.${userId},last_published_by.eq.${userId},deprecated_by.eq.${userId}`
      ),
    ],
    ['skill versions', count(db, 'skill_versions', `published_by.eq.${userId}`)],
  ];
  for (const [label, pending] of operator) {
    const { count: n, error } = await pending;
    if (error) throw new Error(`${label} read failed`);
    if ((n ?? 0) > 0) return { reason: 'operator-account', detail: `${label} name it` };
  }

  const lineage = await db
    .from('kindle_lineage')
    .select('parent_user_id, child_user_id, facilitator_user_id')
    .or(`parent_user_id.eq.${userId},child_user_id.eq.${userId},facilitator_user_id.eq.${userId}`);
  if (lineage.error) throw new Error(`kindle lineage read failed: ${lineage.error.message}`);
  for (const row of lineage.data ?? []) {
    const selfServe =
      row.facilitator_user_id === userId &&
      row.child_user_id === userId &&
      row.parent_user_id === null;
    if (!selfServe) {
      return {
        reason: 'operator-account',
        detail: 'a kindle record links it with another account',
      };
    }
  }
  const tokens = await db
    .from('kindle_tokens')
    .select('creator_user_id, creator_agent_id, used_by_user_id')
    .or(`creator_user_id.eq.${userId},used_by_user_id.eq.${userId}`);
  if (tokens.error) throw new Error(`kindle token read failed: ${tokens.error.message}`);
  for (const row of tokens.data ?? []) {
    const selfServe =
      row.creator_user_id === userId &&
      row.creator_agent_id === null &&
      (row.used_by_user_id === null || row.used_by_user_id === userId);
    if (!selfServe) {
      return { reason: 'operator-account', detail: 'a kindle token links it with another account' };
    }
  }
  return null;
}

function count(
  db: Db,
  table: string,
  orFilter: string
): Promise<{ count: number | null; error: unknown }> {
  return (
    db
      // A table name outside the generated union is still a table here.
      .from(table as 'users')
      .select('*', { count: 'exact', head: true })
      .or(orFilter) as unknown as Promise<{ count: number | null; error: unknown }>
  );
}
