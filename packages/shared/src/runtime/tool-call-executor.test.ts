import { describe, expect, it, vi } from 'vitest';
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
  expect(policy).toHaveBeenNthCalledWith(1, 'read', 'session-a', call.args);
  expect(policy).toHaveBeenNthCalledWith(2, 'read', 'session-a', call.args);
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
  expect(a.policy.canCallInkTool).toHaveBeenCalledWith('read', 'a', call.args);
  expect(b.policy.canCallInkTool).toHaveBeenCalledWith('read', 'b', call.args);
});

describe('concurrent reads', () => {
  /** A dispatcher whose calls stay open until the test answers them by tool name. */
  function gatedDispatcher() {
    const entered: string[] = [];
    const signals = new Map<string, AbortSignal | undefined>();
    const answers = new Map<string, () => void>();
    const callTool = vi.fn(
      (tool: string, _args: Record<string, unknown>, ctx: { signal?: AbortSignal }) =>
        new Promise<Record<string, unknown>>((resolve) => {
          entered.push(tool);
          signals.set(tool, ctx.signal);
          answers.set(tool, () => resolve({ content: [{ type: 'text', text: `${tool} done` }] }));
        })
    );
    const answer = async (tool: string) => {
      await vi.waitFor(() => expect(answers.has(tool)).toBe(true));
      answers.get(tool)!();
    };
    return { entered, signals, callTool, answer };
  }
  const named = (tool: string) => ({ tool, args: { tool }, raw: tool });
  /** Let every queued microtask and timer callback run once. */
  const drain = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('starts adjacent reads together and settles them in emission order', async () => {
    const gate = gatedDispatcher();
    const settled: string[] = [];
    const p = ports({
      concurrentReads: true,
      callTool: gate.callTool,
      onResult: (result) => settled.push(result.tool),
    });
    const run = executeToolCalls([named('read'), named('mcp__inkwell__recall')], p);
    await vi.waitFor(() => expect(gate.entered).toEqual(['read', 'mcp__inkwell__recall']));
    await gate.answer('mcp__inkwell__recall');
    await drain();
    expect(settled).toEqual([]);
    await gate.answer('read');
    const results = await run;
    expect(results.map((r) => r.tool)).toEqual(['read', 'mcp__inkwell__recall']);
    expect(settled).toEqual(['read', 'mcp__inkwell__recall']);
  });

  it('runs one call at a time with the switch off', async () => {
    const gate = gatedDispatcher();
    const run = executeToolCalls(
      [named('read'), named('recall')],
      ports({ callTool: gate.callTool })
    );
    await vi.waitFor(() => expect(gate.entered).toEqual(['read']));
    await drain();
    expect(gate.entered).toEqual(['read']);
    await gate.answer('read');
    await gate.answer('recall');
    await run;
  });

  it('a write waits for the reads before it, and the reads after it wait for the write', async () => {
    const gate = gatedDispatcher();
    const run = executeToolCalls(
      [named('read'), named('grep'), named('send_response'), named('recall')],
      ports({ concurrentReads: true, callTool: gate.callTool })
    );
    await vi.waitFor(() => expect(gate.entered).toEqual(['read', 'grep']));
    await gate.answer('read');
    await drain();
    expect(gate.entered).toEqual(['read', 'grep']);
    await gate.answer('grep');
    await vi.waitFor(() => expect(gate.entered).toContain('send_response'));
    await drain();
    expect(gate.entered).toEqual(['read', 'grep', 'send_response']);
    await gate.answer('send_response');
    await gate.answer('recall');
    expect((await run).map((r) => r.status)).toEqual([
      'executed',
      'executed',
      'executed',
      'executed',
    ]);
  });

  it('a listed client-local read stays exclusive, so it sees earlier results land', async () => {
    const gate = gatedDispatcher();
    const settled: string[] = [];
    const run = executeToolCalls(
      [named('read'), named('list_context')],
      ports({
        concurrentReads: true,
        callTool: gate.callTool,
        onResult: (result) => settled.push(result.tool),
      })
    );
    await vi.waitFor(() => expect(gate.entered).toEqual(['read']));
    await drain();
    expect(gate.entered).toEqual(['read']);
    await gate.answer('read');
    await vi.waitFor(() => expect(gate.entered).toEqual(['read', 'list_context']));
    expect(settled).toEqual(['read']);
    await gate.answer('list_context');
    await run;
  });

  it('a pending approval holds every call after it, and reads before it keep running', async () => {
    const decided: string[] = [];
    const granted = new Set(['grep', 'find']);
    const policy = vi.fn((tool: string) => {
      decided.push(tool);
      return granted.has(tool)
        ? { allowed: true, reason: '' }
        : { allowed: false, promptable: true, reason: 'ask' };
    });
    const asks: Array<{ tool: string; approve: () => void }> = [];
    const gate = gatedDispatcher();
    const run = executeToolCalls([named('grep'), named('read'), named('find'), named('recall')], {
      ...ports({ concurrentReads: true, callTool: gate.callTool }),
      policy: { canCallInkTool: policy },
      promptForApproval: (tool) =>
        new Promise<boolean>((resolve) => {
          asks.push({
            tool,
            approve: () => {
              granted.add(tool);
              resolve(true);
            },
          });
        }),
    });
    await vi.waitFor(() => expect(asks.map((a) => a.tool)).toEqual(['read']));
    await vi.waitFor(() => expect(gate.entered).toEqual(['grep']));
    await drain();
    // Nothing after the pending decision is decided or started.
    expect(decided).toEqual(['grep', 'read']);
    asks[0].approve();
    await vi.waitFor(() => expect(gate.entered).toEqual(['grep', 'read']));
    await gate.answer('read');
    await drain();
    // Approved is not enough: the barrier holds until the call has settled,
    // and it has not, because grep before it is still open.
    expect(decided).toEqual(['grep', 'read', 'read']);
    await gate.answer('grep');
    await vi.waitFor(() => expect(asks.map((a) => a.tool)).toEqual(['read', 'recall']));
    expect(gate.entered).toEqual(['grep', 'read', 'find']);
    asks[1].approve();
    await gate.answer('find');
    await gate.answer('recall');
    expect((await run).map((r) => r.status)).toEqual([
      'executed',
      'approved',
      'executed',
      'approved',
    ]);
  });

  it('a cancelled turn starts nothing new, signals reads in flight and shows no later prompt', async () => {
    const stop = new AbortController();
    const gate = gatedDispatcher();
    const prompted: string[] = [];
    let answerPrompt!: (approved: boolean) => void;
    const run = executeToolCalls(
      [named('grep'), named('read'), named('recall'), named('send_response')],
      {
        ...ports({ concurrentReads: true, callTool: gate.callTool, signal: stop.signal }),
        policy: {
          canCallInkTool: (tool: string) =>
            tool === 'read' || tool === 'recall'
              ? { allowed: false, promptable: true, reason: 'ask' }
              : { allowed: true, reason: '' },
        },
        promptForApproval: (tool) => {
          prompted.push(tool);
          return new Promise<boolean>((resolve) => {
            answerPrompt = resolve;
          });
        },
      }
    );
    await vi.waitFor(() => expect(gate.entered).toEqual(['grep']));
    await vi.waitFor(() => expect(prompted).toEqual(['read']));
    stop.abort();
    answerPrompt(true);
    await gate.answer('grep');
    const results = await run;
    expect(gate.signals.get('grep')?.aborted).toBe(true);
    expect(prompted).toEqual(['read']);
    expect(gate.entered).toEqual(['grep']);
    expect(results.map((r) => [r.tool, r.status, r.reason])).toEqual([
      ['grep', 'executed', undefined],
      ['read', 'denied', 'Cancelled while waiting for approval'],
      ['recall', 'denied', 'Cancelled before this call ran'],
      ['send_response', 'denied', 'Cancelled before this call ran'],
    ]);
  });

  it('a port that throws fails the batch after the calls already started have settled', async () => {
    const gate = gatedDispatcher();
    const settled: string[] = [];
    const run = executeToolCalls([named('read'), named('recall'), named('grep')], {
      ...ports({
        concurrentReads: true,
        callTool: gate.callTool,
        onResult: (result) => settled.push(result.tool),
      }),
      policy: {
        canCallInkTool: (tool: string) => {
          if (tool === 'recall') throw new Error('policy store unreadable');
          return { allowed: true, reason: '' };
        },
      },
    });
    const failed = expect(run).rejects.toThrow('policy store unreadable');
    await vi.waitFor(() => expect(gate.entered).toEqual(['read']));
    await gate.answer('read');
    await failed;
    expect(settled).toEqual(['read']);
    expect(gate.entered).toEqual(['read']);
  });

  it('settles the same results, in the same order, as the serial batch', async () => {
    const delays: Record<string, number> = { read: 15, grep: 1, recall: 5, send_response: 1 };
    const callTool = async (tool: string) => {
      await new Promise((resolve) => setTimeout(resolve, delays[tool]));
      return { content: [{ type: 'text', text: `${tool} answered` }] };
    };
    const batch = [named('read'), named('grep'), named('send_response'), named('recall')];
    const serialLog: unknown[] = [];
    const concurrentLog: unknown[] = [];
    const serial = await executeToolCalls(
      batch,
      ports({ callTool, onResult: (r) => serialLog.push(r) })
    );
    const concurrent = await executeToolCalls(
      batch,
      ports({ concurrentReads: true, callTool, onResult: (r) => concurrentLog.push(r) })
    );
    expect(JSON.stringify(concurrent)).toBe(JSON.stringify(serial));
    expect(JSON.stringify(concurrentLog)).toBe(JSON.stringify(serialLog));
  });
});
