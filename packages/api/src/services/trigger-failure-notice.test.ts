import { describe, expect, it, vi } from 'vitest';
import { sendTriggerFailureNotice } from './trigger-failure-notice';

vi.mock('../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

interface MockOpts {
  /** Row returned by the (user, threadKey) lookup; null = not found. */
  threadLookup?: { id: string } | null;
  threadLookupError?: string;
  threadInsertError?: string;
  legacyInsertError?: string;
}

function createMockClient(opts: MockOpts = {}) {
  const threadInserts: Array<Record<string, unknown>> = [];
  const legacyInserts: Array<Record<string, unknown>> = [];
  const threadUpdates: Array<Record<string, unknown>> = [];

  const fromFn = vi.fn().mockImplementation((table: string) => {
    if (table === 'inbox_threads') {
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi
                .fn()
                .mockResolvedValue(
                  opts.threadLookupError
                    ? { data: null, error: { message: opts.threadLookupError } }
                    : { data: opts.threadLookup ?? null, error: null }
                ),
            }),
          }),
        }),
        update: vi.fn().mockImplementation((row: Record<string, unknown>) => {
          threadUpdates.push(row);
          return { eq: vi.fn().mockResolvedValue({ data: null, error: null }) };
        }),
      };
    }
    if (table === 'inbox_thread_messages') {
      return {
        insert: vi.fn().mockImplementation((row: Record<string, unknown>) => {
          threadInserts.push(row);
          return Promise.resolve(
            opts.threadInsertError
              ? { error: { message: opts.threadInsertError } }
              : { error: null }
          );
        }),
      };
    }
    if (table === 'agent_inbox') {
      return {
        insert: vi.fn().mockImplementation((row: Record<string, unknown>) => {
          legacyInserts.push(row);
          return Promise.resolve(
            opts.legacyInsertError
              ? { error: { message: opts.legacyInsertError } }
              : { error: null }
          );
        }),
      };
    }
    throw new Error(`unexpected table ${table}`);
  });

  return { from: fromFn, threadInserts, legacyInserts, threadUpdates };
}

const BASE = {
  userId: 'user-1',
  fromAgentId: 'wren',
  toAgentId: 'aster',
  subject: 'Trigger failed: aster',
  content: 'Trigger to aster failed (timeout): Gemini exited with code 1',
  metadata: { triggerFailure: true },
};

describe('sendTriggerFailureNotice', () => {
  it('thread-borne failure (threadId) posts INTO the thread — never the legacy inbox', async () => {
    const client = createMockClient();
    const r = await sendTriggerFailureNotice(client, { ...BASE, threadId: 't-1' });

    expect(r).toEqual({ via: 'thread', ok: true });
    expect(client.threadInserts).toHaveLength(1);
    expect(client.threadInserts[0]).toMatchObject({
      thread_id: 't-1',
      // 'system' attribution — a synthetic row bearing the failed agent's
      // name would shadow their newest REAL message in the recipient-session
      // lookup and misroute the next reply (Lumen, PR #487 review).
      sender_agent_id: 'system',
      // 'notification' TYPE, not 'system' — system-type events are excluded
      // from delivery and candidacy, which would bury the notice.
      message_type: 'notification',
      priority: 'high',
    });
    expect(client.legacyInserts).toHaveLength(0);
    // Thread recency bumped so pages sort sensibly.
    expect(client.threadUpdates).toHaveLength(1);
  });

  it('resolves the thread from (user, threadKey) when only the key is present', async () => {
    const client = createMockClient({ threadLookup: { id: 't-9' } });
    const r = await sendTriggerFailureNotice(client, {
      ...BASE,
      threadKey: 'spec:artifact-graph-lifecycle',
    });
    expect(r).toEqual({ via: 'thread', ok: true });
    expect(client.threadInserts[0]).toMatchObject({ thread_id: 't-9' });
    expect(client.legacyInserts).toHaveLength(0);
  });

  it('threadless failure falls back to the legacy agent-scoped inbox', async () => {
    const client = createMockClient();
    const r = await sendTriggerFailureNotice(client, { ...BASE });
    expect(r).toEqual({ via: 'legacy', ok: true });
    expect(client.threadInserts).toHaveLength(0);
    expect(client.legacyInserts[0]).toMatchObject({
      recipient_agent_id: 'wren',
      sender_agent_id: 'aster',
      thread_key: null,
      message_type: 'notification',
    });
  });

  it('unresolvable threadKey (thread gone / lookup error) falls back to legacy WITH the key as metadata', async () => {
    const client = createMockClient({ threadLookupError: 'connection reset' });
    const r = await sendTriggerFailureNotice(client, { ...BASE, threadKey: 'pr:404' });
    expect(r).toEqual({ via: 'legacy', ok: true });
    expect(client.legacyInserts[0]).toMatchObject({ thread_key: 'pr:404' });
  });

  it('a failed thread insert falls back to legacy — the notice is never lost', async () => {
    const client = createMockClient({ threadInsertError: 'permission denied' });
    const r = await sendTriggerFailureNotice(client, { ...BASE, threadId: 't-1' });
    expect(r).toEqual({ via: 'legacy', ok: true });
    expect(client.legacyInserts).toHaveLength(1);
  });

  it('reports ok:false only when BOTH lanes fail', async () => {
    const client = createMockClient({
      threadInsertError: 'permission denied',
      legacyInsertError: 'also down',
    });
    const r = await sendTriggerFailureNotice(client, { ...BASE, threadId: 't-1' });
    expect(r).toEqual({ via: 'legacy', ok: false });
  });
});
