/**
 * The sealed saved-login store: both halves sealed by this server
 * (sealing.ts) and kept in one row of saved_logins_sealed.
 *
 * The server holds the key, so this protects what is stored (a copy of the
 * database alone opens nothing), not what the server itself can read. A
 * missing or wrong key, or a value that won't open, refuses; nothing is ever
 * re-sealed over a value that didn't open. This is the reviewed r4 design,
 * kept so a server can use it instead of Supabase Vault (store.ts).
 */
import { randomUUID } from 'node:crypto';
import { open, seal } from './sealing';
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

interface SealedRow {
  id: string;
  user_id: string;
  item_sealed: string;
  secret_sealed: string;
  revision: number;
  created_at: string;
  updated_at: string;
}

export function createSealedStore(client: () => Promise<Client>, key: Buffer): SavedLoginStore {
  const openHalf = <T>(row: SealedRow, half: Half): T =>
    parseHalf<T>(
      open(
        key,
        half === 'item' ? row.item_sealed : row.secret_sealed,
        bindingFor(row.user_id, row.id, half)
      )
    );
  const sealHalf = (userId: string, id: string, half: Half, value: LoginItem | LoginSecret) =>
    seal(key, JSON.stringify(value), bindingFor(userId, id, half));

  async function ownRow(userId: string, id: string): Promise<SealedRow | null> {
    const { data, error } = await (await client())
      .from('saved_logins_sealed')
      .select('*')
      .eq('id', id)
      .eq('user_id', userId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return (data as SealedRow | null) ?? null;
  }

  return {
    kind: 'sealed',

    async list(userId) {
      const rows = await allOwnRows<SealedRow>(await client(), 'saved_logins_sealed', userId);
      if (rows === null) return null;
      return rows.map((row) => ({
        login: storedLogin(row),
        item: openHalf<LoginItem>(row, 'item'),
      }));
    },

    async open(userId, id, halves) {
      const row = await ownRow(userId, id);
      if (!row) return null;
      const opened: OpenedLogin = { login: storedLogin(row) };
      if (halves.includes('item')) opened.item = openHalf<LoginItem>(row, 'item');
      if (halves.includes('secret')) opened.secret = openHalf<LoginSecret>(row, 'secret');
      return opened;
    },

    async create(userId, item, secret) {
      const id = randomUUID();
      const { data, error } = await (
        await client()
      )
        .from('saved_logins_sealed')
        .insert({
          id,
          user_id: userId,
          item_sealed: sealHalf(userId, id, 'item', item),
          secret_sealed: sealHalf(userId, id, 'secret', secret),
          revision: 1,
        })
        .select('*')
        .single();
      if (error) throw new Error(error.message);
      return storedLogin(data as SealedRow);
    },

    async replace(userId, id, revision, item, secret) {
      // Both halves and the next revision in one statement, only from `revision`.
      const { data, error } = await (
        await client()
      )
        .from('saved_logins_sealed')
        .update({
          item_sealed: sealHalf(userId, id, 'item', item),
          secret_sealed: sealHalf(userId, id, 'secret', secret),
          revision: revision + 1,
        })
        .eq('id', id)
        .eq('user_id', userId)
        .eq('revision', revision)
        .select('*')
        .maybeSingle();
      if (error) throw new Error(error.message);
      return data ? storedLogin(data as SealedRow) : null;
    },

    async remove(userId, id) {
      const { data, error } = await (await client())
        .from('saved_logins_sealed')
        .delete()
        .eq('id', id)
        .eq('user_id', userId)
        .select('id');
      if (error) throw new Error(error.message);
      return Boolean(data && data.length > 0);
    },
  };
}
