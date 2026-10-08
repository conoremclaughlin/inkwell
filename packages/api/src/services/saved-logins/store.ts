/**
 * What a saved-login store is (routes/admin-vault.ts); index.ts picks one.
 *
 * Each saved login has two halves: what may be listed (name, address,
 * username) and its secrets (password, authenticator setup key). Listing opens
 * only the first. A store keeps both encrypted and opens a half only for the
 * person who owns it; inside its encrypted text each half names its owner,
 * its login and which half it is (bindingFor), and a half that names anything
 * else is refused.
 *
 * Two stores, chosen by SAVED_LOGINS_STORE:
 *   - supabase-vault (the default): each half is a Supabase Vault secret,
 *     encrypted by the database under its root key (vault-store.ts);
 *   - sealed: each half is AES-256-GCM sealed by this server under
 *     SAVED_LOGINS_SEALING_KEY and kept in a row (sealed-store.ts).
 * They keep separate tables. Switching stores moves nothing: the other
 * store's logins stay where they are, unlisted, until switched back.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../../data/supabase/types';
import type { Authenticator } from './authenticator';

export type Client = SupabaseClient<Database>;

/** What may be listed. */
export interface LoginItem {
  name: string;
  url: string | null;
  username: string | null;
}

/** The secrets. */
export interface LoginSecret {
  password: string | null;
  authenticator: Authenticator | null;
}

/** A saved login without either half. */
export interface StoredLogin {
  id: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export type Half = 'item' | 'secret';

/** A login and the halves that were asked for; a half not asked for is absent. */
export interface OpenedLogin {
  login: StoredLogin;
  item?: LoginItem;
  secret?: LoginSecret;
}

export interface SavedLoginStore {
  readonly kind: SavedLoginStoreKind;
  /** Every login the person owns, with what may be listed; null if there are more than MAX_LISTED. */
  list(userId: string): Promise<Array<{ login: StoredLogin; item: LoginItem }> | null>;
  /** The person's login with this id and the halves asked for, or null if they have none. */
  open(userId: string, id: string, halves: Half[]): Promise<OpenedLogin | null>;
  create(userId: string, item: LoginItem, secret: LoginSecret): Promise<StoredLogin>;
  /**
   * Replaces both halves and moves to the next revision, in one write, if the
   * login is still the person's at `revision`; null if it has moved on or gone.
   */
  replace(
    userId: string,
    id: string,
    revision: number,
    item: LoginItem,
    secret: LoginSecret
  ): Promise<StoredLogin | null>;
  /** False if the person has no login with this id. */
  remove(userId: string, id: string): Promise<boolean>;
}

export type SavedLoginStoreKind = 'supabase-vault' | 'sealed';

/** Rows asked for per page. A server may cap a page lower; listing carries on regardless. */
export const PAGE = 500;
/** More than this, and the list refuses rather than answering with some of them. */
export const MAX_LISTED = 5000;

/** What a half's encrypted text must name: one half of one login of one person. */
export function bindingFor(userId: string, loginId: string, half: Half): string {
  return `saved_login:${userId}:${loginId}:${half}`;
}

/**
 * JSON.parse that never repeats what it was given. A SyntaxError's message can
 * quote the text, and the text here is a decrypted half.
 */
export function parseHalf<T>(text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error('A saved-login half did not parse');
  }
}

export function storedLogin(row: {
  id: string;
  revision: number;
  created_at: string;
  updated_at: string;
}): StoredLogin {
  return {
    id: row.id,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Every row the person owns in `table`, a page at a time in id order, however
 * low the server caps a page. Null if there are more than MAX_LISTED: a list
 * is never answered with only some of them.
 */
export async function allOwnRows<Row extends { id: string }>(
  db: Client,
  table: 'saved_logins_opened' | 'saved_logins_sealed',
  userId: string,
  columns = '*'
): Promise<Row[] | null> {
  const rows: Row[] = [];
  let after: string | null = null;
  // The generated types can't follow one query across a table and a view;
  // the caller types the rows.
  const untyped = db as unknown as SupabaseClient;
  for (;;) {
    let query = untyped.from(table).select(columns).eq('user_id', userId);
    if (after !== null) query = query.gt('id', after);
    const { data, error } = await query.order('id', { ascending: true }).limit(PAGE);
    if (error) throw new Error(error.message);
    const page = (data ?? []) as unknown as Row[];
    if (page.length === 0) return rows;
    const last = page[page.length - 1].id;
    if (after !== null && !(last > after)) throw new Error('Listing did not advance');
    rows.push(...page);
    if (rows.length > MAX_LISTED) return null;
    after = last;
  }
}
