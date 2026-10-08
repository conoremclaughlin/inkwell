/**
 * The deletion worker end to end against a real database, with its file
 * roots in a temporary directory and the Supabase sign-in deletion stood in
 * for (ink://specs/account-deletion v6 §4).
 *
 * Run via: yarn test:integration:db:local src/services/account-deletion/worker.integration.test.ts
 *
 * Every person here is invented, at example.com.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDataComposer } from '../../data/composer';
import { savedLoginStore } from '../saved-logins';
import { claudeProjectDirName } from './files';
import { accountGate } from './gate';
import { advanceDeletion, type DeletionDeps } from './worker';

const run = randomUUID().slice(0, 8);
let base: string;
let roots: DeletionDeps['roots'];
const revoked: string[] = [];
const stopped: string[] = [];

async function client() {
  return (await getDataComposer()).getClient();
}

async function deps(): Promise<DeletionDeps> {
  return {
    db: await client(),
    deleteAuthUser: async (authUid) => {
      revoked.push(authUid);
      return 'deleted';
    },
    stopTurns: (sbIds) => stopped.push(...sbIds),
    serverInstance: () => 'test-host:1',
    roots,
    uploadsRoot: null,
    drainTimeoutMs: 50,
    now: Date.now,
  };
}

async function consumer(label: string, extra?: { identityMetadata?: Record<string, unknown> }) {
  const db = await client();
  const authUid = randomUUID();
  const { data: user, error } = await db
    .from('users')
    .insert({ email: `${label}-${run}@example.com`, auth_uid: authUid })
    .select('id')
    .single();
  if (error || !user) throw new Error(`user: ${error?.message}`);
  const { data: personal } = await db
    .from('workspaces')
    .select('id')
    .eq('user_id', user.id)
    .eq('type', 'personal')
    .single();
  const { data: inkling, error: idError } = await db
    .from('agent_identities')
    .insert({
      user_id: user.id,
      workspace_id: personal!.id,
      agent_id: `inkling-${label}-${run}`,
      name: 'Pip',
      role: 'Inkling',
      metadata: (extra?.identityMetadata ?? { client: 'inkling-mobile' }) as never,
    })
    .select('id')
    .single();
  if (idError || !inkling) throw new Error(`identity: ${idError?.message}`);
  const { error: reqError } = await db
    .from('account_deletion_requests')
    .insert({ user_id: user.id, auth_uid: authUid });
  if (reqError) throw new Error(`request: ${reqError.message}`);
  return { userId: user.id, sbId: inkling.id, authUid };
}

function plantFiles(sbId: string) {
  const folder = join(roots.inklings, sbId);
  mkdirSync(join(folder, '.ink', 'runtime', 'repl'), { recursive: true });
  writeFileSync(join(folder, '.ink', 'runtime', 'repl', 'session-1.jsonl'), '{}');
  mkdirSync(join(roots.inklings, '.tool-policy'), { recursive: true });
  writeFileSync(join(roots.inklings, '.tool-policy', `${sbId}.json`), '{}');
  const projects = join(roots.claudeProjects, claudeProjectDirName(folder));
  mkdirSync(projects, { recursive: true });
  writeFileSync(join(projects, 'transcript.jsonl'), '{}');
  return { folder, projects };
}

/** Vault secrets still tagged for the person, counted in vault.secrets itself. */
async function vaultSecretsTaggedFor(userId: string): Promise<number> {
  const url = process.env.INTEGRATION_DB_URL;
  if (!url) throw new Error('INTEGRATION_DB_URL is required: run through the managed harness');
  const { Client: Pg } = await import('pg');
  const asPostgres = new URL(url);
  asPostgres.username = 'postgres';
  const pg = new Pg({ connectionString: asPostgres.toString() });
  await pg.connect();
  try {
    const { rows } = await pg.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM vault.secrets WHERE description = $1',
      [`saved_login:${userId}`]
    );
    return rows[0]!.n;
  } finally {
    await pg.end();
  }
}

async function stepOf(userId: string) {
  const { data } = await (await client())
    .from('account_deletion_requests')
    .select('step, outcomes')
    .eq('user_id', userId)
    .single();
  return data as { step: string; outcomes: Record<string, unknown> };
}

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'acct-worker-')));
  roots = {
    inklings: join(base, 'inklings'),
    claudeProjects: join(base, 'claude-projects'),
    codexSessions: join(base, 'codex-sessions'),
  };
  for (const dir of Object.values(roots)) mkdirSync(dir, { recursive: true });
});

afterAll(() => rmSync(base, { recursive: true, force: true }));

