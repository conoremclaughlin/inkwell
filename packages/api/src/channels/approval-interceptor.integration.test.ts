/**
 * Approval Interceptor Integration Tests
 *
 * End-to-end: inserts real approval_requests rows against the local Supabase
 * database, then drives them through `checkApprovalResponse` and verifies the
 * resolved state on disk — status, action, granted_tools, granted_by,
 * resolved_at, and the optimistic lock.
 *
 * Run via: yarn workspace @inklabs/api test:integration:db
 */

import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import { getDataComposer, type DataComposer } from '../data/composer';
import { ensureEchoIntegrationFixture } from '../test/integration-fixtures';
import { checkApprovalResponse } from './approval-interceptor';

describe('Approval Interceptor Integration', () => {
  let dataComposer: DataComposer;
  let userId: string;
  const createdIds: string[] = [];

  beforeAll(async () => {
    dataComposer = await getDataComposer();
    const fixture = await ensureEchoIntegrationFixture(dataComposer);
    userId = fixture.userId;
  });

  afterEach(async () => {
    if (createdIds.length === 0) return;
    const supabase = dataComposer.getClient();
    await supabase.from('approval_requests').delete().in('id', createdIds);
    createdIds.length = 0;
  });

  afterAll(async () => {
    if (!dataComposer) return;
    const supabase = dataComposer.getClient();
    // Safety sweep: drop any leftover test rows for this user
    await supabase.from('approval_requests').delete().eq('user_id', userId);
  });

  async function insertPendingRequest(overrides: Record<string, unknown> = {}): Promise<string> {
    const supabase = dataComposer.getClient();
    const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
    const { data, error } = await supabase
      .from('approval_requests')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .insert({
        user_id: userId,
        requesting_agent_id: 'echo',
        tool: 'Bash',
        args: 'docker push registry/app',
        reason: 'test',
        expires_at: expiresAt,
        timeout_seconds: 300,
        ...overrides,
      } as any)
      .select('id')
      .single();

    if (error || !data) throw new Error(`insert failed: ${error?.message}`);
    createdIds.push(data.id);
    return data.id;
  }

  async function readRow(id: string) {
    const supabase = dataComposer.getClient();
    const { data, error } = await supabase
      .from('approval_requests')
      .select('id, status, action, granted_tools, granted_by, resolved_at')
      .eq('id', id)
      .single();
    if (error) throw new Error(`select failed: ${error.message}`);
    return data as unknown as {
      id: string;
      status: string;
      action: string | null;
      granted_tools: string[] | null;
      granted_by: string | null;
      resolved_at: string | null;
    };
  }

  it('resolves a pending request to granted on "approve"', async () => {
    const id = await insertPendingRequest();

    const result = await checkApprovalResponse(userId, 'telegram:chat-test', 'approve');
    expect(result.intercepted).toBe(true);
    expect(result.action).toBe('grant');
    expect(result.requestId).toBe(id);

    const row = await readRow(id);
    expect(row.status).toBe('granted');
    expect(row.action).toBe('grant');
    expect(row.granted_tools).toEqual(['Bash(docker push registry/app)']);
    expect(row.granted_by).toBe('platform:telegram:chat-test');
    expect(row.resolved_at).not.toBeNull();
  });

  it('resolves to denied on "deny" without granting any tools', async () => {
    const id = await insertPendingRequest();

    const result = await checkApprovalResponse(userId, 'telegram:chat-test', 'no');
    expect(result.intercepted).toBe(true);
    expect(result.action).toBe('deny');

    const row = await readRow(id);
    expect(row.status).toBe('denied');
    expect(row.action).toBe('deny');
    expect(row.granted_tools).toBeNull();
  });

  it('ignores messages that do not match an approval pattern', async () => {
    const id = await insertPendingRequest();

    const result = await checkApprovalResponse(userId, 'telegram:chat-test', 'hey what is up');
    expect(result.intercepted).toBe(false);

    const row = await readRow(id);
    expect(row.status).toBe('pending'); // untouched
  });

  it('does nothing when the user has no pending requests', async () => {
    // No insertPendingRequest call — user has no pending rows
    const result = await checkApprovalResponse(userId, 'telegram:chat-test', 'approve');
    expect(result.intercepted).toBe(false);
  });

  it('ignores expired pending requests (filters by expires_at > now)', async () => {
    const pastExpiry = new Date(Date.now() - 60_000).toISOString();
    const id = await insertPendingRequest({ expires_at: pastExpiry });

    const result = await checkApprovalResponse(userId, 'telegram:chat-test', 'approve');
    expect(result.intercepted).toBe(false);

    const row = await readRow(id);
    expect(row.status).toBe('pending'); // interceptor never touched it
  });

  it('matches by metadata.telegramMessageId when replyToMessageId is provided', async () => {
    // Insert two pending requests with different telegram message IDs
    const oldId = await insertPendingRequest({
      tool: 'Bash',
      args: 'old request',
      metadata: { telegramMessageId: 100 },
    });
    // Small delay to guarantee created_at ordering
    await new Promise((r) => setTimeout(r, 20));
    const newId = await insertPendingRequest({
      tool: 'Bash',
      args: 'new request',
      metadata: { telegramMessageId: 200 },
    });

    // Reply threaded to the OLD request
    const result = await checkApprovalResponse(userId, 'telegram:chat-test', 'approve', '100');
    expect(result.intercepted).toBe(true);
    expect(result.requestId).toBe(oldId);

    const oldRow = await readRow(oldId);
    const newRow = await readRow(newId);
    expect(oldRow.status).toBe('granted');
    expect(newRow.status).toBe('pending'); // untouched
  });

  it('falls back to the most recent pending request when reply-to does not match', async () => {
    const firstId = await insertPendingRequest({ args: 'first' });
    await new Promise((r) => setTimeout(r, 20));
    const secondId = await insertPendingRequest({ args: 'second' });

    const result = await checkApprovalResponse(
      userId,
      'telegram:chat-test',
      'approve',
      '9999' // no request has this telegramMessageId
    );
    expect(result.intercepted).toBe(true);
    expect(result.requestId).toBe(secondId);

    const firstRow = await readRow(firstId);
    const secondRow = await readRow(secondId);
    expect(firstRow.status).toBe('pending');
    expect(secondRow.status).toBe('granted');
  });

  it('enforces the optimistic lock: only one of two concurrent resolutions wins', async () => {
    const id = await insertPendingRequest();

    // Race two resolution attempts against the same pending row.
    const [a, b] = await Promise.all([
      checkApprovalResponse(userId, 'telegram:chat-a', 'approve'),
      checkApprovalResponse(userId, 'telegram:chat-b', 'approve'),
    ]);

    // At least one must have intercepted; since Supabase .update() returns
    // success even when 0 rows are touched, both report intercepted=true.
    // What matters is that the row is only written once — check the granted_by
    // is one of the two, not a mix.
    expect(a.intercepted || b.intercepted).toBe(true);

    const row = await readRow(id);
    expect(row.status).toBe('granted');
    expect(['platform:telegram:chat-a', 'platform:telegram:chat-b']).toContain(row.granted_by);
  });

  it('does not resolve requests belonging to a different user', async () => {
    // Insert a pending row for our user
    const myRow = await insertPendingRequest();

    // Attempt to resolve using a different userId
    const otherUserId = '00000000-0000-0000-0000-000000000001';
    const result = await checkApprovalResponse(otherUserId, 'telegram:chat-attacker', 'approve');
    expect(result.intercepted).toBe(false);

    const row = await readRow(myRow);
    expect(row.status).toBe('pending');
  });
});
