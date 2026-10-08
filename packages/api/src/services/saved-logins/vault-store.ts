/**
 * The Supabase Vault saved-login store: each half of a login is a Vault
 * secret, and saved_logins records which person owns which two
 * (supabase/migrations/20261008004326_saved_logins_vault.sql).
 *
 * The database encrypts. A value reaches Postgres through PostgREST as a
 * function argument and is encrypted as it is written
 * (create_saved_login_secret); it is read back decrypted through the
 * saved_login_vault_secrets view, by id. Inside the encrypted text each half
 * names its owner, its login and which half it is, and one that names anything
 * else is refused, so a row pointed at someone else's secret doesn't open.
 *
 * An edit never changes a secret in place: it makes two new ones and points
 * the row at them in one fenced statement, and the database deletes the old
 * ones in that same statement (the trigger). A secret this server made for a
 * write that didn't land is deleted again; if that fails, it stays, tagged
 * with its owner, until deleteAllSavedLogins removes it.
 *
 * Key custody: Vault's root key lives with the database. On a local or
 * self-hosted stack that is the same machine, so this is not managed key
 * custody until the database is hosted.
 */
import { randomUUID } from 'node:crypto';
import { logger } from '../../utils/logger';
import {
  allOwnRows,
  bindingFor,
  parseHalf,
  storedLogin,
  type Client,
  type Half,
  type LoginItem,
  type LoginSecret,
  type OpenedLogin,
  type SavedLoginStore,
} from './store';

interface VaultLoginRow {
  id: string;
  user_id: string;
  item_secret_id: string;
  secret_secret_id: string;
  revision: number;
  created_at: string;
  updated_at: string;
}

/** The decrypted saved-login secrets, by id (service_role only). */
const SECRETS = 'saved_login_vault_secrets';
/** Ids per read of SECRETS: each one is in the request's address. */
const IDS_PER_READ = 100;

/** How Vault tags a person's saved-login secrets (create_saved_login_secret). */
export function ownerTag(userId: string): string {
  return `saved_login:${userId}`;
}

/** The text Vault keeps for one half: the value, and whose half of which login it is. */
function envelope(userId: string, loginId: string, half: Half, value: LoginItem | LoginSecret) {
  return JSON.stringify({ for: bindingFor(userId, loginId, half), value });
}

function unwrap<T>(text: string | undefined, userId: string, loginId: string, half: Half): T {
  if (typeof text !== 'string') throw new Error('A saved-login secret is missing');
  const opened = parseHalf<{ for?: unknown; value?: unknown }>(text);
  if (opened?.for !== bindingFor(userId, loginId, half) || opened.value === undefined) {
    throw new Error('A saved-login secret belongs to another login');
  }
  return opened.value as T;
}

async function createSecret(db: Client, userId: string, value: string): Promise<string> {
  const { data, error } = await db.rpc('create_saved_login_secret', {
    p_owner: userId,
    p_value: value,
  });
  if (error) throw new Error(error.message);
  if (typeof data !== 'string') throw new Error('Vault returned no secret id');
  return data;
}

/**
 * The decrypted text of each id, read a bounded number of ids at a time and
 * asked again for any a capped page left out. An id that never comes back is
 * absent from the map, and the half that needed it refuses to open.
 */
async function readSecrets(db: Client, ids: string[]): Promise<Map<string, string>> {
  const values = new Map<string, string>();
  let pending = [...new Set(ids)];
  while (pending.length > 0) {
    const batch = pending.slice(0, IDS_PER_READ);
    const { data, error } = await db.from(SECRETS).select('id, value').in('id', batch);
    if (error) throw new Error(error.message);
    let found = 0;
    for (const row of data ?? []) {
      const id = row.id as unknown;
      const value = row.value as unknown;
      if (typeof id !== 'string' || typeof value !== 'string') continue;
      if (!batch.includes(id) || values.has(id)) continue;
      values.set(id, value);
      found += 1;
    }
    if (found === 0) break;
    pending = pending.filter((id) => !values.has(id));
  }
  return values;
}

/**
 * Deletes secrets made for a write that didn't land. The foreign keys from
 * saved_logins refuse to delete one a row points at, so a write that failed in
 * transit and landed anyway keeps its secrets. Failing here is logged, never
 * thrown: the caller is already answering with the write's own failure.
 */
async function discard(db: Client, userId: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  try {
    const { error } = await db
      .from(SECRETS)
      .delete()
      .in('id', ids)
      .eq('owner_tag', ownerTag(userId));
    if (error) throw new Error(error.message);
  } catch (error) {
    logger.warn('Saved logins: kept secrets from a write that did not land', {
      count: ids.length,
      reason: error instanceof Error ? error.name : 'unknown',
    });
  }
}

