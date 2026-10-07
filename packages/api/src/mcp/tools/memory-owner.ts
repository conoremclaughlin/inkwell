/**
 * Whose memories a call acts for.
 *
 * Every memory has exactly one owner, a canonical identity, and every
 * agent-facing memory path acts only for that owner
 * (ink://specs/remove-shared-memories §3.1). Until 2026-10-07 a memory with
 * no owner was "shared" and reached every SB of the user, inklings included,
 * and a read with no slug applied no owner filter at all: an inkling calling
 * `recall({})` or `bootstrap({})` read every memory of every SB under its user.
 *
 * So remember, recall and bootstrap resolve their owner here, and the tools
 * that address a memory by id (history, restore, forget, update_memory)
 * resolve their actor here, the same way. Each gets an owner or a refusal:
 * "no owner, so no filter" is not an outcome either function has.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../../data/supabase/types';
import type { MemoryOwnerFilter } from '../../data/models/memory';
import { resolveSbIdResult, resolveSbSlug } from '../../auth/resolve-identity';
import { getRequestContext } from '../../utils/request-context';
import { resolveCallerIdentity } from './caller-identity';

export interface MemoryOwner extends MemoryOwnerFilter {
  sbId: string;
}

export type MemoryOwnerResolution =
  | {
      ok: true;
      owner: MemoryOwner;
      /** An SB's own token, or the stdio pin: confined to its own memories. */
      agentBound: boolean;
    }
  | { ok: false; error: string };

/**
 * Resolve the owner of a memory call.
 *
 * 1. A bound token, or the stdio pin, wins. Its owner is the identity it
 *    was minted for: the signed sbId, or its slug resolved in the trusted
 *    actor-derived workspace (resolveSbIdResult with no explicit scope, which
 *    ignores a header-selected workspace). An explicit slug naming another SB is refused, never
 *    silently replaced, and the unsigned x-ink-context header never moves
 *    the owner. A bound token reads and writes its own memories only (D2).
 * 2. A person's token names the SB with the explicit slug, or else the
 *    request context's, and that slug must resolve to exactly one identity
 *    in the trusted actor-derived workspace. A person keeps same-user authority over all
 *    of their SBs' memories.
 * 3. With no identity at all, there is no owner, and the caller is refused.
 */
export async function resolveMemoryOwner(
  supabase: SupabaseClient<Database>,
  userId: string,
  explicitSlug?: string
): Promise<MemoryOwnerResolution> {
  const caller = resolveCallerIdentity();

  if (caller.agentBound) {
    let sbSlug = caller.sbSlug;
    let sbId = caller.sbId;
    if (sbId && !sbSlug) {
      sbSlug = (await resolveSbSlug(supabase, sbId)) ?? undefined;
      if (!sbSlug) return refuse('The identity this token was issued for could not be read.');
    }
    if (!sbSlug) return refuse('This token carries no identity to own memories.');
    if (explicitSlug !== undefined && explicitSlug !== sbSlug) {
      return refuse(
        `This token belongs to ${sbSlug}, and an SB reads and writes only its own memories; ` +
          `${explicitSlug}'s were not touched.`
      );
    }
    if (!sbId) {
      const resolved = await resolveSbIdResult(supabase, userId, sbSlug);
      if (!resolved.ok) return refuse(unresolved(sbSlug, resolved.reason));
      sbId = resolved.sbId;
    }
    return { ok: true, owner: { sbId, sbSlug }, agentBound: true };
  }

  const sbSlug = explicitSlug ?? getRequestContext()?.sbSlug;
  if (!sbSlug) {
    return refuse(
      'Pass sbSlug: this request carries no identity, and there are no shared memories.'
    );
  }
  const resolved = await resolveSbIdResult(supabase, userId, sbSlug);
  if (!resolved.ok) return refuse(unresolved(sbSlug, resolved.reason));
  return { ok: true, owner: { sbId: resolved.sbId, sbSlug }, agentBound: false };
}

/**
 * Who is acting on memories addressed by id: history, restore, forget and
 * update_memory. An SB acts for its own identity only. A person acts as
 * themselves, with the same-user authority the repository already enforces,
 * and does not have to name an SB to reach a memory the id already names
 * (Lumen, spec v2 re-review).
 */
export type MemoryActor = { kind: 'person' } | { kind: 'agent'; owner: MemoryOwner };

export async function resolveMemoryActor(
  supabase: SupabaseClient<Database>,
  userId: string
): Promise<{ ok: true; actor: MemoryActor } | { ok: false; error: string }> {
  if (!resolveCallerIdentity().agentBound) return { ok: true, actor: { kind: 'person' } };
  const resolution = await resolveMemoryOwner(supabase, userId);
  if (!resolution.ok) return resolution;
  return { ok: true, actor: { kind: 'agent', owner: resolution.owner } };
}

/** The owner filter a repository call takes for this actor: none for a person. */
export function actorOwnerSbId(actor: MemoryActor): string | undefined {
  return actor.kind === 'agent' ? actor.owner.sbId : undefined;
}

function refuse(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

function unresolved(sbSlug: string, reason: string): string {
  return reason === 'lookup-failed'
    ? `Could not look up ${sbSlug}'s identity just now; nothing was read or written. Try again.`
    : `"${sbSlug}" does not name exactly one SB here (${reason}), so its memories have no owner to act for.`;
}

/**
 * The owner of a memory the server writes on a session's behalf: a phase
 * transition, an end-of-session summary, a compaction. It is the session's
 * own identity, never the caller's parameter. A session with no SB, or one
 * whose slug no longer resolves to exactly one identity, gets no memory.
 */
export async function sessionMemoryOwner(
  supabase: SupabaseClient<Database>,
  session: { userId?: string; sbSlug?: string; sbId?: string }
): Promise<MemoryOwner | null> {
  if (!session.sbSlug) return null;
  if (session.sbId) return { sbSlug: session.sbSlug, sbId: session.sbId };
  if (!session.userId) return null;
  const resolved = await resolveSbIdResult(supabase, session.userId, session.sbSlug);
  return resolved.ok ? { sbSlug: session.sbSlug, sbId: resolved.sbId } : null;
}
