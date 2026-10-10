import { expect, it, vi } from 'vitest';
import { executeToolCalls, type ToolCallExecutorPorts } from './tool-call-executor.js';
import { createToolIntentCommitter } from './tool-intent.js';
import { SessionLog } from './session-log.js';

const call = { tool: 'read', args: { path: 'sample.txt' }, raw: 'read sample.txt' };
function ports(over: Partial<ToolCallExecutorPorts> = {}): ToolCallExecutorPorts {
  return {
    policy: { canCallInkTool: vi.fn(() => ({ allowed: true, reason: '' })) },
    mintInvocationId: () => 'invocation-a',
    impossibleCallRefusal: () => null,
    commitIntent: vi.fn(async () => {}),
    callTool: vi.fn(async () => ({ content: [] })),
    promptForApproval: vi.fn(async () => false),
    ...over,
  };
}

it('commits unresolved model args through the existing log before dispatching', async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const written: string[] = [];
  const log = new SessionLog({
    path: 'memory',
    sink: {
      write: async (line) => {
        await pending;
        written.push(line);
      },
    },
  });
  const p = ports({ commitIntent: createToolIntentCommitter(log) });
  const original = { ...call, args: { path: '$REFERENCE' } };
  const run = executeToolCalls([original], p);
  await Promise.resolve();
  expect(p.callTool).not.toHaveBeenCalled();
  release();
  const [result] = await run;
  expect(JSON.parse(written[0])).toMatchObject({
    type: 'tool_intent',
    invocationId: 'invocation-a',
    args: { path: '$REFERENCE' },
  });
  expect(p.callTool).toHaveBeenCalledWith('read', { path: '$REFERENCE' }, { signal: undefined });
  expect(result.dispatchState).toBe('returned');
});

it('failed intent write never enters the dispatcher; later dispatcher failure is unknown effect', async () => {
  const p = ports({
    commitIntent: async () => {
      throw new Error('disk failed');
    },
  });
  const [never] = await executeToolCalls([call], p);
  expect(never.dispatchState).toBe('not-dispatched');
  expect(p.callTool).not.toHaveBeenCalled();
  const [unknown] = await executeToolCalls(
    [call],
    ports({
      callTool: async () => {
        throw new Error('lost receipt');
      },
    })
  );
  expect(unknown.dispatchState).toBe('unknown');
});

it('cancellation after intent confirmation fences dispatch and the remaining calls', async () => {
  const stop = new AbortController();
  const p = ports({
    signal: stop.signal,
    commitIntent: async () => {
      stop.abort();
    },
  });
  const results = await executeToolCalls([call, call], p);
  expect(results.map((r) => r.status)).toEqual(['denied', 'denied']);
  expect(results[0].dispatchState).toBe('not-dispatched');
  expect(results[1].invocationId).toBeUndefined();
  expect(p.callTool).not.toHaveBeenCalled();
});

it('an approval is not permission unless the same session policy recheck allows it', async () => {
  const policy = vi
    .fn()
    .mockReturnValueOnce({ allowed: false, promptable: true, reason: 'ask' })
    .mockReturnValueOnce({ allowed: false, promptable: false, reason: 'denied override' });
  const p = ports({
    policy: { canCallInkTool: policy },
    sessionId: 'session-a',
    promptForApproval: async () => true,
  });
  const [result] = await executeToolCalls([{ ...call, tool: 'mcp__inkwell__read' }], p);
  expect(result).toMatchObject({ status: 'blocked', reason: 'denied override' });
  expect(policy).toHaveBeenNthCalledWith(1, 'read', 'session-a');
  expect(policy).toHaveBeenNthCalledWith(2, 'read', 'session-a');
  expect(p.commitIntent).not.toHaveBeenCalled();
  expect(p.callTool).not.toHaveBeenCalled();
});

it('context agency still bypasses policy but never the intent barrier', async () => {
  const p = ports({
    policy: { canCallInkTool: vi.fn(() => ({ allowed: false, reason: 'deny' })) },
  });
  const [result] = await executeToolCalls([{ ...call, tool: 'evict_context' }], p);
  expect(result.status).toBe('executed');
  expect(p.policy.canCallInkTool).not.toHaveBeenCalled();
  expect(p.commitIntent).toHaveBeenCalledTimes(1);
});

it('a structural name refusal does not spend a grant or pretend it entered dispatch', async () => {
  const correction = { isError: true, content: [{ type: 'text', text: 'wrong spelling' }] };
  const p = ports({ impossibleCallRefusal: () => correction });
  const [result] = await executeToolCalls([{ ...call, tool: 'Read' }], p);
  expect(result.result).toBe(correction);
  expect(result.invocationId).toBeUndefined();
  expect(p.policy.canCallInkTool).not.toHaveBeenCalled();
  expect(p.commitIntent).not.toHaveBeenCalled();
});

it('concurrent sessions keep invocation identity, log and policy scope separate', async () => {
  const a = ports({ sessionId: 'a' });
  const b = ports({ sessionId: 'b', mintInvocationId: () => 'invocation-b' });
  const [ar, br] = await Promise.all([executeToolCalls([call], a), executeToolCalls([call], b)]);
  expect(ar[0].invocationId).toBe('invocation-a');
  expect(br[0].invocationId).toBe('invocation-b');
  expect(a.commitIntent).toHaveBeenCalledWith(call, 'invocation-a');
  expect(b.commitIntent).toHaveBeenCalledWith(call, 'invocation-b');
  expect(a.policy.canCallInkTool).toHaveBeenCalledWith('read', 'a');
  expect(b.policy.canCallInkTool).toHaveBeenCalledWith('read', 'b');
});
