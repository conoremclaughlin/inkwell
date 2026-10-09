/**
 * Whether the SB a signed token names still exists.
 *
 * Inkwell tokens carry no workspace. They name an SB: by UUID (`sbId`, or
 * `identityId` in older tokens) and by slug. Deleting a space deletes its
 * SBs' identity rows (agent_identities_workspace_id_fkey ON DELETE CASCADE)
 * while the owner's account stays, and a signed token is otherwise checked
 * without a database read. So a deleted space's SBs kept working until their
 * tokens expired: a runner token's hour, a CLI token's 30 days, and a refresh
 * token's 90, each refresh minting a new access token (task 3f7f6a8f).
 *
 * The check:
 * - A UUID is checked exactly: is there a row with that id.
 * - A slug alone is checked among the token's user's identities: is there any
 *   row with that slug. A slug is unique only within a workspace, so a
 *   deleted space's slug-only token still passes while its user has an SB of
 *   the same slug in another space.
 * - A token that names no SB (a person's) is not checked.
 *
 * One indexed read: the primary key, or (user_id, agent_id) for a slug.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '../utils/logger';

/** The SB a token names, as the verified token or refresh record carries it. */
export interface TokenIdentityClaims {
  userId: string;
  sbId?: string | null;
  sbSlug?: string | null;
}

/**
 * - `none`: the token names no SB.
 * - `live`: the SB it names exists.
 * - `gone`: the SB it names has no identity row.
 * - `unreadable`: the read failed, so neither is known.
 */
export type TokenIdentityState = 'none' | 'live' | 'gone' | 'unreadable';

export async function tokenIdentityState(
  supabase: SupabaseClient,
  claims: TokenIdentityClaims
): Promise<TokenIdentityState> {
  const sbId = claims.sbId?.trim();
  const sbSlug = claims.sbSlug?.trim();
  if (!sbId && !sbSlug) return 'none';

  // Never throws: a read that throws is as unreadable as one that returns an
  // error, and the seams answer it with a 503. A rejection here would escape
  // a route with no try/catch and leave the request hanging.
  let data: unknown[] | null = null;
  let failure: string | null = null;
  try {
    const query = sbId
      ? supabase.from('agent_identities').select('id').eq('id', sbId).limit(1)
      : supabase
          .from('agent_identities')
          .select('id')
          .eq('user_id', claims.userId)
          .eq('agent_id', sbSlug!)
          .limit(1);
    const result = await query;
    data = result.data;
    failure = result.error?.message ?? null;
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }
  if (failure !== null) {
    logger.error('Could not read the SB a token names; refusing to treat it as live', {
      userId: claims.userId,
      by: sbId ? 'id' : 'slug',
      error: failure,
    });
    return 'unreadable';
  }
  if ((data ?? []).length > 0) return 'live';
  logger.warn('Refused a token whose SB no longer exists', {
    userId: claims.userId,
    by: sbId ? 'id' : 'slug',
  });
  return 'gone';
}
