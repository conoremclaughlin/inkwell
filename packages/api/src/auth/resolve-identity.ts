/**
 * Shared identity resolution utility.
 *
 * Resolves an SB's canonical UUID from the agent_identities table given a
 * (user_id, agent_id) pair.  Used across all write paths that store sb_id
 * alongside the text agent_id slug.
 *
 * A slug is unique only *within a workspace* — the workspace is an SB's
 * identity boundary, and two workspaces may each legitimately have their own
 * "wren".  The schema says so: `agent_identities_user_workspace_agent_id_key`
 * is UNIQUE (user_id, workspace_id, agent_id).  So a slug lookup is only
 * well-formed when it is given the workspace to resolve inside of.  Without
 * one, a slug that exists in two workspaces has no single right answer, and
 * this resolver refuses rather than guessing — picking the most recently
 * updated row would silently attribute one SB's work to another.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../data/supabase/types';
import { getRequestContext } from '../utils/request-context';
import { logger } from '../utils/logger';

interface IdentityCandidate {
  id: string;
  workspace_id: string | null;
}

/**
 * Why a slug did not resolve.  The distinction matters at owner-bearing
 * writes: 'no-identity' means nobody claimed the row, which is a legitimate
 * unattributed write, while the others mean a claim was made and could not be
 * honoured — writing sb_id: null for those hands the row to the legacy
 * slug-only authorization path, where two same-slug SBs both pass.
 */
export type IdentityResolution =
  | { ok: true; sbId: string }
  | { ok: false; reason: 'no-identity' | 'ambiguous' | 'not-in-workspace' | 'lookup-failed' };

