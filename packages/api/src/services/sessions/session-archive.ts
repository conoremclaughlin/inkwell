/**
 * The archive fields of a session, and the two metadata contracts that go
 * with them (ink://specs/session-lifecycle-model v7 §2).
 *
 * `archived_at` is the one "do not route here automatically" signal. It
 * replaces `ended_at` as the routing fence at the T11 cutover; until then
 * these fields are carried and mapped but nothing routes on them. Parsing is
 * strict: a value outside the contract reads as absent, never as a guess.
 */

/** Why a session was archived (spec §2.2). Matches the column's CHECK. */
export const SESSION_ARCHIVED_REASONS = ['backfill', 'deliberate', 'handoff', 'empty'] as const;
export type SessionArchivedReason = (typeof SESSION_ARCHIVED_REASONS)[number];

/**
 * A backend refused to resume this transcript (spec §2.3). Only a structured
 * resume refusal: never a content refusal, an auth or quota failure, or a
 * crash. Written by the runner or an authorized recovery path.
 */
export interface SessionResumeRefused {
  reason: string;
  /** ISO timestamp of the refusal. */
  at: string;
  backend: string;
  backendSessionId: string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseArchivedReason(value: unknown): SessionArchivedReason | undefined {
  return typeof value === 'string' &&
    (SESSION_ARCHIVED_REASONS as readonly string[]).includes(value)
    ? (value as SessionArchivedReason)
    : undefined;
}

/** `metadata.handedOffTo`: the successor session's id, or absent. */
export function readHandedOffTo(metadata: unknown): string | undefined {
  if (!metadata || typeof metadata !== 'object') return undefined;
  const value = (metadata as Record<string, unknown>).handedOffTo;
  return typeof value === 'string' && UUID_RE.test(value) ? value : undefined;
}

/** `metadata.resumeRefused`, when it has the full shape; otherwise absent. */
export function readResumeRefused(metadata: unknown): SessionResumeRefused | undefined {
  if (!metadata || typeof metadata !== 'object') return undefined;
  const value = (metadata as Record<string, unknown>).resumeRefused;
  if (!value || typeof value !== 'object') return undefined;
  const r = value as Record<string, unknown>;
  if (typeof r.reason !== 'string' || r.reason === '') return undefined;
  if (typeof r.at !== 'string' || Number.isNaN(Date.parse(r.at))) return undefined;
  if (typeof r.backend !== 'string' || r.backend === '') return undefined;
  if (r.backendSessionId !== null && typeof r.backendSessionId !== 'string') return undefined;
  return {
    reason: r.reason,
    at: r.at,
    backend: r.backend,
    backendSessionId: r.backendSessionId as string | null,
  };
}
