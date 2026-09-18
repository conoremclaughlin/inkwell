/**
 * What a session is working on, rendered for display.
 *
 * `sessions.context` already held real operational state and nothing surfaced
 * it — reading it took an explicit get_session that nobody makes casually. The
 * obvious fix, printing `context` as a status line, does not survive the data.
 * Measured 2026-09-15 across the 90 sessions touched in the previous 7 days:
 *
 *   median context length   349 chars      within 280 chars   30.0%
 *   p90                     974            multiline          4 of 90
 *   max                   5,200
 *
 * Two things follow. Context is far too long for a list, and because almost
 * nothing is multiline there is no first line to lift as a lead — the first
 * line IS the paragraph (median 322 of 349). Hence `headline`, a short field
 * written on purpose, with the truncated context as a fallback so the 736
 * sessions that predate it still show something.
 *
 * Every rendering carries an age. A description without one is read as current
 * however old it is: a context block written on 11 Sep, describing round five
 * of a PR, was read on 15 Sep as a live claim about the same PR at round eight.
 * The age is the difference between a snapshot and an assertion about now.
 */

/** Display cap for a context block used as a headline fallback. */
export const CURRENT_WORK_FALLBACK_MAX = 160;

export interface CurrentWorkSource {
  headline?: string;
  headlineUpdatedAt?: Date;
  context?: string;
  contextUpdatedAt?: Date;
}

export interface CurrentWorkView {
  /** The line to display, or null when the session has said nothing. */
  currentWork: string | null;
  /** 'headline' when purpose-written, 'context' when derived from the scratch board. */
  currentWorkSource: 'headline' | 'context' | null;
  /** ISO timestamp the displayed text was written, or null if unknown. */
  currentWorkAt: string | null;
  /**
   * Human-readable age, or null when unknown.
   *
   * null is deliberate and must NOT be rendered as "just now": rows predating
   * the timestamp columns have no age, and showing an unknown age as recent is
   * the precise failure this field exists to prevent.
   */
  currentWorkAgeLabel: string | null;
  /** True when the text was cut for display and the full value is elsewhere. */
  currentWorkTruncated: boolean;
}

/** "3d ago" / "2h ago" / "5m ago", or null when there is no timestamp. */
export function formatAge(
  at: Date | string | null | undefined,
  now: number = Date.now()
): string | null {
  if (!at) return null;
  const ms = now - new Date(at).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * Render a session's current work.
 *
 * Prefers the headline, falls back to a truncated context, and reports which it
 * used. Reporting the source matters: a truncated scratch-board note and a line
 * someone wrote to be read are different kinds of claim, and collapsing them
 * would let the fallback pass as a deliberate status.
 */
export function describeCurrentWork(
  session: CurrentWorkSource,
  now: number = Date.now()
): CurrentWorkView {
  const headline = session.headline?.trim();
  if (headline) {
    return {
      currentWork: headline,
      currentWorkSource: 'headline',
      currentWorkAt: session.headlineUpdatedAt?.toISOString() ?? null,
      currentWorkAgeLabel: formatAge(session.headlineUpdatedAt, now),
      currentWorkTruncated: false,
    };
  }

  const context = session.context?.trim();
  if (context) {
    const truncated = context.length > CURRENT_WORK_FALLBACK_MAX;
    return {
      currentWork: truncated
        ? `${context.slice(0, CURRENT_WORK_FALLBACK_MAX - 1).trimEnd()}…`
        : context,
      currentWorkSource: 'context',
      currentWorkAt: session.contextUpdatedAt?.toISOString() ?? null,
      currentWorkAgeLabel: formatAge(session.contextUpdatedAt, now),
      currentWorkTruncated: truncated,
    };
  }

  return {
    currentWork: null,
    currentWorkSource: null,
    currentWorkAt: null,
    currentWorkAgeLabel: null,
    currentWorkTruncated: false,
  };
}

/** The raw `sessions` columns this rendering reads. */
export interface CurrentWorkRow {
  headline?: string | null;
  headline_updated_at?: string | null;
  context?: string | null;
  context_updated_at?: string | null;
}

/**
 * Render current work straight from a database row.
 *
 * The admin routes map snake_case rows by hand rather than going through the
 * repository's camelCase `Session`, so without this they would need their own
 * copy of the headline/context fallback. Two copies of that rule is precisely
 * the divergence this module exists to prevent: the fallback decides whether a
 * displayed line is a deliberate status or a truncated scratch note, and a
 * second implementation would eventually disagree about which.
 */
export function describeCurrentWorkFromRow(
  row: CurrentWorkRow,
  now: number = Date.now()
): CurrentWorkView {
  return describeCurrentWork(
    {
      headline: row.headline ?? undefined,
      headlineUpdatedAt: row.headline_updated_at ? new Date(row.headline_updated_at) : undefined,
      context: row.context ?? undefined,
      contextUpdatedAt: row.context_updated_at ? new Date(row.context_updated_at) : undefined,
    },
    now
  );
}
