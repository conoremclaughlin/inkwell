import { describe, expect, it, vi } from 'vitest';
import {
  executeToolCalls,
  type LocalToolCall,
  type ToolCallExecutorDeps,
} from './tool-call-executor.js';

function makeDeps(overrides: Partial<ToolCallExecutorDeps> = {}): ToolCallExecutorDeps {
  return {
    policy: {
      canCallPcpTool: vi.fn().mockReturnValue({ allowed: true, reason: '' }),
    } as unknown as ToolCallExecutorDeps['policy'],
    callTool: vi.fn().mockResolvedValue({ success: true }),
    sessionId: 'session-1',
    promptForApproval: vi.fn().mockResolvedValue(true),
    onResult: vi.fn(),
    ...overrides,
  };
}

function makeCall(tool = 'recall', args: Record<string, unknown> = {}): LocalToolCall {
  return { tool, args, raw: JSON.stringify({ tool, args }) };
}

describe('executeToolCalls', () => {
  it('executes allowed tool calls immediately', async () => {
    const deps = makeDeps();
    const calls = [makeCall('recall', { query: 'test' })];

    const results = await executeToolCalls(calls, deps);

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('executed');
    expect(results[0].result).toEqual({ success: true });
    expect(deps.callTool).toHaveBeenCalledWith('recall', { query: 'test' });
    expect(deps.promptForApproval).not.toHaveBeenCalled();
  });

  it('blocks non-promptable tools', async () => {
    const deps = makeDeps({
      policy: {
        canCallPcpTool: vi.fn().mockReturnValue({
          allowed: false,
          promptable: false,
          reason: 'Tool is denied',
        }),
      } as unknown as ToolCallExecutorDeps['policy'],
    });
    const calls = [makeCall('send_to_inbox')];

    const results = await executeToolCalls(calls, deps);

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('blocked');
    expect(results[0].reason).toBe('Tool is denied');
    expect(deps.callTool).not.toHaveBeenCalled();
    expect(deps.promptForApproval).not.toHaveBeenCalled();
  });

  it('prompts for approval when tool is promptable', async () => {
    const canCallPcpTool = vi
      .fn()
      .mockReturnValueOnce({ allowed: false, promptable: true, reason: 'Requires approval' })
      .mockReturnValueOnce({ allowed: true, reason: '' }); // after grant applied

    const deps = makeDeps({
      policy: { canCallPcpTool } as unknown as ToolCallExecutorDeps['policy'],
      promptForApproval: vi.fn().mockResolvedValue(true),
    });
    const calls = [makeCall('send_to_inbox', { content: 'hi' })];

    const results = await executeToolCalls(calls, deps);

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('approved');
    expect(results[0].result).toEqual({ success: true });
    expect(deps.promptForApproval).toHaveBeenCalledWith('send_to_inbox', 'Requires approval');
    expect(deps.callTool).toHaveBeenCalledWith('send_to_inbox', { content: 'hi' });
  });

  it('reports denied when user rejects approval prompt', async () => {
    const deps = makeDeps({
      policy: {
        canCallPcpTool: vi.fn().mockReturnValue({
          allowed: false,
          promptable: true,
          reason: 'Requires approval',
        }),
      } as unknown as ToolCallExecutorDeps['policy'],
      promptForApproval: vi.fn().mockResolvedValue(false),
    });
    const calls = [makeCall('send_to_inbox')];

    const results = await executeToolCalls(calls, deps);

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('denied');
    expect(results[0].reason).toBe('User denied tool call');
    expect(deps.callTool).not.toHaveBeenCalled();
  });

  it('handles PcpClient errors gracefully', async () => {
    const deps = makeDeps({
      callTool: vi.fn().mockRejectedValue(new Error('Network timeout')),
    });
    const calls = [makeCall('recall')];

    const results = await executeToolCalls(calls, deps);

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('error');
    expect(results[0].error).toBe('Network timeout');
  });

  it('executes multiple tools sequentially', async () => {
    const callOrder: string[] = [];
    const deps = makeDeps({
      callTool: vi.fn().mockImplementation(async (tool: string) => {
        callOrder.push(tool);
        return { tool, ok: true };
      }),
    });
    const calls = [
      makeCall('recall', { query: 'a' }),
      makeCall('remember', { content: 'b' }),
      makeCall('list_sessions'),
    ];

    const results = await executeToolCalls(calls, deps);

    expect(results).toHaveLength(3);
    expect(results.every((r: { status: string }) => r.status === 'executed')).toBe(true);
    expect(callOrder).toEqual(['recall', 'remember', 'list_sessions']);
  });

  it('calls onResult callback for each tool call', async () => {
    const onResult = vi.fn();
    const deps = makeDeps({ onResult });
    const calls = [makeCall('recall'), makeCall('remember')];

    await executeToolCalls(calls, deps);

    expect(onResult).toHaveBeenCalledTimes(2);
    expect(onResult.mock.calls[0][0].tool).toBe('recall');
    expect(onResult.mock.calls[1][0].tool).toBe('remember');
  });

  it('handles mixed allowed/blocked/promptable tools', async () => {
    let callCount = 0;
    const canCallPcpTool = vi.fn().mockImplementation((tool: string) => {
      callCount++;
      if (tool === 'recall') return { allowed: true, reason: '' };
      if (tool === 'send_email') return { allowed: false, promptable: false, reason: 'Denied' };
      if (tool === 'send_to_inbox') {
        // First call: promptable; second call (after approval): allowed
        if (callCount <= 3) return { allowed: false, promptable: true, reason: 'Needs approval' };
        return { allowed: true, reason: '' };
      }
      return { allowed: true, reason: '' };
    });

    const deps = makeDeps({
      policy: { canCallPcpTool } as unknown as ToolCallExecutorDeps['policy'],
      promptForApproval: vi.fn().mockResolvedValue(true),
    });
    const calls = [makeCall('recall'), makeCall('send_email'), makeCall('send_to_inbox')];

    const results = await executeToolCalls(calls, deps);

    expect(results).toHaveLength(3);
    expect(results[0].status).toBe('executed'); // allowed
    expect(results[1].status).toBe('blocked'); // denied, not promptable
    expect(results[2].status).toBe('approved'); // promptable → approved → executed
  });

  it('blocks tool when policy still denies after approval', async () => {
    // Edge case: user approves but deny rule takes precedence
    const deps = makeDeps({
      policy: {
        canCallPcpTool: vi.fn().mockReturnValue({
          allowed: false,
          promptable: true,
          reason: 'Deny overrides grant',
        }),
      } as unknown as ToolCallExecutorDeps['policy'],
      promptForApproval: vi.fn().mockResolvedValue(true),
    });
    const calls = [makeCall('send_email')];

    const results = await executeToolCalls(calls, deps);

    expect(results).toHaveLength(1);
    // After approval, re-check still denies → blocked
    expect(results[0].status).toBe('blocked');
    expect(deps.callTool).not.toHaveBeenCalled();
  });

  it('returns empty array for empty calls', async () => {
    const deps = makeDeps();
    const results = await executeToolCalls([], deps);
    expect(results).toEqual([]);
    expect(deps.callTool).not.toHaveBeenCalled();
  });
});
