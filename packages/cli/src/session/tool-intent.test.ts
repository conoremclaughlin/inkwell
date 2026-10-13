import { describe, expect, it, vi } from 'vitest';
import { executeToolCalls, type ToolCallExecutorDeps } from '../repl/tool-call-executor.js';
import { SessionLog, type SessionLogSink } from './session-log.js';
import { toolIntentCommitter } from './tool-intent.js';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const call = { tool: 'recall', args: { query: '$FIXTURE_REFERENCE' }, raw: 'not journalled' };
function harness(sink: SessionLogSink, type = 'local_tool_call') {
  const projected: Record<string, unknown>[] = [];
  const log = new SessionLog({
    path: 'unused-fixture-path',
    sink,
    onProjection: (e) => {
      projected.push(e);
    },
  });
  const d: ToolCallExecutorDeps = {
    policy: {
      canCallInkTool: () => ({ allowed: true, reason: '' }),
    } as unknown as ToolCallExecutorDeps['policy'],
    commitIntent: toolIntentCommitter(log),
    callTool: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'fixture' }] }),
    promptForApproval: async () => false,
    onResult: (result) => {
      log.append({ type, ...result });
    },
  };
  return { d, log, projected };
}

describe('session log tool intent adapter (in-memory sinks, fake tools)', () => {
  it('isolates parent/clone logs and IDs, with one intent preceding its existing outcome', async () => {
    const parent: Record<string, unknown>[] = [];
    const clone: Record<string, unknown>[] = [];
    const p = harness({
      write: (line) => {
        parent.push(JSON.parse(line));
      },
    });
    const c = harness(
      {
        write: (line) => {
          clone.push(JSON.parse(line));
        },
      },
      'clone_tool_call'
    );
    await Promise.all([executeToolCalls([call], p.d), executeToolCalls([call], c.d)]);
    for (const records of [parent, clone]) {
      expect(records.map((e) => e.eid)).toEqual([1, 2]);
      expect(records[0]).toMatchObject({ type: 'tool_intent', tool: 'recall', args: call.args });
      expect(records[0]).not.toHaveProperty('raw');
      expect(records[1]).toMatchObject({
        invocationId: records[0].invocationId,
        dispatchState: 'returned',
      });
    }
    expect(parent[0].invocationId).not.toBe(clone[0].invocationId);
    expect(p.projected.map((e) => e.type)).toEqual(['local_tool_call']);
    expect(c.projected).toEqual([]);
  });

  it('does not treat a reserved async append ID as commitment', async () => {
    const writes: Array<{ entry: Record<string, unknown>; resolve: () => void }> = [];
    const h = harness({
      write: (line) =>
        new Promise<void>((resolve) => {
          writes.push({ entry: JSON.parse(line), resolve });
        }),
    });
    const running = executeToolCalls([call], h.d);
    await tick();
    expect(writes).toHaveLength(1);
    expect(writes[0].entry.type).toBe('tool_intent');
    expect(h.d.callTool).not.toHaveBeenCalled();
    writes[0].resolve();
    await running;
    expect(writes).toHaveLength(2);
    expect(writes[1].entry.invocationId).toBe(writes[0].entry.invocationId);
    // 1b-1 does not activate the async CLI outcome/exit path. Drain explicitly.
    writes[1].resolve();
    await h.log.flush();
  });

  it.each([false, true])(
    'closes known no-dispatch after sync failure (intent actually written: %s)',
    async (writtenBeforeThrow) => {
      const records: Record<string, unknown>[] = [];
      let first = true;
      const h = harness({
        write: (line) => {
          const event = JSON.parse(line);
          if (first) {
            first = false;
            if (writtenBeforeThrow) records.push(event);
            throw new Error('fixture commit failure');
          }
          records.push(event);
        },
      });
      const [result] = await executeToolCalls([call], h.d);
      expect(h.d.callTool).not.toHaveBeenCalled();
      expect(records.at(-1)).toMatchObject({
        type: 'local_tool_call',
        invocationId: result.invocationId,
        dispatchState: 'not-dispatched',
      });
      if (writtenBeforeThrow) expect(records[0].invocationId).toBe(result.invocationId);
    }
  );

  it('keeps the no-dispatch closure readable after a torn synchronous intent write', async () => {
    let bytes = '';
    let first = true;
    const h = harness({
      write: (line) => {
        if (first) {
          first = false;
          bytes += line.slice(0, line.length / 2);
          throw new Error('fixture partial write');
        }
        bytes += line;
      },
    });
    const [result] = await executeToolCalls([call], h.d);
    const readable = bytes.split('\n').flatMap((line) => {
      try {
        return [JSON.parse(line) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
    expect(h.d.callTool).not.toHaveBeenCalled();
    expect(readable).toEqual([
      expect.objectContaining({
        type: 'local_tool_call',
        eid: 2,
        invocationId: result.invocationId,
        dispatchState: 'not-dispatched',
      }),
    ]);
    expect(h.projected).toEqual(readable);
  });

  it('closes an intent when cancellation arrives during commit', async () => {
    const controller = new AbortController();
    const records: Record<string, unknown>[] = [];
    const h = harness({
      write: (line) => {
        records.push(JSON.parse(line));
        if (records.length === 1) controller.abort();
      },
    });
    h.d.signal = controller.signal;
    await executeToolCalls([call], h.d);
    expect(h.d.callTool).not.toHaveBeenCalled();
    expect(records[1]).toMatchObject({
      invocationId: records[0].invocationId,
      dispatchState: 'not-dispatched',
      status: 'denied',
    });
  });

  it('does not claim durable closure when a failed async sink cannot write the outcome', async () => {
    const h = harness({
      write: async () => {
        throw new Error('fixture sink unavailable');
      },
    });
    const onResult = vi.fn(h.d.onResult!);
    h.d.onResult = onResult;
    await expect(executeToolCalls([call], h.d)).rejects.toThrow('fixture sink unavailable');
    expect(h.d.callTool).not.toHaveBeenCalled();
    expect(onResult).toHaveBeenCalledWith(
      expect.objectContaining({ dispatchState: 'not-dispatched', invocationId: expect.any(String) })
    );
    expect(h.projected).toEqual([]);
    await expect(h.log.flush()).rejects.toThrow('fixture sink unavailable');
  });
});