/** Postgres returns uuid columns canonically lower-cased; header input is not. */
function sameUuid(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * The workspace to resolve a slug inside, when the caller did not name one.
 *
 * Only a *derived* workspace is usable here.  The server derives that one from
 * the caller's own identity, so it is the actor's own scope.  A workspace that
 * arrived in the `x-ink-workspace-id` header is a resource-selection scope the
 * user chose, and it is accepted whenever the USER has access — so honouring it
 * here would let a header rename the authenticated writer: token identity A
 * (`wren` in workspace A) plus a header selecting workspace B that also has a
 * `wren` would stamp B's UUID on A's writes (Lumen, PR #634).  A resource
 * scope must never redefine the actor.  Callers that genuinely mean "resolve
 * inside this workspace" pass it explicitly.
 */
function ambientActorWorkspace(): string | undefined {
  const reqCtx = getRequestContext();
  return reqCtx?.workspaceSource === 'derived' ? reqCtx.workspaceId : undefined;
}

/**
 * Resolve the canonical identity UUID for a slug, reporting why when it cannot.
 *
 * @param workspaceId The workspace to resolve the slug inside.  When omitted,
 *   only a workspace the server derived from the caller's own identity is used;
 *   see ambientActorWorkspace.
 */
export async function resolveIdentityResult(
  supabase: SupabaseClient<Database>,
  userId: string,
  sbSlug: string,
  workspaceId?: string
): Promise<IdentityResolution> {
  const scope = workspaceId ?? ambientActorWorkspace();

  const { data, error } = await supabase
    .from('agent_identities')
    .select('id, workspace_id')
    .eq('user_id', userId)
    .eq('agent_id', sbSlug);

  if (error) {
    logger.warn('Failed to resolve identity UUID for agent slug', {
      sbSlug,
      workspaceId: scope,
      error: error.message,
    });
    return { ok: false, reason: 'lookup-failed' };
  }

  // PostgREST returns an array for a select without .single(). Anything else —
  // a bare object, or data and error both null — is a response we cannot read,
  // and that is NOT the same as a successfully queried empty list. Reporting it
  // as 'no-identity' would let an owner-bearing write insert a fresh null-owned
  // row, which is precisely the legacy ownership path this change exists to
  // stop feeding (Lumen, PR #634 round 2).
  if (!Array.isArray(data)) {
    logger.warn('Unreadable identity lookup response', { agentId, workspaceId: scope });
    return { ok: false, reason: 'lookup-failed' };
  }

  const candidates = data as IdentityCandidate[];
  if (candidates.length === 0) return { ok: false, reason: 'no-identity' };

  if (scope) {
    // At most one row can match exactly: UNIQUE (user_id, workspace_id, agent_id).
    const scoped = candidates.find((row) => sameUuid(row.workspace_id, scope));
    if (scoped) return { ok: true, sbId: scoped.id };

    // Legacy rows predating workspace scoping carry a NULL workspace and are not
    // yet claimed by any workspace.  At most one can exist:
    // `agent_identities_user_agent_null_workspace_key` is a partial UNIQUE on
    // (user_id, agent_id) WHERE workspace_id IS NULL.  Accept it so identities
    // that have not been backfilled keep resolving, and say so loudly.
    const unscoped = candidates.find((row) => row.workspace_id === null);
    if (unscoped) {
      logger.warn('Resolved agent slug to a legacy identity with no workspace', {
        sbSlug,
        workspaceId: scope,
        identityId: unscoped.id,
        hint: 'Backfill agent_identities.workspace_id for this row',
      });
      return { ok: true, sbId: unscoped.id };
    }

    logger.warn('Agent slug does not exist in this workspace', {
      sbSlug,
      workspaceId: scope,
      candidateWorkspaceCount: candidates.length,
    });
    return { ok: false, reason: 'not-in-workspace' };
  }

  if (candidates.length === 1) return { ok: true, sbId: candidates[0].id };

  // No workspace to resolve inside and more than one answer.  Refuse: choosing
  // between two SBs who share a slug is a coin flip, and the loser's memories,
  // activity and leases would be written under the winner's UUID.
  logger.error('Refusing to resolve an ambiguous agent slug without a workspace', {
    sbSlug,
    candidateCount: candidates.length,
  });
  return { ok: false, reason: 'ambiguous' };
}

/**
 * Slug -> canonical identity UUID, or null.
 *
 * For callers where attribution is optional and a missing sb_id is harmless.
 * Anything that writes an OWNER should use resolveIdentityResult and fail
 * closed instead, so that "nobody claimed this" and "a claim was made and
 * could not be honoured" do not collapse into the same null.
 */
export async function resolveIdentityId(
  supabase: SupabaseClient<Database>,
  userId: string,
  agentId: string,
  workspaceId?: string
): Promise<string | null> {
  const result = await resolveIdentityResult(supabase, userId, agentId, workspaceId);
  return result.ok ? result.sbId : null;
}

/**
 * Reverse lookup: resolve an agent slug from a canonical identity UUID.
 *
 * Unambiguous in the direction that matters — a UUID names exactly one row.
 */
export async function resolveAgentSlug(
  supabase: SupabaseClient<Database>,
  sbId: string
): Promise<string | null> {
  const { data, error } = await supabase
    .from('agent_identities')
    .select('agent_id')
    .eq('id', sbId)
    .single();

  if (error) {
    logger.warn('Failed to resolve agent slug from identity UUID', {
      sbId,
      error: error.message,
    });
    return null;
  }

  return (data as { agent_id: string } | null)?.agent_id ?? null;
}

/**
 * Resolve an owner for a row that carries ownership.
 *
 * Fails closed when a slug was supplied and could not be honoured. Writing
 * sb_id: null there is not "unattributed" — it drops the row into the legacy
 * slug-only authorization path, where two same-slug SBs both authorize
 * (isIdentityAuthorized / studioOwnershipMismatch). Only "nobody claimed this"
 * is allowed to be null (Lumen, PR #634).
 */
export async function resolveOwnerSbId(
  supabase: Parameters<typeof resolveIdentityResult>[0],
  userId: string | undefined,
  agentId: string | undefined,
  known?: string | null
): Promise<string | null> {
  if (known) return known;
  if (!agentId || !userId) return null;
  const result = await resolveIdentityResult(supabase, userId, agentId);
  if (result.ok) return result.sbId;
  if (result.reason === 'no-identity') return null;
  throw new Error(
    `Refusing to write a row owned by "${agentId}": identity unresolved (${result.reason}). ` +
      'Pass the canonical sbId, or scope the request to the right workspace.'
  );
}
