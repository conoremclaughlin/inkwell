import { describe, expect, it, vi } from 'vitest';
import { advanceThreadReadPointer, advanceAgentInboxReadPointer } from './read-state';

const PARAMS = {
  threadId: 'thread-1',
  agentId: 'wren',
  throughMessageId: 'msg-9',
  source: 'test',
};

describe('advanceThreadReadPointer', () => {
  it('calls the atomic RPC with the message cursor and reports success', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: '2026-08-06T00:00:00Z', error: null });
    const ok = await advanceThreadReadPointer({ rpc }, PARAMS);
    expect(ok).toBe(true);
    expect(rpc).toHaveBeenCalledWith('advance_thread_read_pointer', {
      p_thread_id: 'thread-1',
      p_agent_id: 'wren',
      p_through_message_id: 'msg-9',
    });
  });

  it('returns false and does not throw when the RPC reports an error', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: 'permission denied' } });
    const ok = await advanceThreadReadPointer({ rpc }, PARAMS);
    expect(ok).toBe(false);
  });

  it('returns false and does not throw when the RPC call itself rejects', async () => {
    const rpc = vi.fn().mockRejectedValue(new Error('network down'));
    const ok = await advanceThreadReadPointer({ rpc }, PARAMS);
    expect(ok).toBe(false);
  });
});

const INBOX_PARAMS = {
  userId: 'user-1',
  agentId: 'myra',
  throughMessageId: 'msg-9',
  source: 'test',
};

describe('advanceAgentInboxReadPointer', () => {
  it('calls the atomic RPC with the message cursor and reports the monotonic result', async () => {
    // The RPC returns rows of (last_read_at, changed) — the RESULT the
    // response must report, never the requested anchor (Lumen #504 r1 P2).
    const rpc = vi.fn().mockResolvedValue({
      data: [{ last_read_at: '2026-08-06T00:00:00Z', changed: true }],
      error: null,
    });
    const result = await advanceAgentInboxReadPointer({ rpc }, INBOX_PARAMS);
    expect(result).toEqual({ ok: true, lastReadAt: '2026-08-06T00:00:00Z', changed: true });
    expect(rpc).toHaveBeenCalledWith('advance_agent_inbox_read_pointer', {
      p_user_id: 'user-1',
      p_agent_id: 'myra',
      p_through_message_id: 'msg-9',
    });
  });

  it('reports an unchanged pointer when the DB kept a newer position', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [{ last_read_at: '2026-08-16T00:00:00Z', changed: false }],
      error: null,
    });
    const result = await advanceAgentInboxReadPointer({ rpc }, INBOX_PARAMS);
    expect(result).toEqual({ ok: true, lastReadAt: '2026-08-16T00:00:00Z', changed: false });
  });

  it('reports failure rather than throwing when the RPC errors', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: 'permission denied' } });
    const result = await advanceAgentInboxReadPointer({ rpc }, INBOX_PARAMS);
    expect(result).toEqual({ ok: false, lastReadAt: null, changed: false });
  });

  it('reports failure rather than throwing when the RPC call itself rejects', async () => {
    const rpc = vi.fn().mockRejectedValue(new Error('network down'));
    const result = await advanceAgentInboxReadPointer({ rpc }, INBOX_PARAMS);
    expect(result).toEqual({ ok: false, lastReadAt: null, changed: false });
  });

  it('never advances through a wall-clock timestamp', async () => {
    // The RPC surface takes a message id and nothing else, which is what makes
    // "mark everything read as of now" unable to swallow a message that landed
    // between the caller's decision and the write.
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
    await advanceAgentInboxReadPointer({ rpc }, INBOX_PARAMS);
    const args = rpc.mock.calls[0][1] as Record<string, unknown>;
    expect(Object.keys(args).sort()).toEqual(['p_agent_id', 'p_through_message_id', 'p_user_id']);
  });
});
