import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { FakeVaultDb, OWNERS } from '../../test/fake-vault-db';
import { deleteAllSavedLogins, savedLoginStore } from './index';
import { parseHalf, type Client } from './store';

const PASSWORD = 'FAKE-hunter2-Q9';

describe('parseHalf', () => {
  it('fails without quoting the text, which JSON.parse would', () => {
    const broken = `{"password":"${PASSWORD}`;
    // The control: V8's own message repeats the text it couldn't parse.
    let raw = '';
    try {
      JSON.parse(`${PASSWORD} is not json`);
    } catch (error) {
      raw = (error as Error).message;
    }
    expect(raw).toContain(PASSWORD.slice(0, 5));
    expect(() => parseHalf(broken)).toThrow('A saved-login half did not parse');
    try {
      parseHalf(`${PASSWORD} is not json`);
    } catch (error) {
      expect((error as Error).message).not.toContain(PASSWORD.slice(0, 5));
    }
  });
});

describe('deleteAllSavedLogins', () => {
  let db: FakeVaultDb;
  const ADA = randomUUID();
  const SAM = randomUUID();

  beforeEach(() => {
    db = new FakeVaultDb();
  });

  it('removes the person’s logins in both stores and their leftover Vault secrets, and no one else’s', async () => {
    const client = async () => db as unknown as Client;
    const vault = savedLoginStore(client, { SAVED_LOGINS_STORE: 'supabase-vault' })!;
    const item = { name: 'Example', url: null, username: null };
    const secret = { password: PASSWORD, authenticator: null };
    await vault.create(ADA, item, secret);
    await vault.create(SAM, item, secret);
    // A secret no row points at: a write that didn't land.
    await db.rpc('create_saved_login_secret', { p_owner: ADA, p_value: 'left over' });
    db.seed('saved_logins_sealed', { user_id: ADA, item_sealed: 'v1.x', secret_sealed: 'v1.x' });
    db.seed('saved_logins_sealed', { user_id: SAM, item_sealed: 'v1.x', secret_sealed: 'v1.x' });

    await deleteAllSavedLogins(db as unknown as Client, ADA);

    for (const table of ['saved_logins', 'saved_logins_sealed']) {
      expect(db.rows(table).map((r) => r.user_id)).toEqual([SAM]);
    }
    // Every secret the person owns goes, the leftover included. (The fake has
    // no trigger or foreign keys; vault-store.integration.test.ts proves the
    // real ones.)
    expect(db.rows(OWNERS).filter((s) => s.user_id === ADA)).toHaveLength(0);
    expect(db.rows(OWNERS).filter((s) => s.user_id === SAM)).toHaveLength(2);
  });

  it('stops at the first failure rather than reporting success', async () => {
    db.from = () => {
      throw new Error('connection lost');
    };
    await expect(deleteAllSavedLogins(db as unknown as Client, ADA)).rejects.toThrow();
  });
});
