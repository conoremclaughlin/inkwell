/**
 * Resolve the Inkwell account for a Supabase sign-in by the sign-in itself
 * (users.auth_uid), never by its email alone (ink://specs/account-deletion
 * v6 §7).
 *
 * Supabase gives every sign-in a fresh id, and a deleted one is never
 * reused. So a request that outlives an account's deletion, carrying the
 * deleted sign-in, finds no account, even after someone signs up again with
 * the same email; under email lookup it would have landed on theirs.
 *
 * - An account bound to this sign-in is returned.
 * - A legacy account (no auth_uid yet) with this email is bound, by an
 *   update conditional on auth_uid still being null. If that loses a race it
 *   is read again, and accepted only if it is now bound to this same sign-in.
 *   An account bound to another sign-in is never accepted, whatever its email.
 * - Otherwise, when the caller may create, an account is created already
 *   bound, after a fresh check that the sign-in still exists. An insert
 *   conflict is resolved the same way: by this sign-in, never by email.
 *
 * An account that is being deleted is never bound or returned.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../../data/supabase/types';
import { accountGate } from './gate';

export type PrincipalResolution =
  | { ok: true; userId: string; created: boolean }
  | { ok: false; status: 403 | 500 | 503; reason: string };

const OTHER_PRINCIPAL = 'This email belongs to an account of another sign-in';
const BEING_DELETED = 'This account is being deleted';

export async function resolveAccountForPrincipal(
  supabase: SupabaseClient<Database>,
  input: { authUid: string; email: string | null; create: boolean }
): Promise<PrincipalResolution> {
  const { authUid, email, create } = input;

  const bound = await byAuthUid(supabase, authUid);
  if (bound.error) return failed(bound.error);
  if (bound.id) return accept(bound.id, false);

  if (email) {
    const legacy = await supabase
      .from('users')
      .select('id, auth_uid')
      .eq('email', email)
      .maybeSingle();
    if (legacy.error) return failed(legacy.error.message);
    if (legacy.data) {
      const row = legacy.data as { id: string; auth_uid: string | null };
      if (row.auth_uid !== null) {
        return row.auth_uid === authUid
          ? accept(row.id, false)
          : { ok: false, status: 403, reason: OTHER_PRINCIPAL };
      }
      if (accountGate.isClosed(row.id)) return { ok: false, status: 403, reason: BEING_DELETED };
      const claimed = await supabase
        .from('users')
        .update({ auth_uid: authUid })
        .eq('id', row.id)
        .is('auth_uid', null)
        .select('id');
      if (claimed.error) return failed(claimed.error.message);
      if ((claimed.data ?? []).length === 1) return accept(row.id, false);
      // Lost the race: accept it only if it is now bound to this sign-in.
      const reread = await byAuthUid(supabase, authUid);
      if (reread.error) return failed(reread.error);
      if (reread.id === row.id) return accept(row.id, false);
      return { ok: false, status: 403, reason: OTHER_PRINCIPAL };
    }
  }

  if (!create) return { ok: false, status: 403, reason: 'No account for this sign-in' };
  if (!email) return { ok: false, status: 403, reason: 'No email for this sign-in' };

  // The sign-in may have been deleted since the caller verified it. Absence
  // must be confirmed: any other answer refuses.
  const still = await supabase.auth.admin.getUserById(authUid);
  if (still.error || !still.data?.user) {
    return {
      ok: false,
      status: still.error && !/not.?found/i.test(still.error.message) ? 503 : 403,
      reason: 'This sign-in no longer exists',
    };
  }

  const inserted = await supabase
    .from('users')
    .insert({ email, auth_uid: authUid })
    .select('id')
    .single();
  if (!inserted.error && inserted.data) return accept((inserted.data as { id: string }).id, true);

  // A conflict, on the email or on the sign-in: resolve it by the sign-in.
  const after = await byAuthUid(supabase, authUid);
  if (after.error) return failed(after.error);
  if (after.id) return accept(after.id, false);
  return inserted.error?.code === '23505'
    ? { ok: false, status: 403, reason: OTHER_PRINCIPAL }
    : failed(inserted.error?.message ?? 'account creation failed');
}

async function byAuthUid(
  supabase: SupabaseClient<Database>,
  authUid: string
): Promise<{ id?: string; error?: string }> {
  const { data, error } = await supabase
    .from('users')
    .select('id')
    .eq('auth_uid', authUid)
    .maybeSingle();
  if (error) return { error: error.message };
  return { id: (data as { id: string } | null)?.id };
}

function accept(userId: string, created: boolean): PrincipalResolution {
  if (accountGate.isClosed(userId)) return { ok: false, status: 403, reason: BEING_DELETED };
  return { ok: true, userId, created };
}

function failed(message: string): PrincipalResolution {
  return { ok: false, status: 500, reason: `Account lookup failed: ${message}` };
}
