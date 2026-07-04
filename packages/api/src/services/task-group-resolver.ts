/**
 * Task Group Resolver
 *
 * Resolves a threadKey to the task group (mission) it belongs to, so message
 * activities (check-ins, inkmail) can be tagged with `task_group_id` and
 * appear on the mission timeline.
 *
 * Resolution is deliberately conservative — a wrong task group is worse than
 * none. Only two forms resolve:
 *
 *   1. `task:<uuid>` / `strategy:<uuid>` — the id is verified against
 *      `task_groups` (and, for `task:`, against `tasks` → `task_group_id`)
 *      before being returned. An unverifiable id resolves to null.
 *   2. Exact `task_groups.thread_key` match, scoped to the user. If more than
 *      one group claims the same thread_key the match is ambiguous → null.
 *
 * See ink://specs/live-session-experience (WS3).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../data/supabase/types.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve the task group a threadKey refers to, or null when the key doesn't
 * unambiguously identify one. Never throws — DB errors resolve to null.
 *
 * Cost: zero queries when threadKey is absent; at most three when present.
 */
export async function resolveTaskGroupForThreadKey(
  supabase: SupabaseClient<Database>,
  userId: string,
  threadKey: string | null | undefined
): Promise<string | null> {
  if (!userId || !threadKey) return null;
  const key = threadKey.trim();
  if (!key) return null;

  try {
    // 1) task:<uuid> / strategy:<uuid> — verify the id before trusting it.
    //    `strategy:<groupId>` is the auto-generated fallback threadKey used by
    //    the strategy service when a group has no explicit thread_key.
    const prefixed = key.match(/^(task|strategy):(.+)$/);
    if (prefixed && UUID_RE.test(prefixed[2])) {
      const id = prefixed[2];

      const { data: group } = await supabase
        .from('task_groups')
        .select('id')
        .eq('id', id)
        .eq('user_id', userId)
        .maybeSingle();
      if (group?.id) return group.id;

      // `task:<id>` may reference an individual task — map it to its group.
      if (prefixed[1] === 'task') {
        const { data: task } = await supabase
          .from('tasks')
          .select('task_group_id')
          .eq('id', id)
          .eq('user_id', userId)
          .maybeSingle();
        if (task?.task_group_id) return task.task_group_id;
      }
      // Fall through: a group could still declare this literal key as its
      // thread_key (e.g. a task id from another system).
    }

    // 2) Exact thread_key column match — only when unambiguous.
    const { data: rows, error } = await supabase
      .from('task_groups')
      .select('id')
      .eq('user_id', userId)
      .eq('thread_key', key)
      .limit(2);

    if (error || !rows || rows.length !== 1) return null;
    return rows[0].id;
  } catch {
    // Conservative: resolution failures leave the activity untagged.
    return null;
  }
}
