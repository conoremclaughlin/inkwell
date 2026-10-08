/**
 * Saved logins: which store a server keeps them in, and removing all of a
 * person's for account deletion. store.ts says what a store is.
 */
import { createSealedStore } from './sealed-store';
import { sealingKeyFrom } from './sealing';
import type { Client, SavedLoginStore } from './store';
import { createVaultStore, deleteAllVaultLogins } from './vault-store';

/**
 * The store named by SAVED_LOGINS_STORE (supabase-vault when unset), or null
 * if this server can't keep saved logins: an unknown name, or the sealed
 * store without a valid SAVED_LOGINS_SEALING_KEY.
 */
export function savedLoginStore(
  client: () => Promise<Client>,
  source: NodeJS.ProcessEnv = process.env
): SavedLoginStore | null {
  const kind = source.SAVED_LOGINS_STORE?.trim() || 'supabase-vault';
  if (kind === 'supabase-vault') return createVaultStore(client);
  if (kind === 'sealed') {
    const key = sealingKeyFrom(source);
    return key ? createSealedStore(client, key) : null;
  }
  return null;
}

/**
 * Removes every saved login a person has, in both stores, whichever this
 * server uses. For account deletion: call it before deleting the users row.
 * That delete cascades to both tables, and the Vault rows' trigger deletes
 * their secrets, but only this also removes a Vault secret left by a write
 * that didn't land, which no row points at.
 */
export async function deleteAllSavedLogins(db: Client, userId: string): Promise<void> {
  const { error } = await db.from('saved_logins_sealed').delete().eq('user_id', userId);
  if (error) throw new Error(error.message);
  await deleteAllVaultLogins(db, userId);
}

export type { SavedLoginStore } from './store';
