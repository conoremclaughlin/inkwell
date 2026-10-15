import { describe, expect, it, vi } from 'vitest';
import { ContextLedger } from './context-ledger.js';
import type { SessionToolBatchPorts } from './session-tool-batch.js';
import { createSessionToolStream } from './session-tool-stream.js';
import {
  createToolInvocationJournal,
  readToolInvocationJournal,
} from './tool-invocation-journal.js';
import type { ContextImage } from './context-image.js';
import { SessionLog } from './session-log.js';
import { SessionContextState } from './session-context-state.js';

const block = (tool: string, args: Record<string, unknown> = {}) =>
  '```ink-tool\n' + JSON.stringify({ tool, args }) + '\n```\n';
function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { resolve, promise };
}
function harness() {
  const events: Record<string, unknown>[] = [];
  const release = vi.fn();
  let sequence = 0;
  const ports: SessionToolBatchPorts = {
    sessionId: 'synthetic-session',
    ledger: new ContextLedger(),
    log: {
      append: vi.fn((event) => events.push(structuredClone(event))),
      flush: vi.fn(async () => {}),
    },
    policy: { canCallInkTool: vi.fn(() => ({ allowed: true, reason: 'fixture' })) },
    mintInvocationId: () => {
      throw new Error('Stream must use its reserved identity');
    },
    impossibleCallRefusal: () => null,
    callTool: vi.fn(async () => ({ success: true })),
    promptForApproval: vi.fn(async () => false),
    beginContextMutation: vi.fn(() => release),
    isHandoffTool: (tool) => tool === 'spawn_agent' || tool === 'collect_agents',
    takeImages: vi.fn(() => []),
    onResult: vi.fn(),
  };
  const journal = createToolInvocationJournal({
    sessionId: ports.sessionId!,
    log: ports.log,
    mintInvocationId: () => `synthetic-call-${++sequence}`,
  });
  const start = (attemptId = 'attempt-1', turnId = 'turn-1', enabled = true) =>
    createSessionToolStream({ enabled, ports, journal, owner: { turnId, attemptId } });
  return { ports, events, release, journal, start };
}

