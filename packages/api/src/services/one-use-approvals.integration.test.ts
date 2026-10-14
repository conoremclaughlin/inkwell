/**
 * One-use approval grants against the real database (spec
 * automated-turn-permissions §3.5): a grant is spent once, under
 * concurrency too, and only for exactly the scope it was asked in.
 *
 * Run via: yarn workspace @inklabs/api test:integration:db
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { getDataComposer, type DataComposer } from '../data/composer';
import {
  approvalScopeKey,
  consumeOneUseGrant,
  readSignedSession,
  type OneUseScope,
} from './one-use-approvals';

/** A user of this suite's own, so its approval rows never meet another file's. */
async function createSuiteUser(composer: DataComposer): Promise<string> {
  const id = randomUUID();
  const { error } = await composer
    .getClient()
    .from('users')
    .insert({
      id,
      email: `one-use-${id}@example.com`,
      username: `one-use-${id.slice(0, 8)}`,
      first_name: 'Suite',
      last_name: 'User',
      timezone: 'UTC',
      preferences: {},
    } as never);
  if (error) throw new Error(`suite user insert failed: ${error.message}`);
  return id;
}

describe('one-use approval grants', () => {
  let composer: DataComposer;
  let userId: string;
  let sessionId: string;
  let otherSessionId: string;
  const requestIds: string[] = [];

  const scopeFor = (overrides: Partial<OneUseScope> = {}): OneUseScope => ({
    userId,
    sessionId,
    studioId: null,
    sbId: null,
    tool: 'Bash',
    args: 'rm -rf /tmp/fixture-target',
    cwd: '/tmp',
    ...overrides,
  });

  async function insertSession(): Promise<string> {
    const id = randomUUID();
    const { error } = await composer
      .getClient()
      .from('sessions')
      .insert({ id, user_id: userId, agent_id: 'echo', status: 'active' } as never);
    if (error) throw new Error(`session insert failed: ${error.message}`);
    return id;
  }

  async function insertRequest(row: {
    session: string;
    scopeKey: string;
    status: 'pending' | 'granted' | 'denied';
    expiresInMs?: number;
  }): Promise<string> {
    const { data, error } = await composer
      .getClient()
      .from('approval_requests')
      .insert({
        user_id: userId,
        session_id: row.session,
        requesting_agent_id: 'echo',
        tool: 'Bash',
        args: 'rm -rf /tmp/fixture-target',
        scope_key: row.scopeKey,
        status: row.status,
        ...(row.status === 'granted' ? { action: 'grant' } : {}),
        expires_at: new Date(Date.now() + (row.expiresInMs ?? 10 * 60_000)).toISOString(),
        timeout_seconds: 1800,
      } as never)
      .select('id')
      .single();
    if (error || !data) throw new Error(`request insert failed: ${error?.message}`);
    requestIds.push((data as { id: string }).id);
    return (data as { id: string }).id;
  }

  beforeAll(async () => {
    composer = await getDataComposer();
    userId = await createSuiteUser(composer);
    sessionId = await insertSession();
    otherSessionId = await insertSession();
  });

  afterAll(async () => {
    const client = composer.getClient();
    if (requestIds.length) await client.from('approval_requests').delete().in('id', requestIds);
    await client.from('sessions').delete().in('id', [sessionId, otherSessionId]);
    await client.from('users').delete().eq('id', userId);
  });

  it('the scope key changes with every field, so nothing else can spend the grant', () => {
    const base = approvalScopeKey(scopeFor());
    for (const change of [
      { sessionId: otherSessionId },
      { studioId: randomUUID() },
      { sbId: randomUUID() },
      { tool: 'Edit' },
      { args: 'rm -rf /tmp/fixture-target ' },
      { cwd: '/tmp/other' },
      { userId: randomUUID() },
    ]) {
      expect(approvalScopeKey(scopeFor(change)), JSON.stringify(change)).not.toBe(base);
    }
    expect(approvalScopeKey(scopeFor())).toBe(base);
  });

  it('a granted request is spent once, and a second consume finds nothing', async () => {
    const scopeKey = approvalScopeKey(scopeFor({ args: 'rm -rf /tmp/once' }));
    const id = await insertRequest({ session: sessionId, scopeKey, status: 'granted' });
    const client = composer.getClient();
    expect(await consumeOneUseGrant(client, { userId, sessionId, scopeKey })).toBe(id);
    expect(await consumeOneUseGrant(client, { userId, sessionId, scopeKey })).toBeNull();
  });

  it('two racing consumes spend one grant exactly once', async () => {
    const scopeKey = approvalScopeKey(scopeFor({ args: 'rm -rf /tmp/race' }));
    const id = await insertRequest({ session: sessionId, scopeKey, status: 'granted' });
    const client = composer.getClient();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => consumeOneUseGrant(client, { userId, sessionId, scopeKey }))
    );
    expect(results.filter((r) => r === id)).toHaveLength(1);
    expect(results.filter((r) => r === null)).toHaveLength(7);
  });

  it('pending, denied, expired, another session or another scope: nothing to spend', async () => {
    const client = composer.getClient();
    const pendingKey = approvalScopeKey(scopeFor({ args: 'rm -rf /tmp/pending' }));
    await insertRequest({ session: sessionId, scopeKey: pendingKey, status: 'pending' });
    expect(
      await consumeOneUseGrant(client, { userId, sessionId, scopeKey: pendingKey })
    ).toBeNull();

    const deniedKey = approvalScopeKey(scopeFor({ args: 'rm -rf /tmp/denied' }));
    await insertRequest({ session: sessionId, scopeKey: deniedKey, status: 'denied' });
    expect(await consumeOneUseGrant(client, { userId, sessionId, scopeKey: deniedKey })).toBeNull();

    const expiredKey = approvalScopeKey(scopeFor({ args: 'rm -rf /tmp/expired' }));
    await insertRequest({
      session: sessionId,
      scopeKey: expiredKey,
      status: 'granted',
      expiresInMs: -1000,
    });
    expect(
      await consumeOneUseGrant(client, { userId, sessionId, scopeKey: expiredKey })
    ).toBeNull();

    const otherKey = approvalScopeKey(scopeFor({ args: 'rm -rf /tmp/other' }));
    await insertRequest({ session: otherSessionId, scopeKey: otherKey, status: 'granted' });
    expect(await consumeOneUseGrant(client, { userId, sessionId, scopeKey: otherKey })).toBeNull();
    expect(
      await consumeOneUseGrant(client, {
        userId,
        sessionId: otherSessionId,
        scopeKey: approvalScopeKey(scopeFor({ args: 'rm -rf /tmp/different' })),
      })
    ).toBeNull();
  });

  it("readSignedSession reads the token's session for this user only", async () => {
    const client = composer.getClient();
    expect(await readSignedSession(client, userId, sessionId)).toMatchObject({ sessionId });
    expect(await readSignedSession(client, randomUUID(), sessionId)).toBeNull();
    expect(await readSignedSession(client, userId, undefined)).toBeNull();
  });
});
