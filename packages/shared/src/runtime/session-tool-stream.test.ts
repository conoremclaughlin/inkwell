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
import { parseJsonRpcToolPayload } from './mcp-result.js';
import { ToolSettlementSupervisor } from './tool-settlement-supervisor.js';

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
  const supervisor = new ToolSettlementSupervisor({
    sessionId: journal.sessionId,
    maxActiveAttempts: 4,
  });
  const start = (attemptId = 'attempt-1', turnId = 'turn-1', enabled = true) =>
    createSessionToolStream({ enabled, ports, journal, supervisor, owner: { turnId, attemptId } });
  return { ports, events, release, journal, supervisor, start };
}

describe('session-owned stream settlement and identity', () => {
  it('keeps abort-ignoring work and mutation ownership visible after a bounded Stop', async () => {
    const h = harness();
    const effect = gate<Record<string, unknown>>();
    vi.mocked(h.ports.callTool).mockReturnValueOnce(effect.promise);
    const stream = (await h.start())!;
    stream.append(block('remember'));
    await vi.waitFor(() => expect(h.ports.callTool).toHaveBeenCalledOnce());
    stream.markGenerationEnded();
    const pending = await h.supervisor.stopAndWait(0);
    expect(pending).toMatchObject([
      {
        resources: 'live',
        waitExpired: true,
        generationEnded: true,
        admission: 'closed',
        stopRequested: true,
      },
    ]);
    expect(vi.mocked(h.ports.callTool).mock.calls[0][2].signal?.aborted).toBe(true);
    expect(h.release).not.toHaveBeenCalled();
    expect(h.events.filter((event) => event.type === 'local_tool_call')).toEqual([]);
    effect.resolve({ success: true });
    expect((await stream.finish({ endOfResponse: false })).results).toMatchObject([
      { dispatchState: 'returned' },
    ]);
    expect(h.release).toHaveBeenCalledOnce();
    expect(h.supervisor.observe()).toEqual([]);
  });

  it('releases settled dispatcher exceptions without treating unknown effects as live work', async () => {
    const h = harness();
    vi.mocked(h.ports.callTool).mockRejectedValueOnce(new Error('synthetic unknown effect'));
    const stream = (await h.start())!;
    stream.append(block('send_response'));
    const done = await stream.finish({ endOfResponse: true });
    expect(done.results).toMatchObject([{ dispatchState: 'unknown', status: 'error' }]);
    expect(h.supervisor.observe()).toEqual([]);
    expect(
      readToolInvocationJournal(h.events, h.journal.sessionId)[0].invocations[0].result
    ).toMatchObject({ dispatchState: 'unknown' });
    expect(h.ports.callTool).toHaveBeenCalledOnce();
  });

  it('retains opening writes after Stop and never admits work when the opening write resumes', async () => {
    const h = harness();
    const opening = gate<void>();
    vi.mocked(h.ports.log.flush).mockReturnValueOnce(opening.promise);
    const starting = h.start();
    expect(h.supervisor.observe()).toHaveLength(1);
    expect(await h.supervisor.stopAndWait(0)).toMatchObject([
      { resources: 'live', waitExpired: true },
    ]);
    opening.resolve();
    const stream = (await starting)!;
    await stream.finish({ endOfResponse: false });
    expect(() => stream.append(block('remember'))).toThrow('ended');
    expect(h.ports.callTool).not.toHaveBeenCalled();
    expect(h.supervisor.observe()).toEqual([]);
  });

  it('owns an intent flush past Stop and does not dispatch when it eventually finishes', async () => {
    const h = harness();
    const stream = (await h.start())!;
    const intent = gate<void>();
    vi.mocked(h.ports.log.flush).mockReturnValueOnce(intent.promise);
    stream.append(block('remember'));
    await vi.waitFor(() =>
      expect(h.events.some((event) => event.type === 'tool_intent')).toBe(true)
    );
    expect(await h.supervisor.stopAndWait(0)).toMatchObject([{ resources: 'live' }]);
    expect(h.release).not.toHaveBeenCalled();
    intent.resolve();
    const done = await stream.finish({ endOfResponse: false });
    expect(done.results).toMatchObject([{ dispatchState: 'not-dispatched', status: 'denied' }]);
    expect(h.ports.callTool).not.toHaveBeenCalled();
    expect(h.supervisor.observe()).toEqual([]);
  });

  it('keeps a pending approval owned past Stop without acting on a late approval', async () => {
    const h = harness();
    const approval = gate<boolean>();
    vi.mocked(h.ports.policy.canCallInkTool).mockReturnValue({
      allowed: false,
      promptable: true,
      reason: 'synthetic approval',
    });
    vi.mocked(h.ports.promptForApproval).mockReturnValue(approval.promise);
    const stream = (await h.start())!;
    stream.append(block('remember') + block('send_response'));
    await vi.waitFor(() => expect(h.ports.promptForApproval).toHaveBeenCalledOnce());
    expect(await h.supervisor.stopAndWait(0)).toMatchObject([
      { resources: 'live', waitExpired: true },
    ]);
    expect(h.release).not.toHaveBeenCalled();
    approval.resolve(true);
    const done = await stream.finish({ endOfResponse: false });
    expect(done.results.map((result) => result.status)).toEqual(['denied', 'denied']);
    expect(h.ports.callTool).not.toHaveBeenCalled();
    expect(h.ports.promptForApproval).toHaveBeenCalledOnce();
    expect(h.supervisor.observe()).toEqual([]);
  });

  it('holds ownership through the outcome flush, not only the dispatcher result', async () => {
    const h = harness();
    const outcome = gate<void>();
    const stream = (await h.start())!;
    vi.mocked(h.ports.log.flush).mockImplementation(() =>
      h.events.at(-1)?.type === 'local_tool_call' ? outcome.promise : Promise.resolve()
    );
    stream.append(block('remember'));
    const finishing = stream.finish({ endOfResponse: true });
    await vi.waitFor(() => expect(h.ports.onResult).toHaveBeenCalledOnce());
    expect(await stream.ownership.wait(0)).toMatchObject({ resources: 'live', waitExpired: true });
    expect(h.release).not.toHaveBeenCalled();
    outcome.resolve();
    await finishing;
    expect(h.supervisor.observe()).toEqual([]);
    expect(h.release).toHaveBeenCalledOnce();
  });

  it('retains a failed mutation release for explicit reconciliation', async () => {
    const h = harness();
    h.release.mockImplementation(() => {
      throw new Error('synthetic release failure');
    });
    const stream = (await h.start())!;
    stream.append(block('remember'));
    expect((await stream.finish({ endOfResponse: true })).failure?.message).toContain(
      'settlement failed'
    );
    expect(h.supervisor.observe()).toMatchObject([{ resources: 'reconciliation-required' }]);
    expect(await stream.ownership.reconcile(async () => false)).toBe(false);
    expect(h.supervisor.observe()).toHaveLength(1);
    expect(await stream.ownership.reconcile(async () => true)).toBe(true);
    expect(h.supervisor.observe()).toEqual([]);
    expect(h.ports.callTool).toHaveBeenCalledOnce();
  });

  it('keeps late records bound to their original owner while a newer turn is present', async () => {
    const h = harness();
    const oldEffect = gate<Record<string, unknown>>();
    vi.mocked(h.ports.callTool).mockReturnValueOnce(oldEffect.promise);
    const old = (await h.start('attempt-old', 'turn-old'))!;
    old.append(block('recall'));
    await vi.waitFor(() => expect(h.ports.callTool).toHaveBeenCalledOnce());
    const oldFinished = old.finish({ endOfResponse: true });
    await old.ownership.wait(0);
    const newer = (await h.start('attempt-new', 'turn-new'))!;
    expect(h.supervisor.observe().map((entry) => entry.owner.turnId)).toEqual([
      'turn-old',
      'turn-new',
    ]);
    oldEffect.resolve({ value: 'synthetic old result' });
    await oldFinished;
    expect(h.events.find((event) => event.type === 'local_tool_call')?.toolOwner).toMatchObject({
      turnId: 'turn-old',
      attemptId: 'attempt-old',
    });
    expect(h.supervisor.observe()).toMatchObject([
      { owner: { turnId: 'turn-new' }, resources: 'live', waitExpired: false },
    ]);
    await newer.finish({ endOfResponse: true });
    expect(h.supervisor.observe()).toEqual([]);
  });

  it('refuses duplicate ownership before attempting another journal write', async () => {
    const h = harness();
    const stream = (await h.start())!;
    const eventCount = h.events.length;
    await expect(h.start()).rejects.toThrow('already live');
    expect(h.events).toHaveLength(eventCount);
    await stream.finish({ endOfResponse: true });
    expect(h.supervisor.observe()).toEqual([]);
    await expect(h.start()).rejects.toThrow('never redispatch');
    expect(h.supervisor.observe()).toEqual([]);
  });

  it('is inert when disabled and refuses mismatched session/log ownership before writing', async () => {
    const h = harness();
    expect(await h.start('attempt-1', 'turn-1', false)).toBeUndefined();
    expect(h.events).toEqual([]);
    await expect(
      createSessionToolStream({
        enabled: true,
        ports: { ...h.ports, sessionId: 'wrong-session' },
        journal: h.journal,
        supervisor: h.supervisor,
        owner: { turnId: 't', attemptId: 'a' },
      })
    ).rejects.toThrow('owning session');
    await expect(
      createSessionToolStream({
        enabled: true,
        ports: { ...h.ports, log: { ...h.ports.log } },
        journal: h.journal,
        supervisor: h.supervisor,
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
        supervisor: h.supervisor,
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

  it.each([null, [1, 2], 'done', 42, true].map((payload) => [payload]))(
    'recovers the opaque JSON payload %j accepted by the tool parser',
    async (payload) => {
      const h = harness();
      const lines: string[] = [];
      const log = new SessionLog({
        path: '/synthetic/result-shapes.jsonl',
        sink: {
          write: (line) => {
            lines.push(line);
          },
        },
      });
      const journal = createToolInvocationJournal({
        sessionId: h.ports.sessionId!,
        log,
        mintInvocationId: () => 'synthetic-shape-call',
      });
      vi.mocked(h.ports.callTool).mockResolvedValue(
        parseJsonRpcToolPayload({
          result: { content: [{ type: 'text', text: JSON.stringify(payload) }] },
        })
      );
      const stream = (await createSessionToolStream({
        enabled: true,
        ports: { ...h.ports, log },
        journal,
        supervisor: h.supervisor,
        owner: { turnId: 'synthetic-turn', attemptId: 'synthetic-attempt' },
      }))!;
      stream.append(block('recall'));
      const done = await stream.finish({ endOfResponse: true });
      expect(done.failure).toBeUndefined();
      expect(done.results[0]).toMatchObject({ status: 'executed', result: payload });
      const restored = createToolInvocationJournal({
        sessionId: h.ports.sessionId!,
        log,
        mintInvocationId: () => 'unused',
        recoveredEvents: lines.map((line) => JSON.parse(line)),
      });
      expect(restored.recovered[0].invocations[0]).toMatchObject({
        state: 'settled',
        result: { status: 'executed', dispatchState: 'returned', result: payload },
      });
      await expect(
        restored.begin({ turnId: 'synthetic-turn', attemptId: 'synthetic-attempt' })
      ).rejects.toThrow('never redispatch');
      expect(h.ports.callTool).toHaveBeenCalledOnce();
    }
  );
});
