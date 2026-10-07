/**
 * A session the caller named on a send, checked before anything is stored
 * (ink://specs/session-lifecycle-model v7 §3 rungs 1–2, task T4).
 *
 * "Explicit" means caller intent: `recipientSessionId` or `sessionKey` on
 * send_to_inbox. Thread history and participant stamps also produce session
 * ids, but those are continuity hints and never come through here.
 *
 * Before this, a made-up `recipientSessionId` was accepted without complaint
 * and routing quietly dropped it (observed 2026-10-02), and a key no live
 * session carried minted a new session under that key. Both now refuse, and
 * nothing is stored, triggered or stamped. Conor, 2026-10-02: "If the address
 * is wrong, just like the mail, we should know."
 *
 * What is admitted: a session of the same user and the same recipient
 * identity, in owner scope (an inbox send never lands in a per-sender contact
 * session). An ended session is admitted: an explicit address reopens it at
 * delivery (Conor, 2026-10-02). Refusals name only the recipient's own
 * sessions, never whether an id exists for someone else.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { AmbiguousAliasError, SessionRepository } from './session-repository';
import { sessionKeyMatchPattern } from './session-key';

export type ExplicitAddressRefusal =
  | 'unknown-session'
  | 'contact-scoped'
  | 'session-key-miss'
  | 'session-key-ambiguous'
  | 'conflicting-address';

export interface SessionKeyCandidate {
  sessionId: string;
  sessionKey: string;
  studioId: string | null;
}

export class ExplicitAddressRefusedError extends Error {
  readonly code = 'EXPLICIT_ADDRESS_REFUSED';

  constructor(
    readonly reason: ExplicitAddressRefusal,
    message: string,
    readonly candidates: SessionKeyCandidate[] = []
  ) {
    super(message);
    this.name = 'ExplicitAddressRefusedError';
  }
}

export interface ResolvedExplicitAddress {
  sessionId: string;
  via: 'recipientSessionId' | 'sessionKey';
  /** The session has ended; delivery reopens it. */
  ended: boolean;
}

interface AddressedSessionRow {
  id: string;
  user_id: string;
  sb_id: string | null;
  agent_id: string | null;
  contact_id: string | null;
  ended_at: string | null;
  lifecycle: string | null;
  status: string | null;
}

/** Ended in any of the three spellings the pickers read today. */
function hasEnded(row: Pick<AddressedSessionRow, 'ended_at' | 'lifecycle' | 'status'>): boolean {
  if (row.ended_at) return true;
  if (row.lifecycle === 'completed') return true;
  const status = (row.status ?? '').toLowerCase();
  return status === 'completed' || status.startsWith('completed:');
}

function belongsToRecipient(
  row: AddressedSessionRow,
  input: { userId: string; recipientSlug: string; recipientSbId: string | null }
): boolean {
  if (row.user_id !== input.userId) return false;
  // A row that carries an identity must match it canonically. Only a legacy
  // row with no identity falls back to the slug.
  if (row.sb_id) return input.recipientSbId ? row.sb_id === input.recipientSbId : false;
  return row.agent_id === input.recipientSlug;
}

function listSessionsHint(slug: string): string {
  return `list_sessions(sbSlug: "${slug}", status: "attachable") shows its sessions and keys.`;
}

/**
 * Resolve the caller's named session, or refuse. Returns null when the send
 * names no session. `studioId` scopes a key lookup to the studio the caller
 * named, when it named one.
 */
