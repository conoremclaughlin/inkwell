/**
 * One-use requests through the approval interceptor, against the real
 * database (spec automated-turn-permissions §3.5):
 *   - a bulk reply ("approve all", a scope, a numbered batch) never resolves
 *     one, so a destructive command is approved only when it is the one
 *     request answered;
 *   - any approving reply resolves it as a one-shot `grant`;
 *   - a grant wakes the session it was asked from, by id.
 * The wake goes through handleSendToInbox, which is recorded here rather
 * than delivered.
 *
 * Run via: yarn workspace @inklabs/api test:integration:db
 */
import { describe, it, expect, beforeAll, afterEach, afterAll, vi } from 'vitest';
import { randomUUID } from 'crypto';

const sends = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>> }));
vi.mock('../mcp/tools/inbox-handlers.js', () => ({
  handleSendToInbox: vi.fn(async (args: Record<string, unknown>) => {
    sends.calls.push(args);
    return { success: true };
  }),
}));

import { getDataComposer, type DataComposer } from '../data/composer';
import { checkApprovalResponse } from './approval-interceptor';

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

describe('one-use approval requests through the interceptor', () => {
  let composer: DataComposer;
  let userId: string;
  let sessionId: string;
  const requestIds: string[] = [];

  async function insertPending(oneUse: boolean): Promise<string> {
    const { data, error } = await composer
      .getClient()
      .from('approval_requests')
      .insert({
        user_id: userId,
        session_id: sessionId,
        requesting_agent_id: 'echo',
        tool: 'Bash',
        args: oneUse ? 'rm -rf /tmp/fixture-out' : 'docker push registry/app',
        ...(oneUse ? { scope_key: randomUUID() } : {}),
        expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
        timeout_seconds: 1800,
      } as never)
      .select('id')
      .single();
    if (error || !data) throw new Error(`insert failed: ${error?.message}`);
    requestIds.push((data as { id: string }).id);
    return (data as { id: string }).id;
  }

  async function statusOf(id: string): Promise<{ status: string; action: string | null }> {
    const { data, error } = await composer
      .getClient()
      .from('approval_requests')
      .select('status, action')
      .eq('id', id)
      .single();
    if (error) throw new Error(error.message);
    return data as { status: string; action: string | null };
  }

  beforeAll(async () => {
    composer = await getDataComposer();
    userId = await createSuiteUser(composer);
    sessionId = randomUUID();
    const { error } = await composer
      .getClient()
      .from('sessions')
      .insert({ id: sessionId, user_id: userId, agent_id: 'echo', status: 'active' } as never);
    if (error) throw new Error(error.message);
  });

  afterEach(async () => {
    sends.calls.length = 0;
    await composer.getClient().from('approval_requests').delete().eq('user_id', userId);
  });

  afterAll(async () => {
    await composer.getClient().from('sessions').delete().eq('id', sessionId);
    await composer.getClient().from('users').delete().eq('id', userId);
  });

  it('"approve all" resolves the ordinary requests and leaves a one-use request pending', async () => {
    const ordinary = await insertPending(false);
    const oneUse = await insertPending(true);
    const result = await checkApprovalResponse(userId, 'telegram:100200300', 'approve all');
    expect(result.intercepted).toBe(true);
    expect((await statusOf(ordinary)).status).toBe('granted');
    expect((await statusOf(oneUse)).status).toBe('pending');
    expect(sends.calls).toEqual([]);
  });

  it('answered alone, it is granted as a one-shot grant, whatever scope the reply named', async () => {
    const oneUse = await insertPending(true);
    await checkApprovalResponse(userId, 'telegram:100200300', 'approve session');
    expect(await statusOf(oneUse)).toEqual({ status: 'granted', action: 'grant' });
  });

  it('a grant wakes the session it was asked from, by id', async () => {
    const oneUse = await insertPending(true);
    await checkApprovalResponse(userId, 'telegram:100200300', 'approve');
    expect(sends.calls).toHaveLength(1);
    expect(sends.calls[0]).toMatchObject({
      userId,
      recipientSessionId: sessionId,
      messageType: 'session_resume',
      metadata: { approvalRequestId: oneUse },
    });
    expect(String(sends.calls[0].content)).toContain('rm -rf /tmp/fixture-out');
  });

  it('a denial wakes no one', async () => {
    const oneUse = await insertPending(true);
    await checkApprovalResponse(userId, 'telegram:100200300', 'deny');
    expect((await statusOf(oneUse)).status).toBe('denied');
    expect(sends.calls).toEqual([]);
  });
});
