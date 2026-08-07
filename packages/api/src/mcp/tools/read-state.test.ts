import { describe, expect, it, vi } from 'vitest';
import { advanceThreadReadPointer } from './read-state';

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
