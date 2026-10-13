import { describe, expect, it, vi } from 'vitest';
import { ContextLedger } from './context-ledger.js';
import { runSessionToolBatch, type SessionToolBatchPorts } from './session-tool-batch.js';
import type { LocalToolCall } from './agent-loop.js';
import type { ContextImage } from './context-image.js';

const call = (tool: string, args: Record<string, unknown> = {}): LocalToolCall => ({
  tool,
  args,
  raw: 'synthetic',
});
function harness() {
  const entries: Record<string, unknown>[] = [];
  const order: string[] = [];
  const settle = vi.fn(() => {
    order.push('settled');
  });
  let sequence = 0;
  const ports: SessionToolBatchPorts = {
    ledger: new ContextLedger(),
    log: {
      append: vi.fn((event) => {
        order.push(`append:${event.type}`);
        return entries.push(event);
      }),
      flush: vi.fn(async () => {
        order.push('flush');
      }),
    },
    policy: { canCallInkTool: vi.fn(() => ({ allowed: true, reason: 'test allow' })) },
    mintInvocationId: () => `call-${++sequence}`,
    impossibleCallRefusal: () => null,
    callTool: vi.fn(async () => {
      order.push('dispatch');
      return { content: [] };
    }),
    promptForApproval: vi.fn(async () => false),
    beginContextMutation: vi.fn(() => settle),
    isHandoffTool: (tool) => tool === 'spawn_agent' || tool === 'collect_agents',
    takeImages: vi.fn(() => []),
    onResult: vi.fn(() => {
      order.push('notify');
    }),
  };
  return {
    ports,
    order,
    entries,
    settle,
    run: (calls: LocalToolCall[]) => runSessionToolBatch(calls, ports),
  };
}

describe('shared parent tool batch', () => {
  it('commits original arguments before dispatch, logs returned outcomes and releases mutation bookkeeping', async () => {
    const h = harness();
    const request = call('read', { path: '$FIXTURE' });
    const out = await h.run([request]);
    expect(out).toEqual([
      { tool: 'read', status: 'executed', args: { path: '$FIXTURE' }, result: { content: [] } },
    ]);
    expect(h.order).toEqual([
      'append:tool_intent',
      'flush',
      'dispatch',
      'append:local_tool_call',
      'notify',
      'settled',
    ]);
    expect(h.entries).toEqual([
      { type: 'tool_intent', invocationId: 'call-1', tool: 'read', args: request.args },
      {
        type: 'local_tool_call',
        invocationId: 'call-1',
        dispatchState: 'returned',
        tool: 'read',
        args: request.args,
        status: 'executed',
        result: { content: [] },
      },
    ]);
    expect(h.ports.ledger.listEntries()).toHaveLength(1);
    expect(h.ports.beginContextMutation).toHaveBeenCalledExactlyOnceWith([request]);
    expect(h.settle).toHaveBeenCalledOnce();
  });

  it.each(['list_context', 'evict_context', 'signal_status', 'spawn_agent', 'collect_agents'])(
    'retains the %s transcript without reinserting its self-managed result into context',
    async (tool) => {
      const h = harness();
      await h.run([call(tool)]);
      expect(h.entries.at(-1)).toMatchObject({ type: 'local_tool_call', tool, status: 'executed' });
      expect(h.ports.ledger.listEntries()).toEqual([]);
      expect(h.ports.takeImages).not.toHaveBeenCalled();
    }
  );

  it('keeps captured images attached to their result entry and does not claim semantic success', async () => {
    const h = harness();
    const image: ContextImage = {
      ref: 'img:fixture',
      path: '/synthetic/image.png',
      mimeType: 'image/png',
      width: 30,
      height: 40,
      approxTokens: 20,
    };
    vi.mocked(h.ports.takeImages).mockReturnValue([image]);
    vi.mocked(h.ports.callTool).mockResolvedValue({
      isError: true,
      content: [{ type: 'text', text: 'not found' }],
    });
    const [out] = await h.run([call('read')]);
    expect(out.status).toBe('executed'); // Dispatcher returned; success is in the payload.
    expect(out.result).toMatchObject({ isError: true });
    expect(h.ports.ledger.listImages()).toEqual([image]);
    expect(h.ports.ledger.listEntries()[0].content).toContain('img:fixture 30x40 attached');
    expect(h.ports.ledger.listEntries()[0].content).toContain('failed');
  });

  it('records a refused call without an intent or effect and a thrown dispatcher as unknown', async () => {
    const h = harness();
    vi.mocked(h.ports.policy.canCallInkTool).mockReturnValueOnce({
      allowed: false,
      reason: 'denied by policy',
    });
    vi.mocked(h.ports.callTool).mockRejectedValueOnce(new Error('connection lost after write'));
    const out = await h.run([call('write'), call('send_response')]);
    expect(out.map((r) => r.status)).toEqual(['blocked', 'error']);
    expect(h.entries[0]).toMatchObject({
      type: 'local_tool_call',
      status: 'blocked',
      reason: 'denied by policy',
    });
    expect(h.entries.at(-1)).toMatchObject({
      type: 'local_tool_call',
      status: 'error',
      dispatchState: 'unknown',
    });
    expect(h.ports.callTool).toHaveBeenCalledOnce();
    expect(h.ports.ledger.listEntries().map((e) => e.content)).toEqual([
      'Local tool blocked (write): denied by policy',
      'Local tool error (send_response): connection lost after write',
    ]);
  });

  it('an intent persistence failure never enters dispatch', async () => {
    const h = harness();
    vi.mocked(h.ports.log.flush).mockRejectedValueOnce(new Error('write failed'));
    const [out] = await h.run([call('write')]);
    expect(out.status).toBe('error');
    expect(h.entries.at(-1)).toMatchObject({ dispatchState: 'not-dispatched' });
    expect(h.ports.callTool).not.toHaveBeenCalled();
    expect(h.settle).toHaveBeenCalledOnce();
  });

  it('a failing outcome append stops the batch and still releases mutation bookkeeping', async () => {
    const h = harness();
    vi.mocked(h.ports.log.append).mockImplementation((event) => {
      if (event.type === 'local_tool_call') throw new Error('outcome write failed');
      return h.entries.push(event);
    });
    await expect(h.run([call('write'), call('write')])).rejects.toThrow('outcome write failed');
    expect(h.ports.callTool).toHaveBeenCalledOnce();
    expect(h.ports.onResult).not.toHaveBeenCalled();
    expect(h.settle).toHaveBeenCalledOnce();
  });

  it('cancellation during an approval prevents that and every remaining call', async () => {
    const h = harness();
    const stop = new AbortController();
    h.ports.signal = stop.signal;
    vi.mocked(h.ports.policy.canCallInkTool).mockReturnValue({
      allowed: false,
      promptable: true,
      reason: 'ask',
    });
    vi.mocked(h.ports.promptForApproval).mockImplementation(async () => {
      stop.abort();
      return true;
    });
    const out = await h.run([call('write'), call('write')]);
    expect(out.map((r) => r.status)).toEqual(['denied', 'denied']);
    expect(h.ports.callTool).not.toHaveBeenCalled();
    expect(h.entries.every((e) => e.type === 'local_tool_call')).toBe(true);
    expect(h.settle).toHaveBeenCalledOnce();
  });
});
