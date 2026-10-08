/**
 * The Supabase Vault saved-login store: each half of a login is a Vault
 * secret owned by its person (saved_login_secrets), and saved_logins records
 * which two are each login's
 * (supabase/migrations/20261008004326_saved_logins_vault.sql).
 *
 * The database encrypts. A value reaches Postgres through PostgREST as a
 * function argument and is encrypted as it is written
 * (create_saved_login_secret). A login and its halves are read back together,
 * decrypted, in one statement (saved_logins_opened), so an edit landing at the
 * same moment is seen whole or not at all. Inside the encrypted text each half
 * names its owner, its login and which half it is, and one that names
 * anything else is refused, so a row pointed at someone else's secret doesn't
 * open.
 *
 * An edit never changes a secret in place: it makes two new ones and points
 * the row at them in one fenced statement, and the database deletes the old
 * ones in that same statement (the triggers). A secret made for a write that
 * didn't land is deleted again; if that fails, it stays, owned by its person,
 * and goes with them when their account is deleted.
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

interface OpenedRow {
  id: string;
  user_id: string;
  revision: number;
  created_at: string;
  updated_at: string;
  item_value?: string | null;
  secret_value?: string | null;
}

/** Each login with its halves decrypted, read in one statement (service_role only). */
const OPENED = 'saved_logins_opened';
/** Which person owns each saved-login secret; deleting a row deletes its secret. */
const OWNERS = 'saved_login_secrets';
const LOGIN_COLUMNS = 'id, user_id, revision, created_at, updated_at';

/** The text Vault keeps for one half: the value, and whose half of which login it is. */
function envelope(userId: string, loginId: string, half: Half, value: LoginItem | LoginSecret) {
  return JSON.stringify({ for: bindingFor(userId, loginId, half), value });
}

function unwrap<T>(
  text: string | null | undefined,
  userId: string,
  loginId: string,
  half: Half
): T {
  if (typeof text !== 'string') throw new Error('A saved-login secret did not open');
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
 * Deletes secrets made for a write that didn't land. The database refuses to
 * delete one a login points at, so a write that failed in transit and landed
 * anyway keeps its secrets. Failing here is logged, never thrown: the caller
 * is already answering with the write's own failure.
 */
async function discard(db: Client, userId: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  try {
    const { error } = await db.from(OWNERS).delete().in('secret_id', ids).eq('user_id', userId);
    if (error) throw new Error(error.message);
  } catch (error) {
    logger.warn('Saved logins: kept secrets from a write that did not land', {
      count: ids.length,
      reason: error instanceof Error ? error.name : 'unknown',
    });
  }
}

export function createVaultStore(client: () => Promise<Client>): SavedLoginStore {
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
      // Each page reads rows and their listable halves in one statement; the
      // secret half isn't selected, so it isn't decrypted.
      const rows = await allOwnRows<OpenedRow>(
        await client(),
        OPENED,
        userId,
        `${LOGIN_COLUMNS}, item_value`
      );
      if (rows === null) return null;
      return rows.map((row) => ({
        login: storedLogin(row),
        item: unwrap<LoginItem>(row.item_value, userId, row.id, 'item'),
      }));
    },

    async open(userId, id, halves) {
      const columns = [
        LOGIN_COLUMNS,
        ...(halves.includes('item') ? ['item_value'] : []),
        ...(halves.includes('secret') ? ['secret_value'] : []),
      ].join(', ');
      const { data, error } = await (await client())
        .from(OPENED)
        .select(columns)
        .eq('id', id)
        .eq('user_id', userId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      const row = data as unknown as OpenedRow | null;
      if (!row) return null;
      const opened: OpenedLogin = { login: storedLogin(row) };
      if (halves.includes('item')) {
        opened.item = unwrap<LoginItem>(row.item_value, userId, id, 'item');
      }
      if (halves.includes('secret')) {
        opened.secret = unwrap<LoginSecret>(row.secret_value, userId, id, 'secret');
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
          .select(LOGIN_COLUMNS)
          .single();
        if (error) throw new Error(error.message);
        return storedLogin(data as unknown as OpenedRow);
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
        // `revision`; the triggers delete the old secrets in the same statement.
        const { data, error } = await db
          .from('saved_logins')
          .update({ item_secret_id: made[0], secret_secret_id: made[1], revision: revision + 1 })
          .eq('id', id)
          .eq('user_id', userId)
          .eq('revision', revision)
          .select(LOGIN_COLUMNS)
          .maybeSingle();
        if (error) throw new Error(error.message);
        if (!data) {
          await discard(db, userId, made);
          return null;
        }
        return storedLogin(data as unknown as OpenedRow);
      } catch (error) {
        await discard(db, userId, made);
        throw error;
      }
    },

    async remove(userId, id) {
      // The triggers delete the login's secrets in the same statement.
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
 * Removes every saved login a person has in Supabase Vault, without deleting
 * the person: their logins (the triggers delete each one's secrets) and any
 * secret of theirs no login points at, left by a write that didn't land.
 * Deleting the users row does all of this by cascade on its own.
 */
export async function deleteAllVaultLogins(db: Client, userId: string): Promise<void> {
  const { error } = await db.from('saved_logins').delete().eq('user_id', userId);
  if (error) throw new Error(error.message);
  const { error: leftoverError } = await db.from(OWNERS).delete().eq('user_id', userId);
  if (leftoverError) throw new Error(leftoverError.message);
}