export async function resolveExplicitAddress(
  supabase: SupabaseClient,
  input: {
    userId: string;
    recipientSlug: string;
    recipientSbId: string | null;
    recipientSessionId?: string;
    sessionKey?: string;
    studioId?: string;
  }
): Promise<ResolvedExplicitAddress | null> {
  const { userId, recipientSlug, recipientSbId } = input;
  if (!input.recipientSessionId && !input.sessionKey) return null;

  let byId: ResolvedExplicitAddress | null = null;
  if (input.recipientSessionId) {
    const { data, error } = await supabase
      .from('sessions')
      .select('id, user_id, sb_id, agent_id, contact_id, ended_at, lifecycle, status')
      .eq('id', input.recipientSessionId)
      .eq('user_id', userId)
      .maybeSingle();
    // An unreadable address fails the send. Delivering anyway would reach
    // routing with an unchecked id, which is the fall-through this replaces.
    if (error) throw new Error(`Could not check recipientSessionId: ${error.message}`);
    const row = data as AddressedSessionRow | null;
    if (!row || !belongsToRecipient(row, { userId, recipientSlug, recipientSbId })) {
      throw new ExplicitAddressRefusedError(
        'unknown-session',
        `recipientSessionId ${input.recipientSessionId} is not a session of "${recipientSlug}". ` +
          `Nothing was sent. ${listSessionsHint(recipientSlug)}`
      );
    }
    if (row.contact_id) {
      throw new ExplicitAddressRefusedError(
        'contact-scoped',
        `recipientSessionId ${row.id} is one of "${recipientSlug}"'s per-sender contact ` +
          `sessions, and an inbox send never lands in one. Nothing was sent.`
      );
    }
    byId = { sessionId: row.id, via: 'recipientSessionId', ended: hasEnded(row) };
  }

  if (!input.sessionKey) return byId;

  const key = input.sessionKey;
  let match;
  try {
    match = await new SessionRepository(supabase).findByAlias(
      userId,
      recipientSlug,
      key,
      input.studioId,
      recipientSbId
    );
  } catch (err) {
    if (err instanceof AmbiguousAliasError) {
      throw new ExplicitAddressRefusedError(
        'session-key-ambiguous',
        `${err.message} Nothing was sent.`,
        err.candidates.map((c) => ({
          sessionId: c.sessionId,
          sessionKey: c.alias ?? key,
          studioId: c.studioId,
        }))
      );
    }
    throw err;
  }

  if (!match) {
    const candidates = await liveKeyedSessions(supabase, userId, recipientSlug, recipientSbId);
    const endedHolders = await endedHoldersOfKey(
      supabase,
      userId,
      recipientSlug,
      recipientSbId,
      key
    );
    const live = candidates.length
      ? `Its live keys: ${candidates.map((c) => `"${c.sessionKey}" (${c.sessionId})`).join(', ')}.`
      : `None of its live sessions carries a key.`;
    const ended = endedHolders.length
      ? ` An ended session carries this key (${endedHolders.join(', ')}); ` +
        `address it by recipientSessionId to reopen it.`
      : '';
    throw new ExplicitAddressRefusedError(
      'session-key-miss',
      `No live session of "${recipientSlug}" carries sessionKey "${key}"` +
        `${input.studioId ? ' in the studio you named' : ''}. Nothing was sent. ${live}${ended}`,
      candidates
    );
  }

  if (byId && byId.sessionId !== match.id) {
    throw new ExplicitAddressRefusedError(
      'conflicting-address',
      `recipientSessionId ${byId.sessionId} and sessionKey "${key}" (${match.id}) name ` +
        `different sessions of "${recipientSlug}". Nothing was sent. Pass one of them.`
    );
  }
  return { sessionId: match.id, via: byId ? 'recipientSessionId' : 'sessionKey', ended: false };
}

function scopeToRecipient<T>(
  query: T & { eq: (c: string, v: string) => T },
  recipientSlug: string,
  recipientSbId: string | null
): T {
  return recipientSbId ? query.eq('sb_id', recipientSbId) : query.eq('agent_id', recipientSlug);
}

async function liveKeyedSessions(
  supabase: SupabaseClient,
  userId: string,
  recipientSlug: string,
  recipientSbId: string | null
): Promise<SessionKeyCandidate[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let query: any = supabase
    .from('sessions')
    .select('id, alias, studio_id')
    .eq('user_id', userId)
    .is('ended_at', null)
    .is('contact_id', null)
    .not('alias', 'is', null);
  query = scopeToRecipient(query, recipientSlug, recipientSbId);
  const { data } = await query.order('started_at', { ascending: false }).limit(20);
  return ((data ?? []) as Array<{ id: string; alias: string; studio_id: string | null }>).map(
    (r) => ({ sessionId: r.id, sessionKey: r.alias, studioId: r.studio_id })
  );
}

async function endedHoldersOfKey(
  supabase: SupabaseClient,
  userId: string,
  recipientSlug: string,
  recipientSbId: string | null,
  key: string
): Promise<string[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let query: any = supabase
    .from('sessions')
    .select('id')
    .eq('user_id', userId)
    .not('ended_at', 'is', null)
    .is('contact_id', null)
    .ilike('alias', sessionKeyMatchPattern(key));
  query = scopeToRecipient(query, recipientSlug, recipientSbId);
  const { data } = await query.order('started_at', { ascending: false }).limit(5);
  return ((data ?? []) as Array<{ id: string }>).map((r) => r.id);
}
