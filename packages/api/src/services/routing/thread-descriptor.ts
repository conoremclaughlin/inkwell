/**
 * Thread descriptor for the trigger preamble.
 *
 * The trigger message is what an SB reads BEFORE deciding whether to act, and
 * for a threaded trigger it carried only the key:
 *
 *   Thread: pcp:thread:legibility-commission
 *
 * which says nothing about what the thread is for. The key is a stable
 * identifier by design and therefore a poor description — one thread routinely
 * spans several PRs, specs and incidents.
 *
 * Lives here rather than in server.ts because that module ends in an
 * unconditional startServer(), so anything importing it to reach a helper boots
 * a real server. Keeping this side-effect free is what makes it testable.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '../../utils/logger';

export interface ThreadDescriptor {
  title: string | null;
  summary: string | null;
  titleUpdatedAt: string | null;
  summaryUpdatedAt: string | null;
}

/**
 * Render an edit age as "(set 3d ago)", or "" when the field has never been
 * edited.
 *
 * The empty string is deliberate rather than a fallback like "(set at
 * creation)": a title that has never been touched is the default state of 19.2%
 * of threads, and annotating every one of them adds noise to the line it is
 * supposed to clarify. What matters is that an edited field always shows its
 * age, so a summary cannot be read as current merely because it is present.
 */
export function formatEditAge(at: string | null | undefined, now: number = Date.now()): string {
  if (!at) return '';
  const ms = now - new Date(at).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return ` (set ${minutes}m ago)`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return ` (set ${hours}h ago)`;
  return ` (set ${Math.floor(hours / 24)}d ago)`;
}

/**
 * Build the descriptor lines appended under `Thread: <key>`.
 * Returns an empty array when the thread has neither title nor summary, so a
 * thread nobody has described reads exactly as it does today.
 */
export function formatThreadDescriptorLines(
  descriptor: ThreadDescriptor | null,
  now: number = Date.now()
): string[] {
  if (!descriptor) return [];
  const lines: string[] = [];
  if (descriptor.title) {
    lines.push(`Title: ${descriptor.title}${formatEditAge(descriptor.titleUpdatedAt, now)}`);
  }
  if (descriptor.summary) {
    lines.push(
      `Summary of thread: ${descriptor.summary}${formatEditAge(descriptor.summaryUpdatedAt, now)}`
    );
  }
  return lines;
}

/**
 * Load a thread's current title and summary.
 *
 * Best-effort: a trigger must still be delivered if this fails, so it returns
 * null rather than throwing and the caller simply omits the lines. Failing to
 * describe a thread is where we already were; failing to wake an SB is not.
 */
export async function loadThreadDescriptor(
  supabase: SupabaseClient,
  userId: string,
  threadKey: string
): Promise<ThreadDescriptor | null> {
  try {
    const { data, error } = await supabase
      .from('inbox_threads')
      .select('title, summary, title_updated_at, summary_updated_at')
      .eq('user_id', userId)
      .eq('thread_key', threadKey)
      .maybeSingle();

    if (error || !data) return null;
    return {
      title: data.title ?? null,
      summary: data.summary ?? null,
      titleUpdatedAt: data.title_updated_at ?? null,
      summaryUpdatedAt: data.summary_updated_at ?? null,
    };
  } catch (err) {
    logger.warn('Failed to load thread descriptor for trigger', {
      threadKey,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
