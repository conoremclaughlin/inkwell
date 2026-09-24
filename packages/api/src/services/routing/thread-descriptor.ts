/**
 * Thread descriptor for the trigger preamble.
 *
 * The trigger message is what an SB reads BEFORE deciding whether to act, and
 * for a threaded trigger it carried only the key:
 *
 *   Thread: inkwell:thread:legibility-commission
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
  /** When the thread itself was opened — the age of a title nobody has edited. */
  createdAt: string | null;
}

/**
 * "12m" / "5h" / "3d", or null when the instant cannot be turned into an age:
 * unparseable, or in the future, which would otherwise render "-3m" and read as
 * a bug in the thread rather than in the clock.
 */
function ageLabel(at: string | null | undefined, now: number): string | null {
  if (!at) return null;
  const ms = now - new Date(at).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * Render an edit age as "(set 3d ago)", or "" when there is no usable instant.
 */
export function formatEditAge(at: string | null | undefined, now: number = Date.now()): string {
  const age = ageLabel(at, now);
  return age ? ` (set ${age} ago)` : '';
}

/**
 * The provenance suffix for a title, which unlike a summary has two origins.
 *
 * An edited title carries its edit age. A title nobody has edited came from the
 * first message's subject, and says so with the thread's own age.
 *
 * I originally emitted nothing at all in that second case, reasoning that
 * annotating the 19.2% of threads that have never been retitled would add noise
 * to the line the annotation exists to clarify. That was backwards, and Lumen's
 * review said so: an unedited title is not the case least in need of a date, it
 * is the case most in need of one. The measured failure in this feature's own
 * migration header — spec:review-requests still reading "v1" while the artifact
 * is at v10 — IS a creation-time title, and under the old rule it rendered as a
 * bare confident `Title:` with nothing to distrust it by.
 *
 * So the rule is now the one the feature was always for: no description reaches
 * an SB's prompt without something to date it by.
 *
 * "Never edited" is a claim about the row, so it is made from the row's own
 * evidence — whether `title_updated_at` is set — and never from whether that
 * instant could be turned into an age. A future-dated or unparseable stamp
 * still means somebody edited the title; the first cut fell through to the
 * creation-time branch and told the reader the opposite, with a confident age
 * attached (Lumen, #641 round 2). An edit we cannot date says so.
 */
export function formatTitleProvenance(
  titleUpdatedAt: string | null | undefined,
  createdAt: string | null | undefined,
  now: number = Date.now()
): string {
  if (titleUpdatedAt) {
    const edited = ageLabel(titleUpdatedAt, now);
    return edited ? ` (set ${edited} ago)` : ' (edited, edit time unknown)';
  }
  const opened = ageLabel(createdAt, now);
  if (opened) return ` (never edited, from the first message ${opened} ago)`;
  return ' (never edited, age unknown)';
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
    lines.push(
      `Title: ${descriptor.title}${formatTitleProvenance(descriptor.titleUpdatedAt, descriptor.createdAt, now)}`
    );
  }
  if (descriptor.summary) {
    // A summary has only one origin — update_thread, which always stamps the
    // time — so a missing instant here is an anomalous row rather than a
    // creation-time value, and saying so beats implying the summary is fresh.
    const age = formatEditAge(descriptor.summaryUpdatedAt, now);
    lines.push(`Summary of thread: ${descriptor.summary}${age || ' (edit time unknown)'}`);
  }
  return lines;
}

/**
 * Load a thread's current title and summary, for a recipient who is on it.
 *
 * `recipientSlug` is not a convenience — it is the access check. `trigger_agent`
 * takes an arbitrary threadKey and does not join the target to that thread, so
 * scoping this read by user and key alone would deliver a thread's description
 * into the prompt of an SB that `get_thread_messages` refuses as "not a
 * participant" (Lumen, #641 review). The membership test is an INNER JOIN on
 * inbox_thread_participants in the same round trip, by slug, exactly as every
 * other reader tests it — and it is a read: a non-participant gets nothing, and
 * is never joined as a side effect of being triggered.
 *
 * Best-effort in the other direction: a trigger must still be delivered if this
 * fails, so a query error returns null and the caller omits the lines rather
 * than throwing. Failing to describe a thread is where we already were; failing
 * to wake an SB is not. An error is therefore indistinguishable from
 * non-membership here, which is the safe way round.
 */
export async function loadThreadDescriptor(
  supabase: SupabaseClient,
  userId: string,
  threadKey: string,
  recipientSlug: string
): Promise<ThreadDescriptor | null> {
  if (!recipientSlug) return null;
  try {
    const { data, error } = await supabase
      .from('inbox_threads')
      .select(
        'title, summary, title_updated_at, summary_updated_at, created_at, inbox_thread_participants!inner(agent_id)'
      )
      .eq('user_id', userId)
      .eq('thread_key', threadKey)
      .eq('inbox_thread_participants.agent_id', recipientSlug)
      .maybeSingle();

    if (error || !data) return null;
    return {
      title: data.title ?? null,
      summary: data.summary ?? null,
      titleUpdatedAt: data.title_updated_at ?? null,
      summaryUpdatedAt: data.summary_updated_at ?? null,
      createdAt: data.created_at ?? null,
    };
  } catch (err) {
    logger.warn('Failed to load thread descriptor for trigger', {
      threadKey,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
