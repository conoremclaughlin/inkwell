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

/**
 * Who is reading, and therefore whether this session's work may be described
 * at all.
 *
 * - `owner` — the caller is authorized for this session (`isSessionAuthorized`):
 *   headline, else the truncated context.
 * - `none`  — anyone else: nothing. No context, no headline, no age.
 *
 * Required rather than defaulted, because the safe value is the one a new call
 * site would omit.
 *
 * There was a middle tier here — `peer`, which published the headline but
 * withheld the context — on the reasoning that a headline is written to be read
 * by someone else and a scratch note is not. The distinction is real; using it
 * as an authorization boundary was not, and Lumen was right to refuse it on
 * #652. "Not authorized" is a single bucket holding three different failures:
 * a different canonical identity, a different contact, a different workspace
 * whose "wren" is not our "wren". A tier that publishes to everything outside
 * `isSessionAuthorized` publishes across all three.
 *
 * Nothing legitimate was lost by collapsing it, because nothing legitimate was
 * reaching it. Every query behind these surfaces filters by user and slug, so a
 * row that fails authorization is by construction one wearing the caller's own
 * name while belonging to someone else — exactly the case the tier was unsafe
 * for. Sibling visibility, the thing `peer` was meant to deliver, never arrived
 * through this path at all.
 *
 * Publishing status across identities is a feature worth having. It needs a
 * predicate that says who the team IS, rather than inferring membership from a
 * failed ownership check, so it belongs in its own design and not in the
 * fallthrough branch of this one.
 */
export type CurrentWorkAudience = 'owner' | 'none';

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

/**
 * The view for a session with nothing to say — and, identically, for a reader
 * who may not be told. Frozen so a caller that spreads it cannot edit the shared
 * "nothing" into someone else's response.
 */
const NO_CURRENT_WORK: CurrentWorkView = Object.freeze({
  currentWork: null,
  currentWorkSource: null,
  currentWorkAt: null,
  currentWorkAgeLabel: null,
  currentWorkTruncated: false,
});

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
 * Render a session's current work for `audience`.
 *
 * Prefers the headline, falls back to a truncated context, and reports which it
 * used. Reporting the source matters: a truncated scratch-board note and a line
 * someone wrote to be read are different kinds of claim, and collapsing them
 * would let the fallback pass as a deliberate status.
 *
 * An unauthorized reader gets the same view as a session that has said nothing —
 * every field null. That is the honest answer and it is also the quiet one: a
 * withheld-because-forbidden marker would confirm the row exists and has
 * something to say, which is most of what the boundary is protecting.
 *
 * Truncating to 160 chars is not an authorization boundary. 160 characters of
 * someone else's note is still someone else's note, so the gate is here, before
 * the slice, rather than in how much gets sliced.
 */
export function describeCurrentWork(
  session: CurrentWorkSource,
  audience: CurrentWorkAudience,
  now: number = Date.now()
): CurrentWorkView {
  if (audience !== 'owner') return NO_CURRENT_WORK;

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

  return NO_CURRENT_WORK;
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
  audience: CurrentWorkAudience,
  now: number = Date.now()
): CurrentWorkView {
  return describeCurrentWork(
    {
      headline: row.headline ?? undefined,
      headlineUpdatedAt: row.headline_updated_at ? new Date(row.headline_updated_at) : undefined,
      context: row.context ?? undefined,
      contextUpdatedAt: row.context_updated_at ? new Date(row.context_updated_at) : undefined,
    },
    audience,
    now
  );
}
