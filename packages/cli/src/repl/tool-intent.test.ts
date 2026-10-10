import { describe, expect, it, vi } from 'vitest';
import {
  executeToolCalls,
  type LocalToolCall,
  type ToolCallExecutorDeps,
} from './tool-call-executor.js';

const call = (tool = 'recall'): LocalToolCall => ({ tool, args: { query: 'fixture' }, raw: '' });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const deps = (overrides: Partial<ToolCallExecutorDeps> = {}): ToolCallExecutorDeps => ({
  policy: {
    canCallInkTool: vi.fn().mockReturnValue({ allowed: true }),
  } as unknown as ToolCallExecutorDeps['policy'],
  callTool: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'fixture result' }] }),
  promptForApproval: vi.fn().mockResolvedValue(true),
  commitIntent: vi.fn().mockResolvedValue(undefined),
  onResult: vi.fn(),
  ...overrides,
});

describe('tool intent barrier (fake tools only)', () => {
  it.each(['recall', 'signal_status'])(
    'awaits commitment before %s and correlates the outcome',
    async (tool) => {
      const gate = deferred();
      const d = deps({ commitIntent: vi.fn(() => gate.promise) });
      const running = executeToolCalls([call(tool)], d);
      await tick();
      expect(d.commitIntent).toHaveBeenCalledTimes(1);
      expect(d.callTool).not.toHaveBeenCalled();
      expect(d.onResult).not.toHaveBeenCalled();
      gate.resolve();
      const [result] = await running;
      expect(result).toMatchObject({
        invocationId: expect.any(String),
        dispatchState: 'returned',
        status: 'executed',
      });
      expect(d.commitIntent).toHaveBeenCalledWith(call(tool), result.invocationId);
      expect(d.onResult).toHaveBeenCalledWith(result);
    }
  );

  it('also gates the post-approval route, after permission is resolved', async () => {
    const approval = deferred();
    const gate = deferred();
    const d = deps({
      policy: {
        canCallInkTool: vi
          .fn()
          .mockReturnValueOnce({ allowed: false, promptable: true, reason: 'fixture' })
          .mockReturnValue({ allowed: true }),
      } as unknown as ToolCallExecutorDeps['policy'],
      promptForApproval: vi.fn(async () => {
        await approval.promise;
        return true;
      }),
      commitIntent: vi.fn(() => gate.promise),
    });
    const running = executeToolCalls([call()], d);
    await tick();
    expect(d.commitIntent).not.toHaveBeenCalled();
    approval.resolve();
    await tick();
    expect(d.commitIntent).toHaveBeenCalledTimes(1);
    expect(d.callTool).not.toHaveBeenCalled();
    gate.resolve();
    expect((await running)[0]).toMatchObject({ status: 'approved', dispatchState: 'returned' });
  });

  it.each(['intent rejected', 'commit acknowledgement lost'])(
    'closes known no-dispatch when %s',
    async (error) => {
      const d = deps({ commitIntent: vi.fn().mockRejectedValue(new Error(error)) });
      const [result] = await executeToolCalls([call()], d);
      expect(d.callTool).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        invocationId: expect.any(String),
        dispatchState: 'not-dispatched',
        status: 'error',
      });
      expect(result.error).toContain('not dispatched');
      expect(d.commitIntent).toHaveBeenCalledWith(call(), result.invocationId);
      expect(d.onResult).toHaveBeenCalledWith(result);
    }
  );

  it('closes a committed intent if cancelled while awaiting it', async () => {
    const gate = deferred();
    const controller = new AbortController();
    const d = deps({ signal: controller.signal, commitIntent: vi.fn(() => gate.promise) });
    const running = executeToolCalls([call()], d);
    await tick();
    controller.abort();
    gate.resolve();
    const [result] = await running;
    expect(d.callTool).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      invocationId: expect.any(String),
      dispatchState: 'not-dispatched',
      status: 'denied',
    });
    expect(d.commitIntent).toHaveBeenCalledWith(call(), result.invocationId);
    expect(d.onResult).toHaveBeenCalledWith(result);
  });

  it('keeps thrown dispatcher outcomes unknown, not proof of no external effect', async () => {
    const d = deps({ callTool: vi.fn().mockRejectedValue(new Error('fixture timeout')) });
    const [result] = await executeToolCalls([call()], d);
    expect(result).toMatchObject({
      status: 'error',
      dispatchState: 'unknown',
      invocationId: expect.any(String),
    });
    expect(d.commitIntent).toHaveBeenCalledWith(call(), result.invocationId);
  });

  it('does not confuse a returned tool failure with an unstarted tool', async () => {
    const d = deps({ callTool: vi.fn().mockResolvedValue({ isError: true, content: [] }) });
    const [result] = await executeToolCalls([call()], d);
    expect(result).toMatchObject({
      status: 'executed',
      dispatchState: 'returned',
      result: { isError: true },
    });
  });

  it('gives identical calls independent IDs, including after known no-dispatch', async () => {
    const d = deps({
      commitIntent: vi
        .fn()
        .mockRejectedValueOnce(new Error('fixture rejection'))
        .mockResolvedValue(undefined),
    });
    const results = await executeToolCalls([call(), call()], d);
    expect(results[0].dispatchState).toBe('not-dispatched');
    expect(results[1].dispatchState).toBe('returned');
    expect(new Set(results.map((r) => r.invocationId)).size).toBe(2);
    expect(d.callTool).toHaveBeenCalledTimes(1);
  });

  it('does not create intents for policy refusals or impossible names', async () => {
    const d = deps({
      policy: {
        canCallInkTool: vi.fn().mockReturnValue({ allowed: false, promptable: false }),
      } as unknown as ToolCallExecutorDeps['policy'],
    });
    const results = await executeToolCalls([call(), call('Bash')], d);
    expect(d.commitIntent).not.toHaveBeenCalled();
    expect(d.callTool).not.toHaveBeenCalled();
    expect(results.every((r) => r.invocationId === undefined)).toBe(true);
  });

  it('fails closed if a JavaScript caller omits the required barrier', async () => {
    const d = deps();
    delete (d as Partial<ToolCallExecutorDeps>).commitIntent;
    const [result] = await executeToolCalls([call()], d);
    expect(d.callTool).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: 'error', dispatchState: 'not-dispatched' });
  });
});