export function createVaultStore(client: () => Promise<Client>): SavedLoginStore {
  async function ownRow(db: Client, userId: string, id: string): Promise<VaultLoginRow | null> {
    const { data, error } = await db
      .from('saved_logins')
      .select('*')
      .eq('id', id)
      .eq('user_id', userId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return (data as VaultLoginRow | null) ?? null;
  }

  /** New secrets for both halves of a login; any made are discarded if the second fails. */
  async function createBoth(
    db: Client,
    userId: string,
    id: string,
    item: LoginItem,
    secret: LoginSecret
  ): Promise<[string, string]> {
    const itemSecretId = await createSecret(db, userId, envelope(userId, id, 'item', item));
    try {
      return [itemSecretId, await createSecret(db, userId, envelope(userId, id, 'secret', secret))];
    } catch (error) {
      await discard(db, userId, [itemSecretId]);
      throw error;
    }
  }

  return {
    kind: 'supabase-vault',

    async list(userId) {
      const db = await client();
      const rows = await allOwnRows<VaultLoginRow>(db, 'saved_logins', userId);
      if (rows === null) return null;
      const items = await readSecrets(
        db,
        rows.map((row) => row.item_secret_id)
      );
      return rows.map((row) => ({
        login: storedLogin(row),
        item: unwrap<LoginItem>(items.get(row.item_secret_id), userId, row.id, 'item'),
      }));
    },

    async open(userId, id, halves) {
      const db = await client();
      const row = await ownRow(db, userId, id);
      if (!row) return null;
      const opened: OpenedLogin = { login: storedLogin(row) };
      const wanted = [
        ...(halves.includes('item') ? [row.item_secret_id] : []),
        ...(halves.includes('secret') ? [row.secret_secret_id] : []),
      ];
      if (wanted.length === 0) return opened;
      const values = await readSecrets(db, wanted);
      if (halves.includes('item')) {
        opened.item = unwrap<LoginItem>(values.get(row.item_secret_id), userId, id, 'item');
      }
      if (halves.includes('secret')) {
        opened.secret = unwrap<LoginSecret>(values.get(row.secret_secret_id), userId, id, 'secret');
      }
      return opened;
    },

    async create(userId, item, secret) {
      const db = await client();
      const id = randomUUID();
      const [itemSecretId, secretSecretId] = await createBoth(db, userId, id, item, secret);
      try {
        const { data, error } = await db
          .from('saved_logins')
          .insert({
            id,
            user_id: userId,
            item_secret_id: itemSecretId,
            secret_secret_id: secretSecretId,
            revision: 1,
          })
          .select('*')
          .single();
        if (error) throw new Error(error.message);
        return storedLogin(data as VaultLoginRow);
      } catch (error) {
        await discard(db, userId, [itemSecretId, secretSecretId]);
        throw error;
      }
    },

    async replace(userId, id, revision, item, secret) {
      const db = await client();
      const made = await createBoth(db, userId, id, item, secret);
      try {
        // The new secrets and the next revision in one statement, only from
        // `revision`; the trigger deletes the old secrets in the same statement.
        const { data, error } = await db
          .from('saved_logins')
          .update({ item_secret_id: made[0], secret_secret_id: made[1], revision: revision + 1 })
          .eq('id', id)
          .eq('user_id', userId)
          .eq('revision', revision)
          .select('*')
          .maybeSingle();
        if (error) throw new Error(error.message);
        if (!data) {
          await discard(db, userId, made);
          return null;
        }
        return storedLogin(data as VaultLoginRow);
      } catch (error) {
        await discard(db, userId, made);
        throw error;
      }
    },

    async remove(userId, id) {
      // The trigger deletes the login's secrets in the same statement.
      const { data, error } = await (await client())
        .from('saved_logins')
        .delete()
        .eq('id', id)
        .eq('user_id', userId)
        .select('id');
      if (error) throw new Error(error.message);
      return Boolean(data && data.length > 0);
    },
  };
}

/**
 * Removes every saved login a person has in Supabase Vault, for account
 * deletion: their rows (the trigger deletes each row's secrets) and then any
 * secret tagged for them that no row points at, left by a write that didn't
 * land. Deleting the users row alone removes the rows and their secrets by
 * cascade, but not those leftovers.
 */
export async function deleteAllVaultLogins(db: Client, userId: string): Promise<void> {
  const { error } = await db.from('saved_logins').delete().eq('user_id', userId);
  if (error) throw new Error(error.message);
  const { error: leftoverError } = await db
    .from(SECRETS)
    .delete()
    .eq('owner_tag', ownerTag(userId));
  if (leftoverError) throw new Error(leftoverError.message);
}