describe('session-owned stream settlement and identity', () => {
  it('is inert when disabled and refuses mismatched session/log ownership before writing', async () => {
    const h = harness();
    expect(await h.start('attempt-1', 'turn-1', false)).toBeUndefined();
    expect(h.events).toEqual([]);
    await expect(
      createSessionToolStream({
        enabled: true,
        ports: { ...h.ports, sessionId: 'wrong-session' },
        journal: h.journal,
        owner: { turnId: 't', attemptId: 'a' },
      })
    ).rejects.toThrow('owning session');
    await expect(
      createSessionToolStream({
        enabled: true,
        ports: { ...h.ports, log: { ...h.ports.log } },
        journal: h.journal,
        owner: { turnId: 't', attemptId: 'a' },
      })
    ).rejects.toThrow('owning session');
    expect(h.events).toEqual([]);
  });

  it('commits identities and effects before a scripted provider ends, using the existing ledger path', async () => {
    const h = harness();
    const providerEnd = gate<void>();
    const intent = gate<void>();
    const counts = { userTurns: 0, providerRequests: 0 };
    const stream = (await h.start())!;
    vi.mocked(h.ports.log.flush).mockImplementationOnce(() => intent.promise);
    async function providerRequest() {
      counts.providerRequests++;
      stream.append(block('send_response', { content: 'Synthetic progress.' }));
      await providerEnd.promise;
      stream.append('Finished writing.');
    }
    async function userTurn() {
      counts.userTurns++;
      try {
        await providerRequest();
      } finally {
        await stream.finish({ endOfResponse: true });
      }
    }
    const pending = userTurn();
    await vi.waitFor(() => expect(h.events.some((e) => e.type === 'tool_intent')).toBe(true));
    expect(h.ports.callTool).not.toHaveBeenCalled();
    intent.resolve();
    await vi.waitFor(() => expect(h.ports.onResult).toHaveBeenCalledOnce());
    expect(h.ports.ledger.listEntries()).toHaveLength(1);
    expect(h.release).not.toHaveBeenCalled();
    providerEnd.resolve();
    await pending;
    const done = await stream.finish({ endOfResponse: true });
    expect(done.failure).toBeUndefined();
    expect(done.results).toMatchObject([
      { tool: 'send_response', invocationId: 'synthetic-call-1', dispatchState: 'returned' },
    ]);
    expect(done.records).toMatchObject([{ tool: 'send_response', status: 'executed' }]);
    expect(h.events.map((e) => e.type)).toEqual([
      'tool_attempt',
      'tool_admission',
      'tool_intent',
      'local_tool_call',
    ]);
    for (const event of h.events.slice(1)) {
      expect(event).toMatchObject({
        invocationId: 'synthetic-call-1',
        toolOwner: {
          version: 1,
          sessionId: 'synthetic-session',
          turnId: 'turn-1',
          attemptId: 'attempt-1',
          ordinal: 0,
        },
      });
    }
    expect(h.release).toHaveBeenCalledOnce();
    expect(counts).toEqual({ userTurns: 1, providerRequests: 1 });
  });

  it('holds mutation bookkeeping and ordered image settlement until overlapping reads finish', async () => {
    const h = harness();
    h.ports.concurrentReads = true;
    const first = gate<Record<string, unknown>>();
    const second = gate<Record<string, unknown>>();
    vi.mocked(h.ports.callTool)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const image: ContextImage = {
      ref: 'img:stream-fixture',
      path: '/synthetic/stream.png',
      mimeType: 'image/png',
      width: 10,
      height: 20,
      approxTokens: 5,
    };
    vi.mocked(h.ports.takeImages).mockImplementation((result) => (result?.hasImage ? [image] : []));
    const stream = (await h.start())!;
    stream.append(block('recall') + block('get_artifact'));
    const finishing = stream.finish({ endOfResponse: true });
    await vi.waitFor(() => expect(h.ports.callTool).toHaveBeenCalledTimes(2));
    second.resolve({ hasImage: true });
    await Promise.resolve();
    expect(h.ports.onResult).not.toHaveBeenCalled();
    expect(h.release).not.toHaveBeenCalled();
    first.resolve({ value: 'first' });
    const done = await finishing;
    expect(done.records.map((r) => r.tool)).toEqual(['recall', 'get_artifact']);
    expect(h.events.filter((e) => e.type === 'local_tool_call').map((e) => e.tool)).toEqual([
      'recall',
      'get_artifact',
    ]);
    expect(h.ports.ledger.listImages()).toEqual([image]);
    expect(h.release).toHaveBeenCalledTimes(2);
  });

  it('identifies refusals without an intent and preserves identical distinct invocations', async () => {
    const h = harness();
    vi.mocked(h.ports.policy.canCallInkTool).mockReturnValueOnce({
      allowed: false,
      reason: 'fixture refusal',
    });
    const stream = (await h.start())!;
    stream.append(block('remember') + block('remember'));
    const done = await stream.finish({ endOfResponse: true });
    expect(done.results.map((r) => r.invocationId)).toEqual([
      'synthetic-call-1',
      'synthetic-call-2',
    ]);
    expect(h.events.filter((e) => e.type === 'tool_intent')).toHaveLength(1);
    const recovered = readToolInvocationJournal(h.events, 'synthetic-session')[0].invocations;
    expect(recovered.map((i) => i.result?.status)).toEqual(['blocked', 'executed']);
    expect(h.ports.callTool).toHaveBeenCalledOnce();
  });

  it('preserves unknown and returned receipts on recovery without reopening any old attempt', async () => {
    const h = harness();
    vi.mocked(h.ports.callTool).mockRejectedValueOnce(new Error('synthetic lost receipt'));
    const stream = (await h.start())!;
    stream.append(block('send_response') + block('remember'));
    await stream.finish({ endOfResponse: false });
    // A compaction marker changes context, not the immutable effect journal.
    h.events.push({ type: 'compaction', summary: 'Synthetic compacted context.' });
    const resumed = createToolInvocationJournal({
      sessionId: 'synthetic-session',
      log: h.ports.log,
      mintInvocationId: () => 'new-call',
      recoveredEvents: h.events,
    });
    expect(resumed.recovered[0].invocations.map((i) => i.result?.dispatchState)).toEqual([
      'unknown',
      'returned',
    ]);
    await expect(resumed.begin({ turnId: 'turn-1', attemptId: 'attempt-1' })).rejects.toThrow(
      'never redispatch'
    );
    expect(h.ports.callTool).toHaveBeenCalledTimes(2);
    expect(h.ports.onResult).toHaveBeenCalledTimes(2);
    const next = (await h.start('attempt-2', 'turn-2'))!;
    next.append(block('remember'));
    await next.finish({ endOfResponse: true });
    expect(
      readToolInvocationJournal(h.events, 'synthetic-session')[1].invocations[0].toolOwner
    ).toMatchObject({ turnId: 'turn-2', attemptId: 'attempt-2' });
  });

  it('retains a returned effect and releases resources if outcome recording fails; recovery remains unknown', async () => {
    const h = harness();
    const stream = (await h.start())!;
    vi.mocked(h.ports.log.append).mockImplementation((event) => {
      if (event.type === 'local_tool_call') throw new Error('synthetic result write failure');
      return h.events.push(structuredClone(event));
    });
    stream.append(block('send_response') + block('remember'));
    const done = await stream.finish({ endOfResponse: true });
    expect(done.results).toMatchObject([{ tool: 'send_response', dispatchState: 'returned' }]);
    expect(done.failure?.kind).toBe('executor');
    expect(done.notRun.map((r) => r.call.tool)).toEqual(['remember']);
    expect(h.release).toHaveBeenCalledTimes(2);
    const recovered = readToolInvocationJournal(h.events, 'synthetic-session')[0].invocations;
    expect(recovered.map((i) => i.state)).toEqual(['unknown', 'not-dispatched']);
    expect(h.ports.callTool).toHaveBeenCalledOnce();
  });

  it('does not lose known effects when the final flush or context release fails', async () => {
    const h = harness();
    const stream = (await h.start())!;
    stream.append(block('remember'));
    await vi.waitFor(() => expect(h.ports.onResult).toHaveBeenCalledOnce());
    vi.mocked(h.ports.log.flush).mockRejectedValueOnce(new Error('synthetic flush failure'));
    h.release.mockImplementation(() => {
      throw new Error('synthetic release failure');
    });
    const done = await stream.finish({ endOfResponse: true });
    expect(done.results).toMatchObject([{ dispatchState: 'returned' }]);
    expect(done.failure?.message).toContain('persistence failed');
    expect(h.release).toHaveBeenCalledOnce();
    expect(await stream.finish({ endOfResponse: true })).toEqual(done);
  });

  it('refuses session admission failure without executing later calls', async () => {
    const h = harness();
    const stream = (await h.start())!;
    vi.mocked(h.ports.beginContextMutation).mockImplementation(() => {
      throw new Error('synthetic mutation admission failure');
    });
    stream.append(block('remember') + block('send_response'));
    const done = await stream.finish({ endOfResponse: true });
    expect(done.notRun.map((r) => r.call.tool)).toEqual(['remember', 'send_response']);
    expect(done.failure?.kind).toBe('executor');
    expect(h.ports.callTool).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'uses the real ordered session log and mutation state (sink failure: %s)',
    async (failOutcome) => {
      const h = harness();
      const lines: string[] = [];
      // The production queue/serialization, with an in-memory sink. No file,
      // provider, tool host or credential store is reached by this test.
      const log = new SessionLog({
        path: '/synthetic/stream.jsonl',
        sink: {
          async write(line) {
            await Promise.resolve();
            if (failOutcome && JSON.parse(line).type === 'local_tool_call')
              throw new Error('synthetic outcome sink failure');
            lines.push(line);
          },
        },
      });
      const context = new SessionContextState({
        runtime: () => {
          throw new Error('No provider runtime is used');
        },
        append: (entry) => log.append(entry),
        rolled: () => {},
      });
      let sequence = 0;
      const journal = createToolInvocationJournal({
        sessionId: h.ports.sessionId!,
        log,
        mintInvocationId: () => `synthetic-${++sequence}`,
      });
      const stream = (await createSessionToolStream({
        enabled: true,
        journal,
        owner: { turnId: 'turn-1', attemptId: 'attempt-1' },
        ports: { ...h.ports, log, beginContextMutation: (calls) => context.beginMutation(calls) },
      }))!;
      stream.append(block('write') + block('edit'));
      expect(context.mutationsInFlight).toBe(2);
      expect(context.generation).toBe(2);
      const done = await stream.finish({ endOfResponse: true });
      expect(context.mutationsInFlight).toBe(0);
      expect(context.generation).toBe(4);
      expect(await stream.finish({ endOfResponse: true })).toEqual(done);
      expect(context.generation).toBe(4);
      const restored = createToolInvocationJournal({
        sessionId: h.ports.sessionId!,
        log,
        mintInvocationId: () => 'unused',
        recoveredEvents: lines.map((line) => JSON.parse(line)),
      });
      await expect(restored.begin({ turnId: 'turn-1', attemptId: 'attempt-1' })).rejects.toThrow(
        'never redispatch'
      );
      expect(restored.recovered[0].invocations.map((call) => call.state)).toEqual(
        failOutcome ? ['unknown', 'not-dispatched'] : ['settled', 'settled']
      );
      expect(h.ports.callTool).toHaveBeenCalledTimes(failOutcome ? 1 : 2);
      expect(done.results[0]).toMatchObject({ dispatchState: 'returned' });
      if (failOutcome) expect(done.failure?.kind).toBe('executor');
      else expect(done.failure).toBeUndefined();
    }
  );

  it('releases every admitted mutation even when an earlier release throws', async () => {
    const h = harness();
    const firstRelease = vi.fn(() => {
      throw new Error('synthetic release failure');
    });
    const secondRelease = vi.fn();
    vi.mocked(h.ports.beginContextMutation)
      .mockReturnValueOnce(firstRelease)
      .mockReturnValueOnce(secondRelease);
    const stream = (await h.start())!;
    stream.append(block('remember') + block('recall'));
    const done = await stream.finish({ endOfResponse: true });
    expect(done.failure?.message).toContain('context settlement failed');
    expect(done.results).toHaveLength(2);
    expect(firstRelease).toHaveBeenCalledOnce();
    expect(secondRelease).toHaveBeenCalledOnce();
    await stream.finish({ endOfResponse: true });
    expect(secondRelease).toHaveBeenCalledOnce();
  });
});