describe('the deletion worker', () => {
  it('takes a consumer account from request to completed: sign-in, files and rows', async () => {
    const lia = await consumer('lia');
    const { folder, projects } = plantFiles(lia.sbId);

    const result = await advanceDeletion(await deps(), lia.userId);

    expect(result).toEqual({ step: 'completed' });
    expect(revoked).toContain(lia.authUid);
    expect(stopped).toContain(lia.sbId);
    expect(existsSync(folder)).toBe(false);
    expect(existsSync(projects)).toBe(false);
    expect(existsSync(join(roots.inklings, '.tool-policy', `${lia.sbId}.json`))).toBe(false);
    const db = await client();
    expect((await db.from('users').select('id').eq('id', lia.userId)).data).toEqual([]);
    expect((await stepOf(lia.userId)).step).toBe('completed');
    expect(accountGate.isClosed(lia.userId)).toBe(false);
  });

  it('takes the account’s saved logins with it, leaving no Vault secret tagged for them', async () => {
    const pia = await consumer('pia');
    const db = await client();
    const store = savedLoginStore(async () => db, { SAVED_LOGINS_STORE: 'supabase-vault' })!;
    const item = { name: 'Example Mail', url: 'https://mail.example.test', username: null };
    const secret = (label: string) => ({
      password: `FAKE-PW-${run}-${label}`,
      authenticator: null,
    });
    const saved = await store.create(pia.userId, item, secret('first'));
    // An edit points the login at a new pair; the old pair goes with the edit.
    await store.replace(pia.userId, saved.id, saved.revision, item, secret('second'));
    await store.create(pia.userId, { ...item, name: 'Second' }, secret('other'));
    // A secret whose write never landed: owned, though no login points at it.
    const { error } = await db.rpc('create_saved_login_secret', {
      p_owner: pia.userId,
      p_value: `FAKE-PW-${run}-leftover`,
    });
    expect(error).toBeNull();
    // Someone else's login, which stays.
    const { data: bystander } = await db
      .from('users')
      .insert({ email: `kai-${run}@example.com`, auth_uid: randomUUID() })
      .select('id')
      .single();
    await store.create(bystander!.id, item, secret('kai'));
    // Two logins' pairs and the leftover; vault-store's own tests pin that the
    // edit's old pair is gone already.
    expect(await vaultSecretsTaggedFor(pia.userId)).toBeGreaterThanOrEqual(5);

    try {
      // No removeSavedLogins in deps: under the saved-login triggers, the
      // users delete in delete_account is the whole cleanup.
      expect(await advanceDeletion(await deps(), pia.userId)).toEqual({ step: 'completed' });

      expect(await vaultSecretsTaggedFor(pia.userId)).toBe(0);
      expect((await db.from('saved_logins').select('id').eq('user_id', pia.userId)).data).toEqual(
        []
      );
      expect(
        (await db.from('saved_login_secrets').select('secret_id').eq('user_id', pia.userId)).data
      ).toEqual([]);
      expect(await vaultSecretsTaggedFor(bystander!.id)).toBe(2);
    } finally {
      await db.from('users').delete().eq('id', bystander!.id);
    }
  });

  it('holds an operator account before anything is revoked', async () => {
    const max = await consumer('max', { identityMetadata: {} });
    const before = revoked.length;

    const result = await advanceDeletion(await deps(), max.userId);

    expect(result.step).toBe('requested');
    expect(result.held).toMatch(/not an inkling/);
    expect(revoked.length).toBe(before);
    expect(accountGate.isClosed(max.userId)).toBe(false);
  });

  it('waits at the drain while work of the account is inside its gate, and finishes once it leaves', async () => {
    const neo = await consumer('neo');
    const lease = accountGate.enter(neo.userId);

    const held = await advanceDeletion(await deps(), neo.userId);
    expect(held).toMatchObject({
      step: 'auth_revoked',
      held: 'work of the account is still running',
    });
    // The work that entered before the close keeps its lease; new work is refused.
    expect(() => accountGate.enter(neo.userId)).toThrow();

    lease.release();
    expect(await advanceDeletion(await deps(), neo.userId)).toEqual({ step: 'completed' });
  });

  it('holds when a file of the inventory is a link, removing nothing', async () => {
    const oli = await consumer('oli');
    const outside = join(base, 'outside');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'keep.txt'), 'keep');
    symlinkSync(outside, join(roots.inklings, oli.sbId));

    const result = await advanceDeletion(await deps(), oli.userId);

    expect(result.step).toBe('drained');
    expect(result.held).toMatch(/inkling-folder held: a link/);
    expect(existsSync(join(outside, 'keep.txt'))).toBe(true);
    const db = await client();
    expect((await db.from('users').select('id').eq('id', oli.userId)).data).toHaveLength(1);
  });
});
