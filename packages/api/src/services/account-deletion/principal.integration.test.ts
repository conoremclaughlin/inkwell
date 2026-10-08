/**
 * Resolving an account by its Supabase sign-in, against a real database and
 * real Supabase sign-ins on the test stack (ink://specs/account-deletion v6
 * §7).
 *
 * Run via: yarn test:integration:db:local src/services/account-deletion/principal.integration.test.ts
 *
 * Every person here is invented, at example.com.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { getDataComposer } from '../../data/composer';
import { accountGate } from './gate';
import { resolveAccountForPrincipal } from './principal';

const run = randomUUID().slice(0, 8);
const signIns: string[] = [];

async function db() {
  return (await getDataComposer()).getClient();
}

async function signIn(email: string): Promise<string> {
  const { data, error } = await (
    await db()
  ).auth.admin.createUser({
    email,
    email_confirm: true,
    password: `pw-${randomUUID()}`,
  });
  if (error || !data.user) throw new Error(`sign-in: ${error?.message}`);
  signIns.push(data.user.id);
  return data.user.id;
}

async function deleteSignIn(id: string): Promise<void> {
  const { error } = await (await db()).auth.admin.deleteUser(id);
  if (error) throw new Error(`delete sign-in: ${error.message}`);
}

async function rowOf(email: string) {
  const { data } = await (await db()).from('users').select('id, auth_uid').eq('email', email);
  return data ?? [];
}

afterAll(async () => {
  const client = await db();
  for (const id of signIns) await client.auth.admin.deleteUser(id).catch(() => undefined);
});

describe('resolveAccountForPrincipal', () => {
  it('binds a legacy account to the sign-in that has its email', async () => {
    const email = `una-${run}@example.com`;
    const client = await db();
    const { data: legacy } = await client.from('users').insert({ email }).select('id').single();
    const authUid = await signIn(email);

    const resolved = await resolveAccountForPrincipal(client, { authUid, email, create: false });

    expect(resolved).toEqual({ ok: true, userId: legacy!.id, created: false });
    expect(await rowOf(email)).toEqual([{ id: legacy!.id, auth_uid: authUid }]);
  });

  it('never accepts an email whose account is bound to another sign-in', async () => {
    const email = `vic-${run}@example.com`;
    const client = await db();
    const first = await signIn(email);
    const created = await resolveAccountForPrincipal(client, {
      authUid: first,
      email,
      create: true,
    });
    expect(created).toMatchObject({ ok: true, created: true });

    const intruder = randomUUID();
    const resolved = await resolveAccountForPrincipal(client, {
      authUid: intruder,
      email,
      create: true,
    });

    expect(resolved).toMatchObject({ ok: false, status: 403 });
    expect(await rowOf(email)).toEqual([
      { id: (created as { userId: string }).userId, auth_uid: first },
    ]);
  });

  it('creates a new account already bound', async () => {
    const email = `wes-${run}@example.com`;
    const client = await db();
    const authUid = await signIn(email);
    const resolved = await resolveAccountForPrincipal(client, { authUid, email, create: true });
    expect(resolved).toMatchObject({ ok: true, created: true });
    expect(await rowOf(email)).toEqual([
      { id: (resolved as { userId: string }).userId, auth_uid: authUid },
    ]);
  });

  it('creates nothing for a sign-in that no longer exists', async () => {
    const email = `xia-${run}@example.com`;
    const client = await db();
    const authUid = await signIn(email);
    await deleteSignIn(authUid);
    const resolved = await resolveAccountForPrincipal(client, { authUid, email, create: true });
    expect(resolved).toMatchObject({ ok: false, status: 403 });
    expect(await rowOf(email)).toEqual([]);
  });

  it('never lets a stale request of a deleted sign-in reach the account of a later sign-up', async () => {
    const email = `yan-${run}@example.com`;
    const client = await db();
    // The first person, then their account and sign-in deleted.
    const old = await signIn(email);
    const first = await resolveAccountForPrincipal(client, { authUid: old, email, create: true });
    await client
      .from('users')
      .delete()
      .eq('id', (first as { userId: string }).userId);
    await deleteSignIn(old);
    // Someone signs up again with the same email.
    const fresh = await signIn(email);
    const second = await resolveAccountForPrincipal(client, {
      authUid: fresh,
      email,
      create: true,
    });
    expect(second).toMatchObject({ ok: true, created: true });

    // A request of the old sign-in that resumes now.
    expect(
      await resolveAccountForPrincipal(client, { authUid: old, email, create: true })
    ).toMatchObject({
      ok: false,
      status: 403,
    });
    expect(
      await resolveAccountForPrincipal(client, { authUid: old, email, create: false })
    ).toMatchObject({
      ok: false,
      status: 403,
    });
    expect(await rowOf(email)).toEqual([
      { id: (second as { userId: string }).userId, auth_uid: fresh },
    ]);
  });

  it('never returns an account that is being deleted', async () => {
    const email = `zoe-${run}@example.com`;
    const client = await db();
    const authUid = await signIn(email);
    const created = await resolveAccountForPrincipal(client, { authUid, email, create: true });
    const userId = (created as { userId: string }).userId;
    accountGate.close(userId);
    try {
      expect(
        await resolveAccountForPrincipal(client, { authUid, email, create: false })
      ).toMatchObject({
        ok: false,
        status: 403,
        reason: 'This account is being deleted',
      });
    } finally {
      accountGate.forget(userId);
    }
  });
});
