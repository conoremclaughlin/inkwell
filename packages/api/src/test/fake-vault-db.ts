/**
 * FakePostgrest with a stand-in for the Supabase Vault store's database half
 * (supabase/migrations/20261008004326_saved_logins_vault.sql):
 *   - create_saved_login_secret keeps the value as given, in an owner row of
 *     saved_login_secrets (there is no encryption here);
 *   - saved_logins_opened is computed from saved_logins and those rows each
 *     time it is read, so a read sees one state, as a single statement does.
 * It has no foreign keys or triggers. It proves what the server sends and how
 * it reads each answer, never the SQL: that is
 * services/saved-logins/vault-store.integration.test.ts.
 */
import { randomUUID } from 'node:crypto';
import { FakePostgrest, type Row } from './fake-postgrest';

export const OWNERS = 'saved_login_secrets';
export const OPENED = 'saved_logins_opened';

export class FakeVaultDb extends FakePostgrest {
  constructor() {
    super();
    this.rpcHandlers.create_saved_login_secret = (args) => {
      const row = this.seed(OWNERS, {
        secret_id: randomUUID(),
        user_id: args.p_owner,
        value: args.p_value,
      });
      return { data: row.secret_id, error: null };
    };
  }

  override rows(table: string): Row[] {
    if (table !== OPENED) return super.rows(table);
    const owners = super.rows(OWNERS);
    const value = (id: unknown) => owners.find((owner) => owner.secret_id === id)?.value ?? null;
    return super.rows('saved_logins').map((login) => ({
      id: login.id,
      user_id: login.user_id,
      revision: login.revision,
      created_at: login.created_at,
      updated_at: login.updated_at,
      item_value: value(login.item_secret_id),
      secret_value: value(login.secret_secret_id),
    }));
  }
}
